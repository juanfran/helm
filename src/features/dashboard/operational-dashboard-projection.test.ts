import { describe, expect, it } from "vitest";

import type { ProjectEvent } from "../../domain/activity";
import {
  emptyRichTextDocument,
  taskSchema,
  type Task,
  type TaskAttemptSummary,
  type TaskClaim,
  type TaskEligibility,
  type TaskLifecycle,
  type TaskPriority,
} from "../../domain/tasks";
import {
  buildOperationalDashboard,
  type ActiveAgentRunSummary,
} from "./operational-dashboard-projection";

const projectId = "project-1";

function eligibility(
  status: TaskEligibility["status"],
  claimable = status === "claimable",
): TaskEligibility {
  return {
    claimable,
    status,
    reasons: [`Task is ${status}.`],
    orderingExplanation: "stable order",
    missingCapabilities: [],
    blockingTaskIds: [],
    manualBlockerIds: [],
  };
}

function claim(
  taskId: string,
  agentRunId: string,
  agentDisplayName: string,
  expiresAt: string,
): TaskClaim {
  return {
    id: `lease-${taskId}`,
    taskId,
    attemptId: `attempt-${taskId}`,
    agentRunId,
    agentProfileId: `profile-${agentRunId}`,
    agentDisplayName,
    status: "active",
    acquiredAt: "2026-09-04T09:00:00.000Z",
    expiresAt,
    invalidatedAt: null,
    invalidationReason: null,
  };
}

function task({
  id,
  sequence,
  title,
  lifecycle = "ready",
  priority = "normal",
  position = sequence,
  taskEligibility,
  taskClaim = null,
  notBefore = null,
}: {
  id: string;
  sequence: number;
  title: string;
  lifecycle?: TaskLifecycle;
  priority?: TaskPriority;
  position?: number;
  taskEligibility?: TaskEligibility;
  taskClaim?: TaskClaim | null;
  notBefore?: string | null;
}): Task {
  return taskSchema.parse({
    id,
    projectId,
    sequence,
    title,
    lifecycle,
    priority,
    position,
    notBefore,
    claim: taskClaim,
    eligibility: taskEligibility,
    description: emptyRichTextDocument,
    descriptionText: "",
    expectedOutcome: "Done",
    acceptanceCriteria: "Verified",
    agentContext: "",
    checklist: [{ id: `check-${id}`, text: "Verify", checked: false }],
    version: 1,
    archivedAt: null,
    createdAt: `2026-09-04T08:${String(sequence).padStart(2, "0")}:00.000Z`,
    updatedAt: `2026-09-04T08:${String(sequence).padStart(2, "0")}:00.000Z`,
  });
}

function attempt({
  id,
  taskId,
  attemptNumber,
  status,
  completedAt,
}: {
  id: string;
  taskId: string;
  attemptNumber: number;
  status: TaskAttemptSummary["status"];
  completedAt: string | null;
}): TaskAttemptSummary {
  return {
    id,
    taskId,
    attemptNumber,
    agentRunId: "run-build",
    agentProfileId: "profile-build",
    agentDisplayName: "Build Agent",
    status,
    summary: `${status} attempt`,
    changedAreas: [],
    verificationResults: [],
    references: [],
    risks: [],
    followUpWork: [],
    failureClassification: status === "failed" ? "verification" : null,
    createdAt: `2026-09-04T0${attemptNumber}:00:00.000Z`,
    completedAt,
  };
}

function event({
  id,
  cursor,
  kind,
  taskId,
  payload = {},
}: {
  id: string;
  cursor: number;
  kind: string;
  taskId?: string;
  payload?: ProjectEvent["payload"];
}): ProjectEvent {
  return {
    id,
    cursor,
    projectId,
    kind,
    importance: kind === "task.attempt.failed" ? "critical" : "routine",
    actor: { type: "agent", id: "internal-agent-run" },
    entity: taskId ? { type: "task", id: taskId } : { type: "agent_run", id: "internal-agent-run" },
    payload,
    changes: {
      projectIds: [projectId],
      taskIds: taskId ? [taskId] : [],
      activityEntryIds: [],
      agentRunIds: ["internal-agent-run"],
      scopes: ["tasks"],
    },
    occurredAt: `2026-09-04T10:${String(cursor).padStart(2, "0")}:00.000Z`,
  };
}

