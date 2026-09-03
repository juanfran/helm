import { mkdir, mkdtemp, rm } from "node:fs/promises";
import { join } from "node:path";
import { tmpdir } from "node:os";

import { Effect, Either } from "effect";
import { afterEach, beforeEach, describe, expect, it } from "vitest";

import { createProject } from "./projects";
import { archiveTask, createTask, listTasks, prepareTask } from "./tasks";
import {
  compiledCreateTaskInputSchema,
  createTaskInputSchema,
  emptyRichTextDocument,
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

  it("accepts representative input through normal and compiled task schemas", () => {
    const valid = backlogInput();
    expect(createTaskInputSchema.parse(valid)).toEqual(valid);
    expect(compiledCreateTaskInputSchema.parse(valid)).toEqual(valid);
    expect(() => createTaskInputSchema.parse({ ...valid, expectedVersion: 1 })).toThrow();
    expect(() => compiledCreateTaskInputSchema.parse({ ...valid, title: "" })).toThrow();
  });
});
