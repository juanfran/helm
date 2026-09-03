import { mkdir, mkdtemp, rm } from "node:fs/promises";
import { join } from "node:path";
import { tmpdir } from "node:os";

import { Effect, Either } from "effect";
import { afterEach, beforeEach, describe, expect, it } from "vitest";

import { createProject } from "./projects";
import {
  archiveTask,
  completeTask,
  createTask,
  createTaskRelation,
  discoverTasks,
  listTasks,
  prepareTask,
  reopenTask,
  updateTaskPlanning,
} from "./tasks";
import {
  compiledCreateTaskRelationInputSchema,
  compiledCreateTaskInputSchema,
  compiledUpdateTaskPlanningInputSchema,
  createTaskRelationInputSchema,
  createTaskInputSchema,
  emptyRichTextDocument,
  updateTaskPlanningInputSchema,
  type Actor,
  type CreateTaskInput,
} from "../domain/tasks";
import { localRepositoryInspector } from "../infrastructure/repository-inspector.server";
import {
  createSqliteProjectStore,
  type SqliteProjectStore,
} from "../infrastructure/sqlite-project-store.server";
import { createSqliteTaskStore } from "../infrastructure/sqlite-task-store.server";

const human: Actor = { type: "human", id: "local-human" };
const agent: Actor = { type: "agent", id: "run-42" };
let temporaryRoot: string;
let projectStore: SqliteProjectStore;
let projectId: string;
let taskServices: ReturnType<typeof taskFixtureServices>;

function taskFixtureServices(store: SqliteProjectStore) {
  return { store: createSqliteTaskStore(store.database) };
}

function backlogInput(overrides: Partial<CreateTaskInput> = {}): CreateTaskInput {
  return {
    projectId,
    parentTaskId: null,
    lifecycle: "backlog",
    title: "Investigate flaky build",
    description: emptyRichTextDocument,
    expectedOutcome: "",
    acceptanceCriteria: "",
    agentContext: "",
    checklist: [],
    expectedVersion: 0,
    idempotencyKey: "create-task",
    ...overrides,
  };
}

function readyInput(overrides: Partial<CreateTaskInput> = {}): CreateTaskInput {
  return backlogInput({
    lifecycle: "ready",
    expectedOutcome: "The behavior is available.",
    acceptanceCriteria: "The verification is observable.",
    checklist: [{ id: "verify", text: "Verify the behavior", checked: false }],
    ...overrides,
  });
}

beforeEach(async () => {
  temporaryRoot = await mkdtemp(join(tmpdir(), "helm-task-test-"));
  const repositoryRoot = join(temporaryRoot, "repository");
  await mkdir(join(repositoryRoot, ".git"), { recursive: true });
  projectStore = createSqliteProjectStore(":memory:");
  const project = await Effect.runPromise(
    createProject(
      { repositoryRoot, idempotencyKey: "project" },
      { store: projectStore, inspector: localRepositoryInspector },
    ),
  );
  projectId = project.id;
  taskServices = taskFixtureServices(projectStore);
});

afterEach(async () => {
  projectStore.close();
  await rm(temporaryRoot, { recursive: true, force: true });
});

