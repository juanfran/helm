import { readFile, readdir, rm, writeFile, mkdtemp } from "node:fs/promises";
import { tmpdir } from "node:os";
import { basename, join } from "node:path";

import Database from "better-sqlite3";
import { afterEach, describe, expect, it } from "vitest";

import {
  createSqliteBackup,
  restoreSqliteBackupOffline,
  SqliteBackupAbortedError,
  SqliteBackupDestinationExistsError,
  SqliteRestoreTargetNotEmptyError,
} from "./sqlite-backup.server";
import { createSqliteProjectStore, type SqliteProjectStore } from "./sqlite-project-store.server";

const temporaryRoots: string[] = [];
const timestamp = "2026-09-04T12:00:00.000Z";

async function temporaryRoot() {
  const root = await mkdtemp(join(tmpdir(), "helm-sqlite-backup-"));
  temporaryRoots.push(root);
  return root;
}

afterEach(async () => {
  await Promise.all(
    temporaryRoots.splice(0).map((root) => rm(root, { recursive: true, force: true })),
  );
});

function seedCompleteGraph(store: SqliteProjectStore) {
  store.database.exec(`
    insert into projects (
      id, sequence, name, repository_root, review_mode, version, created_at, updated_at
    ) values (
      'project-1', 1, 'Backup project', '/tmp/backup-project', 'required', 3,
      '${timestamp}', '${timestamp}'
    );
    update preferences set active_project_id = 'project-1', active_project_version = 1;

    insert into saved_views (
      id, project_id, sequence, name, definition_version, definition_json, version,
      archived_at, created_at, updated_at
    ) values (
      'view-1', 'project-1', 1, 'Ready work', 1,
      '{"schemaVersion":1,"filter":{"schemaVersion":1,"projectId":"project-1"},"order":[{"field":"created_at","direction":"asc"}],"grouping":{"type":"none"},"visibleFields":["title"],"presentation":"list"}',
      1, null, '${timestamp}', '${timestamp}'
    );

    insert into custom_field_definitions (
      id, project_id, field_key, type, validation_json, default_value_json,
      display_label, description, position, retired_at, created_at, updated_at
    ) values (
      'field-1', 'project-1', 'risk', 'number', '{"min":0,"max":5,"integer":true}',
      '{"type":"number","value":2}', 'Risk', 'Delivery risk', 0, null,
      '${timestamp}', '${timestamp}'
    );

    insert into tasks (
      id, project_id, sequence, parent_task_id, title, lifecycle, priority, position,
      not_before, due_at, size, description_json, description_text, expected_outcome,
      acceptance_criteria, agent_context, checklist_json, review_mode_override,
      review_attempt_id, cancelled_from_lifecycle, version, archived_at, created_at, updated_at
    ) values
      (
        'task-parent', 'project-1', 1, null, 'Parent task', 'ready', 'high', 0,
        null, '2026-09-30', 'm', '{"version":1,"doc":{"type":"doc","content":[]}}', '',
        'Ship the backup', 'All bytes survive', 'Preserve history',
        '[{"id":"check-1","text":"Verify restore","checked":false}]', null,
        null, null, 2, null, '${timestamp}', '${timestamp}'
      ),
      (
        'task-child', 'project-1', 2, 'task-parent', 'Child task', 'in_progress', 'normal', 1,
        null, null, null, '{"version":1,"doc":{"type":"doc","content":[]}}', '',
        'Exercise WAL', 'Reads remain available', '',
        '[{"id":"check-2","text":"Read during backup","checked":false}]', 'direct',
        null, null, 4, null, '${timestamp}', '${timestamp}'
      );

    insert into task_custom_field_values (task_id, definition_id, value_json, updated_at)
      values ('task-parent', 'field-1', '{"type":"number","value":4}', '${timestamp}');
    insert into task_relations (
      id, project_id, source_task_id, target_task_id, type, created_at
    ) values ('relation-1', 'project-1', 'task-parent', 'task-child', 'related_to', '${timestamp}');
    insert into tags (
      id, project_id, name, description, color, exclusive_group, review_mode_override,
      created_at, updated_at
    ) values (
      'tag-1', 'project-1', 'backup', 'Backup work', '#2563eb', null, 'required',
      '${timestamp}', '${timestamp}'
    );
    insert into task_tags (task_id, tag_id) values ('task-parent', 'tag-1');
    insert into task_capability_requirements (task_id, capability)
      values ('task-parent', 'sqlite');
    insert into task_referenced_paths (task_id, path)
      values ('task-parent', 'src/infrastructure/sqlite-backup.server.ts');

    insert into agent_profiles (
      id, profile_key, display_name, capabilities_json, created_at, updated_at
    ) values (
      'profile-1', 'backup-agent', 'Backup agent', '["sqlite"]', '${timestamp}', '${timestamp}'
    );
    insert into agent_runs (
      id, profile_id, mcp_session_id, status, client_name, client_version,
      created_at, last_seen_at, ended_at
    ) values (
      'run-1', 'profile-1', 'session-1', 'active', 'backup-test', '1.0.0',
      '${timestamp}', '${timestamp}', null
    );
    insert into attempts (
      id, task_id, attempt_number, agent_run_id, agent_profile_id, agent_display_name,
      status, summary, changed_areas_json, verification_json, references_json,
      risks_json, follow_up_work_json, failure_classification, created_at, completed_at
    ) values (
      'attempt-1', 'task-child', 1, 'run-1', 'profile-1', 'Backup agent', 'active', '',
      '[]', '[]', '[]', '[]', '[]', null, '${timestamp}', null
    );
    insert into leases (
      id, task_id, attempt_id, agent_run_id, token_hash, status, acquired_at,
      expires_at, invalidated_at, invalidation_reason
    ) values (
      'lease-1', 'task-child', 'attempt-1', 'run-1', 'hashed-token', 'active',
      '${timestamp}', '2026-09-04T13:00:00.000Z', null, null
    );
    insert into activity_entries (
      id, project_id, task_id, attempt_id, kind, author_type, author_id,
      author_display_name, agent_profile_id, agent_run_id, content_json, content_text,
      created_at, withdrawn_at, withdrawn_by_type, withdrawn_by_id, withdrawal_reason
    ) values (
      'entry-1', 'project-1', 'task-child', 'attempt-1', 'progress', 'agent', 'run-1',
      'Backup agent', 'profile-1', 'run-1',
      '{"version":1,"doc":{"type":"doc","content":[]}}', 'Backing up',
      '${timestamp}', null, null, null, null
    );
    insert into manual_blockers (
      id, project_id, task_id, reason, status, created_by_type, created_by_id,
      created_at, resolved_by_type, resolved_by_id, resolved_at, resolution
    ) values (
      'blocker-1', 'project-1', 'task-parent', 'Wait for storage', 'resolved',
      'human', 'local-human', '${timestamp}', 'human', 'local-human', '${timestamp}', 'Ready'
    );
    insert into idempotency_records (key, command, input_hash, result_json, created_at)
      values ('request-1', 'task.create', 'hash-1', '{"id":"task-parent"}', '${timestamp}');

    insert into events (
      project_id, kind, importance, actor_type, actor_id, entity_type, entity_id,
      payload_json, changes_json, occurred_at
    ) values
      (
        'project-1', 'project.created', 'routine', 'human', 'local-human', 'project',
        'project-1', '{}', '{"projectIds":["project-1"],"taskIds":[],"activityEntryIds":[],"agentRunIds":[],"scopes":["projects"]}', '${timestamp}'
      ),
      (
        'project-1', 'task.created', 'routine', 'human', 'local-human', 'task',
        'task-parent', '{}', '{"projectIds":["project-1"],"taskIds":["task-parent"],"activityEntryIds":[],"agentRunIds":[],"scopes":["tasks"]}', '${timestamp}'
      ),
      (
        'project-1', 'temporary.event', 'routine', 'system', 'helm', 'task',
        'task-child', '{}', '{"projectIds":["project-1"],"taskIds":["task-child"],"activityEntryIds":[],"agentRunIds":[],"scopes":["tasks"]}', '${timestamp}'
      );
    delete from events where kind = 'temporary.event';

    create table backup_load (id integer primary key, payload text not null);
  `);

  const insertLoad = store.database.prepare("insert into backup_load (id, payload) values (?, ?)");
  store.database.transaction(() => {
    for (let index = 1; index <= 320; index += 1) {
      insertLoad.run(index, `${String(index).padStart(4, "0")}:${"x".repeat(8_192)}`);
    }
  })();
}

