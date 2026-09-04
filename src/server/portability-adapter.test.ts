import { Effect } from "effect";
import { describe, expect, it } from "vitest";

import type { PortabilityServices } from "../application/portability";
import { PortabilityAuthorizationError } from "../application/portability-errors";
import type { ProjectImportPreview } from "../domain/portability";
import { executePortableProjectImport, executePreviewProjectImport } from "./portability-adapter";

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

const services: PortabilityServices = {
  clock: { now: () => "2026-09-04T12:00:00.000Z" },
  repositoryInspector: {
    inspect: () => Effect.succeed({ canonicalRoot: "/canonical/project", name: "project" }),
  },
  store: {
    createBackup: () => Effect.succeed(new Uint8Array()),
    exportProject: () => Effect.die("unused"),
    exportProjectMarkdown: () => Effect.die("unused"),
    previewImport: () => Effect.succeed(preview),
    executeImport: () =>
      Effect.succeed({
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
      }),
  },
};

describe("portability adapter", () => {
  it("serializes successful previews and executions", async () => {
    const input = {
      source: { format: "csv" as const, content: "title\nShip" },
      targetProjectId: "project-1",
      reason: "Restore tasks",
    };
    await expect(
      executePreviewProjectImport(input, { type: "human", id: "local-human" }, services),
    ).resolves.toEqual({ ok: true, preview });
    await expect(
      executePortableProjectImport(
        {
          ...input,
          previewToken: preview.previewToken,
          idempotencyKey: "import-1",
        },
        { type: "human", id: "local-human" },
        services,
      ),
    ).resolves.toMatchObject({ ok: true, result: { operationId: "operation-1" } });
  });

  it("returns a tagged authorization DTO without invoking the store", async () => {
    const response = await executePreviewProjectImport(
      {
        source: { format: "csv", content: "title\nShip" },
        targetProjectId: "project-1",
        reason: "Restore tasks",
      },
      { type: "agent", id: "run-1" },
      services,
    );
    expect(response).toEqual({
      ok: false,
      error: {
        type: new PortabilityAuthorizationError({ message: "unused" })["_tag"],
        message: "Only the local human can import project data.",
      },
    });
  });
});
