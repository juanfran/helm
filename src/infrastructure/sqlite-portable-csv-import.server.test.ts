import { mkdir, mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { Effect } from "effect";
import { afterEach, beforeEach, describe, expect, it } from "vitest";

import { createProject } from "../application/projects";
import {
  PortabilityIdempotencyConflictError,
  PortabilityPreviewStaleError,
} from "../application/portability-errors";
import { createTask, type TaskServices } from "../application/tasks";
import { emptyRichTextDocument, type CreateTaskInput } from "../domain/tasks";
import { localRepositoryInspector } from "./repository-inspector.server";
import { createSqliteProjectStore, type SqliteProjectStore } from "./sqlite-project-store.server";
import { createSqliteTaskStore } from "./sqlite-task-store.server";
import {
  executeSqlitePortableCsvImportInCurrentTransaction,
  planSqlitePortableCsvImportInCurrentTransaction,
  type PlannedSqlitePortableCsvImport,
  type SqlitePortableCsvImportHumanActor,
} from "./sqlite-portable-csv-import.server";

const human: SqlitePortableCsvImportHumanActor = { type: "human", id: "local-human" };
const now = "2026-09-04T12:00:00.000Z";

let temporaryRoot: string;
let projectStore: SqliteProjectStore;
let projectId: string;
let taskServices: TaskServices;

function taskInput(overrides: Partial<CreateTaskInput> = {}): CreateTaskInput {
  return {
    projectId,
    parentTaskId: null,
    lifecycle: "backlog",
    title: "CSV fixture",
    description: emptyRichTextDocument,
    expectedOutcome: "",
    acceptanceCriteria: "",
    agentContext: "",
    checklist: [],
    referencedPaths: [],
    expectedVersion: 0,
    idempotencyKey: crypto.randomUUID(),
    ...overrides,
  };
}

function csvCell(value: string) {
  return `"${value.replaceAll('"', '""')}"`;
}

function csv(headers: readonly string[], rows: readonly Readonly<Record<string, string>>[]) {
  return [
    headers.join(","),
    ...rows.map((row) => headers.map((header) => csvCell(row[header] ?? "")).join(",")),
  ].join("\n");
}

function input(content: string, reason = "Import reviewed CSV tasks") {
  return {
    source: { format: "csv" as const, content },
    targetProjectId: projectId,
    reason,
  };
}

function plan(content: string, reason?: string) {
  return projectStore.database
    .transaction(() =>
      planSqlitePortableCsvImportInCurrentTransaction(
        projectStore.database,
        input(content, reason),
        human,
        { now },
      ),
    )
    .deferred();
}

function execute(planned: PlannedSqlitePortableCsvImport, idempotencyKey: string) {
  return projectStore.database
    .transaction(() =>
      executeSqlitePortableCsvImportInCurrentTransaction(
        projectStore.database,
        planned.executionPlan,
        { previewToken: planned.preview.previewToken, idempotencyKey },
      ),
    )
    .immediate();
}

function insertTag(id = "tag-alpha", name = "alpha") {
  projectStore.database
    .prepare(
      `insert into tags (
         id, project_id, name, description, color, exclusive_group,
         review_mode_override, created_at, updated_at
       ) values (?, ?, ?, ?, ?, null, null, ?, ?)`,
    )
    .run(id, projectId, name, `${name} work`, "#2563eb", now, now);
}

type DefinitionFixture = {
  readonly id: string;
  readonly key: string;
  readonly type: "text" | "number" | "boolean" | "date" | "single_select";
  readonly validation: unknown;
};

function insertDefinition(definition: DefinitionFixture, position: number) {
  projectStore.database
    .prepare(
      `insert into custom_field_definitions (
         id, project_id, field_key, type, validation_json, default_value_json,
         display_label, description, position, retired_at, created_at, updated_at
       ) values (?, ?, ?, ?, ?, null, ?, '', ?, null, ?, ?)`,
    )
    .run(
      definition.id,
      projectId,
      definition.key,
      definition.type,
      JSON.stringify(definition.validation),
      definition.key,
      position,
      now,
      now,
    );
}

beforeEach(async () => {
  temporaryRoot = await mkdtemp(join(tmpdir(), "helm-portable-csv-test-"));
  const repositoryRoot = join(temporaryRoot, "repository");
  await mkdir(join(repositoryRoot, ".git"), { recursive: true });
  projectStore = createSqliteProjectStore(join(temporaryRoot, "helm.db"));
  const project = await Effect.runPromise(
    createProject(
      { repositoryRoot, idempotencyKey: "csv-project" },
      { store: projectStore, inspector: localRepositoryInspector },
    ),
  );
  projectId = project.id;
  taskServices = {
    store: createSqliteTaskStore(projectStore.database),
    clock: { today: () => now.slice(0, 10), now: () => now },
  };
});

afterEach(async () => {
  projectStore.close();
  await rm(temporaryRoot, { recursive: true, force: true });
});

describe("SQLite portable CSV import", () => {
  it("previews and executes mixed creates, updates, and no-ops through bulk commands", async () => {
    insertTag();
    insertDefinition(
      {
        id: "field-points",
        key: "points",
        type: "number",
        validation: { min: 0, max: 20, integer: true },
      },
      0,
    );
    const updateTarget = await Effect.runPromise(
      createTask(taskInput({ title: "Update target" }), human, taskServices),
    );
    const noOpTarget = await Effect.runPromise(
      createTask(taskInput({ title: "No-op target" }), human, taskServices),
    );
    const headers = [
      "task_id",
      "expected_version",
      "title",
      "lifecycle",
      "priority",
      "not_before",
      "due_at",
      "description",
      "expected_outcome",
      "acceptance_criteria",
      "checklist",
      "tags",
      "capabilities",
      "custom.points",
    ];
    const content = csv(headers, [
      {
        title: "Imported ready task",
        lifecycle: "ready",
        priority: "urgent",
        not_before: "2026-09-05",
        due_at: "2026-09-12",
        description: "Imported details",
        expected_outcome: "The import works",
        acceptance_criteria: "The task is visible",
        checklist: '["Preview","Execute"]',
        tags: "alpha",
        capabilities: "TypeScript|browser",
        "custom.points": "7",
      },
      {
        task_id: updateTarget.id,
        expected_version: String(updateTarget.version),
        priority: "high",
        tags: "alpha",
        capabilities: "gpu",
        "custom.points": "5",
      },
      {
        task_id: noOpTarget.id,
        expected_version: String(noOpTarget.version),
        priority: "normal",
      },
    ]);

    const planned = plan(content);
    expect(plan(content).preview.previewToken).toBe(planned.preview.previewToken);
    expect(planned.preview).toMatchObject({
      executable: true,
      creates: [{ sourceId: "csv-row-2", targetId: null }],
      updates: [{ sourceId: "csv-row-3", targetId: updateTarget.id }],
      noOps: [{ sourceId: "csv-row-4", targetId: noOpTarget.id }],
      conflicts: [],
      unsupported: [],
    });

    const result = execute(planned, "csv-mixed");
    const createdId = result.creates[0]!.targetId!;
    expect(result).toMatchObject({ executed: true, operationId: expect.any(String) });
    expect(result.eventCursors).toHaveLength(3);
    expect(
      projectStore.database
        .prepare(
          "select title, lifecycle, priority, not_before as notBefore from tasks where id = ?",
        )
        .get(createdId),
    ).toEqual({
      title: "Imported ready task",
      lifecycle: "ready",
      priority: "urgent",
      notBefore: "2026-09-05",
    });
    expect(
      projectStore.database
        .prepare("select priority, version from tasks where id = ?")
        .get(updateTarget.id),
    ).toEqual({ priority: "high", version: updateTarget.version + 1 });
    expect(
      projectStore.database
        .prepare(
          "select capability from task_capability_requirements where task_id = ? order by capability",
        )
        .pluck()
        .all(createdId),
    ).toEqual(["browser", "typescript"]);
    expect(
      projectStore.database
        .prepare(
          "select actor_type as actorType, actor_id as actorId from events where kind = 'project.import.csv'",
        )
        .get(),
    ).toEqual({ actorType: "human", actorId: human.id });
    const bulkEvents = projectStore.database
      .prepare<[], { readonly cursor: number; readonly entityId: string; readonly kind: string }>(
        `select cursor, entity_id as entityId, kind
           from events
          where kind in ('task.bulk.created', 'task.bulk.updated')
          order by cursor`,
      )
      .all();
    expect(bulkEvents.map(({ kind }) => kind)).toEqual(["task.bulk.created", "task.bulk.updated"]);
    const importPayload: unknown = JSON.parse(
      projectStore.database
        .prepare<[], string>("select payload_json from events where kind = 'project.import.csv'")
        .pluck()
        .get()!,
    );
    expect(importPayload).toMatchObject({
      bulkEventCursors: bulkEvents.map(({ cursor }) => cursor),
      bulkOperationIds: bulkEvents.map(({ entityId }) => entityId),
    });
    expect(
      projectStore.database
        .prepare<[], string>(
          "select command from idempotency_records where key like 'csv-import:%' order by key",
        )
        .pluck()
        .all(),
    ).toEqual(["task.bulk.execute", "task.bulk.execute"]);

    const replanned = plan(content);
    const retry = projectStore.database
      .transaction(() =>
        executeSqlitePortableCsvImportInCurrentTransaction(
          projectStore.database,
          replanned.executionPlan,
          { previewToken: planned.preview.previewToken, idempotencyKey: "csv-mixed" },
        ),
      )
      .immediate();
    expect(retry).toEqual(result);
    expect(projectStore.database.prepare("select count(*) from tasks").pluck().get()).toBe(3);
  });

  it("coerces text, number, boolean, date, and single-select custom fields", () => {
    const definitions: readonly DefinitionFixture[] = [
      {
        id: "field-notes",
        key: "notes",
        type: "text",
        validation: { minLength: 0, maxLength: 100 },
      },
      {
        id: "field-score",
        key: "score",
        type: "number",
        validation: { min: null, max: null, integer: false },
      },
      { id: "field-enabled", key: "enabled", type: "boolean", validation: {} },
      { id: "field-start", key: "start", type: "date", validation: { min: null, max: null } },
      {
        id: "field-lane",
        key: "lane",
        type: "single_select",
        validation: { options: [{ id: "high_risk", label: "High Risk" }] },
      },
    ];
    definitions.forEach(insertDefinition);
    const content = csv(
      ["title", "custom.notes", "custom.score", "custom.enabled", "custom.start", "custom.lane"],
      [
        {
          title: "Typed values",
          "custom.notes": "hello",
          "custom.score": "3.5",
          "custom.enabled": "yes",
          "custom.start": "2026-09-10",
          "custom.lane": "High Risk",
        },
      ],
    );

    const result = execute(plan(content), "csv-custom-types");
    const values = projectStore.database
      .prepare<[string], { readonly definitionId: string; readonly valueJson: string }>(
        `select definition_id as definitionId, value_json as valueJson
           from task_custom_field_values where task_id = ? order by definition_id`,
      )
      .all(result.creates[0]!.targetId!)
      .map(({ definitionId, valueJson }) => [definitionId, JSON.parse(valueJson)]);
    expect(Object.fromEntries(values)).toEqual({
      "field-enabled": { type: "boolean", value: true },
      "field-lane": { type: "single_select", value: "high_risk" },
      "field-notes": { type: "text", value: "hello" },
      "field-score": { type: "number", value: 3.5 },
      "field-start": { type: "date", value: "2026-09-10" },
    });
  });

  it("reports unknown headers, malformed widths, and unsupported nonblank update fields", async () => {
    const target = await Effect.runPromise(createTask(taskInput(), human, taskServices));
    const content = `task_id,expected_version,title,mystery\n${target.id},${target.version},Renamed,value,extra`;
    const preview = plan(content).preview;

    expect(preview.executable).toBe(false);
    expect(preview.unsupported.map(({ code }) => code)).toEqual([
      "unknown_header",
      "extra_columns",
      "unsupported_update_field",
    ]);
    expect(preview.updates).toEqual([]);
  });

  it.each([
    [null, "target_project_required"],
    ["missing-project", "project_not_found"],
  ] as const)(
    "reports malformed CSV alongside a missing target (%s)",
    (targetProjectId, targetCode) => {
      const preview = projectStore.database
        .transaction(
          () =>
            planSqlitePortableCsvImportInCurrentTransaction(
              projectStore.database,
              {
                source: { format: "csv", content: 'title\n"unterminated' },
                targetProjectId,
                repositoryRoot: targetProjectId === null ? "/unused" : undefined,
                reason: "Inspect malformed import",
              },
              human,
              { now },
            ).preview,
        )
        .deferred();

      expect(preview.conflicts.map(({ code }) => code)).toEqual(["unterminated_quote", targetCode]);
    },
  );

  it("reports expected-version conflicts and rejects state changes after preview", async () => {
    const target = await Effect.runPromise(createTask(taskInput(), human, taskServices));
    const headers = ["task_id", "expected_version", "priority"];
    const mismatched = plan(
      csv(headers, [
        { task_id: target.id, expected_version: String(target.version + 1), priority: "high" },
      ]),
    ).preview;
    expect(mismatched.conflicts).toMatchObject([{ code: "version_conflict", targetId: target.id }]);

    const planned = plan(
      csv(headers, [
        { task_id: target.id, expected_version: String(target.version), priority: "high" },
      ]),
    );
    projectStore.database
      .prepare("update tasks set version = version + 1, updated_at = ? where id = ?")
      .run("2026-09-04T13:00:00.000Z", target.id);
    expect(() => execute(planned, "csv-stale")).toThrowError(PortabilityPreviewStaleError);
    expect(
      projectStore.database
        .prepare("select priority from tasks where id = ?")
        .pluck()
        .get(target.id),
    ).toBe("normal");
    expect(() =>
      executeSqlitePortableCsvImportInCurrentTransaction(
        projectStore.database,
        planned.executionPlan,
        { previewToken: planned.preview.previewToken, idempotencyKey: "outside-transaction" },
      ),
    ).toThrowError("caller-owned SQLite transaction");
  });

  it("audits successful no-op imports and rejects conflicting outer idempotency reuse", async () => {
    const target = await Effect.runPromise(createTask(taskInput(), human, taskServices));
    const firstContent = csv(
      ["task_id", "expected_version", "priority"],
      [{ task_id: target.id, expected_version: String(target.version), priority: "normal" }],
    );
    const first = execute(plan(firstContent), "csv-no-op");

    expect(first).toMatchObject({ executed: true, noOps: [{ targetId: target.id }] });
    expect(first.eventCursors).toHaveLength(1);
    expect(
      projectStore.database
        .prepare("select count(*) from events where kind = 'project.import.csv'")
        .pluck()
        .get(),
    ).toBe(1);
    expect(
      projectStore.database
        .prepare("select command from idempotency_records where key = 'csv-no-op'")
        .pluck()
        .get(),
    ).toBe("project.import.csv");

    const changed = plan(
      csv(
        ["task_id", "expected_version", "priority"],
        [{ task_id: target.id, expected_version: String(target.version), priority: "high" }],
      ),
    );
    expect(() => execute(changed, "csv-no-op")).toThrowError(PortabilityIdempotencyConflictError);
  });

  it("lets the caller roll every task, event, and idempotency write back on failure", async () => {
    const first = await Effect.runPromise(
      createTask(taskInput({ title: "Rollback first" }), human, taskServices),
    );
    const second = await Effect.runPromise(
      createTask(taskInput({ title: "Rollback second" }), human, taskServices),
    );
    const content = csv(
      ["task_id", "expected_version", "priority"],
      [
        { task_id: first.id, expected_version: String(first.version), priority: "high" },
        { task_id: second.id, expected_version: String(second.version), priority: "high" },
      ],
    );
    const planned = plan(content);
    const eventCount = projectStore.database.prepare("select count(*) from events").pluck().get();
    projectStore.database.exec(`
      create trigger reject_second_csv_child
      before insert on events
      when NEW.kind = 'task.planning.updated'
       and exists (
         select 1 from events
          where kind = 'task.planning.updated'
       )
      begin select raise(abort, 'second CSV child rejected'); end;
    `);

    expect(() => execute(planned, "csv-rollback")).toThrowError("second CSV child rejected");
    expect(
      projectStore.database
        .prepare("select id, priority, version from tasks where id in (?, ?) order by id")
        .all(first.id, second.id),
    ).toEqual(
      [first, second]
        .map(({ id, priority, version }) => ({ id, priority, version }))
        .toSorted((left, right) => left.id.localeCompare(right.id)),
    );
    expect(projectStore.database.prepare("select count(*) from events").pluck().get()).toBe(
      eventCount,
    );
    expect(
      projectStore.database
        .prepare(
          "select count(*) from idempotency_records where key like 'csv-import:%' or key = 'csv-rollback'",
        )
        .pluck()
        .get(),
    ).toBe(0);
  });
});
