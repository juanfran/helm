import { mkdir, mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { Effect, Either } from "effect";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

import { createProject } from "./projects";
import { executeBulkTasks, previewBulkTasks, type BulkTaskServices } from "./bulk-tasks";
import { createTask, listTasks, updateTaskPlanning, type TaskServices } from "./tasks";
import { emptyRichTextDocument, type Actor, type CreateTaskInput } from "../domain/tasks";
import { localRepositoryInspector } from "../infrastructure/repository-inspector.server";
import { createSqliteBulkTaskStore } from "../infrastructure/sqlite-bulk-task-store.server";
import {
  createSqliteProjectStore,
  type SqliteProjectStore,
} from "../infrastructure/sqlite-project-store.server";
import { createSqliteTaskStore } from "../infrastructure/sqlite-task-store.server";

const human: Actor = { type: "human", id: "local-human" };
let temporaryRoot: string;
let projectStore: SqliteProjectStore;
let projectId: string;
let taskServices: TaskServices;
let bulkServices: BulkTaskServices;
let now: string;

function taskInput(overrides: Partial<CreateTaskInput> = {}): CreateTaskInput {
  return {
    projectId,
    parentTaskId: null,
    lifecycle: "backlog",
    title: "Bulk fixture",
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

function updateIntent(
  taskIds: readonly string[],
  patch: Record<string, unknown> = { priority: "high" },
) {
  return {
    schemaVersion: 1 as const,
    kind: "update" as const,
    projectId,
    reason: "Apply the reviewed bulk planning decision",
    selection: { type: "ids" as const, taskIds: [...taskIds] },
    patch,
  };
}

function createItem(clientId: string, title: string, overrides: Record<string, unknown> = {}) {
  return {
    clientId,
    task: {
      parentTaskId: null,
      lifecycle: "backlog" as const,
      title,
      description: emptyRichTextDocument,
      expectedOutcome: "",
      acceptanceCriteria: "",
      agentContext: "",
      checklist: [],
      referencedPaths: [],
      ...overrides,
    },
  };
}

function insertNumberField(
  overrides: Partial<{
    id: string;
    key: string;
    defaultValue: { type: "number"; value: number } | null;
    retiredAt: string | null;
    position: number;
  }> = {},
) {
  const definition = {
    id: "field-estimate",
    key: "estimate",
    defaultValue: { type: "number" as const, value: 3 },
    retiredAt: null,
    position: 0,
    ...overrides,
  };
  projectStore.database
    .prepare(
      `insert into custom_field_definitions (
         id, project_id, field_key, type, validation_json, default_value_json,
         display_label, description, position, retired_at, created_at, updated_at
       ) values (?, ?, ?, 'number', ?, ?, ?, '', ?, ?, ?, ?)`,
    )
    .run(
      definition.id,
      projectId,
      definition.key,
      JSON.stringify({ min: 0, max: 10, integer: true }),
      definition.defaultValue === null ? null : JSON.stringify(definition.defaultValue),
      definition.key === "estimate" ? "Estimate" : definition.key,
      definition.position,
      definition.retiredAt,
      now,
      now,
    );
  return definition;
}

beforeEach(async () => {
  temporaryRoot = await mkdtemp(join(tmpdir(), "helm-bulk-task-test-"));
  const repositoryRoot = join(temporaryRoot, "repository");
  await mkdir(join(repositoryRoot, ".git"), { recursive: true });
  projectStore = createSqliteProjectStore(join(temporaryRoot, "helm.db"));
  const project = await Effect.runPromise(
    createProject(
      { repositoryRoot, idempotencyKey: "bulk-project" },
      { store: projectStore, inspector: localRepositoryInspector },
    ),
  );
  projectId = project.id;
  now = "2026-09-04T12:00:00.000Z";
  taskServices = {
    store: createSqliteTaskStore(projectStore.database),
    clock: { today: () => now.slice(0, 10), now: () => now },
  };
  bulkServices = {
    store: createSqliteBulkTaskStore(projectStore.database),
    clock: { today: () => now.slice(0, 10), now: () => now },
  };
});

afterEach(async () => {
  vi.restoreAllMocks();
  projectStore.close();
  await rm(temporaryRoot, { recursive: true, force: true });
});

describe("SQLite bulk task commands", () => {
  it("previews without writes, updates atomically, preserves no-op versions, and audits one parent first", async () => {
    const first = await Effect.runPromise(
      createTask(taskInput({ title: "Needs priority" }), human, taskServices),
    );
    const alreadyHigh = await Effect.runPromise(
      createTask(taskInput({ title: "Already high", priority: "high" }), human, taskServices),
    );
    const noOpPreview = await Effect.runPromise(
      previewBulkTasks(updateIntent([alreadyHigh.id]), human, bulkServices),
    );
    expect(noOpPreview).toMatchObject({
      executable: false,
      matchedCount: 1,
      affectedCount: 0,
    });
    expect(noOpPreview.failures).toMatchObject([{ code: "no_changes" }]);
    const countsBeforeNoOp = {
      events: projectStore.database.prepare("select count(*) from events").pluck().get(),
      idempotency: projectStore.database
        .prepare("select count(*) from idempotency_records")
        .pluck()
        .get(),
      tasks: projectStore.database
        .prepare("select id, version, priority, not_before, due_at from tasks order by id")
        .all(),
    };
    const noOpExecution = await Effect.runPromise(
      Effect.either(
        executeBulkTasks(
          {
            intent: updateIntent([alreadyHigh.id]),
            previewToken: noOpPreview.previewToken,
            idempotencyKey: "reject-no-op-bulk",
          },
          human,
          bulkServices,
        ),
      ),
    );
    expect(Either.isLeft(noOpExecution) && noOpExecution.left["_tag"]).toBe(
      "BulkTaskPreviewValidationError",
    );
    expect({
      events: projectStore.database.prepare("select count(*) from events").pluck().get(),
      idempotency: projectStore.database
        .prepare("select count(*) from idempotency_records")
        .pluck()
        .get(),
      tasks: projectStore.database
        .prepare("select id, version, priority, not_before, due_at from tasks order by id")
        .all(),
    }).toEqual(countsBeforeNoOp);

    const eventCount = projectStore.database.prepare("select count(*) from events").pluck().get();
    const intent = updateIntent([alreadyHigh.id, first.id]);
    const preview = await Effect.runPromise(previewBulkTasks(intent, human, bulkServices));

    expect(preview).toMatchObject({
      mode: "atomic",
      matchedCount: 2,
      affectedCount: 1,
      executable: true,
    });
    expect(projectStore.database.prepare("select count(*) from events").pluck().get()).toBe(
      eventCount,
    );
    expect(
      projectStore.database.prepare("select count(*) from idempotency_records").pluck().get(),
    ).toBe(3);

    const command = {
      intent,
      previewToken: preview.previewToken,
      idempotencyKey: "execute-priority-bulk",
    };
    const result = await Effect.runPromise(executeBulkTasks(command, human, bulkServices));
    const stored = await Effect.runPromise(listTasks({ projectId }, taskServices));
    const firstAfter = stored.find(({ id }) => id === first.id);
    const alreadyHighAfter = stored.find(({ id }) => id === alreadyHigh.id);
    const bulkEvents = projectStore.database
      .prepare<
        [],
        {
          cursor: number;
          kind: string;
          entityId: string;
          payloadJson: string;
          actorId: string;
        }
      >(
        `select cursor, kind, entity_id as entityId, payload_json as payloadJson,
                actor_id as actorId
         from events where kind in ('task.bulk.updated', 'task.planning.updated')
         order by cursor`,
      )
      .all();

    expect(firstAfter).toMatchObject({
      priority: "high",
      version: first.version + 1,
    });
    expect(alreadyHighAfter).toMatchObject({
      priority: "high",
      version: alreadyHigh.version,
    });
    expect(
      result.items
        .map(({ changed }) => changed)
        .toSorted((left, right) => Number(left) - Number(right)),
    ).toEqual([false, true]);
    expect(bulkEvents.map(({ kind }) => kind)).toEqual([
      "task.bulk.updated",
      "task.planning.updated",
    ]);
    expect(bulkEvents[0]).toMatchObject({
      cursor: result.parentEventCursor,
      entityId: result.operationId,
      actorId: human.id,
    });
    expect(JSON.parse(bulkEvents[1]!.payloadJson)).toMatchObject({
      operationId: result.operationId,
      parentEventCursor: result.parentEventCursor,
    });

    await Effect.runPromise(
      updateTaskPlanning(
        {
          taskId: first.id,
          priority: "urgent",
          position: first.position,
          notBefore: null,
          dueAt: null,
          size: null,
          tags: [],
          requiredCapabilities: [],
          expectedVersion: first.version + 1,
          idempotencyKey: "change-after-bulk",
        },
        human,
        taskServices,
      ),
    );
    expect(await Effect.runPromise(executeBulkTasks(command, human, bulkServices))).toEqual(result);

    const conflictingToken = `${preview.previewToken.slice(0, -1)}${preview.previewToken.endsWith("0") ? "1" : "0"}`;
    const conflict = await Effect.runPromise(
      Effect.either(
        executeBulkTasks({ ...command, previewToken: conflictingToken }, human, bulkServices),
      ),
    );
    expect(Either.isLeft(conflict) && conflict.left["_tag"]).toBe(
      "BulkTaskIdempotencyConflictError",
    );
  });

  it("uses the shared filter selection and ignores unrelated nonmatching changes", async () => {
    const selected = await Effect.runPromise(
      createTask(taskInput({ title: "Selected", priority: "high" }), human, taskServices),
    );
    const untouched = await Effect.runPromise(
      createTask(taskInput({ title: "Untouched", priority: "low" }), human, taskServices),
    );
    const intent = {
      schemaVersion: 1 as const,
      kind: "update" as const,
      projectId,
      reason: "Schedule the high-priority queue",
      selection: {
        type: "filter" as const,
        filter: {
          schemaVersion: 1 as const,
          projectId,
          priorities: ["high" as const],
        },
      },
      patch: { dueAt: "2026-09-12" },
    };
    const preview = await Effect.runPromise(previewBulkTasks(intent, human, bulkServices));
    await Effect.runPromise(
      createTask(
        taskInput({ title: "New unrelated low work", priority: "low" }),
        human,
        taskServices,
      ),
    );

    await Effect.runPromise(
      executeBulkTasks(
        {
          intent,
          previewToken: preview.previewToken,
          idempotencyKey: "execute-filter-bulk",
        },
        human,
        bulkServices,
      ),
    );
    const stored = await Effect.runPromise(listTasks({ projectId }, taskServices));

    expect(stored.find(({ id }) => id === selected.id)?.dueAt).toBe("2026-09-12");
    expect(stored.find(({ id }) => id === untouched.id)?.dueAt).toBeNull();

    const emptyIntent = {
      ...intent,
      selection: {
        type: "filter" as const,
        filter: {
          schemaVersion: 1 as const,
          projectId,
          priorities: ["urgent" as const],
        },
      },
    };
    const emptyPreview = await Effect.runPromise(
      previewBulkTasks(emptyIntent, human, bulkServices),
    );
    expect(emptyPreview).toMatchObject({
      executable: false,
      matchedCount: 0,
      affectedCount: 0,
      failures: [{ code: "no_changes" }],
    });
    const countsBeforeEmptyExecution = {
      events: projectStore.database.prepare("select count(*) from events").pluck().get(),
      idempotency: projectStore.database
        .prepare("select count(*) from idempotency_records")
        .pluck()
        .get(),
      tasks: projectStore.database
        .prepare("select id, version, priority, not_before, due_at from tasks order by id")
        .all(),
    };
    const emptyExecution = await Effect.runPromise(
      Effect.either(
        executeBulkTasks(
          {
            intent: emptyIntent,
            previewToken: emptyPreview.previewToken,
            idempotencyKey: "reject-empty-filter-bulk",
          },
          human,
          bulkServices,
        ),
      ),
    );
    expect(Either.isLeft(emptyExecution) && emptyExecution.left["_tag"]).toBe(
      "BulkTaskPreviewValidationError",
    );
    expect({
      events: projectStore.database.prepare("select count(*) from events").pluck().get(),
      idempotency: projectStore.database
        .prepare("select count(*) from idempotency_records")
        .pluck()
        .get(),
      tasks: projectStore.database
        .prepare("select id, version, priority, not_before, due_at from tasks order by id")
        .all(),
    }).toEqual(countsBeforeEmptyExecution);

    const membershipIntent = { ...intent, patch: { notBefore: "2026-09-07" } };
    const membershipPreview = await Effect.runPromise(
      previewBulkTasks(membershipIntent, human, bulkServices),
    );
    await Effect.runPromise(
      createTask(
        taskInput({ title: "New matching high work", priority: "high" }),
        human,
        taskServices,
      ),
    );
    const membershipStale = await Effect.runPromise(
      Effect.either(
        executeBulkTasks(
          {
            intent: membershipIntent,
            previewToken: membershipPreview.previewToken,
            idempotencyKey: "stale-filter-membership-bulk",
          },
          human,
          bulkServices,
        ),
      ),
    );
    expect(Either.isLeft(membershipStale) && membershipStale.left["_tag"]).toBe(
      "BulkTaskPreviewStaleError",
    );
  });

  it("rejects stale target versions and requires explicit exclusive-tag removal", async () => {
    const tagged = await Effect.runPromise(
      createTask(
        taskInput({
          title: "Tagged task",
          tags: [
            {
              name: "frontend",
              description: "Browser work",
              color: "#2563eb",
              exclusiveGroup: "area",
            },
          ],
          requiredCapabilities: ["browser"],
        }),
        human,
        taskServices,
      ),
    );
    const catalogOwner = await Effect.runPromise(
      createTask(
        taskInput({
          title: "Backend catalog owner",
          tags: [
            {
              name: "backend",
              description: "Server work",
              color: "#16a34a",
              exclusiveGroup: "area",
            },
          ],
        }),
        human,
        taskServices,
      ),
    );
    const frontendId = tagged.tags[0]!.id;
    const backendId = catalogOwner.tags[0]!.id;
    const rejected = await Effect.runPromise(
      previewBulkTasks(
        updateIntent([tagged.id], { tags: { add: [backendId], remove: [] } }),
        human,
        bulkServices,
      ),
    );
    expect(rejected).toMatchObject({ executable: false, affectedCount: 0 });
    expect(rejected.targets[0]?.failures).toMatchObject([{ code: "exclusive_tag_conflict" }]);

    const intent = updateIntent([tagged.id], {
      tags: { add: [backendId], remove: [frontendId] },
    });
    const preview = await Effect.runPromise(previewBulkTasks(intent, human, bulkServices));
    await Effect.runPromise(
      updateTaskPlanning(
        {
          taskId: tagged.id,
          priority: "urgent",
          position: tagged.position,
          notBefore: null,
          dueAt: null,
          size: null,
          tags: tagged.tags.map(({ name, description, color, exclusiveGroup }) => ({
            name,
            description,
            color,
            exclusiveGroup,
          })),
          requiredCapabilities: tagged.requiredCapabilities,
          expectedVersion: tagged.version,
          idempotencyKey: "make-tag-preview-stale",
        },
        human,
        taskServices,
      ),
    );
    const stale = await Effect.runPromise(
      Effect.either(
        executeBulkTasks(
          {
            intent,
            previewToken: preview.previewToken,
            idempotencyKey: "stale-tag-bulk",
          },
          human,
          bulkServices,
        ),
      ),
    );

    expect(Either.isLeft(stale) && stale.left["_tag"]).toBe("BulkTaskPreviewStaleError");

    const replacementIntent = updateIntent([tagged.id], {
      tags: { add: [backendId], remove: [frontendId] },
      capabilities: { add: ["typescript"], remove: ["browser"] },
    });
    const replacementPreview = await Effect.runPromise(
      previewBulkTasks(replacementIntent, human, bulkServices),
    );
    const replacement = await Effect.runPromise(
      executeBulkTasks(
        {
          intent: replacementIntent,
          previewToken: replacementPreview.previewToken,
          idempotencyKey: "execute-tag-capability-bulk",
        },
        human,
        bulkServices,
      ),
    );
    const replacedTask = (await Effect.runPromise(listTasks({ projectId }, taskServices))).find(
      ({ id }) => id === tagged.id,
    );

    expect(replacement).toMatchObject({ affectedCount: 1 });
    expect(replacedTask).toMatchObject({
      version: tagged.version + 2,
      requiredCapabilities: ["typescript"],
    });
    expect(replacedTask?.tags.map(({ name }) => name)).toEqual(["backend"]);
  });

  it("bulk-creates consecutive tasks and rejects conflicting tag definitions before writing", async () => {
    const parent = await Effect.runPromise(
      createTask(taskInput({ title: "Existing parent" }), human, taskServices),
    );
    const intent = {
      schemaVersion: 1 as const,
      kind: "create" as const,
      projectId,
      reason: "Create the approved implementation slices",
      items: [
        createItem("draft-a", "First child", { parentTaskId: parent.id }),
        createItem("draft-b", "Second task", {
          lifecycle: "ready",
          expectedOutcome: "The second slice is complete.",
          acceptanceCriteria: "The second slice is verified.",
          checklist: [{ id: "verify", text: "Verify second slice", checked: false }],
        }),
      ],
    };
    const taskCount = projectStore.database.prepare("select count(*) from tasks").pluck().get();
    const preview = await Effect.runPromise(previewBulkTasks(intent, human, bulkServices));
    expect(projectStore.database.prepare("select count(*) from tasks").pluck().get()).toBe(
      taskCount,
    );
    const result = await Effect.runPromise(
      executeBulkTasks(
        {
          intent,
          previewToken: preview.previewToken,
          idempotencyKey: "execute-create-bulk",
        },
        human,
        bulkServices,
      ),
    );
    const created = (await Effect.runPromise(listTasks({ projectId }, taskServices))).filter(
      ({ id }) => result.items.some(({ taskId }) => taskId === id),
    );

    expect(created.map(({ sequence }) => sequence)).toEqual([
      parent.sequence + 1,
      parent.sequence + 2,
    ]);
    expect(created[0]?.parentTaskId).toBe(parent.id);
    expect(
      projectStore.database
        .prepare("select kind from events where cursor = ?")
        .pluck()
        .get(result.parentEventCursor),
    ).toBe("task.bulk.created");

    const conflictIntent = {
      schemaVersion: 1 as const,
      kind: "create" as const,
      projectId,
      reason: "Demonstrate deterministic tag validation",
      items: [
        createItem("tag-a", "First tag definition", {
          tags: [
            {
              name: "scope",
              description: "One",
              color: "#111111",
              exclusiveGroup: null,
            },
          ],
        }),
        createItem("tag-b", "Conflicting tag definition", {
          tags: [
            {
              name: "scope",
              description: "Two",
              color: "#222222",
              exclusiveGroup: null,
            },
          ],
        }),
      ],
    };
    const conflictPreview = await Effect.runPromise(
      previewBulkTasks(conflictIntent, human, bulkServices),
    );
    expect(conflictPreview.executable).toBe(false);
    expect(conflictPreview.targets[1]?.failures).toMatchObject([
      { code: "tag_definition_conflict" },
    ]);
    const countsBeforeInvalidExecute = {
      tasks: projectStore.database.prepare("select count(*) from tasks").pluck().get(),
      events: projectStore.database.prepare("select count(*) from events").pluck().get(),
    };
    const invalidExecution = await Effect.runPromise(
      Effect.either(
        executeBulkTasks(
          {
            intent: conflictIntent,
            previewToken: conflictPreview.previewToken,
            idempotencyKey: "invalid-create-bulk",
          },
          human,
          bulkServices,
        ),
      ),
    );
    expect(Either.isLeft(invalidExecution) && invalidExecution.left["_tag"]).toBe(
      "BulkTaskPreviewValidationError",
    );
    expect({
      tasks: projectStore.database.prepare("select count(*) from tasks").pluck().get(),
      events: projectStore.database.prepare("select count(*) from events").pluck().get(),
    }).toEqual(countsBeforeInvalidExecute);

    const sequenceIntent = {
      schemaVersion: 1 as const,
      kind: "create" as const,
      projectId,
      reason: "Verify that sequence allocation remains deterministic",
      items: [createItem("sequence-draft", "Sequence-sensitive task")],
    };
    const sequencePreview = await Effect.runPromise(
      previewBulkTasks(sequenceIntent, human, bulkServices),
    );
    await Effect.runPromise(
      createTask(taskInput({ title: "Intervening task" }), human, taskServices),
    );
    const taskCountAfterInterveningCreate = projectStore.database
      .prepare("select count(*) from tasks")
      .pluck()
      .get();
    const sequenceStale = await Effect.runPromise(
      Effect.either(
        executeBulkTasks(
          {
            intent: sequenceIntent,
            previewToken: sequencePreview.previewToken,
            idempotencyKey: "stale-create-sequence-bulk",
          },
          human,
          bulkServices,
        ),
      ),
    );
    expect(Either.isLeft(sequenceStale) && sequenceStale.left["_tag"]).toBe(
      "BulkTaskPreviewStaleError",
    );
    expect(projectStore.database.prepare("select count(*) from tasks").pluck().get()).toBe(
      taskCountAfterInterveningCreate,
    );
  });

  it("bulk-creates, sets, and clears typed custom fields with effective projections", async () => {
    const definition = insertNumberField();
    const createIntent = {
      schemaVersion: 1 as const,
      kind: "create" as const,
      projectId,
      reason: "Create work with reviewed structured metadata",
      items: [
        createItem("custom-draft", "Estimated work", {
          customFields: [
            {
              fieldId: definition.id,
              value: { type: "number" as const, value: 7 },
            },
          ],
        }),
      ],
    };
    const createPreview = await Effect.runPromise(
      previewBulkTasks(createIntent, human, bulkServices),
    );
    expect(createPreview.targets[0]?.changes[0]?.after).toMatchObject({
      customFields: {
        [definition.id]: {
          value: { type: "number", value: 7 },
          source: "explicit",
        },
      },
    });
    const created = await Effect.runPromise(
      executeBulkTasks(
        {
          intent: createIntent,
          previewToken: createPreview.previewToken,
          idempotencyKey: "bulk-create-custom-field",
        },
        human,
        bulkServices,
      ),
    );
    const taskId = created.items[0]!.taskId;
    expect(
      projectStore.database
        .prepare("select value_json from task_custom_field_values where task_id = ?")
        .pluck()
        .get(taskId),
    ).toBe(JSON.stringify({ type: "number", value: 7 }));
    const createdEventPayload = projectStore.database
      .prepare<[string], string>(
        "select payload_json from events where entity_id = ? and kind = 'task.created'",
      )
      .pluck()
      .get(taskId);
    expect(JSON.parse(createdEventPayload ?? "{}")).toMatchObject({
      customFields: [{ fieldId: definition.id, value: { type: "number", value: 7 } }],
      reviewModeOverride: null,
      reviewPolicy: { source: { level: "project", projectId } },
    });

    const clearIntent = updateIntent([taskId], {
      customFields: { set: [], clear: [definition.id] },
    });
    const clearPreview = await Effect.runPromise(
      previewBulkTasks(clearIntent, human, bulkServices),
    );
    expect(clearPreview.targets[0]?.changes).toMatchObject([
      {
        field: "customFields",
        before: {
          [definition.id]: {
            value: { type: "number", value: 7 },
            source: "explicit",
          },
        },
        after: {
          [definition.id]: {
            value: { type: "number", value: 3 },
            source: "default",
          },
        },
      },
    ]);
    const cleared = await Effect.runPromise(
      executeBulkTasks(
        {
          intent: clearIntent,
          previewToken: clearPreview.previewToken,
          idempotencyKey: "bulk-clear-custom-field",
        },
        human,
        bulkServices,
      ),
    );
    expect(
      projectStore.database
        .prepare("select count(*) from task_custom_field_values where task_id = ?")
        .pluck()
        .get(taskId),
    ).toBe(0);
    expect(cleared.items[0]).toMatchObject({ version: 2, changed: true });

    const setIntent = updateIntent([taskId], {
      customFields: {
        set: [
          {
            fieldId: definition.id,
            value: { type: "number", value: 5 },
          },
        ],
        clear: [],
      },
    });
    const setPreview = await Effect.runPromise(previewBulkTasks(setIntent, human, bulkServices));
    const setResult = await Effect.runPromise(
      executeBulkTasks(
        {
          intent: setIntent,
          previewToken: setPreview.previewToken,
          idempotencyKey: "bulk-set-custom-field",
        },
        human,
        bulkServices,
      ),
    );
    const projected = (await Effect.runPromise(listTasks({ projectId }, taskServices))).find(
      ({ id }) => id === taskId,
    );
    expect(setResult.items[0]).toMatchObject({ version: 3, changed: true });
    expect(projected?.customFields).toMatchObject([
      {
        definition: { id: definition.id },
        value: { type: "number", value: 5 },
        source: "explicit",
      },
    ]);
  });

  it("rejects invalid or retired custom-field writes atomically", async () => {
    const active = insertNumberField();
    const retired = insertNumberField({
      id: "field-retired",
      key: "retired_estimate",
      position: 1,
      retiredAt: "2026-09-04T11:00:00.000Z",
    });
    const target = await Effect.runPromise(
      createTask(taskInput({ title: "Custom validation target" }), human, taskServices),
    );
    const intent = updateIntent([target.id], {
      customFields: {
        set: [
          {
            fieldId: "field-missing",
            value: { type: "number", value: 1 },
          },
          {
            fieldId: retired.id,
            value: { type: "number", value: 1 },
          },
          {
            fieldId: active.id,
            value: { type: "number", value: 11 },
          },
        ],
        clear: [],
      },
    });
    const preview = await Effect.runPromise(previewBulkTasks(intent, human, bulkServices));
    expect(preview).toMatchObject({ executable: false, affectedCount: 0 });
    expect(preview.targets[0]?.failures.map(({ code }) => code)).toEqual([
      "custom_field_invalid_value",
      "custom_field_not_found",
      "custom_field_retired",
    ]);
    const before = {
      task: projectStore.database
        .prepare("select version, updated_at from tasks where id = ?")
        .get(target.id),
      values: projectStore.database
        .prepare("select * from task_custom_field_values where task_id = ?")
        .all(target.id),
      events: projectStore.database.prepare("select count(*) from events").pluck().get(),
    };
    const execution = await Effect.runPromise(
      Effect.either(
        executeBulkTasks(
          {
            intent,
            previewToken: preview.previewToken,
            idempotencyKey: "reject-invalid-custom-fields",
          },
          human,
          bulkServices,
        ),
      ),
    );
    expect(Either.isLeft(execution) && execution.left["_tag"]).toBe(
      "BulkTaskPreviewValidationError",
    );
    expect({
      task: projectStore.database
        .prepare("select version, updated_at from tasks where id = ?")
        .get(target.id),
      values: projectStore.database
        .prepare("select * from task_custom_field_values where task_id = ?")
        .all(target.id),
      events: projectStore.database.prepare("select count(*) from events").pluck().get(),
    }).toEqual(before);
  });

  it("invalidates a preview when custom-field definition state changes", async () => {
    const definition = insertNumberField();
    const target = await Effect.runPromise(
      createTask(taskInput({ title: "Definition-sensitive task" }), human, taskServices),
    );
    const intent = updateIntent([target.id], {
      customFields: {
        set: [
          {
            fieldId: definition.id,
            value: { type: "number", value: 5 },
          },
        ],
        clear: [],
      },
    });
    const preview = await Effect.runPromise(previewBulkTasks(intent, human, bulkServices));
    projectStore.database
      .prepare("update custom_field_definitions set display_label = ?, updated_at = ? where id = ?")
      .run("Updated estimate", "2026-09-04T13:00:00.000Z", definition.id);

    const execution = await Effect.runPromise(
      Effect.either(
        executeBulkTasks(
          {
            intent,
            previewToken: preview.previewToken,
            idempotencyKey: "stale-custom-field-definition",
          },
          human,
          bulkServices,
        ),
      ),
    );
    expect(Either.isLeft(execution) && execution.left["_tag"]).toBe("BulkTaskPreviewStaleError");
    expect(
      projectStore.database
        .prepare("select count(*) from task_custom_field_values where task_id = ?")
        .pluck()
        .get(target.id),
    ).toBe(0);
    expect(
      projectStore.database
        .prepare("select version from tasks where id = ?")
        .pluck()
        .get(target.id),
    ).toBe(target.version);
  });

  it("rolls all projections, parent/child events, and idempotency back when a later child event fails", async () => {
    const first = await Effect.runPromise(
      createTask(taskInput({ title: "Rollback first" }), human, taskServices),
    );
    const second = await Effect.runPromise(
      createTask(taskInput({ title: "Rollback second" }), human, taskServices),
    );
    const intent = updateIntent([first.id, second.id]);
    const preview = await Effect.runPromise(previewBulkTasks(intent, human, bulkServices));
    const eventCount = projectStore.database.prepare("select count(*) from events").pluck().get();
    projectStore.database.exec(`
      create trigger reject_second_bulk_child
      before insert on events
      when NEW.kind = 'task.planning.updated'
       and exists (
         select 1 from events
         where kind = 'task.planning.updated'
           and json_extract(payload_json, '$.operationId') = json_extract(NEW.payload_json, '$.operationId')
       )
      begin select raise(abort, 'second bulk child rejected'); end;
    `);

    const loggedFailures: string[] = [];
    vi.spyOn(process.stderr, "write").mockImplementation((chunk) => {
      loggedFailures.push(String(chunk));
      return true;
    });
    const result = await Effect.runPromise(
      Effect.either(
        executeBulkTasks(
          {
            intent,
            previewToken: preview.previewToken,
            idempotencyKey: "rollback-bulk",
          },
          human,
          bulkServices,
        ),
      ),
    );
    const stored = await Effect.runPromise(listTasks({ projectId }, taskServices));

    expect(Either.isLeft(result)).toBe(true);
    if (!Either.isLeft(result)) throw new Error("Expected the bulk transaction to fail.");
    if (result.left["_tag"] !== "BulkTaskPersistenceError") {
      throw new Error(`Expected a persistence error, received ${result.left["_tag"]}.`);
    }
    expect(result.left).toMatchObject({
      _tag: "BulkTaskPersistenceError",
      message: "The bulk task database operation failed.",
      correlationId: expect.stringMatching(/^[0-9a-f-]{36}$/),
    });
    expect(result.left.message).not.toContain("second bulk child rejected");
    expect(loggedFailures.join("\n")).toContain(result.left.correlationId);
    expect(loggedFailures.join("\n")).toContain("second bulk child rejected");
    expect(stored.find(({ id }) => id === first.id)).toMatchObject({
      priority: first.priority,
      version: first.version,
    });
    expect(stored.find(({ id }) => id === second.id)).toMatchObject({
      priority: second.priority,
      version: second.version,
    });
    expect(projectStore.database.prepare("select count(*) from events").pluck().get()).toBe(
      eventCount,
    );
    expect(
      projectStore.database
        .prepare("select count(*) from idempotency_records where key = 'rollback-bulk'")
        .pluck()
        .get(),
    ).toBe(0);
  });
});
