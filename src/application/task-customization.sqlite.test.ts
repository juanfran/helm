import { mkdir, mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { Effect, Either } from "effect";
import { afterEach, beforeEach, describe, expect, it } from "vitest";

import { registerAgentRun } from "./agents";
import { createProject, setProjectReviewMode } from "./projects";
import {
  claimTask,
  completeTask,
  createTask,
  getTaskContext,
  listTasks,
  prepareTask,
  setTaskReviewModeOverride,
  updateTaskPlanning,
  type TaskServices,
} from "./tasks";
import {
  emptyRichTextDocument,
  type Actor,
  type CreateTaskInput,
  type Task,
} from "../domain/tasks";
import { createSqliteAgentStore } from "../infrastructure/sqlite-agent-store.server";
import {
  createSqliteProjectStore,
  type SqliteProjectStore,
} from "../infrastructure/sqlite-project-store.server";
import { createSqliteTaskStore } from "../infrastructure/sqlite-task-store.server";
import { localRepositoryInspector } from "../infrastructure/repository-inspector.server";

const human: Actor = { type: "human", id: "local-human" };
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
    title: "Customized work",
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

function readyTaskInput(overrides: Partial<CreateTaskInput> = {}) {
  return taskInput({
    lifecycle: "ready",
    expectedOutcome: "The customization behavior is observable.",
    acceptanceCriteria: "The completion route matches the resolved policy.",
    checklist: [{ id: "verify", text: "Verify the policy", checked: false }],
    ...overrides,
  });
}

function planningInput(task: Task, overrides: Record<string, unknown> = {}) {
  return {
    taskId: task.id,
    priority: task.priority,
    position: task.position,
    notBefore: task.notBefore,
    dueAt: task.dueAt,
    size: task.size,
    tags: task.tags.map(({ name, description, color, exclusiveGroup }) => ({
      name,
      description,
      color,
      exclusiveGroup,
    })),
    requiredCapabilities: [...task.requiredCapabilities],
    expectedVersion: task.version,
    idempotencyKey: crypto.randomUUID(),
    ...overrides,
  };
}

function insertDefinition(input: {
  id: string;
  key: string;
  type: "text" | "number";
  validation: object;
  defaultValue: object | null;
  position: number;
}) {
  projectStore.database
    .prepare(
      `insert into custom_field_definitions (
        id, project_id, field_key, type, validation_json, default_value_json,
        display_label, description, position, retired_at, created_at, updated_at
      ) values (?, ?, ?, ?, ?, ?, ?, '', ?, null, ?, ?)`,
    )
    .run(
      input.id,
      projectId,
      input.key,
      input.type,
      JSON.stringify(input.validation),
      input.defaultValue === null ? null : JSON.stringify(input.defaultValue),
      input.key,
      input.position,
      now,
      now,
    );
}

async function registerCompleter(key: string) {
  return Effect.runPromise(
    registerAgentRun(
      {
        profileKey: `profile-${key}`,
        displayName: "Completion agent",
        capabilities: [],
        idempotencyKey: `register-${key}`,
      },
      { sessionId: `session-${key}`, clientName: "test", clientVersion: "1" },
      { store: createSqliteAgentStore(projectStore.database) },
    ),
  );
}

async function complete(task: Task, key: string) {
  const registration = await registerCompleter(key);
  const grant = await Effect.runPromise(
    claimTask(
      {
        projectId,
        taskId: task.id,
        expectedVersion: task.version,
        idempotencyKey: `claim-${key}`,
      },
      registration,
      taskServices,
    ),
  );
  return Effect.runPromise(
    completeTask(
      {
        projectId,
        taskId: task.id,
        leaseToken: grant.leaseToken,
        expectedVersion: grant.task.version,
        idempotencyKey: `complete-${key}`,
        report: {
          resultSummary: "Customization verified.",
          changedAreas: ["src/domain/customization.ts"],
          verificationResults: [{ name: "tests", status: "passed", details: "Passed." }],
          references: [],
          risks: [],
          followUpWork: [],
        },
      },
      registration,
      taskServices,
    ),
  );
}

beforeEach(async () => {
  temporaryRoot = await mkdtemp(join(tmpdir(), "helm-task-customization-"));
  const repositoryRoot = join(temporaryRoot, "repository");
  await mkdir(join(repositoryRoot, ".git"), { recursive: true });
  projectStore = createSqliteProjectStore(join(temporaryRoot, "helm.db"));
  const project = await Effect.runPromise(
    createProject(
      { repositoryRoot, idempotencyKey: "create-customization-project" },
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

describe("SQLite task customization", () => {
  it("resolves explicit/default values and keeps retired historical values read-only", async () => {
    insertDefinition({
      id: "field-owner",
      key: "owner",
      type: "text",
      validation: { minLength: 2, maxLength: 40 },
      defaultValue: { type: "text", value: "unassigned" },
      position: 0,
    });
    insertDefinition({
      id: "field-risk",
      key: "risk",
      type: "number",
      validation: { min: 0, max: 5, integer: true },
      defaultValue: null,
      position: 1,
    });

    const created = await Effect.runPromise(
      createTask(
        taskInput({
          customFields: [
            { fieldId: "field-owner", value: { type: "text", value: "Ada" } },
            { fieldId: "field-risk", value: { type: "number", value: 4 } },
          ],
        }),
        human,
        taskServices,
      ),
    );
    expect(
      created.customFields.map(({ definition, source, value }) => [definition.key, source, value]),
    ).toEqual([
      ["owner", "explicit", { type: "text", value: "Ada" }],
      ["risk", "explicit", { type: "number", value: 4 }],
    ]);
    const context = await Effect.runPromise(
      getTaskContext({ projectId, taskId: created.id }, [], taskServices),
    );
    expect(context.customFields).toEqual(created.customFields);
    expect(context.reviewPolicy).toEqual(created.reviewPolicy);
    const createdEventPayload = projectStore.database
      .prepare<[string], string>(
        "select payload_json from events where entity_id = ? and kind = 'task.created'",
      )
      .pluck()
      .get(created.id);
    expect(JSON.parse(createdEventPayload ?? "{}")).toMatchObject({
      customFields: created.customFields,
      reviewModeOverride: null,
      reviewPolicy: created.reviewPolicy,
    });

    const cleared = await Effect.runPromise(
      prepareTask(
        {
          taskId: created.id,
          title: created.title,
          description: created.description,
          expectedOutcome: "Custom metadata is ready for execution.",
          acceptanceCriteria: "The prepared event records typed values.",
          agentContext: created.agentContext,
          checklist: [{ id: "verify", text: "Inspect the audit event", checked: false }],
          referencedPaths: created.referencedPaths,
          customFields: [{ fieldId: "field-owner", value: null }],
          expectedVersion: created.version,
          idempotencyKey: "prepare-customized-task",
        },
        human,
        taskServices,
      ),
    );
    expect(cleared.customFields[0]).toMatchObject({
      source: "default",
      value: { type: "text", value: "unassigned" },
    });
    const preparedEventPayload = projectStore.database
      .prepare<[string], string>(
        "select payload_json from events where entity_id = ? and kind = 'task.prepared'",
      )
      .pluck()
      .get(created.id);
    expect(JSON.parse(preparedEventPayload ?? "{}")).toMatchObject({
      customFields: cleared.customFields,
      reviewModeOverride: null,
      reviewPolicy: cleared.reviewPolicy,
    });

    projectStore.database
      .prepare(
        "update custom_field_definitions set retired_at = ?, updated_at = ? where id = 'field-risk'",
      )
      .run(now, now);
    const [afterRetirement] = await Effect.runPromise(
      listTasks({ projectId, includeArchived: false }, taskServices),
    );
    expect(afterRetirement?.customFields).toEqual(
      expect.arrayContaining([
        expect.objectContaining({
          source: "explicit",
          value: { type: "number", value: 4 },
          definition: expect.objectContaining({ id: "field-risk", retiredAt: now }),
        }),
      ]),
    );

    const rejected = await Effect.runPromise(
      Effect.either(
        updateTaskPlanning(
          planningInput(afterRetirement!, {
            customFields: [{ fieldId: "field-risk", value: { type: "number", value: 5 } }],
          }),
          human,
          taskServices,
        ),
      ),
    );
    expect(Either.isLeft(rejected) && rejected.left).toMatchObject({
      _tag: "TaskCustomFieldError",
      fieldId: "field-risk",
      reason: "retired",
    });
    const [unchanged] = await Effect.runPromise(
      listTasks({ projectId, includeArchived: false }, taskServices),
    );
    expect(unchanged?.version).toBe(afterRetirement?.version);
    expect(
      unchanged?.customFields.find(({ definition }) => definition.id === "field-risk")?.value,
    ).toEqual({
      type: "number",
      value: 4,
    });
  });

  it("explains deterministic tag conflicts and lets the task override win", async () => {
    const project = await Effect.runPromise(
      setProjectReviewMode(
        {
          projectId,
          reviewMode: "direct",
          expectedVersion: 1,
          idempotencyKey: "set-project-direct",
        },
        human,
        { store: projectStore, inspector: localRepositoryInspector },
      ),
    );
    expect(project.reviewMode).toBe("direct");
    for (const tag of [
      { id: "tag-direct", name: "fast", reviewMode: "direct" },
      { id: "tag-required", name: "safety", reviewMode: "required" },
    ] as const) {
      projectStore.database
        .prepare(
          `insert into tags (
            id, project_id, name, description, color, exclusive_group,
            review_mode_override, created_at, updated_at
          ) values (?, ?, ?, '', '#2563eb', null, ?, ?, ?)`,
        )
        .run(tag.id, projectId, tag.name, tag.reviewMode, now, now);
    }
    const tags = [
      { name: "safety", description: "", color: "#2563eb", exclusiveGroup: null },
      { name: "fast", description: "", color: "#2563eb", exclusiveGroup: null },
    ];

    const conflicted = await Effect.runPromise(
      createTask(readyTaskInput({ title: "Conflicted policy", tags }), human, taskServices),
    );
    expect(conflicted.reviewPolicy).toMatchObject({
      mode: "required",
      destination: "review",
      source: { level: "tag", tagIds: ["tag-required"] },
      tagConflict: true,
    });
    expect(conflicted.reviewPolicy?.explanation).toContain("Tag overrides conflict");
    const reviewed = await complete(conflicted, "conflicted");
    expect(reviewed.routing).toMatchObject({
      reviewMode: "required",
      destination: "review",
      policy: { tagConflict: true, source: { level: "tag" } },
    });

    const inherited = await Effect.runPromise(
      createTask(readyTaskInput({ title: "Task policy", tags }), human, taskServices),
    );
    const unauthorized = await Effect.runPromise(
      Effect.either(
        setTaskReviewModeOverride(
          {
            projectId,
            taskId: inherited.id,
            reviewModeOverride: "direct",
            expectedTaskVersion: inherited.version,
            reason: "An unrelated human must not change local policy.",
            idempotencyKey: "unauthorized-task-policy",
          },
          { type: "human", id: "remote-human" },
          taskServices,
        ),
      ),
    );
    expect(Either.isLeft(unauthorized) && unauthorized.left).toMatchObject({
      _tag: "TaskAuthorizationError",
    });
    const overridden = await Effect.runPromise(
      setTaskReviewModeOverride(
        {
          projectId,
          taskId: inherited.id,
          reviewModeOverride: "direct",
          expectedTaskVersion: inherited.version,
          reason: "This task is safe for direct completion.",
          idempotencyKey: "direct-task-policy",
        },
        human,
        taskServices,
      ),
    );
    expect(overridden.reviewPolicy).toMatchObject({
      mode: "direct",
      destination: "done",
      source: { level: "task", taskId: inherited.id },
      tagConflict: true,
    });
    const policyEvent = projectStore.database
      .prepare<[string], { readonly actorId: string; readonly payloadJson: string }>(
        `select actor_id as actorId, payload_json as payloadJson
         from events
         where entity_id = ? and kind = 'task.review_policy.override.changed'
         order by cursor desc limit 1`,
      )
      .get(inherited.id);
    expect(policyEvent?.actorId).toBe("local-human");
    expect(JSON.parse(policyEvent?.payloadJson ?? "{}")).toMatchObject({
      previousReviewModeOverride: null,
      reviewModeOverride: "direct",
      reason: "This task is safe for direct completion.",
      reviewPolicy: { source: { level: "task", taskId: inherited.id } },
    });
    const completed = await complete(overridden, "overridden");
    expect(completed.task.lifecycle).toBe("done");
    expect(completed.routing.policy?.explanation).toContain("takes precedence");
  });
});
