import { mkdir, mkdtemp, rm } from "node:fs/promises";
import { join } from "node:path";
import { tmpdir } from "node:os";

import { Effect, Either } from "effect";
import { afterEach, beforeEach, describe, expect, it } from "vitest";

import { createHumanActivityEntry, withdrawActivityEntry } from "./activity";
import { createProject } from "./projects";
import {
  archiveSavedView,
  createSavedView,
  listSavedViews,
  restoreSavedView,
  searchTasks,
  updateSavedView,
  type TaskQueryServices,
} from "./task-queries";
import { createTask, createTaskRelation, listTasks, type TaskServices } from "./tasks";
import { defaultTaskSearchOrder, type TaskFilterV1 } from "../domain/task-filters";
import { emptyRichTextDocument, type CreateTaskInput } from "../domain/tasks";
import { localRepositoryInspector } from "../infrastructure/repository-inspector.server";
import { createSqliteActivityStore } from "../infrastructure/sqlite-activity-store.server";
import {
  createSqliteProjectStore,
  type SqliteProjectStore,
} from "../infrastructure/sqlite-project-store.server";
import { createSqliteTaskQueryStore } from "../infrastructure/sqlite-task-query-store.server";
import { createSqliteTaskStore } from "../infrastructure/sqlite-task-store.server";

const human = { type: "human", id: "local-human" } as const;
let temporaryRoot: string;
let projectStore: SqliteProjectStore;
let projectId: string;
let taskServices: TaskServices;
let queryServices: TaskQueryServices;
let now: string;

function taskInput(key: string, overrides: Partial<CreateTaskInput> = {}): CreateTaskInput {
  return {
    projectId,
    parentTaskId: null,
    lifecycle: "backlog",
    title: `Task ${key}`,
    description: emptyRichTextDocument,
    expectedOutcome: "",
    acceptanceCriteria: "",
    agentContext: "",
    checklist: [],
    expectedVersion: 0,
    idempotencyKey: `create-${key}`,
    ...overrides,
    referencedPaths: overrides.referencedPaths ?? [],
  };
}

function filter(overrides: Partial<TaskFilterV1> = {}): TaskFilterV1 {
  return {
    schemaVersion: 1,
    projectId,
    archiveState: "exclude",
    ...overrides,
  };
}

function runSearch(taskFilter: TaskFilterV1, limit = 50, cursor: string | null = null) {
  return Effect.runPromise(searchTasks({ filter: taskFilter, limit, cursor }, [], queryServices));
}

function insertCustomFieldDefinition(input: {
  readonly id: string;
  readonly key: string;
  readonly type: "text" | "number" | "boolean" | "date" | "single_select";
  readonly validation: unknown;
  readonly defaultValue?: unknown;
  readonly position: number;
  readonly retiredAt?: string | null;
}) {
  projectStore.database
    .prepare(
      `insert into custom_field_definitions (
        id, project_id, field_key, type, validation_json, default_value_json,
        display_label, description, position, retired_at, created_at, updated_at
      ) values (?, ?, ?, ?, ?, ?, ?, '', ?, ?, ?, ?)`,
    )
    .run(
      input.id,
      projectId,
      input.key,
      input.type,
      JSON.stringify(input.validation),
      input.defaultValue === undefined || input.defaultValue === null
        ? null
        : JSON.stringify(input.defaultValue),
      input.key,
      input.position,
      input.retiredAt ?? null,
      now,
      now,
    );
}

function setExplicitCustomFieldValue(taskId: string, definitionId: string, value: unknown) {
  projectStore.database
    .prepare(
      `insert into task_custom_field_values (task_id, definition_id, value_json, updated_at)
       values (?, ?, ?, ?)`,
    )
    .run(taskId, definitionId, JSON.stringify(value), now);
}

