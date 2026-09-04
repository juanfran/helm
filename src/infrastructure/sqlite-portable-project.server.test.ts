import { createHash } from "node:crypto";
import { spawnSync } from "node:child_process";
import { mkdirSync, mkdtempSync, renameSync, rmSync, symlinkSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { afterEach, describe, expect, it } from "vitest";

import {
  InvalidPortabilityInputError,
  PortabilityConflictError,
  PortabilityIdempotencyConflictError,
  PortabilityPreviewStaleError,
  UnsupportedPortabilityVersionError,
} from "../application/portability-errors";
import {
  canonicalHelmProjectExportJson,
  helmProjectExportSchema,
  stablePortabilityJson,
  type ExecuteProjectImportInput,
  type HelmProjectExport,
  type PreviewProjectImportInput,
} from "../domain/portability";
import { createSqliteProjectStore, type SqliteProjectStore } from "./sqlite-project-store.server";
import {
  executeSqliteProjectImportInCurrentTransaction,
  exportSqliteProject,
  previewSqliteProjectImport,
} from "./sqlite-portable-project.server";

const sourceTime = "2026-09-04T10:00:00.000Z";
const exportTime = "2026-09-04T11:00:00.000Z";
const importTime = "2026-09-04T12:00:00.000Z";
const localHuman = { type: "human" as const, id: "local-human" };
const repositoryRoot = process.cwd();
const sqlRepositoryRoot = repositoryRoot.replaceAll("'", "''");
const stores: SqliteProjectStore[] = [];
const tempDirectories: string[] = [];

function field(value: unknown, key: string) {
  return typeof value === "object" && value !== null ? Reflect.get(value, key) : undefined;
}

function store() {
  const value = createSqliteProjectStore(":memory:");
  stores.push(value);
  return value;
}

afterEach(() => {
  for (const value of stores.splice(0)) value.close();
  for (const directory of tempDirectories.splice(0)) {
    rmSync(directory, { recursive: true, force: true });
  }
});

function tempDirectory(name: string) {
  const directory = mkdtempSync(join(tmpdir(), `helm-${name}-`));
  tempDirectories.push(directory);
  return directory;
}

function seedSource(value: SqliteProjectStore) {
  value.database.exec(`
    insert into projects (
      id, sequence, name, repository_root, review_mode, version, created_at, updated_at
    ) values (
      'project-1', 7, 'Portable project', '${sqlRepositoryRoot}', 'required', 3,
      '${sourceTime}', '${sourceTime}'
    );
    update preferences
       set active_project_id = 'project-1', active_project_version = 8,
           theme = 'dark', updated_at = '${sourceTime}'
     where id = 1;

    insert into tags (
      id, project_id, name, description, color, exclusive_group, review_mode_override,
      created_at, updated_at
    ) values (
      'tag-1', 'project-1', 'portable', 'Portable work', '#2563eb', null, 'required',
      '${sourceTime}', '${sourceTime}'
    );
    insert into custom_field_definitions (
      id, project_id, field_key, type, validation_json, default_value_json,
      display_label, description, position, retired_at, created_at, updated_at
    ) values (
      'field-1', 'project-1', 'risk', 'number',
      '{"min":0,"max":5,"integer":true}', '{"type":"number","value":2}',
      'Risk', 'Delivery risk', 0, null, '${sourceTime}', '${sourceTime}'
    );
    insert into saved_views (
      id, project_id, sequence, name, definition_version, definition_json, version,
      archived_at, created_at, updated_at
    ) values (
      'view-1', 'project-1', 1, 'Review queue', 0,
      '{"filter":{"schemaVersion":1,"projectId":"project-1"},"order":[{"field":"sequence","direction":"asc"},{"field":"id","direction":"asc"}],"grouping":{"type":"none"},"visibleFields":["title","priority"],"presentation":"list"}',
      2, null, '${sourceTime}', '${sourceTime}'
    );

    insert into tasks (
      id, project_id, sequence, parent_task_id, title, lifecycle, priority, position,
      not_before, due_at, size, description_json, description_text, expected_outcome,
      acceptance_criteria, agent_context, checklist_json, review_mode_override,
      review_attempt_id, cancelled_from_lifecycle, version, archived_at, created_at, updated_at
    ) values
      (
        'task-parent', 'project-1', 1, null, 'Review export', 'review', 'high', 0,
        null, '2026-09-30', 'm',
        '{"version":1,"doc":{"type":"doc","content":[{"type":"paragraph","content":[{"type":"text","text":"Parent description"}]}]}}',
        'Parent description', 'Keep project semantics', 'Round trip every section',
        'Portable context', '[{"id":"check-1","text":"Verify export","checked":true}]',
        null, 'attempt-review', null, 2, null, '${sourceTime}', '${sourceTime}'
      ),
      (
        'task-child', 'project-1', 2, 'task-parent', 'Active child', 'in_progress',
        'normal', 1, null, null, 's',
        '{"version":1,"doc":{"type":"doc","content":[]}}', '',
        'Do work', 'Report progress', '',
        '[{"id":"check-2","text":"Finish work","checked":false}]',
        'direct', null, null, 4, null, '${sourceTime}', '${sourceTime}'
      );
    insert into task_tags (task_id, tag_id) values ('task-parent', 'tag-1');
    insert into task_custom_field_values (task_id, definition_id, value_json, updated_at)
      values ('task-parent', 'field-1', '{"type":"number","value":4}', '${sourceTime}');
    insert into task_capability_requirements (task_id, capability)
      values ('task-parent', 'typescript');
    insert into task_referenced_paths (task_id, path)
      values ('task-parent', 'src/domain/portability.ts');
    insert into task_relations (
      id, project_id, source_task_id, target_task_id, type, created_at
    ) values (
      'relation-1', 'project-1', 'task-parent', 'task-child', 'related_to', '${sourceTime}'
    );

    insert into agent_profiles (
      id, profile_key, display_name, capabilities_json, created_at, updated_at
    ) values
      ('profile-1', 'codex', 'Coding agent', '["typescript"]', '${sourceTime}', '${sourceTime}'),
      ('profile-unused', 'unused', 'Unused agent', '[]', '${sourceTime}', '${sourceTime}');
    insert into agent_runs (
      id, profile_id, mcp_session_id, status, client_name, client_version,
      created_at, last_seen_at, ended_at
    ) values (
      'run-1', 'profile-1', 'source-session-secret', 'active', 'generic-agent', '1.0',
      '${sourceTime}', '${sourceTime}', null
    );
    insert into attempts (
      id, task_id, attempt_number, agent_run_id, agent_profile_id, agent_display_name,
      status, summary, changed_areas_json, verification_json, references_json,
      risks_json, follow_up_work_json, failure_classification, created_at, completed_at
    ) values
      (
        'attempt-review', 'task-parent', 1, 'run-1', 'profile-1', 'Coding agent',
        'completed', 'Ready for review', '["src/domain"]',
        '[{"name":"typecheck","status":"passed","details":"Passed"}]',
        '["issue-14"]', '[]', '[]', null, '${sourceTime}', '${sourceTime}'
      ),
      (
        'attempt-active', 'task-child', 1, 'run-1', 'profile-1', 'Coding agent',
        'active', '', '[]', '["legacy verification"]', '[]', '[]', '[]', null,
        '${sourceTime}', null
      );
    insert into leases (
      id, task_id, attempt_id, agent_run_id, token_hash, status, acquired_at,
      expires_at, invalidated_at, invalidation_reason
    ) values (
      'lease-1', 'task-child', 'attempt-active', 'run-1', 'lease-token-secret',
      'active', '${sourceTime}', '2026-09-04T13:00:00.000Z', null, null
    );
    insert into activity_entries (
      id, project_id, task_id, attempt_id, kind, author_type, author_id,
      author_display_name, agent_profile_id, agent_run_id, content_json, content_text,
      created_at, withdrawn_at, withdrawn_by_type, withdrawn_by_id, withdrawal_reason
    ) values (
      'entry-1', 'project-1', 'task-child', 'attempt-active', 'progress', 'agent',
      'run-1', 'Coding agent', 'profile-1', 'run-1',
      '{"version":1,"doc":{"type":"doc","content":[{"type":"paragraph","content":[{"type":"text","text":"Working"}]}]}}',
      'Working', '${sourceTime}', null, null, null, null
    );
    insert into manual_blockers (
      id, project_id, task_id, reason, status, created_by_type, created_by_id,
      created_at, resolved_by_type, resolved_by_id, resolved_at, resolution
    ) values (
      'blocker-1', 'project-1', 'task-parent', 'Wait for review', 'resolved',
      'human', 'local-human', '${sourceTime}', 'human', 'local-human',
      '${sourceTime}', 'Reviewed'
    );
    insert into idempotency_records (key, command, input_hash, result_json, created_at)
      values ('source-request-secret', 'task.create', 'hash', '{}', '${sourceTime}');

    insert into events (
      cursor, project_id, kind, importance, actor_type, actor_id, entity_type, entity_id,
      payload_json, changes_json, occurred_at
    ) values
      (
        41, 'project-1', 'project.created', 'routine', 'human', 'local-human',
        'project', 'project-1', '{"name":"Portable project"}',
        '{"projectIds":["project-1"],"taskIds":[],"activityEntryIds":[],"agentRunIds":[],"scopes":["projects"]}',
        '${sourceTime}'
      ),
      (
        43, 'project-1', 'task.progress.reported', 'routine', 'agent', 'run-1',
        'task', 'task-child', '{"message":"Working"}',
        '{"projectIds":["project-1"],"taskIds":["task-child"],"activityEntryIds":["entry-1"],"agentRunIds":["run-1"],"scopes":["tasks","activity"]}',
        '${sourceTime}'
      );
  `);
}

function exportedSource() {
  const source = store();
  seedSource(source);
  return exportSqliteProject(source.database, { projectId: "project-1" }, { now: exportTime });
}

function previewInput(
  artifact: HelmProjectExport,
  options: { targetProjectId?: string | null; repositoryRoot?: string } = {},
): PreviewProjectImportInput {
  return {
    source: {
      format: "json",
      content: canonicalHelmProjectExportJson(artifact),
    },
    targetProjectId: options.targetProjectId ?? null,
    ...(options.repositoryRoot === undefined
      ? { repositoryRoot }
      : { repositoryRoot: options.repositoryRoot }),
    reason: "Restore the portable project.",
  };
}

function executeInput(
  input: PreviewProjectImportInput,
  previewToken: string,
): ExecuteProjectImportInput {
  return {
    ...input,
    previewToken,
    idempotencyKey: "import-project-1",
  };
}

function existingProjectInput(artifact: HelmProjectExport): PreviewProjectImportInput {
  return {
    source: {
      format: "json",
      content: canonicalHelmProjectExportJson(artifact),
    },
    targetProjectId: artifact.project.id,
    reason: "Merge the portable project.",
  };
}

describe("SQLite semantic project portability", () => {
  it("exports a canonical, complete snapshot while omitting machine-local state", () => {
    const source = store();
    seedSource(source);

    const artifact = exportSqliteProject(
      source.database,
      { projectId: "project-1" },
      { now: exportTime },
    );

    expect(helmProjectExportSchema.parse(artifact)).toEqual(artifact);
    expect(artifact).toMatchObject({
      format: "helm-project-export",
      schemaVersion: 1,
      exportedAt: exportTime,
      project: { id: "project-1", sequence: 7, version: 3 },
    });
    expect(artifact.tags.map(({ id }) => id)).toEqual(["tag-1"]);
    expect(artifact.customFieldDefinitions.map(({ id }) => id)).toEqual(["field-1"]);
    expect(artifact.tasks.map(({ id }) => id)).toEqual(["task-parent", "task-child"]);
    expect(artifact.tasks[0]?.customFieldValues).toEqual([
      expect.objectContaining({
        fieldId: "field-1",
        value: { type: "number", value: 4 },
      }),
    ]);
    expect(artifact.tasks[1]?.customFieldValues).toEqual([]);
    expect(artifact.savedViews[0]?.definition.schemaVersion).toBe(1);
    expect(artifact.agentProfiles.map(({ id }) => id)).toEqual(["profile-1"]);
    expect(artifact.agentRuns).toEqual([
      expect.objectContaining({
        id: "run-1",
        sourceStatus: "active",
        status: "closed",
        endedAt: exportTime,
      }),
    ]);
    expect(
      artifact.attempts.find(({ id }) => id === "attempt-active")?.verificationResults,
    ).toEqual([
      {
        name: "legacy verification",
        status: "not_run",
        details: "Imported from a legacy verification note.",
      },
    ]);
    expect(artifact.sourceEvents.map(({ sourceCursor }) => sourceCursor)).toEqual([41, 43]);

    const serialized = canonicalHelmProjectExportJson(artifact);
    expect(serialized).not.toContain("source-session-secret");
    expect(serialized).not.toContain("lease-token-secret");
    expect(serialized).not.toContain("source-request-secret");
    expect(serialized).not.toContain('"leases"');
    expect(serialized).not.toContain('"preferences"');
    expect(serialized).not.toContain('"idempotencyRecords"');
    expect(serialized).not.toContain("profile-unused");
  });

  it("round trips an agent profile and run referenced only by source-event attribution", () => {
    const source = store();
    seedSource(source);
    source.database.exec(`
      insert into agent_runs (
        id, profile_id, mcp_session_id, status, client_name, client_version,
        created_at, last_seen_at, ended_at
      ) values (
        'run-event-only', 'profile-unused', 'event-only-secret', 'closed',
        'generic-agent', '1.1', '${sourceTime}', '${sourceTime}', '${sourceTime}'
      );
      insert into events (
        cursor, project_id, kind, importance, actor_type, actor_id, entity_type, entity_id,
        payload_json, changes_json, occurred_at
      ) values (
        45, 'project-1', 'task.observed', 'routine', 'agent', 'run-event-only',
        'task', 'task-parent', '{"observation":"event-only attribution"}',
        '{"projectIds":["project-1"],"taskIds":["task-parent"],"activityEntryIds":[],"agentRunIds":["run-event-only"],"savedViewIds":[],"scopes":["tasks","agents"]}',
        '${sourceTime}'
      );
    `);

    const artifact = exportSqliteProject(
      source.database,
      { projectId: "project-1" },
      { now: exportTime },
    );
    expect(artifact.agentProfiles.map(({ id }) => id)).toEqual(["profile-1", "profile-unused"]);
    expect(artifact.agentRuns.map(({ id }) => id)).toEqual(["run-1", "run-event-only"]);
    expect(artifact.sourceEvents.find(({ sourceCursor }) => sourceCursor === 45)).toMatchObject({
      actor: { type: "agent", id: "run-event-only" },
      changes: { agentRunIds: ["run-event-only"] },
    });

    const target = store();
    const input = previewInput(artifact);
    const preview = previewSqliteProjectImport(target.database, input, localHuman, {
      now: importTime,
    });
    target.database
      .transaction(() =>
        executeSqliteProjectImportInCurrentTransaction(
          target.database,
          executeInput(input, preview.previewToken),
          localHuman,
          { now: importTime },
        ),
      )
      .immediate();
    const reExport = exportSqliteProject(
      target.database,
      { projectId: "project-1" },
      { now: importTime },
    );

    expect(reExport.agentProfiles.map(({ id }) => id)).toEqual(["profile-1", "profile-unused"]);
    expect(reExport.agentRuns.map(({ id }) => id)).toEqual(["run-1", "run-event-only"]);
    const provenanceBatch = reExport.sourceEvents.find(
      ({ kind }) => kind === "project.import.source_events_batch",
    );
    expect(field(provenanceBatch?.payload, "sourceEvents")).toEqual(artifact.sourceEvents);
  });

  it("rejects an export whose source-event collection exceeds the import record bound", () => {
    const source = store();
    seedSource(source);
    source.database.exec(`
        with recursive generated(value) as (
          select 1
          union all
          select value + 1 from generated where value < 99999
        )
        insert into events (
          project_id, kind, importance, actor_type, actor_id, entity_type, entity_id,
          payload_json, changes_json, occurred_at
        )
        select
          'project-1', 'project.snapshot.observed', 'routine', 'system', 'helm',
          'project', 'project-1', '{}',
          '{"projectIds":["project-1"],"taskIds":[],"activityEntryIds":[],"agentRunIds":[],"savedViewIds":[],"scopes":["projects"]}',
          '${sourceTime}'
        from generated;
      `);

    let failure: unknown;
    try {
      exportSqliteProject(source.database, { projectId: "project-1" }, { now: exportTime });
    } catch (error) {
      failure = error;
    }
    expect(failure).toBeInstanceOf(InvalidPortabilityInputError);
    expect(failure).toMatchObject({
      message: "The project exceeds Helm's portable JSON export limits.",
      issues: ["sourceEvents may contain at most 100000 records."],
    });
  }, 30_000);

  it("rejects a canonical export that would exceed the import byte bound", () => {
    const source = store();
    seedSource(source);
    source.database
      .prepare(
        `update events
              set payload_json = json_object('value', printf('%.*c', ?, 'x'))
            where cursor = 41`,
      )
      .run(64 * 1024 * 1024);

    let failure: unknown;
    try {
      exportSqliteProject(source.database, { projectId: "project-1" }, { now: exportTime });
    } catch (error) {
      failure = error;
    }
    expect(failure).toBeInstanceOf(InvalidPortabilityInputError);
    expect(failure).toMatchObject({
      message: "The project exceeds Helm's portable JSON export limits.",
      issues: [
        "Portable JSON may contain at most 67108864 bytes including the download's trailing newline.",
      ],
    });
  }, 30_000);

  it("round trips the full graph with fresh provenance events and inert execution state", () => {
    const artifact = exportedSource();
    const target = store();
    const input = previewInput(artifact);
    const preview = previewSqliteProjectImport(target.database, input, localHuman, {
      now: importTime,
    });

    expect(preview.executable).toBe(true);
    expect(preview.previewToken).toMatch(/^hip1:[a-f0-9]{64}:[a-f0-9]{64}$/);
    expect(preview.creates).toHaveLength(13);
    const result = target.database
      .transaction(() =>
        executeSqliteProjectImportInCurrentTransaction(
          target.database,
          executeInput(input, preview.previewToken),
          localHuman,
          { now: importTime },
        ),
      )
      .immediate();

    expect(result.executed).toBe(true);
    expect(result.operationId).not.toBeNull();
    expect(result.eventCursors).toHaveLength(5);
    expect(result.eventCursors).not.toEqual([41, 43]);
    expect(
      target.database
        .prepare("select lifecycle, version, updated_at as updatedAt from tasks where id = ?")
        .get("task-child"),
    ).toEqual({ lifecycle: "ready", version: 5, updatedAt: importTime });
    expect(
      target.database
        .prepare("select status, completed_at as completedAt from attempts where id = ?")
        .get("attempt-active"),
    ).toEqual({ status: "abandoned", completedAt: importTime });
    expect(
      target.database
        .prepare(
          "select status, mcp_session_id as mcpSessionId, ended_at as endedAt from agent_runs where id = ?",
        )
        .get("run-1"),
    ).toMatchObject({
      status: "closed",
      mcpSessionId: expect.stringMatching(/^portable-import:/),
      endedAt: importTime,
    });
    expect(target.database.prepare("select count(*) from leases").pluck().get()).toBe(0);
    expect(
      target.database.prepare("select key, command from idempotency_records order by key").all(),
    ).toEqual([{ key: "import-project-1", command: "project.import.execute" }]);
    expect(
      target.database
        .prepare("select active_project_id as activeProjectId, theme from preferences where id = 1")
        .get(),
    ).toEqual({ activeProjectId: "project-1", theme: "system" });

    const importedEvents = target.database
      .prepare(
        `select cursor, kind, actor_type as actorType, actor_id as actorId,
                payload_json as payloadJson, changes_json as changesJson
           from events order by cursor`,
      )
      .all();
    expect(importedEvents).toHaveLength(5);
    expect(importedEvents.map((row) => field(row, "cursor"))).not.toEqual(
      expect.arrayContaining([41, 43]),
    );
    expect(importedEvents).toEqual(
      expect.arrayContaining([
        expect.objectContaining({
          kind: "project.imported",
          actorType: "human",
          actorId: "local-human",
        }),
        expect.objectContaining({ kind: "project.import.entities_batch" }),
        expect.objectContaining({ kind: "project.import.source_events_batch" }),
        expect.objectContaining({ kind: "project.import.tasks_batch" }),
        expect.objectContaining({ kind: "project.import.activity_batch" }),
      ]),
    );
    for (const row of importedEvents) {
      const payload = JSON.parse(String(field(row, "payloadJson")));
      expect(payload.sourceProvenance).toMatchObject({
        projectId: "project-1",
        eventCount: 2,
        firstCursor: 41,
        lastCursor: 43,
        eventDigest: createHash("sha256")
          .update(stablePortabilityJson(artifact.sourceEvents))
          .digest("hex"),
      });
    }
    const taskBatch = importedEvents.find(
      (row) => field(row, "kind") === "project.import.tasks_batch",
    );
    const taskChanges = JSON.parse(String(field(taskBatch, "changesJson")));
    expect(taskChanges.taskIds).toEqual(["task-child", "task-parent"]);
    expect(taskChanges.taskIds).toHaveLength(2);
    const entityBatch = importedEvents.find(
      (row) => field(row, "kind") === "project.import.entities_batch",
    );
    const entityOperations = field(
      JSON.parse(String(field(entityBatch, "payloadJson"))),
      "operations",
    );
    expect(entityOperations).toEqual(
      expect.arrayContaining([
        expect.objectContaining({
          operation: "create",
          entityType: "project",
          sourceId: "project-1",
          previousVersion: null,
          newVersion: 3,
          changedFields: ["created"],
        }),
        expect.objectContaining({
          operation: "create",
          entityType: "task",
          sourceId: "task-child",
          previousVersion: null,
          newVersion: 5,
          changedFields: ["created"],
        }),
      ]),
    );

    const reExport = exportSqliteProject(
      target.database,
      { projectId: "project-1" },
      { now: importTime },
    );
    expect(reExport.project.repositoryRoot).toBe(repositoryRoot);
    expect(reExport.tags).toEqual(artifact.tags);
    expect(reExport.customFieldDefinitions).toEqual(artifact.customFieldDefinitions);
    expect(reExport.savedViews).toEqual(artifact.savedViews);
    expect(reExport.activityEntries).toEqual(artifact.activityEntries);
    expect(reExport.manualBlockers).toEqual(artifact.manualBlockers);
    const reExportedProvenance = reExport.sourceEvents.find(
      ({ kind }) => kind === "project.import.source_events_batch",
    );
    expect(field(reExportedProvenance?.payload, "sourceEvents")).toEqual(artifact.sourceEvents);
  });

  it("audits semantic no-ops and returns the cached result before stale checks", () => {
    const target = store();
    seedSource(target);
    const importingHuman = { type: "human" as const, id: "human-42" };
    const artifact = exportSqliteProject(
      target.database,
      { projectId: "project-1" },
      { now: exportTime },
    );
    const input: PreviewProjectImportInput = {
      source: {
        format: "json",
        content: canonicalHelmProjectExportJson(artifact),
      },
      targetProjectId: "project-1",
      reason: "Verify the existing project.",
    };
    const preview = previewSqliteProjectImport(target.database, input, importingHuman, {
      now: importTime,
    });

    expect(preview).toMatchObject({
      executable: true,
      creates: [],
      conflicts: [],
    });
    expect(preview.noOps).toHaveLength(13);
    const execution = executeInput(input, preview.previewToken);
    const result = target.database
      .transaction(() =>
        executeSqliteProjectImportInCurrentTransaction(target.database, execution, importingHuman, {
          now: importTime,
        }),
      )
      .immediate();

    expect(result.executed).toBe(true);
    expect(result.operationId).not.toBeNull();
    expect(result.eventCursors).toHaveLength(2);
    expect(
      target.database
        .prepare("select actor_id as actorId from events order by cursor desc limit 1")
        .get(),
    ).toEqual({ actorId: "human-42" });
    const eventCount = target.database.prepare("select count(*) from events").pluck().get();
    const cached = target.database
      .transaction(() =>
        executeSqliteProjectImportInCurrentTransaction(target.database, execution, importingHuman, {
          now: "2026-09-05T00:00:00.000Z",
        }),
      )
      .immediate();
    expect(cached).toEqual(result);
    expect(target.database.prepare("select count(*) from events").pluck().get()).toBe(eventCount);
    expect(target.database.prepare("select count(*) from idempotency_records").pluck().get()).toBe(
      2,
    );

    expect(() =>
      target.database
        .transaction(() =>
          executeSqliteProjectImportInCurrentTransaction(
            target.database,
            { ...execution, reason: "Reuse the key for another request." },
            importingHuman,
            { now: importTime },
          ),
        )
        .immediate(),
    ).toThrow(PortabilityIdempotencyConflictError);
  });

  it("treats a null target as create-only when the source project identity already exists", () => {
    const target = store();
    seedSource(target);
    const source = exportSqliteProject(
      target.database,
      { projectId: "project-1" },
      { now: exportTime },
    );
    const artifact = helmProjectExportSchema.parse({
      ...source,
      project: { ...source.project, name: "Must not merge implicitly" },
    });
    const input = previewInput(artifact);
    const preview = previewSqliteProjectImport(target.database, input, localHuman, {
      now: importTime,
    });

    expect(preview.executable).toBe(false);
    expect(preview.conflicts).toContainEqual(
      expect.objectContaining({
        code: "duplicate_identity",
        entityType: "project",
        sourceId: "project-1",
        path: ["project", "id"],
        message:
          "New-project import cannot reuse existing project identity project-1. Choose the existing project explicitly to merge.",
      }),
    );
    expect(preview.updates).not.toContainEqual(
      expect.objectContaining({ entityType: "project", sourceId: "project-1" }),
    );
    expect(preview.noOps).not.toContainEqual(
      expect.objectContaining({ entityType: "project", sourceId: "project-1" }),
    );
    const eventCount = target.database.prepare("select count(*) from events").pluck().get();
    expect(() =>
      target.database
        .transaction(() =>
          executeSqliteProjectImportInCurrentTransaction(
            target.database,
            executeInput(input, preview.previewToken),
            localHuman,
            { now: importTime },
          ),
        )
        .immediate(),
    ).toThrow(PortabilityConflictError);
    expect(
      target.database.prepare("select name, version from projects where id = 'project-1'").get(),
    ).toEqual({ name: "Portable project", version: 3 });
    expect(target.database.prepare("select count(*) from events").pluck().get()).toBe(eventCount);
  });

  it("updates mutable versioned records by expected version and reconciles task assignments", () => {
    const target = store();
    seedSource(target);
    const source = exportSqliteProject(
      target.database,
      { projectId: "project-1" },
      { now: exportTime },
    );
    const artifact = helmProjectExportSchema.parse({
      ...source,
      project: { ...source.project, name: "Renamed portable project" },
      tasks: source.tasks.map((task) =>
        task.id === "task-parent"
          ? {
              ...task,
              title: "Updated review export",
              tagIds: [],
              customFieldValues: [],
              requiredCapabilities: [],
              referencedPaths: [],
            }
          : task,
      ),
      savedViews: source.savedViews.map((view) =>
        Object.assign({}, view, { name: "Updated review queue" }),
      ),
    });
    const input = existingProjectInput(artifact);
    const preview = previewSqliteProjectImport(target.database, input, localHuman, {
      now: importTime,
    });

    expect(preview.executable).toBe(true);
    expect(preview.updates).toEqual(
      expect.arrayContaining([
        expect.objectContaining({
          entityType: "project",
          sourceId: "project-1",
        }),
        expect.objectContaining({
          entityType: "task",
          sourceId: "task-parent",
        }),
        expect.objectContaining({
          entityType: "saved_view",
          sourceId: "view-1",
        }),
      ]),
    );
    const result = target.database
      .transaction(() =>
        executeSqliteProjectImportInCurrentTransaction(
          target.database,
          executeInput(input, preview.previewToken),
          localHuman,
          { now: importTime },
        ),
      )
      .immediate();

    expect(
      target.database
        .prepare("select name, version, updated_at as updatedAt from projects where id = ?")
        .get("project-1"),
    ).toEqual({
      name: "Renamed portable project",
      version: 4,
      updatedAt: importTime,
    });
    expect(
      target.database
        .prepare("select title, version, updated_at as updatedAt from tasks where id = ?")
        .get("task-parent"),
    ).toEqual({
      title: "Updated review export",
      version: 3,
      updatedAt: importTime,
    });
    expect(
      target.database
        .prepare("select name, version, updated_at as updatedAt from saved_views where id = ?")
        .get("view-1"),
    ).toEqual({
      name: "Updated review queue",
      version: 3,
      updatedAt: importTime,
    });
    for (const table of [
      "task_tags",
      "task_custom_field_values",
      "task_capability_requirements",
      "task_referenced_paths",
    ]) {
      expect(
        target.database
          .prepare(`select count(*) from ${table} where task_id = ?`)
          .pluck()
          .get("task-parent"),
      ).toBe(0);
    }
    const operationEvent = target.database
      .prepare(
        `select payload_json as payloadJson
           from events
          where cursor in (${result.eventCursors.map(() => "?").join(",")})
            and kind = 'project.import.entities_batch'`,
      )
      .get(...result.eventCursors);
    expect(field(JSON.parse(String(field(operationEvent, "payloadJson"))), "operations")).toEqual(
      expect.arrayContaining([
        expect.objectContaining({
          entityType: "project",
          operation: "update",
          previousVersion: 3,
          newVersion: 4,
          changedFields: ["name"],
        }),
        expect.objectContaining({
          entityType: "task",
          sourceId: "task-parent",
          previousVersion: 2,
          newVersion: 3,
          changedFields: [
            "customFieldValues",
            "referencedPaths",
            "requiredCapabilities",
            "tagIds",
            "title",
          ],
        }),
        expect.objectContaining({
          entityType: "saved_view",
          previousVersion: 2,
          newVersion: 3,
          changedFields: ["name"],
        }),
      ]),
    );
  });

  it("rejects stale, future, immutable, and active-target versioned updates", () => {
    const target = store();
    seedSource(target);
    const source = exportSqliteProject(
      target.database,
      { projectId: "project-1" },
      { now: exportTime },
    );

    for (const version of [2, 4]) {
      const artifact = helmProjectExportSchema.parse({
        ...source,
        project: { ...source.project, name: `Version ${version}`, version },
      });
      const preview = previewSqliteProjectImport(
        target.database,
        existingProjectInput(artifact),
        localHuman,
        { now: importTime },
      );
      expect(preview.executable).toBe(false);
      expect(preview.conflicts).toContainEqual(
        expect.objectContaining({
          code: "version_conflict",
          entityType: "project",
        }),
      );
    }

    const immutable = helmProjectExportSchema.parse({
      ...source,
      tasks: source.tasks.map((task) =>
        task.id === "task-parent" ? Object.assign({}, task, { sequence: 99 }) : task,
      ),
    });
    expect(
      previewSqliteProjectImport(target.database, existingProjectInput(immutable), localHuman, {
        now: importTime,
      }).conflicts,
    ).toContainEqual(
      expect.objectContaining({
        code: "immutable_mismatch",
        entityType: "task",
      }),
    );

    const active = helmProjectExportSchema.parse({
      ...source,
      tasks: source.tasks.map((task) =>
        task.id === "task-child"
          ? Object.assign({}, task, { title: "Overwrite active work" })
          : task,
      ),
    });
    expect(
      previewSqliteProjectImport(target.database, existingProjectInput(active), localHuman, {
        now: importTime,
      }).conflicts,
    ).toContainEqual(
      expect.objectContaining({
        code: "active_execution_conflict",
        sourceId: "task-child",
      }),
    );
  });

  it("previews unknown top-level and nested strict fields as unsupported", () => {
    const artifact = exportedSource();
    const decoded: unknown = JSON.parse(canonicalHelmProjectExportJson(artifact));
    if (typeof decoded !== "object" || decoded === null) throw new Error("Expected object export.");
    Reflect.set(decoded, "futureSection", true);
    const decodedTasks = Reflect.get(decoded, "tasks");
    if (!Array.isArray(decodedTasks)) throw new Error("Expected task array.");
    const checklist = field(decodedTasks[0], "checklist");
    if (!Array.isArray(checklist) || typeof checklist[0] !== "object" || checklist[0] === null) {
      throw new Error("Expected checklist item.");
    }
    Reflect.set(checklist[0], "futureFlag", true);
    const target = store();
    const preview = previewSqliteProjectImport(
      target.database,
      {
        source: { format: "json", content: JSON.stringify(decoded) },
        targetProjectId: null,
        repositoryRoot,
        reason: "Preview future fields.",
      },
      localHuman,
      { now: importTime },
    );

    expect(preview.executable).toBe(false);
    expect(preview.unsupported).toEqual(
      expect.arrayContaining([
        expect.objectContaining({
          code: "unknown_field",
          path: ["futureSection"],
        }),
        expect.objectContaining({
          code: "unknown_field",
          entityType: "task",
          sourceId: "task-parent",
          path: ["tasks", 0, "checklist", 0, "futureFlag"],
        }),
      ]),
    );
  });

  it("blocks escaping and broken-symlink referenced paths without exposing host roots", () => {
    const artifact = exportedSource();
    const destination = tempDirectory("portable-destination");
    const outside = tempDirectory("portable-outside");
    symlinkSync(outside, join(destination, "escape"), "dir");
    symlinkSync(join(destination, "missing-target"), join(destination, "broken"), "dir");
    const unsafe = helmProjectExportSchema.parse({
      ...artifact,
      tasks: artifact.tasks.map((task) =>
        task.id === "task-parent"
          ? Object.assign({}, task, { referencedPaths: ["escape/private.ts"] })
          : Object.assign({}, task, { referencedPaths: ["broken/future.ts"] }),
      ),
    });

    const preview = previewSqliteProjectImport(
      store().database,
      previewInput(unsafe, { repositoryRoot: destination }),
      localHuman,
      { now: importTime },
    );
    const pathConflicts = preview.conflicts.filter(({ code }) => code === "invalid_path");

    expect(preview.executable).toBe(false);
    expect(pathConflicts).toEqual([
      expect.objectContaining({
        sourceId: "task-parent",
        message: "Task task-parent has an invalid referenced path (symlink-escape).",
        path: ["tasks", "task-parent", "referencedPaths", 0],
      }),
      expect.objectContaining({
        sourceId: "task-child",
        message: "Task task-child has an invalid referenced path (broken-symlink).",
        path: ["tasks", "task-child", "referencedPaths", 0],
      }),
    ]);
    expect(JSON.stringify(pathConflicts)).not.toContain(destination);
    expect(JSON.stringify(pathConflicts)).not.toContain(outside);
  });

  it("revalidates referenced paths during execution before writing the import graph", () => {
    const artifact = exportedSource();
    const destination = tempDirectory("portable-swap-destination");
    const outside = tempDirectory("portable-swap-outside");
    const withFuturePath = helmProjectExportSchema.parse({
      ...artifact,
      tasks: artifact.tasks.map((task) =>
        task.id === "task-parent"
          ? Object.assign({}, task, { referencedPaths: ["future/file.ts"] })
          : task,
      ),
    });
    const target = store();
    const input = previewInput(withFuturePath, { repositoryRoot: destination });
    const preview = previewSqliteProjectImport(target.database, input, localHuman, {
      now: importTime,
    });
    expect(preview.executable).toBe(true);

    symlinkSync(outside, join(destination, "future"), "dir");
    let executionError: unknown;
    try {
      target.database
        .transaction(() =>
          executeSqliteProjectImportInCurrentTransaction(
            target.database,
            executeInput(input, preview.previewToken),
            localHuman,
            { now: importTime },
          ),
        )
        .immediate();
    } catch (error) {
      executionError = error;
    }

    expect(executionError).toBeInstanceOf(PortabilityConflictError);
    if (!(executionError instanceof PortabilityConflictError)) {
      throw executionError;
    }
    expect(executionError.conflicts).toContainEqual(
      expect.objectContaining({
        code: "invalid_path",
        sourceId: "task-parent",
      }),
    );
    expect(target.database.prepare("select count(*) from projects").pluck().get()).toBe(0);
    expect(target.database.prepare("select count(*) from events").pluck().get()).toBe(0);
  });

  it("rejects an existing-project import when its repository root changes identity", () => {
    const container = tempDirectory("portable-root-swap");
    const registeredRoot = join(container, "repository");
    const movedRoot = join(container, "repository-before-swap");
    const outside = join(container, "outside");
    mkdirSync(registeredRoot);
    mkdirSync(outside);
    writeFileSync(join(outside, "private.txt"), "outside\n");

    const target = store();
    seedSource(target);
    target.database
      .prepare("update projects set repository_root = ? where id = 'project-1'")
      .run(registeredRoot);
    const source = exportSqliteProject(
      target.database,
      { projectId: "project-1" },
      { now: exportTime },
    );
    const artifact = helmProjectExportSchema.parse({
      ...source,
      tasks: source.tasks.map((task) =>
        task.id === "task-parent"
          ? Object.assign({}, task, { referencedPaths: ["private.txt"] })
          : task,
      ),
    });
    const input = existingProjectInput(artifact);
    const preview = previewSqliteProjectImport(target.database, input, localHuman, {
      now: importTime,
    });
    expect(preview.executable).toBe(true);

    const eventCount = target.database.prepare("select count(*) from events").pluck().get();
    const idempotencyCount = target.database
      .prepare("select count(*) from idempotency_records")
      .pluck()
      .get();
    const referencesBefore = target.database
      .prepare("select task_id as taskId, path from task_referenced_paths order by task_id, path")
      .all();
    renameSync(registeredRoot, movedRoot);
    symlinkSync(outside, registeredRoot, "dir");

    expect(() =>
      target.database
        .transaction(() =>
          executeSqliteProjectImportInCurrentTransaction(
            target.database,
            executeInput(input, preview.previewToken),
            localHuman,
            { now: importTime },
          ),
        )
        .immediate(),
    ).toThrow(PortabilityPreviewStaleError);
    expect(target.database.prepare("select count(*) from events").pluck().get()).toBe(eventCount);
    expect(target.database.prepare("select count(*) from idempotency_records").pluck().get()).toBe(
      idempotencyCount,
    );
    expect(
      target.database
        .prepare("select task_id as taskId, path from task_referenced_paths order by task_id, path")
        .all(),
    ).toEqual(referencesBefore);
    const swappedPreview = previewSqliteProjectImport(target.database, input, localHuman, {
      now: importTime,
    });
    expect(swappedPreview.executable).toBe(false);
    expect(swappedPreview.conflicts).toContainEqual(
      expect.objectContaining({
        code: "repository_conflict",
        entityType: "project",
        sourceId: "project-1",
      }),
    );
    expect(JSON.stringify(swappedPreview.conflicts)).not.toContain(registeredRoot);
    expect(JSON.stringify(swappedPreview.conflicts)).not.toContain(outside);
  });

  it("rejects a diagnostic-flood archive within a 256 MiB heap", () => {
    const script = String.raw`
      import Database from "better-sqlite3";
      import { previewSqliteProjectImport } from "./src/infrastructure/sqlite-portable-project.server.ts";

      const occurredAt = "2026-09-04T12:00:00.000Z";
      const content = JSON.stringify({
        format: "helm-project-export",
        schemaVersion: 1,
        exportedAt: occurredAt,
        project: {
          id: "project-1",
          sequence: 1,
          name: "Bounded validation",
          repositoryRoot: process.cwd(),
          reviewMode: "required",
          version: 1,
          createdAt: occurredAt,
          updatedAt: occurredAt,
        },
        tags: [],
        customFieldDefinitions: [],
        tasks: Array.from({ length: 30_000 }, () => ({})),
        relations: [],
        savedViews: [],
        agentProfiles: [],
        agentRuns: [],
        attempts: [],
        activityEntries: [],
        manualBlockers: [],
        sourceEvents: [],
      });
      const database = new Database(":memory:");
      try {
        previewSqliteProjectImport(
          database,
          {
            source: { format: "json", content },
            targetProjectId: null,
            repositoryRoot: process.cwd(),
            reason: "Exercise bounded structural validation.",
          },
          { type: "human", id: "local-human" },
          { now: occurredAt },
        );
        process.exitCode = 2;
      } catch (error) {
        const value = error && typeof error === "object" ? error : {};
        process.stdout.write(JSON.stringify({
          tag: Reflect.get(value, "_tag"),
          issues: Reflect.get(value, "issues"),
        }));
      } finally {
        database.close();
      }
    `;
    const result = spawnSync(
      process.execPath,
      ["--max-old-space-size=256", "--import", "tsx", "--input-type=module", "--eval", script],
      { cwd: process.cwd(), encoding: "utf8", timeout: 15_000 },
    );

    expect(result.signal).toBeNull();
    expect(result.status, result.stderr).toBe(0);
    expect(JSON.parse(result.stdout)).toEqual({
      tag: "InvalidPortabilityInputError",
      issues: ["tasks[0] is not a valid portable task record."],
    });
  }, 20_000);

  it("rejects unsupported versions, malformed graphs, and oversized top-level collections early", () => {
    const artifact = exportedSource();
    const target = store();
    const versionInput = previewInput(artifact);
    versionInput.source = {
      format: "json",
      content: JSON.stringify({ ...artifact, schemaVersion: 2 }),
    };
    expect(() =>
      previewSqliteProjectImport(target.database, versionInput, localHuman, {
        now: importTime,
      }),
    ).toThrow(UnsupportedPortabilityVersionError);

    const brokenGraph = {
      ...artifact,
      tasks: artifact.tasks.map((task) =>
        task.id === "task-parent"
          ? Object.assign({}, task, { reviewAttemptId: "missing-attempt" })
          : task,
      ),
    };
    const graphPreview = previewSqliteProjectImport(
      target.database,
      previewInput(helmProjectExportSchema.parse(brokenGraph)),
      localHuman,
      { now: importTime },
    );
    expect(graphPreview.executable).toBe(false);
    expect(graphPreview.conflicts).toContainEqual(
      expect.objectContaining({
        code: "missing_dependency",
        entityType: "task",
        sourceId: "task-parent",
      }),
    );

    const oversizedInput = previewInput(artifact);
    oversizedInput.source = {
      format: "json",
      content: JSON.stringify({
        ...artifact,
        tags: Array.from({ length: 100_001 }, () => null),
      }),
    };
    expect(() =>
      previewSqliteProjectImport(target.database, oversizedInput, localHuman, {
        now: importTime,
      }),
    ).toThrow(InvalidPortabilityInputError);
  });

  it("rejects source-unique collisions, invalid lifecycle state, and blocking cycles", () => {
    const source = exportedSource();
    const target = store();
    const duplicateSequence = helmProjectExportSchema.parse({
      ...source,
      tasks: source.tasks.map((task) => Object.assign({}, task, { sequence: 1 })),
    });
    const sequencePreview = previewSqliteProjectImport(
      target.database,
      previewInput(duplicateSequence),
      localHuman,
      { now: importTime },
    );
    expect(sequencePreview.conflicts).toContainEqual(
      expect.objectContaining({
        code: "duplicate_identity",
        entityType: "task",
      }),
    );

    const invalidLifecycle = helmProjectExportSchema.parse({
      ...source,
      tasks: source.tasks.map((task) =>
        task.id === "task-parent" ? Object.assign({}, task, { expectedOutcome: "" }) : task,
      ),
    });
    expect(
      previewSqliteProjectImport(target.database, previewInput(invalidLifecycle), localHuman, {
        now: importTime,
      }).conflicts,
    ).toContainEqual(
      expect.objectContaining({
        code: "immutable_mismatch",
        sourceId: "task-parent",
      }),
    );

    const cycle = helmProjectExportSchema.parse({
      ...source,
      relations: [
        ...source.relations,
        {
          id: "blocks-forward",
          projectId: "project-1",
          sourceTaskId: "task-parent",
          targetTaskId: "task-child",
          type: "blocks",
          createdAt: sourceTime,
        },
        {
          id: "blocks-back",
          projectId: "project-1",
          sourceTaskId: "task-child",
          targetTaskId: "task-parent",
          type: "blocks",
          createdAt: sourceTime,
        },
      ],
    });
    expect(
      previewSqliteProjectImport(target.database, previewInput(cycle), localHuman, {
        now: importTime,
      }).conflicts,
    ).toContainEqual(
      expect.objectContaining({
        code: "immutable_mismatch",
        entityType: "task_relation",
      }),
    );
  });

  it("binds previews to exact source text and remaps an occupied project sequence", () => {
    const artifact = exportedSource();
    const target = store();
    target.database
      .prepare(
        `insert into projects
           (id, sequence, name, repository_root, review_mode, version, created_at, updated_at)
         values ('existing-project', 7, 'Existing', '/existing', 'required', 1, ?, ?)`,
      )
      .run(sourceTime, sourceTime);
    const input = previewInput(artifact);
    const whitespaceInput: PreviewProjectImportInput = {
      ...input,
      source: { format: "json", content: `${input.source.content}\n` },
    };
    const preview = previewSqliteProjectImport(target.database, input, localHuman, {
      now: importTime,
    });
    const whitespacePreview = previewSqliteProjectImport(
      target.database,
      whitespaceInput,
      localHuman,
      { now: importTime },
    );

    expect(preview.executable).toBe(true);
    expect(whitespacePreview.executable).toBe(true);
    expect(whitespacePreview.previewToken).not.toBe(preview.previewToken);
    target.database
      .transaction(() =>
        executeSqliteProjectImportInCurrentTransaction(
          target.database,
          executeInput(input, preview.previewToken),
          localHuman,
          { now: importTime },
        ),
      )
      .immediate();
    expect(
      target.database.prepare("select sequence from projects where id = 'project-1'").pluck().get(),
    ).toBe(8);
  });

  it.each([
    ["repository_conflict", "repository"],
    ["profile_key_conflict", "profile-key"],
    ["duplicate_identity", "opaque-task-id"],
    ["version_conflict", "project-version"],
    ["immutable_mismatch", "task-immutable"],
    ["sequence_conflict", "task-sequence"],
  ])("reports %s deterministically for a %s collision", (expectedCode, scenario) => {
    const artifact = exportedSource();
    const target = store();
    if (scenario === "repository") {
      target.database
        .prepare(
          `insert into projects
             (id, sequence, name, repository_root, review_mode, version, created_at, updated_at)
           values ('other-project', 8, 'Other', ?, 'required', 1, ?, ?)`,
        )
        .run(repositoryRoot, sourceTime, sourceTime);
    } else if (scenario === "profile-key") {
      target.database
        .prepare(
          `insert into agent_profiles
             (id, profile_key, display_name, capabilities_json, created_at, updated_at)
           values ('other-profile', 'codex', 'Other', '[]', ?, ?)`,
        )
        .run(sourceTime, sourceTime);
    } else {
      target.database
        .prepare(
          `insert into projects
             (id, sequence, name, repository_root, review_mode, version, created_at, updated_at)
           values ('project-1', 7, 'Portable project', ?,
                   'required', ?, ?, ?)`,
        )
        .run(repositoryRoot, scenario === "project-version" ? 4 : 3, sourceTime, sourceTime);
      if (["opaque-task-id", "task-immutable"].includes(scenario)) {
        if (scenario === "opaque-task-id") {
          target.database
            .prepare(
              `insert into projects
                 (id, sequence, name, repository_root, review_mode, version, created_at, updated_at)
               values ('other-project', 8, 'Other', '/other', 'required', 1, ?, ?)`,
            )
            .run(sourceTime, sourceTime);
        }
        target.database
          .prepare(
            `insert into tasks (
               id, project_id, sequence, parent_task_id, title, lifecycle, priority, position,
               description_json, description_text, expected_outcome, acceptance_criteria,
               agent_context, checklist_json, version, created_at, updated_at
             ) values (?, ?, ?, null, ?, 'review', 'high', 0,
                       '{"version":1,"doc":{"type":"doc","content":[]}}', '',
                       '', '', '', '[]', ?, ?, ?)`,
          )
          .run(
            "task-parent",
            scenario === "opaque-task-id" ? "other-project" : "project-1",
            scenario === "opaque-task-id" ? 9 : 1,
            "Different task",
            2,
            scenario === "task-immutable" ? importTime : sourceTime,
            sourceTime,
          );
      } else if (scenario === "task-sequence") {
        target.database
          .prepare(
            `insert into tasks (
               id, project_id, sequence, parent_task_id, title, lifecycle, priority, position,
               description_json, description_text, expected_outcome, acceptance_criteria,
               agent_context, checklist_json, version, created_at, updated_at
             ) values ('other-task', 'project-1', 1, null, 'Other', 'ready', 'normal', 0,
                       '{"version":1,"doc":{"type":"doc","content":[]}}', '',
                       '', '', '', '[]', 1, ?, ?)`,
          )
          .run(sourceTime, sourceTime);
      }
    }

    const preview = previewSqliteProjectImport(
      target.database,
      ["repository", "profile-key"].includes(scenario)
        ? previewInput(artifact)
        : existingProjectInput(artifact),
      localHuman,
      { now: importTime },
    );
    expect(preview.executable).toBe(false);
    expect(preview.conflicts.map(({ code }) => code)).toContain(expectedCode);
  });

  it("detects stale previews and requires caller-owned transaction execution", () => {
    const artifact = exportedSource();
    const target = store();
    const input = previewInput(artifact);
    const preview = previewSqliteProjectImport(target.database, input, localHuman, {
      now: importTime,
    });
    const execution = executeInput(input, preview.previewToken);

    expect(() =>
      executeSqliteProjectImportInCurrentTransaction(target.database, execution, localHuman, {
        now: importTime,
      }),
    ).toThrow(InvalidPortabilityInputError);

    target.database
      .prepare(
        `insert into projects
           (id, sequence, name, repository_root, review_mode, version, created_at, updated_at)
         values ('concurrent-project', 99, 'Concurrent', '/concurrent', 'required', 1, ?, ?)`,
      )
      .run(importTime, importTime);
    expect(() =>
      target.database
        .transaction(() =>
          executeSqliteProjectImportInCurrentTransaction(target.database, execution, localHuman, {
            now: importTime,
          }),
        )
        .immediate(),
    ).toThrow(PortabilityPreviewStaleError);
  });

  it("binds the reviewed reason but ignores unrelated agent heartbeats", () => {
    const artifact = exportedSource();
    const newTarget = store();
    const newInput = previewInput(artifact);
    const newPreview = previewSqliteProjectImport(newTarget.database, newInput, localHuman, {
      now: importTime,
    });
    expect(() =>
      newTarget.database
        .transaction(() =>
          executeSqliteProjectImportInCurrentTransaction(
            newTarget.database,
            {
              ...executeInput(newInput, newPreview.previewToken),
              reason: "A different unreviewed reason.",
            },
            localHuman,
            { now: importTime },
          ),
        )
        .immediate(),
    ).toThrow(PortabilityPreviewStaleError);

    const target = store();
    seedSource(target);
    const existingArtifact = exportSqliteProject(
      target.database,
      { projectId: "project-1" },
      { now: exportTime },
    );
    const input = existingProjectInput(existingArtifact);
    const preview = previewSqliteProjectImport(target.database, input, localHuman, {
      now: importTime,
    });
    target.database.exec(`
      insert into agent_profiles (
        id, profile_key, display_name, capabilities_json, created_at, updated_at
      ) values ('unrelated-profile', 'other', 'Other', '[]', '${sourceTime}', '${sourceTime}');
      insert into agent_runs (
        id, profile_id, mcp_session_id, status, created_at, last_seen_at, ended_at
      ) values (
        'unrelated-run', 'unrelated-profile', 'other-session', 'active',
        '${sourceTime}', '${importTime}', null
      );
    `);
    expect(() =>
      target.database
        .transaction(() =>
          executeSqliteProjectImportInCurrentTransaction(
            target.database,
            executeInput(input, preview.previewToken),
            localHuman,
            { now: importTime },
          ),
        )
        .immediate(),
    ).not.toThrow();
  });

  it("bumps both existing relation endpoints once and includes them in import hints", () => {
    const target = store();
    seedSource(target);
    target.database
      .prepare(
        `update tasks
            set lifecycle = 'ready', version = 5, updated_at = ?
          where id = 'task-child'`,
      )
      .run(sourceTime);
    target.database
      .prepare(
        `update attempts
            set status = 'abandoned', completed_at = ?
          where id = 'attempt-active'`,
      )
      .run(sourceTime);
    target.database
      .prepare(
        `update leases
            set status = 'released', invalidated_at = ?, invalidation_reason = 'Prepared test'
          where id = 'lease-1'`,
      )
      .run(sourceTime);
    const artifact = exportSqliteProject(
      target.database,
      { projectId: "project-1" },
      { now: exportTime },
    );
    target.database.prepare("delete from task_relations where id = 'relation-1'").run();
    const input = existingProjectInput(artifact);
    const preview = previewSqliteProjectImport(target.database, input, localHuman, {
      now: importTime,
    });

    expect(preview.executable).toBe(true);
    expect(preview.creates).toContainEqual(
      expect.objectContaining({
        entityType: "task_relation",
        sourceId: "relation-1",
      }),
    );
    expect(
      preview.updates
        .filter(({ entityType }) => entityType === "task")
        .map(({ sourceId }) => sourceId),
    ).toEqual(["task-parent", "task-child"]);
    const result = target.database
      .transaction(() =>
        executeSqliteProjectImportInCurrentTransaction(
          target.database,
          executeInput(input, preview.previewToken),
          localHuman,
          { now: importTime },
        ),
      )
      .immediate();
    expect(target.database.prepare("select id, version from tasks order by id").all()).toEqual([
      { id: "task-child", version: 6 },
      { id: "task-parent", version: 3 },
    ]);
    const parentEvent = target.database
      .prepare("select changes_json as changesJson from events where cursor = ?")
      .get(result.eventCursors[0]);
    expect(JSON.parse(String(field(parentEvent, "changesJson")))).toMatchObject({
      taskIds: ["task-child", "task-parent"],
      scopes: expect.arrayContaining(["tasks"]),
    });
  });

  it("bumps a blocker task once and publishes task plus activity invalidation hints", () => {
    const target = store();
    seedSource(target);
    const artifact = exportSqliteProject(
      target.database,
      { projectId: "project-1" },
      { now: exportTime },
    );
    target.database.prepare("delete from manual_blockers where id = 'blocker-1'").run();
    const input = existingProjectInput(artifact);
    const preview = previewSqliteProjectImport(target.database, input, localHuman, {
      now: importTime,
    });

    expect(preview.executable).toBe(true);
    expect(preview.updates).toContainEqual(
      expect.objectContaining({ entityType: "task", sourceId: "task-parent" }),
    );
    const result = target.database
      .transaction(() =>
        executeSqliteProjectImportInCurrentTransaction(
          target.database,
          executeInput(input, preview.previewToken),
          localHuman,
          { now: importTime },
        ),
      )
      .immediate();
    expect(
      target.database.prepare("select version from tasks where id = 'task-parent'").pluck().get(),
    ).toBe(3);
    const parentEvent = target.database
      .prepare("select changes_json as changesJson from events where cursor = ?")
      .get(result.eventCursors[0]);
    expect(JSON.parse(String(field(parentEvent, "changesJson")))).toMatchObject({
      taskIds: ["task-parent"],
      scopes: expect.arrayContaining(["tasks", "activity"]),
    });
  });

  it("previews and inserts a large parent-first task graph through bounded batches", () => {
    const source = exportedSource();
    const template = source.tasks[0];
    if (!template) throw new Error("Expected a task template.");
    const taskCount = 5_001;
    const bulkTasks = Array.from({ length: taskCount }, (_, index) => ({
      ...template,
      id: index === 0 ? "bulk-parent" : `bulk-child-${String(index).padStart(5, "0")}`,
      sequence: index + 1,
      parentTaskId: index === 0 ? null : "bulk-parent",
      title: index === 0 ? "Bulk parent" : `Bulk child ${index}`,
      lifecycle: "backlog" as const,
      description: source.tasks[1]?.description ?? template.description,
      expectedOutcome: "",
      acceptanceCriteria: "",
      agentContext: "",
      checklist: [],
      reviewModeOverride: null,
      reviewAttemptId: null,
      cancelledFromLifecycle: null,
      version: 1,
      tagIds: [],
      customFieldValues: [],
      requiredCapabilities: [],
      referencedPaths: [],
    }));
    const artifact = helmProjectExportSchema.parse({
      ...source,
      tags: [],
      customFieldDefinitions: [],
      tasks: bulkTasks,
      relations: [],
      savedViews: [],
      agentProfiles: [],
      agentRuns: [],
      attempts: [],
      activityEntries: [],
      manualBlockers: [],
      sourceEvents: [],
    });
    const target = store();
    const input = previewInput(artifact);
    const preview = previewSqliteProjectImport(target.database, input, localHuman, {
      now: importTime,
    });

    expect(preview).toMatchObject({ executable: true, conflicts: [] });
    expect(preview.creates).toHaveLength(taskCount + 1);
    target.database
      .transaction(() =>
        executeSqliteProjectImportInCurrentTransaction(
          target.database,
          executeInput(input, preview.previewToken),
          localHuman,
          { now: importTime },
        ),
      )
      .immediate();

    expect(target.database.prepare("select count(*) from tasks").pluck().get()).toBe(taskCount);
    expect(
      target.database
        .prepare("select parent_task_id from tasks where id = 'bulk-child-05000'")
        .pluck()
        .get(),
    ).toBe("bulk-parent");
    expect(
      target.database
        .prepare("select count(*) from events where kind = 'project.import.entities_batch'")
        .pluck()
        .get(),
    ).toBe(Math.ceil((taskCount + 1) / 200));
  }, 20_000);

  it("leaves the whole import graph rollback-able by the caller", () => {
    const artifact = exportedSource();
    const target = store();
    const input = previewInput(artifact);
    const preview = previewSqliteProjectImport(target.database, input, localHuman, {
      now: importTime,
    });

    expect(() =>
      target.database
        .transaction(() => {
          executeSqliteProjectImportInCurrentTransaction(
            target.database,
            executeInput(input, preview.previewToken),
            localHuman,
            { now: importTime },
          );
          throw new Error("force caller rollback");
        })
        .immediate(),
    ).toThrow("force caller rollback");

    expect(target.database.prepare("select count(*) from projects").pluck().get()).toBe(0);
    expect(target.database.prepare("select count(*) from events").pluck().get()).toBe(0);
    expect(
      target.database
        .prepare("select active_project_id from preferences where id = 1")
        .pluck()
        .get(),
    ).toBeNull();
  });

  it("returns an explicit unsupported preview for CSV at this semantic seam", () => {
    const target = store();
    const input: PreviewProjectImportInput = {
      source: { format: "csv", content: "title\nTask" },
      targetProjectId: null,
      repositoryRoot: "/canonical/csv",
      reason: "Preview CSV.",
    };

    const preview = previewSqliteProjectImport(target.database, input, localHuman, {
      now: importTime,
    });

    expect(preview).toMatchObject({
      sourceFormat: "csv",
      executable: false,
      conflicts: [],
      unsupported: [{ code: "csv_not_supported" }],
    });
  });
});
