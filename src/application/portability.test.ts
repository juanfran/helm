import { Effect, Either } from "effect";
import { describe, expect, it, vi } from "vitest";

import type { ProjectImportExecutionResult, ProjectImportPreview } from "../domain/portability";
import { InvalidRepositoryRootError } from "./project-errors";
import type { RepositoryInspector } from "./projects";
import { PortabilityNotFoundError } from "./portability-errors";
import {
  createDatabaseBackup,
  executeProjectImport,
  exportProject,
  exportProjectMarkdown,
  previewProjectImport,
  type PortabilityServices,
} from "./portability";

const preview: ProjectImportPreview = {
  format: "helm-project-import-preview",
  schemaVersion: 1,
  sourceFormat: "csv",
  sourceProjectId: null,
  targetProjectId: "project-1",
  creates: [],
  updates: [],
  noOps: [],
  conflicts: [],
  unsupported: [],
  executable: true,
  previewToken: `hip1:${"a".repeat(64)}:${"b".repeat(64)}`,
};

const execution: ProjectImportExecutionResult = {
  format: "helm-project-import-result",
  schemaVersion: 1,
  sourceFormat: "csv",
  sourceProjectId: null,
  targetProjectId: "project-1",
  creates: [],
  updates: [],
  noOps: [],
  conflicts: [],
  unsupported: [],
  executed: true,
  operationId: "operation-1",
  eventCursors: [1],
};

function services() {
  const inspectRepository = vi.fn(() =>
    Effect.succeed({ canonicalRoot: "/canonical/project", name: "project" }),
  );
  const repositoryInspector: RepositoryInspector = {
    inspect: inspectRepository,
  };
  const createBackup = vi.fn(() => Effect.succeed(Uint8Array.from([1, 2, 3])));
  const exportJson = vi.fn(() =>
    Effect.fail(
      new PortabilityNotFoundError({
        entityType: "project",
        entityId: "project-1",
        message: "Not needed by this delegation test.",
      }),
    ),
  );
  const exportMarkdown = vi.fn(() =>
    Effect.fail(
      new PortabilityNotFoundError({
        entityType: "saved_view",
        entityId: "view-1",
        message: "Not needed by this delegation test.",
      }),
    ),
  );
  const previewImport = vi.fn(() => Effect.succeed(preview));
  const executeImport = vi.fn(() => Effect.succeed(execution));
  const store: PortabilityServices["store"] = {
    createBackup,
    exportProject: exportJson,
    exportProjectMarkdown: exportMarkdown,
    previewImport,
    executeImport,
  };
  return {
    store,
    spies: {
      createBackup,
      executeImport,
      exportJson,
      exportMarkdown,
      inspectRepository,
      previewImport,
    },
    services: {
      store,
      clock: { now: () => "2026-09-04T12:00:00.000Z" },
      repositoryInspector,
    } satisfies PortabilityServices,
  };
}

describe("portability application operations", () => {
  it("delegates read-only exports and online backup with validated inputs", async () => {
    const test = services();
    const controller = new AbortController();
    await expect(
      Effect.runPromise(createDatabaseBackup(test.services, controller.signal)),
    ).resolves.toEqual(Uint8Array.from([1, 2, 3]));
    await Effect.runPromise(
      Effect.either(exportProject({ projectId: "project-1" }, test.services)),
    );
    await Effect.runPromise(
      Effect.either(
        exportProjectMarkdown({ projectId: "project-1", savedViewId: "view-1" }, test.services),
      ),
    );
    expect(test.spies.createBackup).toHaveBeenCalledWith(controller.signal);
    expect(test.spies.exportJson).toHaveBeenCalledWith(
      { projectId: "project-1" },
      { now: "2026-09-04T12:00:00.000Z" },
    );
    expect(test.spies.exportMarkdown).toHaveBeenCalledWith(
      { projectId: "project-1", savedViewId: "view-1" },
      { now: "2026-09-04T12:00:00.000Z" },
    );
  });

  it("rejects malformed import requests before the store", async () => {
    const test = services();
    const result = await Effect.runPromise(
      Effect.either(
        executeProjectImport(
          {
            source: { format: "json", content: "{}" },
            targetProjectId: null,
            reason: "Restore project",
            previewToken: preview.previewToken,
            idempotencyKey: "restore-1",
          },
          { type: "human", id: "local-human" },
          test.services,
        ),
      ),
    );
    expect(Either.isLeft(result) && result.left["_tag"]).toBe("InvalidPortabilityInputError");
    expect(test.spies.executeImport).not.toHaveBeenCalled();
  });

  it("keeps preview and execution human-only", async () => {
    const test = services();
    const input = {
      source: { format: "csv" as const, content: "title\nShip" },
      targetProjectId: "project-1",
      reason: "Import tasks",
    };
    const previewResult = await Effect.runPromise(
      Effect.either(previewProjectImport(input, { type: "agent", id: "run-1" }, test.services)),
    );
    const executionResult = await Effect.runPromise(
      Effect.either(
        executeProjectImport(
          { ...input, previewToken: preview.previewToken, idempotencyKey: "import-1" },
          { type: "agent", id: "run-1" },
          test.services,
        ),
      ),
    );
    expect(Either.isLeft(previewResult) && previewResult.left["_tag"]).toBe(
      "PortabilityAuthorizationError",
    );
    expect(Either.isLeft(executionResult) && executionResult.left["_tag"]).toBe(
      "PortabilityAuthorizationError",
    );
    expect(test.spies.previewImport).not.toHaveBeenCalled();
    expect(test.spies.executeImport).not.toHaveBeenCalled();
  });

  it("canonicalizes new-project roots before preview and execution", async () => {
    const test = services();
    const input = {
      source: { format: "csv" as const, content: "title\nShip" },
      targetProjectId: null,
      repositoryRoot: "/uncanonical/project",
      reason: "Import tasks",
    };
    await Effect.runPromise(
      previewProjectImport(input, { type: "human", id: "local-human" }, test.services),
    );
    await Effect.runPromise(
      executeProjectImport(
        { ...input, previewToken: preview.previewToken, idempotencyKey: "import-new" },
        { type: "human", id: "local-human" },
        test.services,
      ),
    );

    expect(test.spies.inspectRepository).toHaveBeenCalledTimes(2);
    expect(test.spies.previewImport).toHaveBeenCalledWith(
      expect.objectContaining({ repositoryRoot: "/canonical/project" }),
      { type: "human", id: "local-human" },
      { now: "2026-09-04T12:00:00.000Z" },
    );
    expect(test.spies.executeImport).toHaveBeenCalledWith(
      expect.objectContaining({ repositoryRoot: "/canonical/project" }),
      { type: "human", id: "local-human" },
      { now: "2026-09-04T12:00:00.000Z" },
    );
  });

  it("maps repository inspection failures to invalid portability input", async () => {
    const test = services();
    test.services.repositoryInspector.inspect = vi.fn(() =>
      Effect.fail(
        new InvalidRepositoryRootError({
          path: "/missing",
          reason: "missing",
          message: "The repository path does not exist.",
        }),
      ),
    );
    const result = await Effect.runPromise(
      Effect.either(
        previewProjectImport(
          {
            source: { format: "csv", content: "title\nShip" },
            targetProjectId: null,
            repositoryRoot: "/missing",
            reason: "Import tasks",
          },
          { type: "human", id: "local-human" },
          test.services,
        ),
      ),
    );

    expect(Either.isLeft(result) && result.left["_tag"]).toBe("InvalidPortabilityInputError");
    expect(test.spies.previewImport).not.toHaveBeenCalled();
  });
});