beforeEach(async () => {
  temporaryRoot = await mkdtemp(join(tmpdir(), "helm-task-query-test-"));
  const repositoryRoot = join(temporaryRoot, "repository");
  await mkdir(join(repositoryRoot, ".git"), { recursive: true });
  projectStore = createSqliteProjectStore(join(temporaryRoot, "helm.db"));
  const project = await Effect.runPromise(
    createProject(
      { repositoryRoot, idempotencyKey: "create-project" },
      { store: projectStore, inspector: localRepositoryInspector },
    ),
  );
  projectId = project.id;
  now = "2026-09-04T10:00:00.000Z";
  taskServices = {
    store: createSqliteTaskStore(projectStore.database),
    clock: { today: () => "2026-09-04", now: () => now },
  };
  queryServices = {
    store: createSqliteTaskQueryStore(projectStore.database),
    clock: { today: () => "2026-09-04", now: () => now },
  };
});

afterEach(async () => {
  projectStore.close();
  await rm(temporaryRoot, { recursive: true, force: true });
});

describe("task query application seam", () => {
  it("searches every source and removes withdrawn or rolled-back activity atomically", async () => {
    const task = await Effect.runPromise(
      createTask(
        taskInput("aurora", {
          title: "Aurora investigation",
          description: {
            version: 1,
            doc: {
              type: "doc",
              content: [{ type: "paragraph", content: [{ type: "text", text: "Nebula body" }] }],
            },
          },
          expectedOutcome: "Orbit is stable.",
          acceptanceCriteria: "Quasar evidence is attached.",
          agentContext: "Use the telescope.",
        }),
        human,
        taskServices,
      ),
    );

    const sourcePages = await Promise.all(
      (
        [
          ["Aurora", "title"],
          ["Nebula", "task_content"],
          ["Quasar", "acceptance_criteria"],
        ] as const
      ).map(async ([text, source]) => ({
        source,
        page: await runSearch(filter({ search: { text, mode: "all" } })),
      })),
    );
    for (const { page, source } of sourcePages) {
      expect(page.items).toHaveLength(1);
      expect(page.items[0]?.matchedSources).toContain(source);
    }

    const crossColumn = await runSearch(filter({ search: { text: "Aurora Quasar", mode: "all" } }));
    expect(crossColumn.items[0]?.matchedSources).toEqual(
      expect.arrayContaining(["title", "acceptance_criteria"]),
    );

    projectStore.database
      .prepare("update tasks set title = ? where id = ?")
      .run("Zenith investigation", task.id);
    expect(
      (await runSearch(filter({ search: { text: "Zenith", mode: "all" } }))).items[0]
        ?.matchedSources,
    ).toContain("title");
    expect(
      (await runSearch(filter({ search: { text: "Aurora", mode: "all" } }))).items,
    ).toHaveLength(0);

    const activityServices = {
      store: createSqliteActivityStore(projectStore.database),
      clock: { now: () => now },
    };
    const entry = await Effect.runPromise(
      createHumanActivityEntry(
        {
          entryId: "query-comment",
          projectId,
          taskId: task.id,
          kind: "comment",
          content: {
            version: 1,
            doc: {
              type: "doc",
              content: [
                { type: "paragraph", content: [{ type: "text", text: "Chromatic resonance" }] },
              ],
            },
          },
          expectedTaskVersion: task.version,
          idempotencyKey: "query-comment-create",
        },
        human,
        activityServices,
      ),
    );
    expect(
      (await runSearch(filter({ search: { text: "Chromatic", mode: "all" } }))).items[0]
        ?.matchedSources,
    ).toContain("comments");

    now = "2026-09-04T10:05:00.000Z";
    await Effect.runPromise(
      withdrawActivityEntry(
        {
          projectId,
          entryId: entry.entry.id,
          expectedTaskVersion: entry.taskVersion,
          reason: "The observation was incorrect.",
          idempotencyKey: "query-comment-withdraw",
        },
        human,
        activityServices,
      ),
    );
    expect(
      (await runSearch(filter({ search: { text: "Chromatic", mode: "all" } }))).items,
    ).toHaveLength(0);

    projectStore.database
      .prepare(
        `insert into attempts (
          id, task_id, attempt_number, agent_run_id, agent_profile_id, agent_display_name,
          status, summary, changed_areas_json, verification_json, references_json,
          risks_json, follow_up_work_json, failure_classification, created_at, completed_at
        ) values (?, ?, 1, null, null, null, 'active', '', '[]', '[]', '[]', '[]', '[]',
          null, ?, null)`,
      )
      .run("query-attempt", task.id, now);
    expect(
      (await runSearch(filter({ search: { text: "Polarimeter", mode: "all" } }))).items,
    ).toHaveLength(0);
    projectStore.database
      .prepare(
        `update attempts
         set status = 'failed', summary = ?, verification_json = ?,
             failure_classification = 'verification', completed_at = ?
         where id = ?`,
      )
      .run(
        "Spectrometer calibration failed.",
        JSON.stringify([{ name: "Polarimeter", status: "failed", details: "Mismatch" }]),
        now,
        "query-attempt",
      );
    expect(
      (await runSearch(filter({ search: { text: "Polarimeter", mode: "all" } }))).items[0]
        ?.matchedSources,
    ).toContain("reports");
    projectStore.database.prepare("delete from attempts where id = ?").run("query-attempt");
    expect(
      (await runSearch(filter({ search: { text: "Polarimeter", mode: "all" } }))).items,
    ).toHaveLength(0);

    expect(() =>
      projectStore.database.transaction(() => {
        projectStore.database
          .prepare(
            `insert into activity_entries (
              id, project_id, task_id, attempt_id, kind, author_type, author_id,
              author_display_name, agent_profile_id, agent_run_id, content_json, content_text,
              created_at, withdrawn_at, withdrawn_by_type, withdrawn_by_id, withdrawal_reason
            ) values (?, ?, ?, null, 'comment', 'human', 'local-human', 'You', null, null,
              '{}', 'Rollback-only comet', ?, null, null, null, null)`,
          )
          .run("rollback-entry", projectId, task.id, now);
        throw new Error("rollback");
      })(),
    ).toThrow("rollback");
    expect(
      (await runSearch(filter({ search: { text: "comet", mode: "all" } }))).items,
    ).toHaveLength(0);

    await expect(
      runSearch(filter({ search: { text: `" OR *`, mode: "any" } })),
    ).resolves.toMatchObject({ items: expect.any(Array) });
  });

  it("combines lifecycle, eligibility, priority, tag, capability, actor, date, and relation clauses", async () => {
    const dependency = await Effect.runPromise(
      createTask(taskInput("dependency"), human, taskServices),
    );
    const target = await Effect.runPromise(
      createTask(
        taskInput("combined", {
          lifecycle: "ready",
          title: "Combined filter target",
          expectedOutcome: "The combined query finds this task.",
          acceptanceCriteria: "Every structured clause matches.",
          checklist: [{ id: "combined-check", text: "Run query", checked: false }],
          priority: "high",
          dueAt: "2026-09-10",
          tags: [
            {
              name: "search",
              description: "Search work",
              color: "#2563eb",
              exclusiveGroup: null,
            },
          ],
          requiredCapabilities: ["typescript"],
        }),
        human,
        taskServices,
      ),
    );
    await Effect.runPromise(
      createTaskRelation(
        {
          projectId,
          sourceTaskId: dependency.id,
          targetTaskId: target.id,
          type: "blocks",
          expectedSourceVersion: dependency.version,
          expectedTargetVersion: target.version,
          idempotencyKey: "combined-relation",
        },
        human,
        taskServices,
      ),
    );
    const currentTarget = (await Effect.runPromise(listTasks({ projectId }, taskServices))).find(
      ({ id }) => id === target.id,
    );
    if (!currentTarget) throw new Error("Expected target task");
    const activityServices = {
      store: createSqliteActivityStore(projectStore.database),
      clock: { now: () => now },
    };
    await Effect.runPromise(
      createHumanActivityEntry(
        {
          entryId: "combined-comment",
          projectId,
          taskId: target.id,
          kind: "comment",
          content: {
            version: 1,
            doc: {
              type: "doc",
              content: [{ type: "paragraph", content: [{ type: "text", text: "Reviewed" }] }],
            },
          },
          expectedTaskVersion: currentTarget.version,
          idempotencyKey: "combined-comment-key",
        },
        human,
        activityServices,
      ),
    );

    const page = await runSearch(
      filter({
        lifecycles: ["ready"],
        eligibility: ["blocked"],
        priorities: ["high"],
        tags: { operator: "all_of", values: [target.tags[0]!.id] },
        capabilities: { operator: "all_of", values: ["typescript"] },
        actor: {
          operator: "any_of",
          actors: [{ type: "human", id: "local-human" }],
          sources: ["activity"],
        },
        dates: [{ field: "due_at", operator: "between", from: "2026-09-09", to: "2026-09-11" }],
        relations: [
          {
            direction: "upstream",
            operator: "exists",
            types: ["blocks"],
            taskIds: [dependency.id],
          },
        ],
      }),
    );
    expect(page.items.map(({ task }) => task.id)).toEqual([target.id]);
    expect(page.items[0]?.task.eligibility?.status).toBe("blocked");
  });

  it("queries explicit, effective-default, missing, and retired historical custom-field values", async () => {
    const explicit = await Effect.runPromise(
      createTask(taskInput("custom-explicit"), human, taskServices),
    );
    const inherited = await Effect.runPromise(
      createTask(taskInput("custom-default"), human, taskServices),
    );
    insertCustomFieldDefinition({
      id: "field-summary",
      key: "summary",
      type: "text",
      validation: { minLength: 0, maxLength: 20_000 },
      defaultValue: { type: "text", value: "Default backlog" },
      position: 0,
    });
    insertCustomFieldDefinition({
      id: "field-score",
      key: "score",
      type: "number",
      validation: { min: null, max: null, integer: false },
      position: 1,
    });
    insertCustomFieldDefinition({
      id: "field-retired",
      key: "retired_evidence",
      type: "text",
      validation: { minLength: 0, maxLength: 20_000 },
      position: 2,
      retiredAt: "2026-09-04T09:00:00.000Z",
    });
    setExplicitCustomFieldValue(explicit.id, "field-summary", {
      type: "text",
      value: "Urgent customer queue",
    });
    setExplicitCustomFieldValue(explicit.id, "field-score", { type: "number", value: 7 });
    setExplicitCustomFieldValue(explicit.id, "field-retired", {
      type: "text",
      value: "Legacy evidence",
    });

    const contains = await runSearch(
      filter({
        customFields: [
          {
            fieldId: "field-summary",
            operator: "contains",
            value: { type: "text", value: "CUSTOMER" },
          },
        ],
      }),
    );
    expect(contains.items.map(({ task }) => task.id)).toEqual([explicit.id]);

    const inheritedDefault = await runSearch(
      filter({
        customFields: [
          {
            fieldId: "field-summary",
            operator: "equals",
            value: { type: "text", value: "Default backlog" },
          },
        ],
      }),
    );
    expect(inheritedDefault.items.map(({ task }) => task.id)).toEqual([inherited.id]);
    expect(inheritedDefault.items[0]?.task.customFields[0]).toMatchObject({ source: "default" });

    const numeric = await runSearch(
      filter({
        customFields: [
          {
            fieldId: "field-score",
            operator: "greater_than",
            value: { type: "number", value: 5 },
          },
        ],
      }),
    );
    expect(numeric.items.map(({ task }) => task.id)).toEqual([explicit.id]);

    const missing = await runSearch(
      filter({ customFields: [{ fieldId: "field-score", operator: "missing" }] }),
    );
    expect(missing.items.map(({ task }) => task.id)).toEqual([inherited.id]);

    const historical = await runSearch(
      filter({
        customFields: [
          {
            fieldId: "field-retired",
            operator: "equals",
            value: { type: "text", value: "Legacy evidence" },
          },
        ],
      }),
    );
    expect(historical.items.map(({ task }) => task.id)).toEqual([explicit.id]);
    expect(historical.items[0]?.task.customFields).toEqual(
      expect.arrayContaining([
        expect.objectContaining({
          definition: expect.objectContaining({
            id: "field-retired",
            retiredAt: expect.any(String),
          }),
          source: "explicit",
        }),
      ]),
    );

    const savedFilter = filter({
      customFields: [
        {
          fieldId: "field-summary",
          operator: "equals",
          value: { type: "text", value: "Default backlog" },
        },
      ],
    });
    const savedView = await Effect.runPromise(
      createSavedView(
        {
          projectId,
          name: "Default backlog",
          definition: {
            schemaVersion: 1,
            filter: savedFilter,
            order: defaultTaskSearchOrder(savedFilter),
            grouping: { type: "none" },
            visibleFields: ["title", "lifecycle", "priority"],
            presentation: "list",
          },
          idempotencyKey: "saved-custom-field-view",
        },
        human,
        queryServices,
      ),
    );
    const retiredAfterTasks = new Date(
      Math.max(Date.parse(explicit.createdAt), Date.parse(inherited.createdAt)) + 1_000,
    ).toISOString();
    projectStore.database
      .prepare(
        "update custom_field_definitions set retired_at = ?, updated_at = ? where id = 'field-summary'",
      )
      .run(retiredAfterTasks, retiredAfterTasks);
    const [persistedView] = await Effect.runPromise(listSavedViews({ projectId }, queryServices));
    expect(persistedView?.id).toBe(savedView.id);
    await expect(runSearch(persistedView!.definition.filter)).resolves.toMatchObject({
      items: [{ task: expect.objectContaining({ id: inherited.id }) }],
    });
  });

  it("rejects unknown, type-mismatched, and unknown-option field clauses", async () => {
    const task = await Effect.runPromise(
      createTask(taskInput("custom-validation"), human, taskServices),
    );
    insertCustomFieldDefinition({
      id: "field-score",
      key: "score",
      type: "number",
      validation: { min: null, max: null, integer: false },
      position: 0,
    });
    insertCustomFieldDefinition({
      id: "field-retired-history",
      key: "retired_history",
      type: "text",
      validation: { minLength: 0, maxLength: 20_000 },
      position: 1,
      retiredAt: "2026-09-04T09:00:00.000Z",
    });
    insertCustomFieldDefinition({
      id: "field-retired-empty",
      key: "retired_empty",
      type: "text",
      validation: { minLength: 0, maxLength: 20_000 },
      position: 2,
      retiredAt: "2026-09-04T09:00:00.000Z",
    });
    insertCustomFieldDefinition({
      id: "field-risk",
      key: "risk",
      type: "single_select",
      validation: { options: [{ id: "high", label: "High" }] },
      position: 3,
    });
    setExplicitCustomFieldValue(task.id, "field-retired-history", {
      type: "text",
      value: "Preserved",
    });

    const invalidFilters: Array<{
      readonly clause: NonNullable<TaskFilterV1["customFields"]>[number];
      readonly issue: RegExp;
    }> = [
      {
        clause: { fieldId: "field-unknown", operator: "present" },
        issue: /does not exist/i,
      },
      {
        clause: {
          fieldId: "field-score",
          operator: "equals",
          value: { type: "text", value: "seven" },
        },
        issue: /type number, not text/i,
      },
      {
        clause: {
          fieldId: "field-risk",
          operator: "equals",
          value: { type: "single_select", value: "unknown" },
        },
        issue: /does not define option unknown/i,
      },
    ];

    const results = await Promise.all(
      invalidFilters.map(({ clause }) =>
        Effect.runPromise(
          Effect.either(
            searchTasks({ filter: filter({ customFields: [clause] }) }, [], queryServices),
          ),
        ),
      ),
    );
    for (const [index, result] of results.entries()) {
      expect(Either.isLeft(result) && result.left).toMatchObject({
        _tag: "InvalidTaskQueryError",
        issues: [expect.stringMatching(invalidFilters[index]!.issue)],
      });
    }

    await expect(
      runSearch(
        filter({
          customFields: [{ fieldId: "field-retired-history", operator: "missing" }],
        }),
      ),
    ).resolves.toMatchObject({ items: [] });
    await expect(
      runSearch(
        filter({
          customFields: [{ fieldId: "field-retired-empty", operator: "present" }],
        }),
      ),
    ).resolves.toMatchObject({ items: [] });
  });

  it("paginates deterministically and rejects mismatched or stale cursors", async () => {
    await Promise.all(
      ["one", "two", "three"].map((key) =>
        Effect.runPromise(createTask(taskInput(key), human, taskServices)),
      ),
    );
    const pageOne = await runSearch(filter(), 1);
    expect(pageOne.items).toHaveLength(1);
    expect(pageOne.hasMore).toBe(true);
    expect(pageOne.nextCursor).toMatch(/^tq1:/);
    const pageTwo = await runSearch(filter(), 1, pageOne.nextCursor);
    expect(pageTwo.items).toHaveLength(1);
    expect(pageTwo.items[0]?.task.id).not.toBe(pageOne.items[0]?.task.id);

    const mismatch = await Effect.runPromise(
      Effect.either(
        searchTasks(
          {
            filter: filter({ lifecycles: ["ready"] }),
            limit: 1,
            cursor: pageOne.nextCursor,
          },
          [],
          queryServices,
        ),
      ),
    );
    expect(Either.isLeft(mismatch) && mismatch.left).toMatchObject({
      _tag: "TaskQueryCursorError",
      reason: "query_mismatch",
    });

    await Effect.runPromise(createTask(taskInput("revision-change"), human, taskServices));
    const stale = await Effect.runPromise(
      Effect.either(
        searchTasks({ filter: filter(), limit: 1, cursor: pageOne.nextCursor }, [], queryServices),
      ),
    );
    expect(Either.isLeft(stale) && stale.left).toMatchObject({
      _tag: "TaskQueryCursorError",
      reason: "stale",
      cursorRevision: pageOne.revision,
    });
  });

  it("keeps relevance ordering and cursors isolated from another project's FTS corpus", async () => {
    const first = await Effect.runPromise(
      createTask(taskInput("xray", { title: "Xray signal" }), human, taskServices),
    );
    const second = await Effect.runPromise(
      createTask(taskInput("yankee", { title: "Yankee signal" }), human, taskServices),
    );
    const searchFilter = filter({ search: { text: "xray yankee", mode: "any" } });
    const firstPage = await runSearch(searchFilter, 1);
    expect(firstPage.items.map(({ task }) => task.id)).toEqual([first.id]);

    const otherRepositoryRoot = join(temporaryRoot, "repository-two");
    await mkdir(join(otherRepositoryRoot, ".git"), { recursive: true });
    const otherProject = await Effect.runPromise(
      createProject(
        { repositoryRoot: otherRepositoryRoot, idempotencyKey: "create-project-two" },
        { store: projectStore, inspector: localRepositoryInspector },
      ),
    );
    await Promise.all(
      Array.from({ length: 12 }, (_, index) =>
        Effect.runPromise(
          createTask(
            taskInput(`other-xray-${index}`, {
              projectId: otherProject.id,
              title: `Xray corpus task ${index}`,
            }),
            human,
            taskServices,
          ),
        ),
      ),
    );

    const secondPage = await runSearch(searchFilter, 1, firstPage.nextCursor);
    expect(secondPage.items.map(({ task }) => task.id)).toEqual([second.id]);
    expect(secondPage.hasMore).toBe(false);
  });

  it("persists versioned saved views with idempotency, conflicts, archive, restore, and events", async () => {
    const savedFilter = filter({ lifecycles: ["ready"], priorities: ["urgent", "high"] });
    const definition = {
      schemaVersion: 1 as const,
      filter: savedFilter,
      order: defaultTaskSearchOrder(savedFilter),
      grouping: { type: "lifecycle" as const },
      visibleFields: ["title", "lifecycle", "priority"] as const,
      presentation: "board" as const,
    };
    const createInput = {
      projectId,
      name: "Review radar",
      definition,
      idempotencyKey: "create-review-radar",
    };
    const created = await Effect.runPromise(createSavedView(createInput, human, queryServices));
    const retried = await Effect.runPromise(createSavedView(createInput, human, queryServices));
    expect(retried).toEqual(created);
    expect(await Effect.runPromise(listSavedViews({ projectId }, queryServices))).toEqual([
      created,
    ]);

    now = "2026-09-04T11:00:00.000Z";
    const updated = await Effect.runPromise(
      updateSavedView(
        {
          ...createInput,
          savedViewId: created.id,
          name: "Ready radar",
          expectedVersion: created.version,
          idempotencyKey: "update-review-radar",
        },
        human,
        queryServices,
      ),
    );
    expect(updated).toMatchObject({ name: "Ready radar", version: 2 });

    const stale = await Effect.runPromise(
      Effect.either(
        updateSavedView(
          {
            ...createInput,
            savedViewId: created.id,
            expectedVersion: 1,
            idempotencyKey: "stale-review-radar",
          },
          human,
          queryServices,
        ),
      ),
    );
    expect(Either.isLeft(stale) && stale.left).toMatchObject({
      _tag: "SavedViewVersionConflictError",
      currentVersion: 2,
    });

    now = "2026-09-04T12:00:00.000Z";
    const archived = await Effect.runPromise(
      archiveSavedView(
        {
          projectId,
          savedViewId: updated.id,
          expectedVersion: updated.version,
          reason: "Temporarily hide this queue.",
          idempotencyKey: "archive-review-radar",
        },
        human,
        queryServices,
      ),
    );
    expect(archived.archivedAt).toBe(now);
    expect(await Effect.runPromise(listSavedViews({ projectId }, queryServices))).toEqual([]);

    now = "2026-09-04T13:00:00.000Z";
    const restored = await Effect.runPromise(
      restoreSavedView(
        {
          projectId,
          savedViewId: archived.id,
          expectedVersion: archived.version,
          reason: "The queue is useful again.",
          idempotencyKey: "restore-review-radar",
        },
        human,
        queryServices,
      ),
    );
    expect(restored).toMatchObject({ archivedAt: null, version: 4 });
    const viewEvents = projectStore.database
      .prepare<
        [],
        {
          kind: string;
          actorType: string;
          actorId: string;
          payloadJson: string;
          changesJson: string;
        }
      >(
        `select kind, actor_type as actorType, actor_id as actorId,
                payload_json as payloadJson, changes_json as changesJson
         from events where entity_type = 'saved_view' order by cursor`,
      )
      .all();
    expect(viewEvents.map(({ kind }) => kind)).toEqual([
      "saved_view.created",
      "saved_view.updated",
      "saved_view.archived",
      "saved_view.restored",
    ]);
    expect(viewEvents[0]).toMatchObject({ actorType: "human", actorId: "local-human" });
    expect(JSON.parse(viewEvents[0]!.payloadJson)).toEqual({ name: "Review radar", version: 1 });
    expect(JSON.parse(viewEvents[0]!.changesJson)).toMatchObject({
      projectIds: [projectId],
      savedViewIds: [created.id],
      scopes: ["views"],
    });
  });

  it("rolls back a saved view and its idempotency record when audit insertion fails", async () => {
    projectStore.database.exec(`
      create trigger reject_saved_view_event before insert on events
      when NEW.entity_type = 'saved_view'
      begin
        select raise(abort, 'audit unavailable');
      end;
    `);
    const savedFilter = filter();
    const result = await Effect.runPromise(
      Effect.either(
        createSavedView(
          {
            projectId,
            name: "Must be atomic",
            definition: {
              schemaVersion: 1,
              filter: savedFilter,
              order: defaultTaskSearchOrder(savedFilter),
              grouping: { type: "none" },
              visibleFields: ["title"],
              presentation: "list",
            },
            idempotencyKey: "atomic-saved-view",
          },
          human,
          queryServices,
        ),
      ),
    );

    expect(Either.isLeft(result) && result.left).toMatchObject({
      _tag: "TaskQueryPersistenceError",
    });
    expect(projectStore.database.prepare("select count(*) from saved_views").pluck().get()).toBe(0);
    expect(
      projectStore.database
        .prepare("select count(*) from idempotency_records where key = ?")
        .pluck()
        .get("atomic-saved-view"),
    ).toBe(0);
  });

  it("rejects malformed saved-view definitions before persistence", async () => {
    const result = await Effect.runPromise(
      Effect.either(
        createSavedView(
          {
            projectId,
            name: "Broken view",
            definition: {
              schemaVersion: 1,
              filter: filter(),
              order: [{ field: "unknown", direction: "asc" }],
              grouping: { type: "none" },
              visibleFields: ["title"],
              presentation: "list",
            },
            idempotencyKey: "broken-view",
          },
          human,
          queryServices,
        ),
      ),
    );
    expect(Either.isLeft(result) && result.left).toMatchObject({
      _tag: "InvalidTaskQueryError",
    });
    expect(projectStore.database.prepare("select count(*) from saved_views").pluck().get()).toBe(0);
  });
});