function quotedIdentifier(value: string) {
  return `"${value.replaceAll('"', '""')}"`;
}

function databaseSnapshot(database: Database.Database) {
  const tableNames = database
    .prepare<[], string>(
      "select name from sqlite_schema where type = 'table' and name not like 'sqlite_%' order by name",
    )
    .pluck()
    .all();
  return {
    tables: Object.fromEntries(
      tableNames.map((tableName) => [
        tableName,
        database
          .prepare(`select * from ${quotedIdentifier(tableName)}`)
          .all()
          .toSorted((left, right) => JSON.stringify(left).localeCompare(JSON.stringify(right))),
      ]),
    ),
    sqliteSequence: database.prepare("select * from sqlite_sequence order by name").all(),
  };
}

function openReadonly(path: string) {
  return new Database(path, { readonly: true, fileMustExist: true });
}

describe("SQLite backup and offline restoration", () => {
  it("keeps WAL reads and writes available and restores every row and event cursor exactly", async () => {
    const root = await temporaryRoot();
    const sourcePath = join(root, "source.sqlite");
    const backupPath = join(root, "backup.sqlite");
    const restoredPath = join(root, "restored.sqlite");
    const store = createSqliteProjectStore(sourcePath);
    seedCompleteGraph(store);
    expect(store.database.pragma("journal_mode", { simple: true })).toBe("wal");

    const reader = openReadonly(sourcePath);
    let progressReads = 0;
    let wroteDuringBackup = false;
    try {
      const result = await createSqliteBackup(store.database, backupPath, {
        pagesPerStep: 1,
        onProgress(progress) {
          expect(progress.remainingPages).toBeGreaterThan(0);
          expect(reader.prepare("select count(*) from tasks").pluck().get()).toBe(2);
          progressReads += 1;
          if (wroteDuringBackup) return;
          store.database
            .prepare(
              `insert into events (
                 project_id, kind, importance, actor_type, actor_id, entity_type, entity_id,
                 payload_json, changes_json, occurred_at
               ) values (?, ?, 'routine', 'human', 'local-human', 'project', ?, '{}', ?, ?)`,
            )
            .run(
              "project-1",
              "backup.concurrent_write",
              "project-1",
              '{"projectIds":["project-1"],"taskIds":[],"activityEntryIds":[],"agentRunIds":[],"scopes":["projects"]}',
              timestamp,
            );
          wroteDuringBackup = true;
          expect(reader.prepare("select count(*) from events").pluck().get()).toBe(3);
        },
      });
      expect(result).toEqual({ destinationPath: backupPath, totalPages: expect.any(Number) });
    } finally {
      reader.close();
    }

    expect(progressReads).toBeGreaterThan(1);
    expect(wroteDuringBackup).toBe(true);
    const sourceSnapshot = databaseSnapshot(store.database);
    expect(sourceSnapshot.sqliteSequence).toEqual(
      expect.arrayContaining([expect.objectContaining({ name: "events", seq: 4 })]),
    );

    const backupDatabase = openReadonly(backupPath);
    try {
      expect(backupDatabase.pragma("integrity_check", { simple: true })).toBe("ok");
      expect(databaseSnapshot(backupDatabase)).toEqual(sourceSnapshot);
    } finally {
      backupDatabase.close();
    }

    await restoreSqliteBackupOffline(backupPath, restoredPath);
    const restoredDatabase = new Database(restoredPath);
    try {
      expect(restoredDatabase.pragma("integrity_check", { simple: true })).toBe("ok");
      expect(databaseSnapshot(restoredDatabase)).toEqual(sourceSnapshot);
      const nextCursor = restoredDatabase
        .prepare(
          `insert into events (
             project_id, kind, importance, actor_type, actor_id, entity_type, entity_id,
             payload_json, changes_json, occurred_at
           ) values (?, ?, 'routine', 'system', 'helm', 'project', ?, '{}', ?, ?)
           returning cursor`,
        )
        .pluck()
        .get(
          "project-1",
          "restore.verified",
          "project-1",
          '{"projectIds":["project-1"],"taskIds":[],"activityEntryIds":[],"agentRunIds":[],"scopes":["projects"]}',
          timestamp,
        );
      expect(nextCursor).toBe(5);
    } finally {
      restoredDatabase.close();
      store.close();
    }
  });

  it("rejects every existing restore target and installs only at an absent path", async () => {
    const root = await temporaryRoot();
    const sourcePath = join(root, "source.sqlite");
    const backupPath = join(root, "backup.sqlite");
    const occupiedBackupPath = join(root, "occupied-backup.sqlite");
    const restorePath = join(root, "restored.sqlite");
    const store = createSqliteProjectStore(sourcePath);
    seedCompleteGraph(store);

    await writeFile(occupiedBackupPath, "");
    await expect(createSqliteBackup(store.database, occupiedBackupPath)).rejects.toBeInstanceOf(
      SqliteBackupDestinationExistsError,
    );
    expect(await readFile(occupiedBackupPath, "utf8")).toBe("");

    await createSqliteBackup(store.database, backupPath);
    await writeFile(restorePath, "do not replace");
    await expect(restoreSqliteBackupOffline(backupPath, restorePath)).rejects.toBeInstanceOf(
      SqliteRestoreTargetNotEmptyError,
    );
    expect(await readFile(restorePath, "utf8")).toBe("do not replace");

    await writeFile(restorePath, "");
    await expect(restoreSqliteBackupOffline(backupPath, restorePath)).rejects.toBeInstanceOf(
      SqliteRestoreTargetNotEmptyError,
    );
    expect(await readFile(restorePath, "utf8")).toBe("");

    await rm(restorePath);
    await restoreSqliteBackupOffline(backupPath, restorePath);
    const restored = openReadonly(restorePath);
    try {
      expect(restored.pragma("integrity_check", { simple: true })).toBe("ok");
      expect(databaseSnapshot(restored)).toEqual(databaseSnapshot(store.database));
    } finally {
      restored.close();
      store.close();
    }
  });

  it("restores committed rows that have not been checkpointed out of a WAL", async () => {
    const root = await temporaryRoot();
    const sourcePath = join(root, "live-source.sqlite");
    const restoredPath = join(root, "restored.sqlite");
    const source = new Database(sourcePath);
    source.pragma("journal_mode = WAL");
    source.pragma("wal_autocheckpoint = 0");
    source.exec("create table notes (value text not null)");
    source.pragma("wal_checkpoint(TRUNCATE)");
    source.prepare("insert into notes values (?)").run("committed in WAL");

    try {
      expect(source.prepare("select value from notes").pluck().get()).toBe("committed in WAL");

      await restoreSqliteBackupOffline(sourcePath, restoredPath);

      const restored = openReadonly(restoredPath);
      try {
        expect(restored.pragma("integrity_check", { simple: true })).toBe("ok");
        expect(restored.prepare("select value from notes").pluck().get()).toBe("committed in WAL");
      } finally {
        restored.close();
      }
    } finally {
      source.close();
    }
  });

  it("removes staging data and leaves no destination when an online backup is aborted", async () => {
    const root = await temporaryRoot();
    const sourcePath = join(root, "source.sqlite");
    const backupPath = join(root, "aborted.sqlite");
    const store = createSqliteProjectStore(sourcePath);
    seedCompleteGraph(store);
    const controller = new AbortController();

    await expect(
      createSqliteBackup(store.database, backupPath, {
        pagesPerStep: 1,
        signal: controller.signal,
        onProgress: () => controller.abort(),
      }),
    ).rejects.toBeInstanceOf(SqliteBackupAbortedError);

    const entries = await readdir(root);
    expect(entries).not.toContain(basename(backupPath));
    expect(entries.some((entry) => entry.includes("helm-backup"))).toBe(false);
    store.close();
  });
});