describe("operational dashboard projection", () => {
  it("builds exact task buckets in canonical task order", () => {
    const urgentClaimable = task({
      id: "urgent-claimable",
      sequence: 7,
      title: "Urgent claimable",
      priority: "urgent",
      position: 4,
      taskEligibility: eligibility("claimable"),
    });
    const normalClaimable = task({
      id: "normal-claimable",
      sequence: 1,
      title: "Normal claimable",
      priority: "normal",
      position: 1,
      taskEligibility: eligibility("claimable"),
    });
    const activeWithLease = task({
      id: "active-with-lease",
      sequence: 2,
      title: "Active with lease",
      lifecycle: "in_progress",
      taskEligibility: eligibility("claimed", false),
      taskClaim: claim("active-with-lease", "run-build", "Build Agent", "2026-09-04T11:00:00.000Z"),
    });
    const activeWithoutLease = task({
      id: "active-without-lease",
      sequence: 3,
      title: "Active without projected lease",
      lifecycle: "in_progress",
      taskEligibility: eligibility("not_ready", false),
    });
    const blocked = task({
      id: "blocked",
      sequence: 4,
      title: "Blocked",
      taskEligibility: eligibility("blocked", false),
    });
    const review = task({
      id: "review",
      sequence: 5,
      title: "Review",
      lifecycle: "review",
      taskEligibility: eligibility("not_ready", false),
    });
    const scheduled = task({
      id: "scheduled",
      sequence: 6,
      title: "Scheduled",
      notBefore: "2026-09-10",
      taskEligibility: eligibility("scheduled", false),
    });

    const projection = buildOperationalDashboard({
      tasks: [
        scheduled,
        normalClaimable,
        review,
        activeWithoutLease,
        urgentClaimable,
        blocked,
        activeWithLease,
      ],
      attempts: [],
      events: [],
    });

    expect(projection.claimable.map((item) => item.id)).toEqual([
      urgentClaimable.id,
      normalClaimable.id,
    ]);
    expect(projection.active.map((item) => item.id)).toEqual([
      activeWithLease.id,
      activeWithoutLease.id,
    ]);
    expect(projection.blocked).toEqual([blocked]);
    expect(projection.review).toEqual([review]);
    expect(projection.scheduled).toEqual([scheduled]);
    expect(projection.counts).toMatchObject({
      claimable: 2,
      active: 2,
      blocked: 1,
      review: 1,
      scheduled: 1,
      failed: 0,
      reopened: 0,
    });
  });

  it("keeps only each task's latest failed attempt and latest reopen signal", () => {
    const recovered = task({
      id: "recovered",
      sequence: 1,
      title: "Recovered",
      taskEligibility: eligibility("claimable"),
    });
    const stillFailed = task({
      id: "still-failed",
      sequence: 2,
      title: "Still failed",
      taskEligibility: eligibility("claimable"),
    });
    const recoveredFailure = attempt({
      id: "recovered-attempt-1",
      taskId: recovered.id,
      attemptNumber: 1,
      status: "failed",
      completedAt: "2026-09-04T09:00:00.000Z",
    });
    const recoveredCompletion = attempt({
      id: "recovered-attempt-2",
      taskId: recovered.id,
      attemptNumber: 2,
      status: "completed",
      completedAt: "2026-09-04T10:00:00.000Z",
    });
    const latestFailure = attempt({
      id: "failed-attempt-2",
      taskId: stillFailed.id,
      attemptNumber: 2,
      status: "failed",
      completedAt: "2026-09-04T11:00:00.000Z",
    });
    const olderCompletion = attempt({
      id: "failed-attempt-1",
      taskId: stillFailed.id,
      attemptNumber: 1,
      status: "completed",
      completedAt: "2026-09-04T08:00:00.000Z",
    });
    const firstReopen = event({
      id: "reopen-8",
      cursor: 8,
      kind: "task.reopened",
      taskId: recovered.id,
      payload: { reason: "First reason" },
    });
    const latestReopen = event({
      id: "reopen-12",
      cursor: 12,
      kind: "task.reopened",
      taskId: recovered.id,
      payload: { reason: "Latest reason" },
    });
    const otherReopen = event({
      id: "reopen-10",
      cursor: 10,
      kind: "task.reopened",
      taskId: stillFailed.id,
      payload: { reason: "Requirements changed" },
    });

    const projection = buildOperationalDashboard({
      tasks: [stillFailed, recovered],
      attempts: [latestFailure, recoveredCompletion, olderCompletion, recoveredFailure],
      events: [firstReopen, otherReopen, latestReopen],
    });

    expect(projection.failures.map(({ attempt: item }) => item.id)).toEqual([latestFailure.id]);
    expect(projection.reopened.map(({ taskId }) => taskId)).toEqual([recovered.id, stillFailed.id]);
    expect(projection.reopened[0]?.event).toMatchObject({
      cursor: 12,
      detail: "Latest reason",
    });
    expect(projection.counts).toMatchObject({ failed: 1, reopened: 2 });
  });

  it("keeps archived or otherwise absent tasks out of actionable failure and reopen queues", () => {
    const visible = task({
      id: "visible",
      sequence: 1,
      title: "Visible task",
      taskEligibility: eligibility("claimable"),
    });
    const archivedFailure = attempt({
      id: "archived-attempt",
      taskId: "archived-task",
      attemptNumber: 1,
      status: "failed",
      completedAt: "2026-09-04T11:00:00.000Z",
    });
    const archivedReopen = event({
      id: "archived-reopen",
      cursor: 14,
      kind: "task.reopened",
      taskId: "archived-task",
      payload: { reason: "No longer in the detailed view" },
    });

    const projection = buildOperationalDashboard({
      tasks: [visible],
      attempts: [archivedFailure],
      events: [archivedReopen],
    });

    expect(projection.failures).toEqual([]);
    expect(projection.reopened).toEqual([]);
    expect(projection.counts).toMatchObject({ failed: 0, reopened: 0 });
  });

  it("groups active run presence and project leases without carrying protocol secrets", () => {
    const buildTask = task({
      id: "build-task",
      sequence: 2,
      title: "Build task",
      lifecycle: "in_progress",
      priority: "normal",
      taskEligibility: eligibility("claimed", false),
      taskClaim: claim("build-task", "run-build", "Build Agent", "2026-09-04T11:30:00.000Z"),
    });
    const urgentTask = task({
      id: "urgent-task",
      sequence: 9,
      title: "Urgent task",
      lifecycle: "in_progress",
      priority: "urgent",
      taskEligibility: eligibility("claimed", false),
      taskClaim: claim("urgent-task", "run-build", "Build Agent", "2026-09-04T11:00:00.000Z"),
    });
    const reviewTask = task({
      id: "review-task",
      sequence: 4,
      title: "Review task",
      lifecycle: "in_progress",
      taskEligibility: eligibility("claimed", false),
      taskClaim: claim("review-task", "run-review", "Review Agent", "2026-09-04T12:00:00.000Z"),
    });
    const unsafeRuns = [
      {
        id: "run-idle",
        displayName: "Idle Agent",
        capabilities: ["typescript"],
        lastSeenAt: "2026-09-04T10:00:00.000Z",
        mcpSessionId: "session-secret",
      },
      {
        id: "run-build",
        displayName: "Build Agent",
        capabilities: ["typescript", "react", "typescript"],
        lastSeenAt: "2026-09-04T10:05:00.000Z",
        mcpSessionId: "other-session-secret",
      },
    ] satisfies ReadonlyArray<ActiveAgentRunSummary & { mcpSessionId: string }>;
    const unsafeEvent = event({
      id: "unsafe-event",
      cursor: 20,
      kind: "task.attempt.failed",
      taskId: buildTask.id,
      payload: {
        summary: "Verification failed safely.",
        leaseToken: "lease-token-secret",
        mcpSessionId: "event-session-secret",
      },
    });

    const projection = buildOperationalDashboard({
      tasks: [buildTask, urgentTask, reviewTask],
      attempts: [],
      events: [unsafeEvent],
      activeAgentRuns: unsafeRuns,
    });

    expect(projection.activeRuns.map((run) => run.displayName)).toEqual([
      "Build Agent",
      "Review Agent",
      "Idle Agent",
    ]);
    expect(projection.activeRuns[0]).toMatchObject({
      id: "run-build",
      capabilities: ["react", "typescript"],
    });
    expect(projection.activeRuns[0]?.projectLeases.map((lease) => lease.taskId)).toEqual([
      urgentTask.id,
      buildTask.id,
    ]);
    expect(projection.activeRuns[1]?.projectLeases).toHaveLength(1);
    expect(projection.activeRuns[2]?.projectLeases).toEqual([]);
    expect(projection.counts).toMatchObject({ activeRuns: 3, activeLeases: 3 });
    expect(projection.recentEvents).toEqual([
      expect.objectContaining({
        id: unsafeEvent.id,
        taskId: buildTask.id,
        detail: "Verification failed safely.",
      }),
    ]);

    const serialized = JSON.stringify(projection);
    expect(serialized).not.toContain("lease-token-secret");
    expect(serialized).not.toContain("session-secret");
    expect(serialized).not.toContain("mcpSessionId");
    expect(serialized).not.toContain("leaseToken");
  });

  it("is deterministic when input order changes", () => {
    const tasks = [
      task({
        id: "task-b",
        sequence: 2,
        title: "Task B",
        taskEligibility: eligibility("claimable"),
      }),
      task({
        id: "task-a",
        sequence: 1,
        title: "Task A",
        taskEligibility: eligibility("claimable"),
      }),
    ];
    const attempts = [
      attempt({
        id: "attempt-b",
        taskId: tasks[0]!.id,
        attemptNumber: 1,
        status: "failed",
        completedAt: "2026-09-04T11:00:00.000Z",
      }),
      attempt({
        id: "attempt-a",
        taskId: tasks[1]!.id,
        attemptNumber: 1,
        status: "failed",
        completedAt: "2026-09-04T11:00:00.000Z",
      }),
    ];
    const events = [
      event({ id: "event-1", cursor: 1, kind: "task.reopened", taskId: tasks[0]!.id }),
      event({ id: "event-2", cursor: 2, kind: "task.reopened", taskId: tasks[1]!.id }),
    ];

    const forward = buildOperationalDashboard({ tasks, attempts, events });
    const reversed = buildOperationalDashboard({
      tasks: tasks.toReversed(),
      attempts: attempts.toReversed(),
      events: events.toReversed(),
    });

    expect(reversed).toEqual(forward);
  });
});
