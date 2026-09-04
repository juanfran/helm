import { readdir } from "node:fs/promises";
import { tmpdir } from "node:os";

import { Effect, Either } from "effect";
import { afterEach, describe, expect, it, vi } from "vitest";

import { PortabilityPersistenceError } from "../application/portability-errors";
import type { ExecuteProjectImportInput, PreviewProjectImportInput } from "../domain/portability";
import { createSqlitePortabilityStore } from "./sqlite-portability-store.server";
import { createSqliteProjectStore, type SqliteProjectStore } from "./sqlite-project-store.server";

const now = "2026-09-04T12:00:00.000Z";
const human = { type: "human" as const, id: "local-human" };
const stores: SqliteProjectStore[] = [];

function seededStore() {
  const store = createSqliteProjectStore(":memory:");
  stores.push(store);
  store.database
    .prepare(
      `insert into projects (
         id, sequence, name, repository_root, review_mode, version, created_at, updated_at
       ) values (?, ?, ?, ?, ?, ?, ?, ?)`,
    )
    .run("project-1", 1, "Portable project", process.cwd(), "required", 1, now, now);
  return store;
}

afterEach(() => {
  for (const store of stores.splice(0)) {
    if (store.database.open) store.close();
  }
});

describe("SQLite portability repository", () => {
  it("creates a real backup and dispatches CSV preview and execution atomically", async () => {
    const projectStore = seededStore();
    const repository = createSqlitePortabilityStore(projectStore.database);

    const backup = await Effect.runPromise(repository.createBackup());
    expect(backup).toBeInstanceOf(ReadableStream);
    if (backup instanceof Uint8Array) throw new Error("Expected a streamed database backup.");
    const backupBytes = new Uint8Array(await new Response(backup).arrayBuffer());
    expect(new TextDecoder().decode(backupBytes.slice(0, 16))).toBe("SQLite format 3\0");

    const previewInput: PreviewProjectImportInput = {
      source: {
        format: "csv",
        content:
          "title,lifecycle,expected_outcome,acceptance_criteria,checklist\n" +
          '"Imported task","ready","Coordinate work","Visible in Helm","Verify import"',
      },
      targetProjectId: "project-1",
      reason: "Restore a reviewed task list",
    };
    const preview = await Effect.runPromise(repository.previewImport(previewInput, human, { now }));
    expect(preview).toMatchObject({
      executable: true,
      creates: [{ sourceId: "csv-row-2", targetId: null }],
      conflicts: [],
      unsupported: [],
    });

    const executionInput: ExecuteProjectImportInput = {
      ...previewInput,
      previewToken: preview.previewToken,
      idempotencyKey: "portable-store-csv",
    };
    const result = await Effect.runPromise(
      repository.executeImport(executionInput, human, { now }),
    );
    expect(result).toMatchObject({ executed: true, sourceFormat: "csv" });
    expect(result.eventCursors).toHaveLength(2);
    expect(
      projectStore.database
        .prepare("select title, lifecycle from tasks where project_id = ?")
        .get("project-1"),
    ).toEqual({ title: "Imported task", lifecycle: "ready" });
    expect(
      projectStore.database
        .prepare("select actor_type, actor_id from events where kind = 'project.import.csv'")
        .get(),
    ).toEqual({ actor_type: "human", actor_id: "local-human" });

    await expect(
      Effect.runPromise(repository.executeImport(executionInput, human, { now })),
    ).resolves.toEqual(result);
    expect(projectStore.database.prepare("select count(*) from tasks").pluck().get()).toBe(1);
  });

  it("removes the temporary backup image when a streamed download is cancelled", async () => {
    const before = new Set(await readdir(tmpdir()));
    const projectStore = seededStore();
    const repository = createSqlitePortabilityStore(projectStore.database);

    const backup = await Effect.runPromise(repository.createBackup());
    if (backup instanceof Uint8Array) throw new Error("Expected a streamed database backup.");
    const createdDirectories = (await readdir(tmpdir())).filter(
      (entry) => entry.startsWith("helm-portability-backup-") && !before.has(entry),
    );
    expect(createdDirectories).toHaveLength(1);

    await backup.cancel("test consumer cancelled");

    await expect
      .poll(
        async () => (await readdir(tmpdir())).filter((entry) => createdDirectories.includes(entry)),
        { timeout: 1_000 },
      )
      .toEqual([]);
  });

  it("correlates unexpected database failures without exposing their details", async () => {
    const projectStore = seededStore();
    const repository = createSqlitePortabilityStore(projectStore.database);
    const stderr = vi.spyOn(process.stderr, "write").mockReturnValue(true);
    projectStore.close();

    try {
      const outcome = await Effect.runPromise(
        Effect.either(repository.exportProject({ projectId: "project-1" }, { now })),
      );
      expect(Either.isLeft(outcome)).toBe(true);
      if (Either.isRight(outcome)) throw new Error("Expected the closed database read to fail.");
      expect(outcome.left).toBeInstanceOf(PortabilityPersistenceError);
      if (!(outcome.left instanceof PortabilityPersistenceError)) {
        throw new Error("Expected a correlated portability persistence error.");
      }
      expect(outcome.left).toMatchObject({
        message: "The project portability database operation failed.",
        correlationId: expect.stringMatching(/^[0-9a-f-]{36}$/),
      });
      expect(stderr.mock.calls.join("\n")).toContain(outcome.left.correlationId);
      expect(outcome.left.message).not.toContain("closed");
    } finally {
      stderr.mockRestore();
    }
  });
});
