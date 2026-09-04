import type { ProjectEvent } from "../../domain/activity";
import type { AgentRunSummary } from "../../domain/agents";
import {
  compareTaskOrder,
  type Task,
  type TaskAttemptSummary,
  type TaskPriority,
} from "../../domain/tasks";

export type ActiveAgentRunSummary = Pick<
  AgentRunSummary,
  "id" | "displayName" | "capabilities" | "lastSeenAt"
>;

export type OperationalProjectLease = {
  readonly taskId: string;
  readonly taskSequence: number;
  readonly taskTitle: string;
  readonly priority: TaskPriority;
  readonly acquiredAt: string;
  readonly expiresAt: string;
};

export type OperationalActiveRun = {
  readonly id: string;
  readonly displayName: string;
  readonly capabilities: readonly string[];
  readonly lastSeenAt: string | null;
  readonly projectLeases: readonly OperationalProjectLease[];
};

export type OperationalAttemptFailure = {
  readonly task: Task | null;
  readonly attempt: TaskAttemptSummary;
};

/**
 * Event fields safe for operational presentation. Event payloads and protocol identifiers are
 * intentionally not carried into the dashboard read model.
 */
export type OperationalEventSummary = {
  readonly id: string;
  readonly cursor: number;
  readonly projectId: string | null;
  readonly kind: string;
  readonly importance: ProjectEvent["importance"];
  readonly actorType: ProjectEvent["actor"]["type"];
  readonly taskId: string | null;
  readonly taskIds: readonly string[];
  readonly detail: string | null;
  readonly occurredAt: string;
};

export type OperationalReopenedTask = {
  readonly taskId: string;
  readonly task: Task | null;
  readonly event: OperationalEventSummary;
};

export type OperationalDashboardCounts = {
  readonly claimable: number;
  readonly active: number;
  readonly blocked: number;
  readonly review: number;
  readonly scheduled: number;
  readonly failed: number;
  readonly reopened: number;
  readonly activeRuns: number;
  readonly activeLeases: number;
};

export type OperationalDashboardProjection = {
  readonly counts: OperationalDashboardCounts;
  readonly claimable: readonly Task[];
  readonly active: readonly Task[];
  readonly blocked: readonly Task[];
  readonly review: readonly Task[];
  readonly scheduled: readonly Task[];
  readonly failures: readonly OperationalAttemptFailure[];
  readonly reopened: readonly OperationalReopenedTask[];
  readonly activeRuns: readonly OperationalActiveRun[];
  readonly recentEvents: readonly OperationalEventSummary[];
};

export type BuildOperationalDashboardInput = {
  readonly tasks: readonly Task[];
  readonly attempts: readonly TaskAttemptSummary[];
  readonly events: readonly ProjectEvent[];
  readonly activeAgentRuns?: readonly ActiveAgentRunSummary[];
};

function compareTasks(left: Task, right: Task) {
  return compareTaskOrder(left, right) || left.id.localeCompare(right.id);
}

function compareAttemptRecency(left: TaskAttemptSummary, right: TaskAttemptSummary) {
  return (
    left.attemptNumber - right.attemptNumber ||
    left.createdAt.localeCompare(right.createdAt) ||
    left.id.localeCompare(right.id)
  );
}

function latestAttemptFailures(
  attempts: readonly TaskAttemptSummary[],
  tasksById: ReadonlyMap<string, Task>,
) {
  const latestByTask = new Map<string, TaskAttemptSummary>();
  for (const attempt of attempts) {
    const current = latestByTask.get(attempt.taskId);
    if (!current || compareAttemptRecency(attempt, current) > 0) {
      latestByTask.set(attempt.taskId, attempt);
    }
  }

  return [...latestByTask.values()]
    .filter((attempt) => attempt.status === "failed")
    .flatMap((attempt) => {
      const task = tasksById.get(attempt.taskId);
      return task ? [{ task, attempt }] : [];
    })
    .toSorted((left, right) => {
      const leftFinishedAt = left.attempt.completedAt ?? left.attempt.createdAt;
      const rightFinishedAt = right.attempt.completedAt ?? right.attempt.createdAt;
      const completedAt = rightFinishedAt.localeCompare(leftFinishedAt);
      if (completedAt !== 0) return completedAt;
      if (left.task && right.task) {
        const taskOrder = compareTasks(left.task, right.task);
        if (taskOrder !== 0) return taskOrder;
      }
      return left.attempt.taskId.localeCompare(right.attempt.taskId);
    });
}

const eventDetailKeys = ["message", "reason", "summary", "title"] as const;

function eventDetail(event: ProjectEvent) {
  for (const key of eventDetailKeys) {
    const value = event.payload[key];
    if (typeof value === "string" && value.trim()) return value.trim();
  }
  return null;
}

function eventTaskIds(event: ProjectEvent) {
  const primaryTaskId = primaryEventTaskId(event);
  const taskIds = new Set(
    primaryTaskId ? [primaryTaskId, ...event.changes.taskIds] : event.changes.taskIds,
  );
  return [...taskIds];
}

