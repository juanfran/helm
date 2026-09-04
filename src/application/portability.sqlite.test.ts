import { mkdir, mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { Effect, Either } from "effect";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

import { stablePortabilityJson } from "../domain/portability";
import { createSqlitePortabilityStore } from "../infrastructure/sqlite-portability-store.server";
import {
  createSqliteProjectStore,
  type SqliteProjectStore,
} from "../infrastructure/sqlite-project-store.server";
import { localRepositoryInspector } from "../infrastructure/repository-inspector.server";
import { createProject } from "./projects";
import { PortabilityPersistenceError, PortabilityPreviewStaleError } from "./portability-errors";
import {
  executeProjectImport,
  exportProject,
  previewProjectImport,
  type PortabilityServices,
} from "./portability";

const now = "2026-09-04T12:00:00.000Z";
const human = { type: "human" as const, id: "local-human" };

let temporaryRoot: string;
let projectStore: SqliteProjectStore;
let projectId: string;
let services: PortabilityServices;

function csvImportInput(content: string, reason = "Import reviewed task data") {
  return {
    source: { format: "csv" as const, content },
    targetProjectId: projectId,
    reason,
  };
}

async function previewCsv(content: string, reason?: string) {
  return Effect.runPromise(previewProjectImport(csvImportInput(content, reason), human, services));
}

async function executeCsv(
  content: string,
  previewToken: string,
  idempotencyKey: string,
  reason?: string,
) {
  return Effect.runPromise(
    executeProjectImport(
      {
        ...csvImportInput(content, reason),
        previewToken,
        idempotencyKey,
      },
      human,
      services,
    ),
  );
}

async function exportedProject() {
  return Effect.runPromise(exportProject({ projectId }, services));
}

beforeEach(async () => {
  temporaryRoot = await mkdtemp(join(tmpdir(), "helm-portability-application-"));
  const repositoryRoot = join(temporaryRoot, "repository");
  await mkdir(join(repositoryRoot, ".git"), { recursive: true });
  projectStore = createSqliteProjectStore(join(temporaryRoot, "helm.db"));
  const project = await Effect.runPromise(
    createProject(
      { repositoryRoot, idempotencyKey: "create-portability-project" },
      { store: projectStore, inspector: localRepositoryInspector },
    ),
  );
  projectId = project.id;
  services = {
    store: createSqlitePortabilityStore(projectStore.database),
    clock: { now: () => now },
    repositoryInspector: localRepositoryInspector,
  };
});

afterEach(async () => {
  vi.restoreAllMocks();
  if (projectStore.database.open) projectStore.close();
  await rm(temporaryRoot, { recursive: true, force: true });
});

describe("project portability application commands with SQLite", () => {
  it("previews and executes a versioned JSON merge through the application command", async () => {
    const archive = await exportedProject();
    const content = stablePortabilityJson({
      ...archive,
      project: { ...archive.project, name: "Restored project name" },
    });
    const input = {
      source: { format: "json" as const, content },
      targetProjectId: projectId,
      reason: "Restore reviewed project metadata",
    };

    const preview = await Effect.runPromise(previewProjectImport(input, human, services));
    expect(preview).toMatchObject({
      executable: true,
      creates: [],
      conflicts: [],
      updates: [
        expect.objectContaining({
          entityType: "project",
          sourceId: projectId,
          targetId: projectId,
        }),
      ],
    });

    await expect(
      Effect.runPromise(
        executeProjectImport(
          {
            ...input,
            previewToken: preview.previewToken,
            idempotencyKey: "application-json-merge",
          },
          human,
          services,
        ),
      ),
    ).resolves.toMatchObject({ executed: true, targetProjectId: projectId });
    expect((await exportedProject()).project.name).toBe("Restored project name");
  });

  it("previews and executes CSV through the application seam with idempotent retry", async () => {
    const content = "title\nApplication-seam task";
    const preview = await previewCsv(content);

    expect(preview).toMatchObject({
      executable: true,
      creates: [{ sourceId: "csv-row-2", targetId: null }],
      conflicts: [],
      unsupported: [],
    });

    const first = await executeCsv(content, preview.previewToken, "application-success");
    const afterFirst = await exportedProject();
    const retry = await executeCsv(content, preview.previewToken, "application-success");
    const afterRetry = await exportedProject();

    expect(first).toEqual(retry);
    expect(afterRetry).toEqual(afterFirst);
    expect(afterRetry.tasks.map(({ title }) => title)).toEqual(["Application-seam task"]);
    expect(afterRetry.sourceEvents.map(({ kind }) => kind)).toContain("project.import.csv");
  });

  it("rejects a stale preview without partially applying its task", async () => {
    const staleContent = "title\nStale candidate";
    const stalePreview = await previewCsv(staleContent);
    const concurrentContent = "title\nConcurrent task";
    const concurrentPreview = await previewCsv(concurrentContent, "Import concurrent task");
    await executeCsv(
      concurrentContent,
      concurrentPreview.previewToken,
      "application-concurrent",
      "Import concurrent task",
    );

    const outcome = await Effect.runPromise(
      Effect.either(
        executeProjectImport(
          {
            ...csvImportInput(staleContent),
            previewToken: stalePreview.previewToken,
            idempotencyKey: "application-stale",
          },
          human,
          services,
        ),
      ),
    );

    expect(Either.isLeft(outcome)).toBe(true);
    if (Either.isRight(outcome)) throw new Error("Expected the stale import to fail.");
    expect(outcome.left).toBeInstanceOf(PortabilityPreviewStaleError);
    expect((await exportedProject()).tasks.map(({ title }) => title)).toEqual(["Concurrent task"]);
  });

  it("rolls back task, event, and idempotency writes when the import parent event fails", async () => {
    const content = "title\nRolled-back task";
    const preview = await previewCsv(content);
    const before = await exportedProject();
    const stderr = vi.spyOn(process.stderr, "write").mockReturnValue(true);
    projectStore.database.exec(`
      create trigger reject_portability_parent
      before insert on events
      when new.kind = 'project.import.csv'
      begin
        select raise(abort, 'forced portability audit failure');
      end;
    `);

    const outcome = await Effect.runPromise(
      Effect.either(
        executeProjectImport(
          {
            ...csvImportInput(content),
            previewToken: preview.previewToken,
            idempotencyKey: "application-rollback",
          },
          human,
          services,
        ),
      ),
    );

    expect(Either.isLeft(outcome)).toBe(true);
    if (Either.isRight(outcome)) throw new Error("Expected the fault-injected import to fail.");
    expect(outcome.left).toBeInstanceOf(PortabilityPersistenceError);
    if (!(outcome.left instanceof PortabilityPersistenceError)) {
      throw new Error("Expected a correlated portability persistence error.");
    }
    expect(stderr.mock.calls.join("\n")).toContain(outcome.left.correlationId);
    expect(await exportedProject()).toEqual(before);

    projectStore.database.exec("drop trigger reject_portability_parent");
    await expect(
      executeCsv(content, preview.previewToken, "application-rollback"),
    ).resolves.toMatchObject({ executed: true });
    expect((await exportedProject()).tasks.map(({ title }) => title)).toEqual(["Rolled-back task"]);
  });
});
