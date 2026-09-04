import { describe, expect, it, vi } from "vitest";

import type { ActivityEntry, ManualBlocker, ProjectEvent } from "../../domain/activity";
import {
  emptyRichTextDocument,
  taskSchema,
  type Task,
  type TaskAttemptSummary,
} from "../../domain/tasks";
import {
  projectEvent,
  projectImportantEvent,
  type ProjectionCollection,
} from "./project-event-projector";

function collection<T extends { id: string }>() {
  const writeBatch = vi.fn((callback: () => void) => callback());
  const writeDelete = vi.fn();
  const writeUpsert = vi.fn();
  const value: ProjectionCollection<T> = {
    has: vi.fn(() => true),
    utils: { writeBatch, writeDelete, writeUpsert },
  };
  return { value, writeBatch, writeDelete, writeUpsert };
}

function event(overrides: Partial<ProjectEvent> = {}): ProjectEvent {
  return {
    id: "event-8",
    cursor: 8,
    projectId: "project-1",
    kind: "task.entry.comment.created",
    importance: "routine",
    actor: { type: "human", id: "local-human" },
    entity: { type: "activity_entry", id: "entry-1" },
    payload: {},
    changes: {
      projectIds: ["project-1"],
      taskIds: ["task-1", "task-1"],
      activityEntryIds: ["entry-1", "entry-1"],
      agentRunIds: [],
      scopes: ["activity", "tasks"],
    },
    occurredAt: "2026-09-04T10:00:00.000Z",
    ...overrides,
  };
}

const task = taskSchema.parse({
  id: "task-1",
  projectId: "project-1",
  sequence: 1,
  title: "Test task",
  lifecycle: "ready",
  description: emptyRichTextDocument,
  descriptionText: "",
  expectedOutcome: "Done",
  acceptanceCriteria: "Verified",
  agentContext: "",
  checklist: [{ id: "check-1", text: "Verify", checked: false }],
  version: 1,
  archivedAt: null,
  createdAt: "2026-09-04T09:00:00.000Z",
  updatedAt: "2026-09-04T09:00:00.000Z",
});
const entry: ActivityEntry = {
  id: "entry-1",
  projectId: "project-1",
  taskId: "task-1",
  attemptId: null,
  kind: "comment",
  author: { type: "human", id: "local-human" },
  authorDisplayName: "You",
  agentProfileId: null,
  content: emptyRichTextDocument,
  contentText: "Hello",
  createdAt: "2026-09-04T10:00:00.000Z",
  withdrawnAt: null,
  withdrawnBy: null,
  withdrawalReason: null,
};
const attempt: TaskAttemptSummary = {
  id: "attempt-1",
  taskId: task.id,
  attemptNumber: 1,
  agentRunId: "run-1",
  agentProfileId: "profile-1",
  agentDisplayName: "Build Agent",
  status: "completed",
  summary: "Implemented the task.",
  changedAreas: ["src/features"],
  verificationResults: [{ name: "pnpm check", status: "passed", details: "All checks passed." }],
  references: [],
  risks: [],
  followUpWork: [],
  failureClassification: null,
  createdAt: "2026-09-04T09:30:00.000Z",
  completedAt: "2026-09-04T10:00:00.000Z",
};

describe("project event projector", () => {
  it("uses event hints for targeted direct writes", async () => {
    const taskCollection = collection<Task>();
    const attemptCollection = collection<TaskAttemptSummary>();
    const activityCollection = collection<ActivityEntry>();
    const eventCollection = collection<ProjectEvent>();
    const readTaskDelta = vi.fn(async () => ({ upserts: [task], deleteIds: [] }));
    const readAttemptDelta = vi.fn(async () => ({ upserts: [attempt], deleteIds: [] }));
    const readActivityDelta = vi.fn(async () => ({ upserts: [entry], deleteIds: [] }));

    await projectEvent(event(), {
      taskCollection: taskCollection.value,
      attemptCollection: attemptCollection.value,
      activityCollection: activityCollection.value,
      eventCollection: eventCollection.value,
      readTaskDelta,
      readAttemptDelta,
      readActivityDelta,
    });

    expect(readTaskDelta).toHaveBeenCalledWith(["task-1"]);
    expect(readAttemptDelta).toHaveBeenCalledWith(["task-1"]);
    expect(readActivityDelta).toHaveBeenCalledWith(["entry-1"]);
    expect(taskCollection.writeUpsert).toHaveBeenCalledWith([task]);
    expect(attemptCollection.writeUpsert).toHaveBeenCalledWith([attempt]);
    expect(activityCollection.writeUpsert).toHaveBeenCalledWith([entry]);
    expect(eventCollection.writeUpsert).toHaveBeenCalledWith(event());
  });

  it("applies deletions and only reads blockers for blocker events", async () => {
    const taskCollection = collection<Task>();
    const activityCollection = collection<ActivityEntry>();
    const blockerCollection = collection<ManualBlocker>();
    const readBlockerDelta = vi.fn(async () => ({ upserts: [], deleteIds: ["blocker-1"] }));

    await projectEvent(event({ kind: "task.blocker.resolved" }), {
      taskCollection: taskCollection.value,
      activityCollection: activityCollection.value,
      blockerCollection: blockerCollection.value,
      readTaskDelta: async () => ({ upserts: [], deleteIds: ["task-1"] }),
      readActivityDelta: async () => ({ upserts: [], deleteIds: [] }),
      readBlockerDelta,
    });

    expect(taskCollection.writeDelete).toHaveBeenCalledWith(["task-1"]);
    expect(readBlockerDelta).toHaveBeenCalledWith(["task-1"]);
    expect(blockerCollection.writeDelete).toHaveBeenCalledWith(["blocker-1"]);
  });

  it("does not issue unrelated reads for an event without row hints", async () => {
    const readTaskDelta = vi.fn();
    const readActivityDelta = vi.fn();
    await projectEvent(
      event({
        changes: {
          projectIds: ["project-1"],
          taskIds: [],
          activityEntryIds: [],
          agentRunIds: [],
          scopes: ["preferences"],
        },
      }),
      {
        taskCollection: collection<Task>().value,
        activityCollection: collection<ActivityEntry>().value,
        readTaskDelta,
        readActivityDelta,
      },
    );

    expect(readTaskDelta).not.toHaveBeenCalled();
    expect(readActivityDelta).not.toHaveBeenCalled();
  });

  it("treats an already-absent projected deletion as success", async () => {
    const taskCollection = collection<Task>();
    taskCollection.value.has = vi.fn(() => false);

    await projectEvent(event(), {
      taskCollection: taskCollection.value,
      activityCollection: collection<ActivityEntry>().value,
      readTaskDelta: async () => ({ upserts: [], deleteIds: ["task-1"] }),
      readActivityDelta: async () => ({ upserts: [], deleteIds: [] }),
    });

    expect(taskCollection.writeDelete).not.toHaveBeenCalled();
  });

  it("projects only important events into the notification history", () => {
    const importantEventCollection = collection<ProjectEvent>();
    expect(projectImportantEvent(event(), importantEventCollection.value)).toBe(false);
    expect(importantEventCollection.writeUpsert).not.toHaveBeenCalled();

    const important = event({ importance: "attention", kind: "task.blocker.created" });
    expect(projectImportantEvent(important, importantEventCollection.value)).toBe(true);
    expect(importantEventCollection.writeUpsert).toHaveBeenCalledWith(important);
  });
});
