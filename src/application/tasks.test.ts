import { createHash } from "node:crypto";
import { mkdir, mkdtemp, rm, symlink } from "node:fs/promises";
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
  findWork,
  getTaskContext,
  listTaskTags,
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
  return {
    store: createSqliteTaskStore(store.database),
    clock: { today: () => "2026-09-03" },
  };
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
    referencedPaths: overrides.referencedPaths ?? [],
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
    const parsed = compiledCreateTaskInputSchema.parse(command);
    const {
      idempotencyKey: _idempotencyKey,
      referencedPaths: _referencedPaths,
      ...legacyCommand
    } = parsed;
    const legacyHash = createHash("sha256")
      .update(`task.create:${JSON.stringify(legacyCommand)}`)
      .digest("hex");
    const recordedHash = projectStore.database
      .prepare<[string], string>("select input_hash from idempotency_records where key = ?")
      .pluck()
      .get(command.idempotencyKey);

    expect(retry).toEqual(first);
    expect(recordedHash).toBe(legacyHash);
    expect(visible).toEqual([first]);
    expect(first).toMatchObject({ lifecycle: "backlog", version: 1, descriptionText: "" });
    expect(event).toEqual({ kind: "task.created", actorType: "human", actorId: "local-human" });
  });

  it("re-evaluates derived eligibility when an idempotent mutation is replayed", async () => {
    let today = "2026-09-03";
    taskServices = {
      store: taskServices.store,
      clock: { today: () => today },
    };
    const command = readyInput({
      title: "Scheduled TypeScript work",
      notBefore: "2026-09-04",
      requiredCapabilities: ["typescript"],
      idempotencyKey: "contextual-idempotent-result",
    });

    const scheduled = await Effect.runPromise(
      createTask(command, human, taskServices, ["typescript"]),
    );
    today = "2026-09-04";
    const capabilityMismatch = await Effect.runPromise(
      createTask(command, human, taskServices, []),
    );
    const claimable = await Effect.runPromise(
      createTask(command, human, taskServices, [" TypeScript ", "typescript"]),
    );

    expect(scheduled).toMatchObject({
      id: capabilityMismatch.id,
      version: 1,
      eligibility: { status: "scheduled", claimable: false },
    });
    expect(capabilityMismatch).toMatchObject({
      id: scheduled.id,
      version: 1,
      eligibility: { status: "capability_mismatch", claimable: false },
    });
    expect(claimable).toMatchObject({
      id: scheduled.id,
      version: 1,
      eligibility: { status: "claimable", claimable: true },
    });
    expect(
      projectStore.database
        .prepare("select count(*) from events where kind = 'task.created'")
        .pluck()
        .get(),
    ).toBe(1);
  });

  it("keeps replayed eligibility consistent with the cached task version", async () => {
    const blocker = await Effect.runPromise(
      createTask(
        readyInput({ title: "Blocker", idempotencyKey: "replay-blocker" }),
        human,
        taskServices,
      ),
    );
    const targetCommand = readyInput({
      title: "Target",
      idempotencyKey: "replay-target",
    });
    const target = await Effect.runPromise(createTask(targetCommand, human, taskServices));
    await Effect.runPromise(
      createTaskRelation(
        {
          projectId,
          sourceTaskId: blocker.id,
          targetTaskId: target.id,
          type: "blocks",
          expectedSourceVersion: blocker.version,
          expectedTargetVersion: target.version,
          idempotencyKey: "relation-after-cached-result",
        },
        human,
        taskServices,
      ),
    );

    const replay = await Effect.runPromise(createTask(targetCommand, human, taskServices));
    const current = (await Effect.runPromise(listTasks({ projectId }, taskServices))).find(
      (task) => task.id === target.id,
    );

    expect(replay).toMatchObject({
      version: 1,
      upstreamRelations: [],
      eligibility: { status: "claimable", blockingTaskIds: [] },
    });
    expect(current).toMatchObject({
      version: 2,
      upstreamRelations: [{ sourceTaskId: blocker.id, type: "blocks" }],
      eligibility: { status: "blocked", blockingTaskIds: [blocker.id] },
    });
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

  it("rejects symlink-escaping references atomically while allowing missing in-repository paths", async () => {
    const repositoryRoot = join(temporaryRoot, "repository");
    const outside = join(temporaryRoot, "outside");
    await mkdir(outside);
    await symlink(outside, join(repositoryRoot, "external"), "dir");

    const escaped = await Effect.runPromise(
      Effect.either(
        createTask(
          readyInput({
            referencedPaths: ["external/secret.ts"],
            idempotencyKey: "escaped-reference",
          }),
          human,
          taskServices,
        ),
      ),
    );
    const accepted = await Effect.runPromise(
      createTask(
        backlogInput({
          title: "Create a new in-repository file",
          referencedPaths: ["src/new/file.ts"],
          idempotencyKey: "missing-in-repository-reference",
        }),
        human,
        taskServices,
      ),
    );
    const escapedPreparation = await Effect.runPromise(
      Effect.either(
        prepareTask(
          {
            taskId: accepted.id,
            title: accepted.title,
            description: accepted.description,
            expectedOutcome: "The new file exists.",
            acceptanceCriteria: "The change is verified.",
            agentContext: "",
            checklist: [{ id: "verify", text: "Run tests", checked: false }],
            referencedPaths: ["external/secret.ts"],
            expectedVersion: accepted.version,
            idempotencyKey: "escaped-preparation-reference",
          },
          human,
          taskServices,
        ),
      ),
    );
    const [persisted] = await Effect.runPromise(listTasks({ projectId }, taskServices));

    expect(Either.isLeft(escaped) && escaped.left["_tag"]).toBe("TaskPathError");
    expect(Either.isLeft(escapedPreparation) && escapedPreparation.left["_tag"]).toBe(
      "TaskPathError",
    );
    expect(accepted.referencedPaths).toEqual(["src/new/file.ts"]);
    expect(persisted).toMatchObject({
      id: accepted.id,
      lifecycle: "backlog",
      version: 1,
      referencedPaths: ["src/new/file.ts"],
    });
    expect(projectStore.database.prepare("select count(*) from tasks").pluck().get()).toBe(1);
    expect(
      projectStore.database
        .prepare(
          "select count(*) from idempotency_records where key in ('escaped-reference', 'escaped-preparation-reference')",
        )
        .pluck()
        .get(),
    ).toBe(0);
  });

  it("revalidates selected discovery paths after the repository changes", async () => {
    const repositoryRoot = join(temporaryRoot, "repository");
    const referenceDirectory = join(repositoryRoot, "external");
    await mkdir(referenceDirectory);
    const task = await Effect.runPromise(
      createTask(
        readyInput({
          referencedPaths: ["external/file.ts"],
          idempotencyKey: "mutable-reference",
        }),
        human,
        taskServices,
      ),
    );

    await rm(referenceDirectory, { recursive: true, force: true });
    const outside = join(temporaryRoot, "outside-after-create");
    await mkdir(outside);
    await symlink(outside, referenceDirectory, "dir");

    const selectedPaths = await Effect.runPromise(
      Effect.either(findWork({ projectId, fields: ["referencedPaths"] }, [], taskServices)),
    );
    const compactDiscovery = await Effect.runPromise(findWork({ projectId }, [], taskServices));

    expect(Either.isLeft(selectedPaths) && selectedPaths.left["_tag"]).toBe("TaskPathError");
    expect(compactDiscovery.candidates).toMatchObject([{ id: task.id }]);
    expect(compactDiscovery.candidates[0]).not.toHaveProperty("referencedPaths");
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

  it("requires the explicit reopen command before a completed task can be prepared again", async () => {
    const ready = await Effect.runPromise(
      createTask(readyInput({ idempotencyKey: "ready-before-complete" }), human, taskServices),
    );
    const completed = await Effect.runPromise(
      completeTask(
        {
          taskId: ready.id,
          expectedVersion: ready.version,
          idempotencyKey: "complete-before-prepare",
        },
        human,
        taskServices,
      ),
    );
    const eventCount = projectStore.database.prepare("select count(*) from events").pluck().get();

    const result = await Effect.runPromise(
      Effect.either(
        prepareTask(
          {
            taskId: completed.id,
            title: completed.title,
            description: completed.description,
            expectedOutcome: completed.expectedOutcome,
            acceptanceCriteria: completed.acceptanceCriteria,
            agentContext: completed.agentContext,
            checklist: completed.checklist,
            referencedPaths: completed.referencedPaths,
            expectedVersion: completed.version,
            idempotencyKey: "prepare-completed-task",
          },
          human,
          taskServices,
        ),
      ),
    );

    expect(Either.isLeft(result) && result.left["_tag"]).toBe("TaskLifecycleError");
    expect((await Effect.runPromise(listTasks({ projectId }, taskServices)))[0]?.lifecycle).toBe(
      "done",
    );
    expect(projectStore.database.prepare("select count(*) from events").pluck().get()).toBe(
      eventCount,
    );
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
    const listed = await Effect.runPromise(listTasks({ projectId }, taskServices));
    const { candidates } = await Effect.runPromise(
      findWork({ projectId, limit: 100 }, [], taskServices),
    );
    const spoofedClockCandidates = await Effect.runPromise(
      findWork({ projectId, limit: 100, now: "9999-12-31" }, [], taskServices),
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
    expect(spoofedClockCandidates.candidates.map((task) => task.id)).toEqual([boundary.id]);
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
    const { candidates } = await Effect.runPromise(
      findWork({ projectId, limit: 100 }, [], taskServices),
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

  it("rejects a stale cursor when work changes and restarts without skipping", async () => {
    const first = await Effect.runPromise(
      createTask(
        readyInput({ title: "First", position: 1, idempotencyKey: "page-first" }),
        human,
        taskServices,
      ),
    );
    const second = await Effect.runPromise(
      createTask(
        readyInput({ title: "Second", position: 1, idempotencyKey: "page-second" }),
        human,
        taskServices,
      ),
    );
    const third = await Effect.runPromise(
      createTask(
        readyInput({ title: "Third", position: 1, idempotencyKey: "page-third" }),
        human,
        taskServices,
      ),
    );
    const firstPage = await Effect.runPromise(findWork({ projectId, limit: 1 }, [], taskServices));
    if (!firstPage.nextCursor) throw new Error("Expected another discovery page");

    await Effect.runPromise(
      completeTask(
        {
          taskId: first.id,
          expectedVersion: first.version,
          idempotencyKey: "complete-page-first",
        },
        human,
        taskServices,
      ),
    );
    const stalePage = await Effect.runPromise(
      Effect.either(
        findWork({ projectId, limit: 1, cursor: firstPage.nextCursor }, [], taskServices),
      ),
    );
    const restartedPage = await Effect.runPromise(
      findWork({ projectId, limit: 1 }, [], taskServices),
    );

    expect(firstPage.candidates.map((task) => task.id)).toEqual([first.id]);
    expect(Either.isLeft(stalePage) && stalePage.left["_tag"]).toBe(
      "TaskDiscoveryCursorStaleError",
    );
    if (Either.isLeft(stalePage) && stalePage.left["_tag"] === "TaskDiscoveryCursorStaleError") {
      expect(stalePage.left.staleBecause).toBe("queue_changed");
    }
    expect(restartedPage.candidates.map((task) => task.id)).toEqual([second.id]);
    expect(restartedPage.candidates.map((task) => task.id)).not.toContain(third.id);
  });

  it("rejects a discovery cursor when the evaluation date changes", async () => {
    let today = "2026-09-03";
    taskServices = {
      store: taskServices.store,
      clock: { today: () => today },
    };
    const first = await Effect.runPromise(
      createTask(
        readyInput({ title: "Available first", position: 2, idempotencyKey: "dated-first" }),
        human,
        taskServices,
      ),
    );
    const last = await Effect.runPromise(
      createTask(
        readyInput({ title: "Available last", position: 3, idempotencyKey: "dated-last" }),
        human,
        taskServices,
      ),
    );
    const scheduled = await Effect.runPromise(
      createTask(
        readyInput({
          title: "Available tomorrow",
          position: 1,
          notBefore: "2026-09-04",
          idempotencyKey: "dated-scheduled",
        }),
        human,
        taskServices,
      ),
    );
    const firstPage = await Effect.runPromise(findWork({ projectId, limit: 1 }, [], taskServices));
    if (!firstPage.nextCursor) throw new Error("Expected another discovery page");

    today = "2026-09-04";
    const stalePage = await Effect.runPromise(
      Effect.either(
        findWork({ projectId, limit: 1, cursor: firstPage.nextCursor }, [], taskServices),
      ),
    );
    const restartedPage = await Effect.runPromise(
      findWork({ projectId, limit: 3 }, [], taskServices),
    );

    expect(firstPage.candidates.map((task) => task.id)).toEqual([first.id]);
    expect(last.position).toBe(3);
    if (Either.isLeft(stalePage) && stalePage.left["_tag"] === "TaskDiscoveryCursorStaleError") {
      expect(stalePage.left.staleBecause).toBe("evaluation_context_changed");
    } else {
      throw new Error("Expected the prior-date cursor to be stale");
    }
    expect(restartedPage.candidates.map((task) => task.id)).toEqual([
      scheduled.id,
      first.id,
      last.id,
    ]);
  });

  it("binds discovery cursors to normalized agent capabilities", async () => {
    const first = await Effect.runPromise(
      createTask(
        readyInput({ title: "Open first", position: 2, idempotencyKey: "caps-first" }),
        human,
        taskServices,
      ),
    );
    const last = await Effect.runPromise(
      createTask(
        readyInput({ title: "Open last", position: 3, idempotencyKey: "caps-last" }),
        human,
        taskServices,
      ),
    );
    const restricted = await Effect.runPromise(
      createTask(
        readyInput({
          title: "GPU first",
          position: 1,
          requiredCapabilities: ["GPU"],
          idempotencyKey: "caps-restricted",
        }),
        human,
        taskServices,
      ),
    );
    const withoutCapabilities = await Effect.runPromise(
      findWork({ projectId, limit: 1 }, [], taskServices),
    );
    if (!withoutCapabilities.nextCursor) throw new Error("Expected another discovery page");

    const stalePage = await Effect.runPromise(
      Effect.either(
        findWork(
          { projectId, limit: 1, cursor: withoutCapabilities.nextCursor },
          ["gpu"],
          taskServices,
        ),
      ),
    );
    const restartedPage = await Effect.runPromise(
      findWork({ projectId, limit: 1 }, [" GPU ", "gpu"], taskServices),
    );
    if (!restartedPage.nextCursor) throw new Error("Expected another discovery page");
    const normalizedContinuation = await Effect.runPromise(
      findWork({ projectId, limit: 1, cursor: restartedPage.nextCursor }, ["gpu"], taskServices),
    );

    expect(withoutCapabilities.candidates.map((task) => task.id)).toEqual([first.id]);
    expect(last.position).toBe(3);
    if (Either.isLeft(stalePage) && stalePage.left["_tag"] === "TaskDiscoveryCursorStaleError") {
      expect(stalePage.left.staleBecause).toBe("evaluation_context_changed");
    } else {
      throw new Error("Expected the changed-capabilities cursor to be stale");
    }
    expect(restartedPage.candidates.map((task) => task.id)).toEqual([restricted.id]);
    expect(normalizedContinuation.candidates.map((task) => task.id)).toEqual([first.id]);
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

    await Effect.runPromise(
      archiveTask(
        {
          taskId: tagged.id,
          expectedVersion: tagged.version,
          reason: "Verify retained project tag catalog",
          idempotencyKey: "archive-canonical-tag-task",
        },
        human,
        taskServices,
      ),
    );
    expect(await Effect.runPromise(listTaskTags({ projectId }, taskServices))).toEqual(tagged.tags);
  });

  it("keeps project tag definitions canonical when another task assigns the same name", async () => {
    const tagged = await Effect.runPromise(
      createTask(
        readyInput({
          title: "Canonical tags",
          tags: [
            {
              name: "frontend",
              description: "Browser work",
              color: "#2563eb",
              exclusiveGroup: "area",
            },
          ],
          idempotencyKey: "canonical-tag-task",
        }),
        human,
        taskServices,
      ),
    );
    const other = await Effect.runPromise(
      createTask(
        readyInput({ title: "Other task", idempotencyKey: "other-tag-task" }),
        human,
        taskServices,
      ),
    );
    const eventCount = projectStore.database.prepare("select count(*) from events").pluck().get();

    const conflict = await Effect.runPromise(
      Effect.either(
        updateTaskPlanning(
          {
            taskId: other.id,
            priority: other.priority,
            position: other.position,
            notBefore: null,
            dueAt: null,
            size: null,
            tags: [
              {
                name: "frontend",
                description: "Silently rewritten metadata",
                color: "#ff0000",
                exclusiveGroup: null,
              },
            ],
            requiredCapabilities: [],
            expectedVersion: other.version,
            idempotencyKey: "conflicting-tag-definition",
          },
          human,
          taskServices,
        ),
      ),
    );
    const tasksAfterConflict = await Effect.runPromise(listTasks({ projectId }, taskServices));

    expect(Either.isLeft(conflict) && conflict.left["_tag"]).toBe("TaskTagDefinitionConflictError");
    expect(tasksAfterConflict.find((task) => task.id === tagged.id)?.tags).toEqual(tagged.tags);
    expect(tasksAfterConflict.find((task) => task.id === other.id)?.version).toBe(other.version);
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
    const missing = await Effect.runPromise(listTasks({ projectId }, taskServices, ["react"]));
    const incompatibleCandidates = (
      await Effect.runPromise(findWork({ projectId, limit: 100 }, ["react"], taskServices))
    ).candidates;
    const compatibleCandidates = (
      await Effect.runPromise(
        findWork({ projectId, limit: 100 }, ["sqlite", "react"], taskServices),
      )
    ).candidates;
    const context = await Effect.runPromise(
      getTaskContext({ projectId, taskId: task.id }, ["SQLITE", "React"], taskServices),
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
    expect(context.task.eligibility).toMatchObject({
      claimable: true,
      missingCapabilities: [],
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
    const blockedCandidates = (
      await Effect.runPromise(findWork({ projectId, limit: 100 }, [], taskServices))
    ).candidates;
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

  it("treats an archived blocker as withdrawn instead of stranding its dependent", async () => {
    const blocker = await Effect.runPromise(
      createTask(
        readyInput({ title: "Withdrawn blocker", idempotencyKey: "withdrawn-blocker" }),
        human,
        taskServices,
      ),
    );
    const dependent = await Effect.runPromise(
      createTask(
        readyInput({ title: "Dependent work", idempotencyKey: "withdrawn-dependent" }),
        human,
        taskServices,
      ),
    );
    await Effect.runPromise(
      createTaskRelation(
        {
          projectId,
          sourceTaskId: blocker.id,
          targetTaskId: dependent.id,
          type: "blocks",
          expectedSourceVersion: blocker.version,
          expectedTargetVersion: dependent.version,
          idempotencyKey: "withdrawn-blocking-relation",
        },
        human,
        taskServices,
      ),
    );
    const blockedTasks = await Effect.runPromise(listTasks({ projectId }, taskServices));
    const currentBlocker = blockedTasks.find((task) => task.id === blocker.id);
    if (!currentBlocker) throw new Error("Expected the blocker");

    await Effect.runPromise(
      archiveTask(
        {
          taskId: blocker.id,
          expectedVersion: currentBlocker.version,
          reason: "The dependency was withdrawn",
          idempotencyKey: "archive-withdrawn-blocker",
        },
        human,
        taskServices,
      ),
    );
    const afterArchive = await Effect.runPromise(listTasks({ projectId }, taskServices));

    expect(afterArchive.find((task) => task.id === dependent.id)).toMatchObject({
      eligibility: { claimable: true, status: "claimable", blockingTaskIds: [] },
      upstreamRelations: [expect.objectContaining({ sourceTaskId: blocker.id, type: "blocks" })],
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

  it("returns a typed error for a duplicate relation without partial writes", async () => {
    const source = await Effect.runPromise(
      createTask(
        readyInput({ title: "Duplicate source", idempotencyKey: "duplicate-source" }),
        human,
        taskServices,
      ),
    );
    const target = await Effect.runPromise(
      createTask(
        readyInput({ title: "Duplicate target", idempotencyKey: "duplicate-target" }),
        human,
        taskServices,
      ),
    );
    await Effect.runPromise(
      createTaskRelation(
        {
          projectId,
          sourceTaskId: source.id,
          targetTaskId: target.id,
          type: "related_to",
          expectedSourceVersion: source.version,
          expectedTargetVersion: target.version,
          idempotencyKey: "first-duplicate-relation",
        },
        human,
        taskServices,
      ),
    );
    const [currentSource, currentTarget] = (
      await Effect.runPromise(listTasks({ projectId }, taskServices))
    ).filter((task) => task.id === source.id || task.id === target.id);
    if (!currentSource || !currentTarget) throw new Error("Expected both related tasks");
    const eventCount = projectStore.database.prepare("select count(*) from events").pluck().get();

    const duplicate = await Effect.runPromise(
      Effect.either(
        createTaskRelation(
          {
            projectId,
            sourceTaskId: source.id,
            targetTaskId: target.id,
            type: "related_to",
            expectedSourceVersion: currentSource.version,
            expectedTargetVersion: currentTarget.version,
            idempotencyKey: "second-duplicate-relation",
          },
          agent,
          taskServices,
        ),
      ),
    );

    expect(Either.isLeft(duplicate) && duplicate.left["_tag"]).toBe("TaskRelationError");
    expect(projectStore.database.prepare("select count(*) from task_relations").pluck().get()).toBe(
      1,
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
    expect(() => createTaskInputSchema.parse({ ...valid, notBefore: "2026-02-30" })).toThrow();
    expect(() =>
      compiledCreateTaskInputSchema.parse({ ...valid, referencedPaths: ["../outside.ts"] }),
    ).toThrow();
    expect(() =>
      compiledCreateTaskInputSchema.parse({
        ...valid,
        referencedPaths: [`src/${"a".repeat(256)}`],
      }),
    ).toThrow();
    expect(() =>
      compiledCreateTaskInputSchema.parse({ ...valid, referencedPaths: ["src/\0outside.ts"] }),
    ).toThrow();
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
