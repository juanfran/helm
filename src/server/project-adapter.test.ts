import { mkdir, mkdtemp, rm } from "node:fs/promises";
import { join } from "node:path";
import { tmpdir } from "node:os";

import { afterEach, describe, expect, it } from "vitest";

import { localRepositoryInspector } from "../infrastructure/repository-inspector.server";
import {
  createSqliteProjectStore,
  type SqliteProjectStore,
} from "../infrastructure/sqlite-project-store.server";
import { executeCreateProject, executeSelectActiveProject } from "./project-adapter";

const temporaryPaths: string[] = [];
const stores: SqliteProjectStore[] = [];

afterEach(async () => {
  stores.splice(0).forEach((store) => store.close());
  await Promise.all(
    temporaryPaths.splice(0).map((path) => rm(path, { recursive: true, force: true })),
  );
});

async function fixture() {
  const parent = await mkdtemp(join(tmpdir(), "helm-adapter-test-"));
  temporaryPaths.push(parent);
  const repositoryRoot = join(parent, "repository");
  await mkdir(join(repositoryRoot, ".git"), { recursive: true });
  const store = createSqliteProjectStore(":memory:");
  stores.push(store);
  return { parent, repositoryRoot, services: { store, inspector: localRepositoryInspector } };
}

describe("project server adapter", () => {
  it("serializes successful and typed-error command results", async () => {
    const { repositoryRoot, services } = await fixture();
    const success = await executeCreateProject(
      { repositoryRoot, idempotencyKey: "adapter-success" },
      services,
    );
    const duplicate = await executeCreateProject(
      { repositoryRoot, idempotencyKey: "adapter-duplicate" },
      services,
    );
    const invalid = await executeCreateProject({ repositoryRoot: "" }, services);

    expect(success.ok).toBe(true);
    expect(duplicate).toMatchObject({
      ok: false,
      error: { type: "DuplicateRepositoryRootError", path: repositoryRoot },
    });
    expect(invalid).toEqual({
      ok: false,
      error: { type: "InvalidProjectInputError", message: "The command input is invalid." },
    });
  });

  it("serializes active-project selection and conflict errors", async () => {
    const { parent, repositoryRoot, services } = await fixture();
    const first = await executeCreateProject(
      { repositoryRoot, idempotencyKey: "adapter-first-project" },
      services,
    );
    if (!first.ok) throw new Error("Expected the first adapter project to be created.");
    const secondRoot = join(parent, "second-repository");
    await mkdir(join(secondRoot, ".git"), { recursive: true });
    const second = await executeCreateProject(
      { repositoryRoot: secondRoot, idempotencyKey: "adapter-second-project" },
      services,
    );
    if (!second.ok) throw new Error("Expected the second adapter project to be created.");

    const selected = await executeSelectActiveProject(
      { projectId: first.project.id, expectedVersion: 2, idempotencyKey: "adapter-select-first" },
      { type: "human", id: "local-human" },
      services,
    );
    const stale = await executeSelectActiveProject(
      { projectId: second.project.id, expectedVersion: 2, idempotencyKey: "adapter-select-stale" },
      { type: "human", id: "local-human" },
      services,
    );
    const missing = await executeSelectActiveProject(
      {
        projectId: "missing-project",
        expectedVersion: 3,
        idempotencyKey: "adapter-select-missing",
      },
      { type: "human", id: "local-human" },
      services,
    );

    expect(selected).toMatchObject({
      ok: true,
      state: { activeProject: first.project, activeProjectVersion: 3 },
    });
    expect(stale).toEqual({
      ok: false,
      error: {
        type: "ActiveProjectVersionConflictError",
        message: "Active project version conflict: expected 2, current 3.",
        projectId: second.project.id,
        expectedVersion: 2,
        currentVersion: 3,
        changeSummary: `The active project selection is now version 3, with project ${first.project.id} selected.`,
      },
    });
    expect(missing).toEqual({
      ok: false,
      error: {
        type: "ProjectNotFoundError",
        message: "That project does not exist.",
        projectId: "missing-project",
      },
    });
  });
});
