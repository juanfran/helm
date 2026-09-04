import { createHash } from "node:crypto";
import { copyFileSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";

import Database from "better-sqlite3";
import { drizzle } from "drizzle-orm/better-sqlite3";
import { migrate } from "drizzle-orm/better-sqlite3/migrator";
import { Effect } from "effect";
import { afterEach, describe, expect, it } from "vitest";

import { listTaskAttempts, listTasks } from "../application/tasks";
import { emptyRichTextDocument, taskSchema } from "../domain/tasks";
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
const migrationNamesThrough0006 = [
  ...migrationNamesThrough0005,
  "0006_vengeful_mandroid.sql",
] as const;
const migrationNamesThrough0007 = [
  ...migrationNamesThrough0006,
  "0007_sturdy_gladiator.sql",
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
      const cachedResultJson = projectStore.database
        .prepare<[string], string>("select result_json from idempotency_records where key = ?")
        .pluck()
        .get("legacy-complete");
      const cachedTask = taskSchema.parse(JSON.parse(cachedResultJson ?? "null"));
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
      expect(cachedTask).toMatchObject({
        id: "legacy-task",
        notBefore: null,
        dueAt: null,
        version: 2,
        referencedPaths: [],
        reviewAttemptId: null,
        cancelledFromLifecycle: null,
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
    legacyDatabase
      .prepare(
        "insert into idempotency_records (key, command, input_hash, result_json, created_at) values (?, ?, ?, ?, ?)",
      )
      .run(
        "legacy-attempt-snapshot",
        "task.claim",
        "legacy-hash",
        JSON.stringify({ attempt: { id: "legacy-attempt-context" } }),
        createdAt,
      );
    legacyDatabase.close();

    const projectStore = createSqliteProjectStore(databasePath);
    try {
      const reconciledAttempts = projectStore.database
        .prepare<
          [],
          {
            id: string;
            attemptNumber: number;
            status: string;
            summary: string;
            completedAt: string | null;
          }
        >(
          "select id, attempt_number as attemptNumber, status, summary, completed_at as completedAt from attempts order by id",
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
          attemptNumber: 2,
          status: "abandoned",
          summary: "Keep existing context.",
          completedAt: expect.any(String),
        },
        {
          id: "legacy-attempt-empty",
          attemptNumber: 1,
          status: "abandoned",
          summary: "Reconciled during lease migration.",
          completedAt: expect.any(String),
        },
      ]);
      expect(reconciliationEvents).toHaveLength(1);
      expect(
        projectStore.database
          .prepare<[string], number>(
            "select json_extract(result_json, '$.attempt.attemptNumber') from idempotency_records where key = ?",
          )
          .pluck()
          .get("legacy-attempt-snapshot"),
      ).toBe(2);
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

  it("preserves event cursors and backfills normalized feed metadata from 0006", () => {
    const root = temporaryDirectory("helm-activity-migration-fixture-");
    const databasePath = join(root, "helm.db");
    const previousMigrations = createPreviousMigrationFolder(migrationNamesThrough0006);
    const legacyDatabase = new Database(databasePath);
    legacyDatabase.pragma("foreign_keys = ON");
    migrate(drizzle(legacyDatabase), { migrationsFolder: previousMigrations });
    const occurredAt = "2026-08-01T10:00:00.000Z";
    const legacyResult = legacyTaskResult();

    legacyDatabase
      .prepare(
        "insert into projects (id, sequence, name, repository_root, version, created_at, updated_at) values (?, ?, ?, ?, ?, ?, ?)",
      )
      .run("legacy-project", 1, "legacy", root, 1, occurredAt, occurredAt);
    legacyDatabase
      .prepare(
        `insert into tasks (
          id, project_id, sequence, parent_task_id, title, lifecycle, priority, position,
          not_before, due_at, size, description_json, description_text, expected_outcome,
          acceptance_criteria, agent_context, checklist_json, version, archived_at, created_at, updated_at
        ) values (
          @id, @projectId, @sequence, @parentTaskId, @title, @lifecycle, @priority, @position,
          null, null, @size, @descriptionJson, @descriptionText, @expectedOutcome,
          @acceptanceCriteria, @agentContext, @checklistJson, @version, @archivedAt, @createdAt, @updatedAt
        )`,
      )
      .run({
        ...legacyResult,
        descriptionJson: JSON.stringify(legacyResult.description),
        checklistJson: JSON.stringify(legacyResult.checklist),
      });
    const insertLegacyEvent = legacyDatabase.prepare(
      "insert into events (cursor, project_id, kind, actor_type, actor_id, entity_type, entity_id, payload_json, occurred_at) values (?, ?, ?, ?, ?, ?, ?, ?, ?)",
    );
    insertLegacyEvent.run(
      41,
      "legacy-project",
      "task.created",
      "human",
      "local-human",
      "task",
      "legacy-task",
      '{"version":1}',
      occurredAt,
    );
    insertLegacyEvent.run(
      42,
      "legacy-project",
      "task.lease.expired",
      "system",
      "helm",
      "task",
      "legacy-task",
      '{"version":2}',
      occurredAt,
    );
    legacyDatabase.close();

    const projectStore = createSqliteProjectStore(databasePath);
    try {
      const migratedEvents = projectStore.database
        .prepare<[], { cursor: number; kind: string; importance: string; changesJson: string }>(
          "select cursor, kind, importance, changes_json as changesJson from events order by cursor",
        )
        .all();
      expect(migratedEvents.map((event) => event.cursor)).toEqual([41, 42]);
      expect(migratedEvents.map((event) => event.importance)).toEqual(["routine", "attention"]);
      for (const event of migratedEvents) {
        expect(JSON.parse(event.changesJson)).toEqual({
          projectIds: ["legacy-project"],
          taskIds: ["legacy-task"],
          activityEntryIds: [],
          agentRunIds: [],
          scopes: ["tasks"],
        });
      }
      projectStore.database
        .prepare(
          "insert into events (project_id, kind, actor_type, actor_id, entity_type, entity_id, payload_json, occurred_at) values (?, ?, ?, ?, ?, ?, ?, ?)",
        )
        .run(
          "legacy-project",
          "migration.cursor.checked",
          "system",
          "helm",
          "task",
          "legacy-task",
          "{}",
          occurredAt,
        );
      expect(projectStore.database.prepare("select max(cursor) from events").pluck().get()).toBe(
        43,
      );
      expect(
        projectStore.database
          .prepare(
            "select count(*) from sqlite_master where type = 'table' and name in ('activity_entries', 'manual_blockers')",
          )
          .pluck()
          .get(),
      ).toBe(2);
    } finally {
      projectStore.close();
    }
  });

  it("adds review policy and preserves enriched attempt history from 0007", async () => {
    const root = temporaryDirectory("helm-result-migration-fixture-");
    const databasePath = join(root, "helm.db");
    const previousMigrations = createPreviousMigrationFolder(migrationNamesThrough0007);
    const legacyDatabase = new Database(databasePath);
    legacyDatabase.pragma("foreign_keys = ON");
    migrate(drizzle(legacyDatabase), { migrationsFolder: previousMigrations });
    const createdAt = "2026-08-01T10:00:00.000Z";
    const completedAt = "2026-08-01T10:30:00.000Z";
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
          null, null, @size, @descriptionJson, @descriptionText, @expectedOutcome,
          @acceptanceCriteria, @agentContext, @checklistJson, @version, @archivedAt, @createdAt, @updatedAt
        )`,
      )
      .run({
        ...legacyResult,
        lifecycle: "ready",
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
        "insert into agent_runs (id, profile_id, mcp_session_id, status, client_name, client_version, created_at, last_seen_at, ended_at) values (?, ?, ?, 'closed', ?, ?, ?, ?, ?)",
      )
      .run(
        "legacy-run",
        "legacy-profile",
        "legacy-session",
        "migration-test",
        "1.0.0",
        createdAt,
        completedAt,
        completedAt,
      );
    legacyDatabase
      .prepare(
        "insert into attempts (id, task_id, agent_run_id, status, summary, verification_json, created_at, completed_at) values (?, ?, ?, 'abandoned', ?, ?, ?, ?)",
      )
      .run(
        "legacy-attempt",
        "legacy-task",
        "legacy-run",
        "Legacy result",
        '["pnpm check"]',
        createdAt,
        completedAt,
      );
    legacyDatabase.close();

    const projectStore = createSqliteProjectStore(databasePath);
    const services = {
      store: createSqliteTaskStore(projectStore.database),
      clock: { today: () => "2026-09-03", now: () => "2026-09-03T12:00:00.000Z" },
    };
    try {
      const project = projectStore.database
        .prepare<[], { reviewMode: string }>(
          "select review_mode as reviewMode from projects where id = 'legacy-project'",
        )
        .get();
      const migratedTasks = await Effect.runPromise(
        listTasks({ projectId: "legacy-project" }, services),
      );
      const migratedAttempts = await Effect.runPromise(
        listTaskAttempts({ projectId: "legacy-project" }, services),
      );

      expect(project).toEqual({ reviewMode: "required" });
      expect(migratedTasks[0]).toMatchObject({
        id: "legacy-task",
        reviewAttemptId: null,
        cancelledFromLifecycle: null,
      });
      expect(migratedAttempts).toEqual([
        expect.objectContaining({
          id: "legacy-attempt",
          attemptNumber: 1,
          agentProfileId: "legacy-profile",
          agentDisplayName: "Legacy Agent",
          status: "abandoned",
          summary: "Legacy result",
          changedAreas: [],
          verificationResults: [
            {
              name: "pnpm check",
              status: "not_run",
              details: "Imported from a legacy verification note.",
            },
          ],
          references: [],
          risks: [],
          followUpWork: [],
          failureClassification: null,
        }),
      ]);
    } finally {
      projectStore.close();
    }
  });
});
