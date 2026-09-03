import { mkdir, mkdtemp, rm } from "node:fs/promises";
import { join } from "node:path";
import { tmpdir } from "node:os";

import { Effect } from "effect";
import { afterEach, beforeEach, describe, expect, it } from "vitest";

import { createProject } from "../application/projects";
import { emptyRichTextDocument } from "../domain/tasks";
import { localRepositoryInspector } from "../infrastructure/repository-inspector.server";
import {
  createSqliteProjectStore,
  type SqliteProjectStore,
} from "../infrastructure/sqlite-project-store.server";
import { createSqliteTaskStore } from "../infrastructure/sqlite-task-store.server";
import {
  executeArchiveTask,
  executeCreateTask,
  executeCreateTaskRelation,
  executeUpdateTaskPlanning,
} from "./task-adapter";

let temporaryRoot: string;
let projectStore: SqliteProjectStore;
let projectId: string;
let taskServices: { store: ReturnType<typeof createSqliteTaskStore> };
const actor = { type: "human" as const, id: "adapter-human" };

beforeEach(async () => {
  temporaryRoot = await mkdtemp(join(tmpdir(), "helm-task-adapter-test-"));
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
  taskServices = { store: createSqliteTaskStore(projectStore.database) };
});

afterEach(async () => {
  projectStore.close();
  await rm(temporaryRoot, { recursive: true, force: true });
});

describe("task server adapter", () => {
  it("serializes task success, preparation, and version-conflict results", async () => {
    const created = await executeCreateTask(
      {
        projectId,
        parentTaskId: null,
        lifecycle: "backlog",
        title: "Captured work",
        description: emptyRichTextDocument,
        expectedOutcome: "",
        acceptanceCriteria: "",
        agentContext: "",
        checklist: [],
        expectedVersion: 0,
        idempotencyKey: "create",
      },
      actor,
      taskServices,
    );
    const invalidReady = await executeCreateTask(
      {
        projectId,
        parentTaskId: null,
        lifecycle: "ready",
        title: "Not prepared",
        description: emptyRichTextDocument,
        expectedOutcome: "",
        acceptanceCriteria: "",
        agentContext: "",
        checklist: [],
        expectedVersion: 0,
        idempotencyKey: "invalid-ready",
      },
      actor,
      taskServices,
    );
    if (!created.ok) throw new Error("Expected task creation to succeed");
    const archived = await executeArchiveTask(
      {
        taskId: created.task.id,
        expectedVersion: created.task.version,
        reason: "Done elsewhere",
        idempotencyKey: "archive",
      },
      actor,
      taskServices,
    );
    const conflict = await executeArchiveTask(
      {
        taskId: created.task.id,
        expectedVersion: created.task.version,
        reason: "Stale request",
        idempotencyKey: "conflict",
      },
      actor,
      taskServices,
    );

    expect(archived).toMatchObject({ ok: true, task: { archivedAt: expect.any(String) } });
    expect(invalidReady).toMatchObject({
      ok: false,
      error: { type: "TaskPreparationError", missingFields: expect.any(Array) },
    });
    expect(conflict).toMatchObject({
      ok: false,
      error: { type: "TaskVersionConflictError", expectedVersion: 1, currentVersion: 2 },
    });
  });

  it("serializes task planning updates and exclusive tag errors", async () => {
    const created = await executeCreateTask(
      {
        projectId,
        parentTaskId: null,
        lifecycle: "ready",
        title: "Routable work",
        description: emptyRichTextDocument,
        expectedOutcome: "Planning can be changed.",
        acceptanceCriteria: "The adapter returns a compact response.",
        agentContext: "",
        checklist: [{ id: "verify", text: "Verify routing", checked: false }],
        expectedVersion: 0,
        idempotencyKey: "create-routable",
      },
      actor,
      taskServices,
    );
    if (!created.ok) throw new Error("Expected ready task creation to succeed");

    const invalid = await executeUpdateTaskPlanning(
      {
        taskId: created.task.id,
        priority: "high",
        position: 1,
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
        expectedVersion: created.task.version,
        idempotencyKey: "invalid-routing",
      },
      actor,
      taskServices,
    );

    expect(invalid).toMatchObject({
      ok: false,
      error: {
        type: "TaskTagConstraintError",
        group: "area",
        tagNames: ["frontend", "backend"],
      },
    });
  });

  it("serializes relation validation errors", async () => {
    const created = await executeCreateTask(
      {
        projectId,
        parentTaskId: null,
        lifecycle: "ready",
        title: "Self link candidate",
        description: emptyRichTextDocument,
        expectedOutcome: "Relations can be validated.",
        acceptanceCriteria: "The adapter returns relation errors.",
        agentContext: "",
        checklist: [{ id: "verify", text: "Verify relation errors", checked: false }],
        expectedVersion: 0,
        idempotencyKey: "self-link-candidate",
      },
      actor,
      taskServices,
    );
    if (!created.ok) throw new Error("Expected ready task creation to succeed");

    const invalid = await executeCreateTaskRelation(
      {
        projectId,
        sourceTaskId: created.task.id,
        targetTaskId: created.task.id,
        type: "blocks",
        expectedSourceVersion: created.task.version,
        expectedTargetVersion: created.task.version,
        idempotencyKey: "adapter-self-link",
      },
      actor,
      taskServices,
    );

    expect(invalid).toMatchObject({
      ok: false,
      error: {
        type: "TaskRelationError",
        sourceTaskId: created.task.id,
        targetTaskId: created.task.id,
        relationPath: [`#${created.task.sequence}`],
      },
    });
  });
});
