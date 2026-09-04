import { createHash } from "node:crypto";
import { copyFileSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";

import Database from "better-sqlite3";
import { drizzle } from "drizzle-orm/better-sqlite3";
import { migrate } from "drizzle-orm/better-sqlite3/migrator";
import { Effect } from "effect";
import { afterEach, describe, expect, it } from "vitest";

import { completeTask, listTasks } from "../application/tasks";
import { emptyRichTextDocument } from "../domain/tasks";
import { createSqliteProjectStore } from "./sqlite-project-store.server";
import { createSqliteTaskStore } from "./sqlite-task-store.server";

const temporaryPaths: string[] = [];
const migrationNamesThrough0004 = [
  "0000_modern_nick_fury.sql",
  "0001_ambitious_maggott.sql",
  "0002_oval_namor.sql",
  "0003_free_firelord.sql",
  "0004_flaky_shaman.sql",
] as const;
const migrationNamesThrough0005 = [
  ...migrationNamesThrough0004,
  "0005_majestic_patriot.sql",
] as const;

function temporaryDirectory(prefix: string) {
  const path = mkdtempSync(join(tmpdir(), prefix));
  temporaryPaths.push(path);
  return path;
}

function createPreviousMigrationFolder(
  migrationNames: readonly string[] = migrationNamesThrough0004,
) {
  const source = resolve("drizzle");
  const destination = temporaryDirectory("helm-previous-migrations-");
  mkdirSync(join(destination, "meta"));
  for (const name of migrationNames) copyFileSync(join(source, name), join(destination, name));
  const journal = JSON.parse(readFileSync(join(source, "meta", "_journal.json"), "utf8"));
  journal.entries = journal.entries.slice(0, migrationNames.length);
  writeFileSync(join(destination, "meta", "_journal.json"), JSON.stringify(journal));
  return destination;
}

function legacyTaskResult() {
  return {
    id: "legacy-task",
    projectId: "legacy-project",
    sequence: 1,
    parentTaskId: null,
    childTaskIds: [],
    title: "Legacy task",
    lifecycle: "done",
    priority: "normal",
    position: 1,
    notBefore: "2026-02-30",
    dueAt: "2026-13-01",
    size: null,
    tags: [],
    requiredCapabilities: [],
    upstreamRelations: [],
    downstreamRelations: [],
    description: emptyRichTextDocument,
    descriptionText: "",
    expectedOutcome: "Legacy behavior is retained.",
    acceptanceCriteria: "The migration is observable.",
    agentContext: "",
    checklist: [{ id: "verify", text: "Run migration test", checked: false }],
    version: 2,
    archivedAt: null,
    createdAt: "2026-08-01T10:00:00.000Z",
    updatedAt: "2026-08-01T11:00:00.000Z",
  };
}

afterEach(() => {
  for (const path of temporaryPaths.splice(0)) rmSync(path, { recursive: true, force: true });
});

describe("SQLite forward migrations", () => {
  it("repairs invalid legacy dates, cached results, and exclusive tag assignments from 0004", async () => {
    const root = temporaryDirectory("helm-migration-fixture-");
    const databasePath = join(root, "helm.db");
    const previousMigrations = createPreviousMigrationFolder();
    const legacyDatabase = new Database(databasePath);
    legacyDatabase.pragma("foreign_keys = ON");
    migrate(drizzle(legacyDatabase), { migrationsFolder: previousMigrations });

    legacyDatabase
      .prepare(
        "insert into projects (id, sequence, name, repository_root, version, created_at, updated_at) values (?, ?, ?, ?, ?, ?, ?)",
      )
      .run(
        "legacy-project",
        1,
        "legacy",
        root,
        1,
        "2026-08-01T09:00:00.000Z",
        "2026-08-01T09:00:00.000Z",
      );
    const legacyResult = legacyTaskResult();
    legacyDatabase
      .prepare(
        `insert into tasks (
          id, project_id, sequence, parent_task_id, title, lifecycle, priority, position,
          not_before, due_at, size, description_json, description_text, expected_outcome,
          acceptance_criteria, agent_context, checklist_json, version, archived_at, created_at, updated_at
        ) values (
          @id, @projectId, @sequence, @parentTaskId, @title, @lifecycle, @priority, @position,
          @notBefore, @dueAt, @size, @descriptionJson, @descriptionText, @expectedOutcome,
          @acceptanceCriteria, @agentContext, @checklistJson, @version, @archivedAt, @createdAt, @updatedAt
        )`,
      )
      .run({
        ...legacyResult,
        descriptionJson: JSON.stringify(legacyResult.description),
        checklistJson: JSON.stringify(legacyResult.checklist),
      });
    legacyDatabase
      .prepare(
        "insert into tags (id, project_id, name, description, color, exclusive_group, created_at, updated_at) values (?, ?, ?, ?, ?, ?, ?, ?)",
      )
      .run(
        "tag-alpha",
        "legacy-project",
        "alpha",
        "First tag",
        "#2563eb",
        "area",
        legacyResult.createdAt,
        legacyResult.createdAt,
      );
    legacyDatabase
      .prepare(
        "insert into tags (id, project_id, name, description, color, exclusive_group, created_at, updated_at) values (?, ?, ?, ?, ?, ?, ?, ?)",
      )
      .run(
        "tag-beta",
        "legacy-project",
        "beta",
        "Second tag",
        "#16a34a",
        "area",
        legacyResult.createdAt,
        legacyResult.createdAt,
      );
    legacyDatabase
      .prepare("insert into task_tags (task_id, tag_id) values (?, ?), (?, ?)")
      .run("legacy-task", "tag-alpha", "legacy-task", "tag-beta");

    const commandInput = { taskId: legacyResult.id, expectedVersion: 1 };
    const inputHash = createHash("sha256")
      .update(`task.complete:${JSON.stringify(commandInput)}`)
      .digest("hex");
    legacyDatabase
      .prepare(
        "insert into idempotency_records (key, command, input_hash, result_json, created_at) values (?, ?, ?, ?, ?)",
      )
      .run(
        "legacy-complete",
        "task.complete",
        inputHash,
        JSON.stringify(legacyResult),
        legacyResult.updatedAt,
      );
    legacyDatabase.close();

    const projectStore = createSqliteProjectStore(databasePath);
    const services = {
      store: createSqliteTaskStore(projectStore.database),
      clock: { today: () => "2026-09-03" },
    };
    try {
      const tasks = await Effect.runPromise(listTasks({ projectId: "legacy-project" }, services));
      const retry = await Effect.runPromise(
        completeTask(
          { ...commandInput, idempotencyKey: "legacy-complete" },
          { type: "human", id: "local-human" },
          services,
        ),
      );
      const repairEvents = projectStore.database
        .prepare<[], { kind: string; payload: string }>(
          "select kind, payload_json as payload from events order by cursor",
        )
        .all();

      expect(tasks[0]).toMatchObject({
        id: "legacy-task",
        notBefore: null,
        dueAt: null,
        version: 4,
        tags: [{ name: "alpha", exclusiveGroup: "area" }],
      });
      expect(retry).toMatchObject({
        id: "legacy-task",
        notBefore: null,
        dueAt: null,
        version: 2,
        referencedPaths: [],
      });
      expect(repairEvents.map((event) => event.kind)).toEqual([
        "task.tags.repaired",
        "task.dates.repaired",
      ]);
      expect(JSON.parse(repairEvents[0]!.payload)).toMatchObject({
        exclusiveGroup: "area",
        retainedTag: "alpha",
      });
    } finally {
      projectStore.close();
    }
  });

  it("reconciles pre-lease active attempts and installs one-active-owner constraints from 0005", () => {
    const root = temporaryDirectory("helm-lease-migration-fixture-");
    const databasePath = join(root, "helm.db");
    const previousMigrations = createPreviousMigrationFolder(migrationNamesThrough0005);
    const legacyDatabase = new Database(databasePath);
    legacyDatabase.pragma("foreign_keys = ON");
    migrate(drizzle(legacyDatabase), { migrationsFolder: previousMigrations });
    const createdAt = "2026-08-01T10:00:00.000Z";
    const legacyResult = legacyTaskResult();

    legacyDatabase
      .prepare(
        "insert into projects (id, sequence, name, repository_root, version, created_at, updated_at) values (?, ?, ?, ?, ?, ?, ?)",
      )
      .run("legacy-project", 1, "legacy", root, 1, createdAt, createdAt);
    legacyDatabase
      .prepare(
        `insert into tasks (
          id, project_id, sequence, parent_task_id, title, lifecycle, priority, position,
          not_before, due_at, size, description_json, description_text, expected_outcome,
          acceptance_criteria, agent_context, checklist_json, version, archived_at, created_at, updated_at
        ) values (
          @id, @projectId, @sequence, @parentTaskId, @title, @lifecycle, @priority, @position,
          @notBefore, @dueAt, @size, @descriptionJson, @descriptionText, @expectedOutcome,
          @acceptanceCriteria, @agentContext, @checklistJson, @version, @archivedAt, @createdAt, @updatedAt
        )`,
      )
      .run({
        ...legacyResult,
        notBefore: null,
        dueAt: null,
        descriptionJson: JSON.stringify(legacyResult.description),
        checklistJson: JSON.stringify(legacyResult.checklist),
      });
    legacyDatabase
      .prepare(
        "insert into agent_profiles (id, profile_key, display_name, capabilities_json, created_at, updated_at) values (?, ?, ?, ?, ?, ?)",
      )
      .run(
        "legacy-profile",
        "legacy-profile",
        "Legacy Agent",
        '["typescript"]',
        createdAt,
        createdAt,
      );
    legacyDatabase
      .prepare(
        "insert into agent_runs (id, profile_id, mcp_session_id, status, client_name, client_version, created_at, last_seen_at, ended_at) values (?, ?, ?, 'active', ?, ?, ?, ?, null)",
      )
      .run(
        "legacy-run",
        "legacy-profile",
        "legacy-session",
        "migration-test",
        "1.0.0",
        createdAt,
        createdAt,
      );
    legacyDatabase
      .prepare(
        "insert into attempts (id, task_id, agent_run_id, status, summary, verification_json, created_at, completed_at) values (?, ?, ?, 'active', ?, '[]', ?, null)",
      )
      .run("legacy-attempt-empty", "legacy-task", "legacy-run", "", createdAt);
    legacyDatabase
      .prepare(
        "insert into attempts (id, task_id, agent_run_id, status, summary, verification_json, created_at, completed_at) values (?, ?, ?, 'active', ?, '[]', ?, null)",
      )
      .run(
        "legacy-attempt-context",
        "legacy-task",
        "legacy-run",
        "Keep existing context.",
        createdAt,
      );
    legacyDatabase.close();

    const projectStore = createSqliteProjectStore(databasePath);
    try {
      const reconciledAttempts = projectStore.database
        .prepare<[], { id: string; status: string; summary: string; completedAt: string | null }>(
          "select id, status, summary, completed_at as completedAt from attempts order by id",
        )
        .all();
      const reconciliationEvents = projectStore.database
        .prepare<
          [],
          { kind: string; actorType: string; actorId: string; entityId: string; payload: string }
        >(
          "select kind, actor_type as actorType, actor_id as actorId, entity_id as entityId, payload_json as payload from events where kind = 'task.attempts.reconciled'",
        )
        .all();
      const leaseTable = projectStore.database
        .prepare("select count(*) from sqlite_master where type = 'table' and name = 'leases'")
        .pluck()
        .get();

      expect(reconciledAttempts).toEqual([
        {
          id: "legacy-attempt-context",
          status: "abandoned",
          summary: "Keep existing context.",
          completedAt: expect.any(String),
        },
        {
          id: "legacy-attempt-empty",
          status: "abandoned",
          summary: "Reconciled during lease migration.",
          completedAt: expect.any(String),
        },
      ]);
      expect(reconciliationEvents).toHaveLength(1);
      expect(reconciliationEvents[0]).toMatchObject({
        kind: "task.attempts.reconciled",
        actorType: "system",
        actorId: "helm-migration-0006",
        entityId: "legacy-task",
      });
      expect(JSON.parse(reconciliationEvents[0]!.payload)).toEqual({
        abandonedAttempts: 2,
        reason: "pre-lease active attempts cannot own work",
      });
      expect(leaseTable).toBe(1);

      projectStore.database
        .prepare(
          "insert into attempts (id, task_id, agent_run_id, status, summary, verification_json, created_at, completed_at) values (?, ?, ?, 'active', '', '[]', ?, null)",
        )
        .run("post-migration-active", "legacy-task", "legacy-run", createdAt);
      expect(() =>
        projectStore.database
          .prepare(
            "insert into attempts (id, task_id, agent_run_id, status, summary, verification_json, created_at, completed_at) values (?, ?, ?, 'active', '', '[]', ?, null)",
          )
          .run("post-migration-duplicate", "legacy-task", "legacy-run", createdAt),
      ).toThrow(/UNIQUE constraint failed/);

      projectStore.database
        .prepare(
          "insert into leases (id, task_id, attempt_id, agent_run_id, token_hash, status, acquired_at, expires_at, invalidated_at, invalidation_reason) values (?, ?, ?, ?, ?, 'active', ?, ?, null, null)",
        )
        .run(
          "post-migration-lease",
          "legacy-task",
          "post-migration-active",
          "legacy-run",
          "post-migration-token",
          createdAt,
          "2026-08-01T10:15:00.000Z",
        );
      expect(() =>
        projectStore.database
          .prepare(
            "insert into leases (id, task_id, attempt_id, agent_run_id, token_hash, status, acquired_at, expires_at, invalidated_at, invalidation_reason) values (?, ?, ?, ?, ?, 'active', ?, ?, null, null)",
          )
          .run(
            "post-migration-duplicate-lease",
            "legacy-task",
            "post-migration-active",
            "legacy-run",
            "post-migration-second-token",
            createdAt,
            "2026-08-01T10:15:00.000Z",
          ),
      ).toThrow(/UNIQUE constraint failed/);
    } finally {
      projectStore.close();
    }
  });
});