function summarizeEvent(event: ProjectEvent): OperationalEventSummary {
  return {
    id: event.id,
    cursor: event.cursor,
    projectId: event.projectId,
    kind: event.kind,
    importance: event.importance,
    actorType: event.actor.type,
    taskId: primaryEventTaskId(event),
    taskIds: eventTaskIds(event),
    detail: eventDetail(event),
    occurredAt: event.occurredAt,
  };
}

function primaryEventTaskId(event: ProjectEvent) {
  if (event.entity.type === "task") return event.entity.id;
  return event.changes.taskIds[0] ?? null;
}

function latestReopenedTasks(
  events: readonly ProjectEvent[],
  tasksById: ReadonlyMap<string, Task>,
) {
  const seenTaskIds = new Set<string>();
  const reopened: OperationalReopenedTask[] = [];
  for (const event of events.toSorted((left, right) => right.cursor - left.cursor)) {
    if (event.kind !== "task.reopened") continue;
    const taskId = primaryEventTaskId(event);
    if (!taskId || seenTaskIds.has(taskId)) continue;
    const task = tasksById.get(taskId);
    if (!task) continue;
    seenTaskIds.add(taskId);
    reopened.push({
      taskId,
      task,
      event: summarizeEvent(event),
    });
  }
  return reopened;
}

function normalizedCapabilities(capabilities: readonly string[]) {
  return [...new Set(capabilities)].toSorted((left, right) => left.localeCompare(right));
}

function activeRunPresence(
  activeAgentRuns: readonly ActiveAgentRunSummary[],
  tasks: readonly Task[],
) {
  const presence = new Map<
    string,
    {
      id: string;
      displayName: string;
      capabilities: readonly string[];
      lastSeenAt: string | null;
      leasedTasks: Task[];
    }
  >();

  for (const run of activeAgentRuns.toSorted((left, right) => left.id.localeCompare(right.id))) {
    if (presence.has(run.id)) continue;
    presence.set(run.id, {
      id: run.id,
      displayName: run.displayName,
      capabilities: normalizedCapabilities(run.capabilities),
      lastSeenAt: run.lastSeenAt,
      leasedTasks: [],
    });
  }

  for (const task of tasks) {
    const claim = task.claim;
    if (!claim || claim.status !== "active") continue;
    let run = presence.get(claim.agentRunId);
    if (!run) {
      run = {
        id: claim.agentRunId,
        displayName: claim.agentDisplayName,
        capabilities: [],
        lastSeenAt: null,
        leasedTasks: [],
      };
      presence.set(run.id, run);
    }
    run.leasedTasks.push(task);
  }

  return [...presence.values()]
    .map((run): OperationalActiveRun => ({
      id: run.id,
      displayName: run.displayName,
      capabilities: run.capabilities,
      lastSeenAt: run.lastSeenAt,
      projectLeases: run.leasedTasks.toSorted(compareTasks).map((task) => {
        const claim = task.claim;
        if (!claim || claim.status !== "active") {
          throw new Error("An operational lease must come from an active task claim.");
        }
        return {
          taskId: task.id,
          taskSequence: task.sequence,
          taskTitle: task.title,
          priority: task.priority,
          acquiredAt: claim.acquiredAt,
          expiresAt: claim.expiresAt,
        };
      }),
    }))
    .toSorted(
      (left, right) =>
        Number(right.projectLeases.length > 0) - Number(left.projectLeases.length > 0) ||
        left.displayName.localeCompare(right.displayName) ||
        left.id.localeCompare(right.id),
    );
}

export function buildOperationalDashboard({
  tasks,
  attempts,
  events,
  activeAgentRuns = [],
}: BuildOperationalDashboardInput): OperationalDashboardProjection {
  const tasksById = new Map(tasks.map((task) => [task.id, task]));
  const claimable = tasks
    .filter((task) => task.eligibility?.claimable === true)
    .toSorted(compareTasks);
  const active = tasks.filter((task) => task.lifecycle === "in_progress").toSorted(compareTasks);
  const blocked = tasks
    .filter((task) => task.eligibility?.status === "blocked")
    .toSorted(compareTasks);
  const review = tasks.filter((task) => task.lifecycle === "review").toSorted(compareTasks);
  const scheduled = tasks
    .filter((task) => task.eligibility?.status === "scheduled")
    .toSorted(compareTasks);
  const failures = latestAttemptFailures(attempts, tasksById);
  const reopened = latestReopenedTasks(events, tasksById);
  const runs = activeRunPresence(activeAgentRuns, tasks);
  const recentEvents = events
    .toSorted((left, right) => right.cursor - left.cursor)
    .map(summarizeEvent);
  const activeLeases = runs.reduce((total, run) => total + run.projectLeases.length, 0);

  return {
    counts: {
      claimable: claimable.length,
      active: active.length,
      blocked: blocked.length,
      review: review.length,
      scheduled: scheduled.length,
      failed: failures.length,
      reopened: reopened.length,
      activeRuns: runs.length,
      activeLeases,
    },
    claimable,
    active,
    blocked,
    review,
    scheduled,
    failures,
    reopened,
    activeRuns: runs,
    recentEvents,
  };
}