describe("task application commands", () => {
  it("captures one title-only backlog task with an attributed event and retry-safe result", async () => {
    const command = backlogInput();
    const first = await Effect.runPromise(createTask(command, human, taskServices));
    const retry = await Effect.runPromise(createTask(command, human, taskServices));
    const visible = await Effect.runPromise(listTasks({ projectId }, taskServices));
    const event = projectStore.database
      .prepare<[], { kind: string; actorType: string; actorId: string }>(
        "select kind, actor_type as actorType, actor_id as actorId from events where entity_type = 'task'",
      )
      .get();

    expect(retry).toEqual(first);
    expect(visible).toEqual([first]);
    expect(first).toMatchObject({ lifecycle: "backlog", version: 1, descriptionText: "" });
    expect(event).toEqual({ kind: "task.created", actorType: "human", actorId: "local-human" });
  });

  it("rejects an unprepared ready task without writing a projection, event, or retry record", async () => {
    const result = await Effect.runPromise(
      Effect.either(createTask(backlogInput({ lifecycle: "ready" }), agent, taskServices)),
    );

    expect(Either.isLeft(result) && result.left["_tag"]).toBe("TaskPreparationError");
    if (Either.isLeft(result) && result.left["_tag"] === "TaskPreparationError") {
      expect(result.left.missingFields).toEqual([
        "expectedOutcome",
        "acceptanceCriteria",
        "checklist",
      ]);
    }
    expect(projectStore.database.prepare("select count(*) from tasks").pluck().get()).toBe(0);
    expect(
      projectStore.database
        .prepare("select count(*) from events where entity_type = 'task'")
        .pluck()
        .get(),
    ).toBe(0);
  });

  it("prepares backlog work as ready and stores stable rich-text and plain-text projections", async () => {
    const backlog = await Effect.runPromise(createTask(backlogInput(), human, taskServices));
    const description = {
      version: 1 as const,
      doc: {
        type: "doc" as const,
        content: [
          { type: "heading", content: [{ type: "text", text: "Build signal" }] },
          { type: "paragraph", content: [{ type: "text", text: "Make retries visible." }] },
        ],
      },
    };
    const command = {
      taskId: backlog.id,
      title: backlog.title,
      description,
      expectedOutcome: "Operators can see retry state.",
      acceptanceCriteria: "A retry is visible before completion.",
      agentContext: "Keep the event cursor monotonic.",
      checklist: [{ id: "verify", text: "Run the application tests", checked: false }],
      expectedVersion: backlog.version,
      idempotencyKey: "prepare-task",
    };
    const prepared = await Effect.runPromise(prepareTask(command, agent, taskServices));
    const retry = await Effect.runPromise(prepareTask(command, agent, taskServices));
    const row = projectStore.database
      .prepare<[], { descriptionJson: string; descriptionText: string }>(
        "select description_json as descriptionJson, description_text as descriptionText from tasks",
      )
      .get();
    const event = projectStore.database
      .prepare<[], { actorType: string; actorId: string }>(
        "select actor_type as actorType, actor_id as actorId from events where kind = 'task.prepared'",
      )
      .get();

    expect(retry).toEqual(prepared);
    expect(prepared).toMatchObject({ lifecycle: "ready", version: 2, description });
    expect(prepared.descriptionText).toBe("Build signal\nMake retries visible.");
    expect(row).toEqual({
      descriptionJson: JSON.stringify(description),
      descriptionText: "Build signal\nMake retries visible.",
    });
    expect(event).toEqual({ actorType: "agent", actorId: "run-42" });
  });

  it("returns a compact conflict and leaves state and history unchanged on a stale version", async () => {
    const backlog = await Effect.runPromise(createTask(backlogInput(), human, taskServices));
    const archived = await Effect.runPromise(
      archiveTask(
        {
          taskId: backlog.id,
          expectedVersion: backlog.version,
          reason: "No longer needed",
          idempotencyKey: "archive-first",
        },
        human,
        taskServices,
      ),
    );
    const eventCount = projectStore.database.prepare("select count(*) from events").pluck().get();
    const stale = await Effect.runPromise(
      Effect.either(
        archiveTask(
          {
            taskId: backlog.id,
            expectedVersion: backlog.version,
            reason: "Second archive",
            idempotencyKey: "archive-stale",
          },
          agent,
          taskServices,
        ),
      ),
    );

    expect(Either.isLeft(stale) && stale.left["_tag"]).toBe("TaskVersionConflictError");
    if (Either.isLeft(stale) && stale.left["_tag"] === "TaskVersionConflictError") {
      expect(stale.left).toMatchObject({ currentVersion: archived.version, expectedVersion: 1 });
      expect(stale.left.changeSummary).toContain("archived");
    }
    expect(projectStore.database.prepare("select count(*) from events").pluck().get()).toBe(
      eventCount,
    );
  });

  it("archives work out of normal queues while retaining its data and audit history", async () => {
    const backlog = await Effect.runPromise(createTask(backlogInput(), human, taskServices));
    const command = {
      taskId: backlog.id,
      expectedVersion: backlog.version,
      reason: "Superseded by a smaller task",
      idempotencyKey: "archive-task",
    };
    const archived = await Effect.runPromise(archiveTask(command, human, taskServices));
    const retry = await Effect.runPromise(archiveTask(command, human, taskServices));
    const visible = await Effect.runPromise(listTasks({ projectId }, taskServices));
    const history = await Effect.runPromise(
      listTasks({ projectId, includeArchived: true }, taskServices),
    );

    expect(retry).toEqual(archived);
    expect(visible).toEqual([]);
    expect(history).toEqual([archived]);
    expect(archived).toMatchObject({ id: backlog.id, title: backlog.title, version: 2 });
    expect(archived.archivedAt).not.toBeNull();
    expect(
      projectStore.database
        .prepare("select count(*) from events where entity_id = ?")
        .pluck()
        .get(backlog.id),
    ).toBe(2);
  });

  it("rolls projection and idempotency state back when the audit event fails", async () => {
    projectStore.database.exec(`
      create trigger reject_task_event
      before insert on events when NEW.kind = 'task.created'
      begin select raise(abort, 'event rejected'); end;
    `);
    const result = await Effect.runPromise(
      Effect.either(createTask(backlogInput(), human, taskServices)),
    );

    expect(Either.isLeft(result) && result.left["_tag"]).toBe("TaskPersistenceError");
    expect(projectStore.database.prepare("select count(*) from tasks").pluck().get()).toBe(0);
    expect(
      projectStore.database
        .prepare("select count(*) from idempotency_records where command = 'task.create'")
        .pluck()
        .get(),
    ).toBe(0);
  });

  it("excludes future work from claimable candidates without changing lifecycle", async () => {
    const scheduled = await Effect.runPromise(
      createTask(
        readyInput({
          title: "Starts tomorrow",
          notBefore: "2026-09-04",
          idempotencyKey: "scheduled",
        }),
        human,
        taskServices,
      ),
    );
    const boundary = await Effect.runPromise(
      createTask(
        readyInput({
          title: "Starts today",
          notBefore: "2026-09-03",
          idempotencyKey: "boundary",
        }),
        human,
        taskServices,
      ),
    );
    const listed = await Effect.runPromise(
      listTasks({ projectId, now: "2026-09-03" }, taskServices),
    );
    const candidates = await Effect.runPromise(
      discoverTasks({ projectId, now: "2026-09-03" }, taskServices),
    );

    expect(listed.find((task) => task.id === scheduled.id)).toMatchObject({
      lifecycle: "ready",
      eligibility: { claimable: false, status: "scheduled" },
    });
    expect(listed.find((task) => task.id === boundary.id)).toMatchObject({
      lifecycle: "ready",
      eligibility: { claimable: true, status: "claimable" },
    });
    expect(candidates.map((task) => task.id)).toEqual([boundary.id]);
  });

  it("orders candidates by priority, manual position, due date, and stable sequence", async () => {
    const lowDue = await Effect.runPromise(
      createTask(
        readyInput({
          title: "Low due soon",
          priority: "low",
          position: 1,
          dueAt: "2026-09-01",
          size: "s",
          idempotencyKey: "low-due",
        }),
        human,
        taskServices,
      ),
    );
    const urgentLater = await Effect.runPromise(
      createTask(
        readyInput({
          title: "Urgent later",
          priority: "urgent",
          position: 2,
          idempotencyKey: "urgent-later",
        }),
        human,
        taskServices,
      ),
    );
    const urgentFirst = await Effect.runPromise(
      createTask(
        readyInput({
          title: "Urgent first",
          priority: "urgent",
          position: 1,
          dueAt: "2026-09-10",
          idempotencyKey: "urgent-first",
        }),
        human,
        taskServices,
      ),
    );
    const urgentFirstEarlierDue = await Effect.runPromise(
      createTask(
        readyInput({
          title: "Urgent first earlier due",
          priority: "urgent",
          position: 1,
          dueAt: "2026-09-05",
          idempotencyKey: "urgent-first-earlier-due",
        }),
        human,
        taskServices,
      ),
    );
    const candidates = await Effect.runPromise(
      discoverTasks({ projectId, now: "2026-09-03" }, taskServices),
    );

    expect(candidates.map((task) => task.id)).toEqual([
      urgentFirstEarlierDue.id,
      urgentFirst.id,
      urgentLater.id,
      lowDue.id,
    ]);
    expect(lowDue).toMatchObject({ priority: "low", dueAt: "2026-09-01", size: "s" });
    expect(candidates[0]?.eligibility?.orderingExplanation).toContain("stable tie-breaker #4");
  });

  it("stores tag definitions and rejects mutually exclusive assignments in the same group", async () => {
    const task = await Effect.runPromise(
      createTask(readyInput({ idempotencyKey: "tagged" }), human, taskServices),
    );
    const tagged = await Effect.runPromise(
      updateTaskPlanning(
        {
          taskId: task.id,
          priority: "high",
          position: 3,
          notBefore: null,
          dueAt: "2026-09-12",
          size: "m",
          tags: [
            {
              name: "frontend",
              description: "Browser work",
              color: "#2563eb",
              exclusiveGroup: "area",
            },
          ],
          requiredCapabilities: [],
          expectedVersion: task.version,
          idempotencyKey: "tag-task",
        },
        human,
        taskServices,
      ),
    );
    const eventCount = projectStore.database.prepare("select count(*) from events").pluck().get();
    const invalid = await Effect.runPromise(
      Effect.either(
        updateTaskPlanning(
          {
            taskId: task.id,
            priority: "high",
            position: 3,
            notBefore: null,
            dueAt: null,
            size: null,
            tags: [
              {
                name: "frontend",
                description: "Browser work",
                color: "#2563eb",
                exclusiveGroup: "area",
              },
              {
                name: "backend",
                description: "Server work",
                color: "#16a34a",
                exclusiveGroup: "area",
              },
            ],
            requiredCapabilities: [],
            expectedVersion: tagged.version,
            idempotencyKey: "invalid-exclusive-tags",
          },
          human,
          taskServices,
        ),
      ),
    );

    expect(tagged).toMatchObject({
      priority: "high",
      position: 3,
      dueAt: "2026-09-12",
      size: "m",
      tags: [
        {
          name: "frontend",
          description: "Browser work",
          color: "#2563eb",
          exclusiveGroup: "area",
        },
      ],
    });
    expect(Either.isLeft(invalid) && invalid.left["_tag"]).toBe("TaskTagConstraintError");
    expect(projectStore.database.prepare("select count(*) from events").pluck().get()).toBe(
      eventCount,
    );
  });

  it("matches required capabilities and returns them in task context", async () => {
    const task = await Effect.runPromise(
      createTask(
        readyInput({
          title: "Needs React and SQLite",
          requiredCapabilities: ["sqlite", "react"],
          idempotencyKey: "capability-task",
        }),
        agent,
        taskServices,
      ),
    );
    const missing = await Effect.runPromise(
      listTasks({ projectId, agentCapabilities: ["react"], now: "2026-09-03" }, taskServices),
    );
    const incompatibleCandidates = await Effect.runPromise(
      discoverTasks({ projectId, agentCapabilities: ["react"], now: "2026-09-03" }, taskServices),
    );
    const compatibleCandidates = await Effect.runPromise(
      discoverTasks(
        { projectId, agentCapabilities: ["sqlite", "react"], now: "2026-09-03" },
        taskServices,
      ),
    );

    expect(task.requiredCapabilities).toEqual(["react", "sqlite"]);
    expect(missing[0]).toMatchObject({
      eligibility: {
        claimable: false,
        status: "capability_mismatch",
        missingCapabilities: ["sqlite"],
      },
    });
    expect(incompatibleCandidates).toEqual([]);
    expect(compatibleCandidates[0]).toMatchObject({
      id: task.id,
      requiredCapabilities: ["react", "sqlite"],
      eligibility: { claimable: true },
    });
  });

  it("rejects stale planning updates without changing routing state or history", async () => {
    const task = await Effect.runPromise(
      createTask(readyInput({ idempotencyKey: "stale-routing" }), human, taskServices),
    );
    const updated = await Effect.runPromise(
      updateTaskPlanning(
        {
          taskId: task.id,
          priority: "urgent",
          position: 1,
          notBefore: null,
          dueAt: null,
          size: null,
          tags: [],
          requiredCapabilities: [],
          expectedVersion: task.version,
          idempotencyKey: "routing-first",
        },
        human,
        taskServices,
      ),
    );
    const eventCount = projectStore.database.prepare("select count(*) from events").pluck().get();
    const stale = await Effect.runPromise(
      Effect.either(
        updateTaskPlanning(
          {
            taskId: task.id,
            priority: "low",
            position: 99,
            notBefore: "2026-09-10",
            dueAt: "2026-09-11",
            size: "xl",
            tags: [],
            requiredCapabilities: ["react"],
            expectedVersion: task.version,
            idempotencyKey: "routing-stale",
          },
          agent,
          taskServices,
        ),
      ),
    );
    const listed = await Effect.runPromise(listTasks({ projectId }, taskServices));

    expect(updated).toMatchObject({ priority: "urgent", version: 2 });
    expect(Either.isLeft(stale) && stale.left["_tag"]).toBe("TaskVersionConflictError");
    expect(listed[0]).toMatchObject({ priority: "urgent", position: 1, version: 2 });
    expect(projectStore.database.prepare("select count(*) from events").pluck().get()).toBe(
      eventCount,
    );
  });

  it("allows one level of child tasks and rejects deeper nesting atomically", async () => {
    const parent = await Effect.runPromise(
      createTask(
        backlogInput({ title: "Parent task", idempotencyKey: "parent" }),
        human,
        taskServices,
      ),
    );
    const child = await Effect.runPromise(
      createTask(
        backlogInput({
          parentTaskId: parent.id,
          title: "Child task",
          idempotencyKey: "child",
        }),
        human,
        taskServices,
      ),
    );
    const eventCount = projectStore.database.prepare("select count(*) from events").pluck().get();
    const deeper = await Effect.runPromise(
      Effect.either(
        createTask(
          backlogInput({
            parentTaskId: child.id,
            title: "Too deep",
            idempotencyKey: "grandchild",
          }),
          agent,
          taskServices,
        ),
      ),
    );
    const listed = await Effect.runPromise(listTasks({ projectId }, taskServices));

    expect(listed.find((task) => task.id === parent.id)).toMatchObject({
      childTaskIds: [child.id],
    });
    expect(listed.find((task) => task.id === child.id)).toMatchObject({
      parentTaskId: parent.id,
      childTaskIds: [],
    });
    expect(Either.isLeft(deeper) && deeper.left["_tag"]).toBe("TaskNestingError");
    expect(projectStore.database.prepare("select count(*) from tasks").pluck().get()).toBe(2);
    expect(projectStore.database.prepare("select count(*) from events").pluck().get()).toBe(
      eventCount,
    );
  });

  it("creates typed relations and only incomplete blocking dependencies affect eligibility", async () => {
    const blocker = await Effect.runPromise(
      createTask(readyInput({ title: "Blocker", idempotencyKey: "blocker" }), human, taskServices),
    );
    const dependent = await Effect.runPromise(
      createTask(
        readyInput({ title: "Dependent", idempotencyKey: "dependent" }),
        human,
        taskServices,
      ),
    );
    const related = await Effect.runPromise(
      createTask(readyInput({ title: "Related", idempotencyKey: "related" }), human, taskServices),
    );
    const blockingRelation = await Effect.runPromise(
      createTaskRelation(
        {
          projectId,
          sourceTaskId: blocker.id,
          targetTaskId: dependent.id,
          type: "blocks",
          expectedSourceVersion: blocker.version,
          expectedTargetVersion: dependent.version,
          idempotencyKey: "blocker-blocks-dependent",
        },
        agent,
        taskServices,
      ),
    );
    const retry = await Effect.runPromise(
      createTaskRelation(
        {
          projectId,
          sourceTaskId: blocker.id,
          targetTaskId: dependent.id,
          type: "blocks",
          expectedSourceVersion: blocker.version,
          expectedTargetVersion: dependent.version,
          idempotencyKey: "blocker-blocks-dependent",
        },
        agent,
        taskServices,
      ),
    );
    const afterBlocking = await Effect.runPromise(listTasks({ projectId }, taskServices));
    const blockedDependent = afterBlocking.find((task) => task.id === dependent.id);
    const blockerAfterRelation = afterBlocking.find((task) => task.id === blocker.id);
    if (!blockedDependent || !blockerAfterRelation) throw new Error("Expected related tasks");

    await Effect.runPromise(
      createTaskRelation(
        {
          projectId,
          sourceTaskId: related.id,
          targetTaskId: dependent.id,
          type: "related_to",
          expectedSourceVersion: related.version,
          expectedTargetVersion: blockedDependent.version,
          idempotencyKey: "related-to-dependent",
        },
        human,
        taskServices,
      ),
    );
    const blockedCandidates = await Effect.runPromise(discoverTasks({ projectId }, taskServices));
    const completedBlocker = await Effect.runPromise(
      completeTask(
        {
          taskId: blocker.id,
          expectedVersion: blockerAfterRelation.version,
          idempotencyKey: "complete-blocker",
        },
        human,
        taskServices,
      ),
    );
    const unblocked = await Effect.runPromise(listTasks({ projectId }, taskServices));
    const reopenedBlocker = await Effect.runPromise(
      reopenTask(
        {
          taskId: blocker.id,
          expectedVersion: completedBlocker.version,
          reason: "Need more work",
          idempotencyKey: "reopen-blocker",
        },
        human,
        taskServices,
      ),
    );
    const reblocked = await Effect.runPromise(listTasks({ projectId }, taskServices));

    expect(retry).toEqual(blockingRelation);
    expect(blockingRelation).toMatchObject({
      type: "blocks",
      sourceSequence: blocker.sequence,
      targetSequence: dependent.sequence,
    });
    expect(blockedDependent).toMatchObject({
      eligibility: { claimable: false, status: "blocked", blockingTaskIds: [blocker.id] },
      upstreamRelations: [expect.objectContaining({ type: "blocks" })],
    });
    expect(blockedCandidates.map((task) => task.id)).not.toContain(dependent.id);
    expect(unblocked.find((task) => task.id === dependent.id)).toMatchObject({
      eligibility: { claimable: true, status: "claimable", blockingTaskIds: [] },
      upstreamRelations: [
        expect.objectContaining({ type: "blocks" }),
        expect.objectContaining({ type: "related_to" }),
      ],
    });
    expect(reopenedBlocker.lifecycle).toBe("ready");
    expect(reblocked.find((task) => task.id === dependent.id)).toMatchObject({
      eligibility: { claimable: false, status: "blocked", blockingTaskIds: [blocker.id] },
    });
  });

  it("rejects self-links and blocking cycles with an explainable path", async () => {
    const first = await Effect.runPromise(
      createTask(
        readyInput({ title: "First", idempotencyKey: "cycle-first" }),
        human,
        taskServices,
      ),
    );
    const second = await Effect.runPromise(
      createTask(
        readyInput({ title: "Second", idempotencyKey: "cycle-second" }),
        human,
        taskServices,
      ),
    );
    const third = await Effect.runPromise(
      createTask(
        readyInput({ title: "Third", idempotencyKey: "cycle-third" }),
        human,
        taskServices,
      ),
    );
    const self = await Effect.runPromise(
      Effect.either(
        createTaskRelation(
          {
            projectId,
            sourceTaskId: first.id,
            targetTaskId: first.id,
            type: "related_to",
            expectedSourceVersion: first.version,
            expectedTargetVersion: first.version,
            idempotencyKey: "self-link",
          },
          human,
          taskServices,
        ),
      ),
    );

    await Effect.runPromise(
      createTaskRelation(
        {
          projectId,
          sourceTaskId: first.id,
          targetTaskId: second.id,
          type: "blocks",
          expectedSourceVersion: first.version,
          expectedTargetVersion: second.version,
          idempotencyKey: "first-blocks-second",
        },
        human,
        taskServices,
      ),
    );
    const afterFirstEdge = await Effect.runPromise(listTasks({ projectId }, taskServices));
    const firstAfterEdge = afterFirstEdge.find((task) => task.id === first.id);
    const secondAfterEdge = afterFirstEdge.find((task) => task.id === second.id);
    if (!firstAfterEdge || !secondAfterEdge) throw new Error("Expected first blocking edge");
    await Effect.runPromise(
      createTaskRelation(
        {
          projectId,
          sourceTaskId: second.id,
          targetTaskId: third.id,
          type: "blocks",
          expectedSourceVersion: secondAfterEdge.version,
          expectedTargetVersion: third.version,
          idempotencyKey: "second-blocks-third",
        },
        human,
        taskServices,
      ),
    );
    const afterSecondEdge = await Effect.runPromise(listTasks({ projectId }, taskServices));
    const firstBeforeCycle = afterSecondEdge.find((task) => task.id === first.id);
    const thirdBeforeCycle = afterSecondEdge.find((task) => task.id === third.id);
    if (!firstBeforeCycle || !thirdBeforeCycle) throw new Error("Expected second blocking edge");
    const eventCount = projectStore.database.prepare("select count(*) from events").pluck().get();
    const cycle = await Effect.runPromise(
      Effect.either(
        createTaskRelation(
          {
            projectId,
            sourceTaskId: third.id,
            targetTaskId: first.id,
            type: "blocks",
            expectedSourceVersion: thirdBeforeCycle.version,
            expectedTargetVersion: firstBeforeCycle.version,
            idempotencyKey: "third-blocks-first",
          },
          agent,
          taskServices,
        ),
      ),
    );

    expect(Either.isLeft(self) && self.left["_tag"]).toBe("TaskRelationError");
    expect(Either.isLeft(cycle) && cycle.left["_tag"]).toBe("TaskRelationError");
    if (Either.isLeft(cycle) && cycle.left["_tag"] === "TaskRelationError") {
      expect(cycle.left.relationPath).toEqual(["#3", "#1", "#2", "#3"]);
    }
    expect(projectStore.database.prepare("select count(*) from task_relations").pluck().get()).toBe(
      2,
    );
    expect(projectStore.database.prepare("select count(*) from events").pluck().get()).toBe(
      eventCount,
    );
  });

  it("rejects stale relation versions without changing graph or audit history", async () => {
    const source = await Effect.runPromise(
      createTask(
        readyInput({ title: "Source", idempotencyKey: "stale-source" }),
        human,
        taskServices,
      ),
    );
    const target = await Effect.runPromise(
      createTask(
        readyInput({ title: "Target", idempotencyKey: "stale-target" }),
        human,
        taskServices,
      ),
    );
    await Effect.runPromise(
      updateTaskPlanning(
        {
          taskId: target.id,
          priority: "high",
          position: 1,
          notBefore: null,
          dueAt: null,
          size: null,
          tags: [],
          requiredCapabilities: [],
          expectedVersion: target.version,
          idempotencyKey: "change-target-version",
        },
        human,
        taskServices,
      ),
    );
    const eventCount = projectStore.database.prepare("select count(*) from events").pluck().get();
    const stale = await Effect.runPromise(
      Effect.either(
        createTaskRelation(
          {
            projectId,
            sourceTaskId: source.id,
            targetTaskId: target.id,
            type: "blocks",
            expectedSourceVersion: source.version,
            expectedTargetVersion: target.version,
            idempotencyKey: "stale-relation-version",
          },
          agent,
          taskServices,
        ),
      ),
    );

    expect(Either.isLeft(stale) && stale.left["_tag"]).toBe("TaskVersionConflictError");
    expect(projectStore.database.prepare("select count(*) from task_relations").pluck().get()).toBe(
      0,
    );
    expect(projectStore.database.prepare("select count(*) from events").pluck().get()).toBe(
      eventCount,
    );
  });

  it("accepts representative input through normal and compiled task schemas", () => {
    const valid = backlogInput();
    expect(createTaskInputSchema.parse(valid)).toEqual(valid);
    expect(compiledCreateTaskInputSchema.parse(valid)).toEqual(valid);
    expect(() => createTaskInputSchema.parse({ ...valid, expectedVersion: 1 })).toThrow();
    expect(() => compiledCreateTaskInputSchema.parse({ ...valid, title: "" })).toThrow();
    const planning = {
      taskId: "task-1",
      priority: "normal" as const,
      position: 1,
      notBefore: null,
      dueAt: null,
      size: null,
      tags: [],
      requiredCapabilities: [],
      expectedVersion: 1,
      idempotencyKey: "planning",
    };
    expect(updateTaskPlanningInputSchema.parse(planning)).toEqual(planning);
    expect(compiledUpdateTaskPlanningInputSchema.parse(planning)).toEqual(planning);
    const relation = {
      projectId: "project-1",
      sourceTaskId: "task-1",
      targetTaskId: "task-2",
      type: "blocks" as const,
      expectedSourceVersion: 1,
      expectedTargetVersion: 1,
      idempotencyKey: "relation",
    };
    expect(createTaskRelationInputSchema.parse(relation)).toEqual(relation);
    expect(compiledCreateTaskRelationInputSchema.parse(relation)).toEqual(relation);
  });
});
