import { mkdir, mkdtemp, rm } from "node:fs/promises";
import { join } from "node:path";
import { tmpdir } from "node:os";

import { afterEach, describe, expect, it } from "vitest";

import { localRepositoryInspector } from "../infrastructure/repository-inspector.server";
import {
  createSqliteProjectStore,
  type SqliteProjectStore,
} from "../infrastructure/sqlite-project-store.server";
import { executeCreateProject } from "./project-adapter";

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
  return { repositoryRoot, services: { store, inspector: localRepositoryInspector } };
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
});
