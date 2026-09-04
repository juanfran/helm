import { mkdir, mkdtemp, rm } from "node:fs/promises";
import { join } from "node:path";
import { tmpdir } from "node:os";

import { Effect, Either } from "effect";
import { afterEach, beforeEach, describe, expect, it } from "vitest";

import { registerAgentRun } from "./agents";
import { createProject, setProjectReviewMode } from "./projects";
import {
  approveTaskReview,
  cancelTask,
  claimTask,
  completeTask,
  createTask,
  failTask,
  getTaskContext,
  listTaskAttempts,
  listTasks,
  reopenTask,
  requestTaskChanges,
  restoreCancelledTask,
  renewTaskLease,
  type TaskServices,
} from "./tasks";
import type { RegisteredAgentRun } from "../domain/agents";
import {
  emptyRichTextDocument,
  type Actor,
  type Task,
  type TaskCompletionReport,
} from "../domain/tasks";
import { createSqliteAgentStore } from "../infrastructure/sqlite-agent-store.server";
import {
  createSqliteProjectStore,
  type SqliteProjectStore,
} from "../infrastructure/sqlite-project-store.server";
import { createSqliteTaskStore } from "../infrastructure/sqlite-task-store.server";
import { localRepositoryInspector } from "../infrastructure/repository-inspector.server";

const human: Actor = { type: "human", id: "local-human" };
let temporaryRoot: string;
let repositoryRoot: string;
let projectStore: SqliteProjectStore;
let projectId: string;
let services: TaskServices;
let now: string;

function completionReport(label: string): TaskCompletionReport {
  return {
    resultSummary: `${label} is complete.`,
    changedAreas: [`src/${label}.ts`, `tests/${label}.test.ts`],
    verificationResults: [
      { name: "Typecheck", status: "passed", details: "No TypeScript errors." },
      { name: "Browser QA", status: "not_run", details: "No browser was available." },
    ],
    references: [`issue:${label}`],
    risks: ["A follow-up may broaden the policy."],
    followUpWork: ["Monitor the first production run."],
  };
}

function failureReport(label: string) {
  return {
    classification: "verification" as const,
    reason: `${label} could not pass its verification gate.`,
    changedAreas: [`src/${label}.ts`],
    verificationResults: [
      { name: "Integration tests", status: "failed" as const, details: "One assertion failed." },
    ],
    references: [`log:${label}`],
    risks: ["The incomplete change must not ship."],
    followUpWork: ["Repair the failing assertion."],
  };
}

async function registerAgent(key: string, displayName = `Agent ${key}`) {
  return Effect.runPromise(
    registerAgentRun(
      {
        profileKey: key,
        displayName,
        capabilities: ["typescript"],
        idempotencyKey: `register-${key}`,
      },
      {
        sessionId: `session-${key}`,
        clientName: "attempt-test",
        clientVersion: "1.0.0",
      },
      { store: createSqliteAgentStore(projectStore.database) },
    ),
  );
}

async function createReadyTask(key: string) {
  return Effect.runPromise(
    createTask(
      {
        projectId,
        parentTaskId: null,
        lifecycle: "ready",
        title: `Task ${key}`,
        description: emptyRichTextDocument,
        expectedOutcome: `${key} works.`,
        acceptanceCriteria: `${key} is verified.`,
        agentContext: "Preserve immutable attempt history.",
        checklist: [{ id: `verify-${key}`, text: "Verify the result", checked: false }],
        referencedPaths: [],
        requiredCapabilities: ["typescript"],
        expectedVersion: 0,
        idempotencyKey: `create-${key}`,
      },
      human,
      services,
    ),
  );
}

async function claim(task: Task, registration: RegisteredAgentRun, key: string) {
  return Effect.runPromise(
    claimTask(
      {
        projectId,
        taskId: task.id,
        expectedVersion: task.version,
        leaseDurationSeconds: 300,
        idempotencyKey: `claim-${key}`,
      },
      registration,
      services,
    ),
  );
}

async function setReviewMode(reviewMode: "required" | "direct", key: string) {
  const project = projectStore.database
    .prepare<[string], { version: number }>("select version from projects where id = ?")
    .get(projectId);
  if (!project) throw new Error("Expected a project fixture");
  return Effect.runPromise(
    setProjectReviewMode(
      {
        projectId,
        reviewMode,
        expectedVersion: project.version,
        idempotencyKey: `mode-${key}`,
      },
      human,
      { store: projectStore, inspector: localRepositoryInspector },
    ),
  );
}

async function completeClaim(
  grant: Awaited<ReturnType<typeof claim>>,
  registration: RegisteredAgentRun,
  key: string,
) {
  return Effect.runPromise(
    completeTask(
      {
        projectId,
        taskId: grant.task.id,
        leaseToken: grant.leaseToken,
        expectedVersion: grant.task.version,
        report: completionReport(key),
        idempotencyKey: `complete-${key}`,
      },
      registration,
      services,
    ),
  );
}

beforeEach(async () => {
  temporaryRoot = await mkdtemp(join(tmpdir(), "helm-attempt-test-"));
  repositoryRoot = join(temporaryRoot, "repository");
  await mkdir(join(repositoryRoot, ".git"), { recursive: true });
  now = "2026-09-04T09:00:00.000Z";
  projectStore = createSqliteProjectStore(join(temporaryRoot, "helm.db"));
  const project = await Effect.runPromise(
    createProject(
      { repositoryRoot, idempotencyKey: "create-project" },
      { store: projectStore, inspector: localRepositoryInspector },
    ),
  );
  projectId = project.id;
  services = {
    store: createSqliteTaskStore(projectStore.database),
    clock: { today: () => now.slice(0, 10), now: () => now },
  };
});

afterEach(async () => {
  projectStore.close();
  await rm(temporaryRoot, { recursive: true, force: true });
});

describe("task execution attempts", () => {
  it("completes directly with a full immutable report and exact retry snapshot", async () => {
    await setReviewMode("direct", "direct");
    const registration = await registerAgent("direct", "Direct Agent");
    const task = await createReadyTask("direct");
    const grant = await claim(task, registration, "direct");
    const input = {
      projectId,
      taskId: task.id,
      leaseToken: grant.leaseToken,
      expectedVersion: grant.task.version,
      report: completionReport("direct"),
      idempotencyKey: "complete-direct",
    };

    const completed = await Effect.runPromise(completeTask(input, registration, services));
    projectStore.database
      .prepare("update agent_profiles set display_name = ? where id = ?")
      .run("Renamed Agent", registration.profile.id);
    now = "2026-09-04T10:00:00.000Z";
    const retry = await Effect.runPromise(completeTask(input, registration, services));
    const attempts = await Effect.runPromise(listTaskAttempts({ projectId }, services));
    const persistedResult = projectStore.database
      .prepare<[string], string>("select result_json from idempotency_records where key = ?")
      .pluck()
      .get(input.idempotencyKey);
    const conflictingRetry = await Effect.runPromise(
      Effect.either(
        completeTask(
          {
            ...input,
            report: { ...input.report, resultSummary: "A conflicting summary." },
          },
          registration,
          services,
        ),
      ),
    );

    expect(completed).toMatchObject({
      task: { lifecycle: "done", version: grant.task.version + 1, claim: null },
      attempt: {
        id: grant.attempt.id,
        status: "completed",
        agentProfileId: registration.profile.id,
        agentDisplayName: "Direct Agent",
        summary: input.report.resultSummary,
        changedAreas: input.report.changedAreas,
        verificationResults: input.report.verificationResults,
        references: input.report.references,
        risks: input.report.risks,
        followUpWork: input.report.followUpWork,
      },
      claim: { status: "released", invalidationReason: "Completion report accepted." },
      routing: { reviewMode: "direct", destination: "done" },
      event: { kind: "task.completed", actor: { type: "agent", id: registration.run.id } },
    });
    expect(retry).toEqual(completed);
    expect(attempts).toEqual([completed.attempt]);
    expect(attempts[0]?.agentDisplayName).toBe("Direct Agent");
    expect(persistedResult).not.toContain(grant.leaseToken);
    expect(Either.isLeft(conflictingRetry) && conflictingRetry.left).toMatchObject({
      _tag: "TaskIdempotencyConflictError",
    });
  });

  it("routes required completion to review and preserves the reviewed attempt", async () => {
    const registration = await registerAgent("review", "Review Agent");
    const task = await createReadyTask("review");
    const completed = await completeClaim(
      await claim(task, registration, "review"),
      registration,
      "review",
    );
    const approvalInput = {
      taskId: task.id,
      attemptId: completed.attempt.id,
      expectedVersion: completed.task.version,
      summary: "The report and verification evidence are accepted.",
      idempotencyKey: "approve-review",
    };
    const approved = await Effect.runPromise(approveTaskReview(approvalInput, human, services));
    const reopened = await Effect.runPromise(
      reopenTask(
        {
          taskId: task.id,
          destination: "ready",
          expectedVersion: approved.task.version,
          reason: "A production observation requires another pass.",
          idempotencyKey: "reopen-approved",
        },
        human,
        services,
      ),
    );
    const approvalRetry = await Effect.runPromise(
      approveTaskReview(approvalInput, human, services),
    );
    const liveTask = (await Effect.runPromise(listTasks({ projectId }, services)))[0];

    expect(completed).toMatchObject({
      task: { lifecycle: "review", reviewAttemptId: completed.attempt.id },
      routing: { reviewMode: "required", destination: "review" },
      event: { kind: "task.review.requested" },
    });
    expect(approved).toMatchObject({
      task: { lifecycle: "done", reviewAttemptId: null },
      attempt: completed.attempt,
      event: {
        kind: "task.review.approved",
        actor: human,
        changes: {
          agentRunIds: [registration.run.id],
          scopes: ["agents", "tasks"],
        },
      },
    });
    expect(reopened).toMatchObject({
      task: { lifecycle: "ready" },
      attempt: completed.attempt,
      event: { kind: "task.reopened" },
    });
    expect(approvalRetry).toEqual(approved);
    expect(liveTask?.lifecycle).toBe("ready");
  });

  it("records structured review changes for the active or next agent", async () => {
    const registration = await registerAgent("changes", "Change Agent");
    const task = await createReadyTask("changes");
    const completed = await completeClaim(
      await claim(task, registration, "changes"),
      registration,
      "changes",
    );
    const changed = await Effect.runPromise(
      requestTaskChanges(
        {
          entryId: "review-change-entry",
          taskId: task.id,
          attemptId: completed.attempt.id,
          expectedVersion: completed.task.version,
          summary: "The error case still needs coverage.",
          requestedChanges: ["Add a regression test.", "Document the fallback."],
          idempotencyKey: "request-review-changes",
        },
        human,
        services,
      ),
    );
    const context = await Effect.runPromise(
      getTaskContext({ projectId, taskId: task.id }, ["typescript"], services),
    );
    const nextClaim = await claim(changed.task, registration, "changes-next");

    expect(changed).toMatchObject({
      task: { lifecycle: "ready", reviewAttemptId: null },
      attempt: completed.attempt,
      entry: {
        id: "review-change-entry",
        kind: "change_request",
        attemptId: completed.attempt.id,
        contentText: expect.stringContaining("Add a regression test."),
      },
      event: {
        kind: "task.review.changes_requested",
        actor: human,
        changes: {
          activityEntryIds: ["review-change-entry"],
          agentRunIds: [registration.run.id],
          scopes: ["activity", "agents", "tasks"],
        },
      },
    });
    expect(context.priorAttempts).toEqual([completed.attempt]);
    expect(context.entries).toContainEqual(changed.entry);
    expect(nextClaim.attempt.id).not.toBe(completed.attempt.id);
  });

  it("keeps review decisions, task cancellation, and restoration human-only", async () => {
    const registration = await registerAgent("authorization", "Authorization Agent");
    const task = await createReadyTask("authorization");
    const completed = await completeClaim(
      await claim(task, registration, "authorization"),
      registration,
      "authorization",
    );
    const agentActor: Actor = { type: "agent", id: registration.run.id };
    const rejected = await Promise.all([
      Effect.runPromise(
        Effect.either(
          approveTaskReview(
            {
              taskId: task.id,
              attemptId: completed.attempt.id,
              expectedVersion: completed.task.version,
              summary: "An agent cannot approve its own report.",
              idempotencyKey: "agent-approval",
            },
            agentActor,
            services,
          ),
        ),
      ),
      Effect.runPromise(
        Effect.either(
          requestTaskChanges(
            {
              entryId: "agent-change-entry",
              taskId: task.id,
              attemptId: completed.attempt.id,
              expectedVersion: completed.task.version,
              summary: "An agent cannot issue the human review decision.",
              requestedChanges: ["This must be rejected."],
              idempotencyKey: "agent-review-changes",
            },
            agentActor,
            services,
          ),
        ),
      ),
      Effect.runPromise(
        Effect.either(
          cancelTask(
            {
              taskId: task.id,
              expectedVersion: completed.task.version,
              reason: "An agent cannot cancel the task lifecycle.",
              idempotencyKey: "agent-task-cancel",
            },
            agentActor,
            services,
          ),
        ),
      ),
    ]);
    const cancelled = await Effect.runPromise(
      cancelTask(
        {
          taskId: task.id,
          expectedVersion: completed.task.version,
          reason: "The human is pausing this review.",
          idempotencyKey: "human-review-cancel",
        },
        human,
        services,
      ),
    );
    const rejectedRestore = await Effect.runPromise(
      Effect.either(
        restoreCancelledTask(
          {
            taskId: task.id,
            expectedVersion: cancelled.task.version,
            reason: "An agent cannot restore human-cancelled work.",
            idempotencyKey: "agent-task-restore",
          },
          { type: "system", id: "helm" },
          services,
        ),
      ),
    );

    for (const result of [...rejected, rejectedRestore]) {
      expect(Either.isLeft(result) && result.left).toMatchObject({
        _tag: "TaskAuthorizationError",
      });
    }
    expect(
      projectStore.database
        .prepare("select count(*) from activity_entries where id = 'agent-change-entry'")
        .pluck()
        .get(),
    ).toBe(0);
  });

  it("classifies failure, releases the lease, and allows a fresh attempt", async () => {
    const registration = await registerAgent("failure", "Failure Agent");
    const task = await createReadyTask("failure");
    const grant = await claim(task, registration, "failure");
    const failed = await Effect.runPromise(
      failTask(
        {
          projectId,
          taskId: task.id,
          leaseToken: grant.leaseToken,
          expectedVersion: grant.task.version,
          report: failureReport("failure"),
          idempotencyKey: "fail-attempt",
        },
        registration,
        services,
      ),
    );
    now = "2026-09-04T09:05:00.000Z";
    const nextClaim = await claim(failed.task, registration, "after-failure");
    const attempts = await Effect.runPromise(
      listTaskAttempts({ projectId, taskIds: [task.id] }, services),
    );

    expect(failed).toMatchObject({
      task: { lifecycle: "ready", claim: null },
      attempt: {
        id: grant.attempt.id,
        status: "failed",
        failureClassification: "verification",
        summary: failureReport("failure").reason,
      },
      claim: { status: "released" },
      event: { kind: "task.attempt.failed" },
    });
    expect(nextClaim.attempt.id).not.toBe(grant.attempt.id);
    expect(attempts.map(({ status }) => status)).toEqual(["failed", "active"]);
  });

  it("cancels active work, rejects late results, and restores it with attribution", async () => {
    const registration = await registerAgent("cancel", "Cancellation Agent");
    const task = await createReadyTask("cancel");
    const grant = await claim(task, registration, "cancel");
    const cancelled = await Effect.runPromise(
      cancelTask(
        {
          taskId: task.id,
          expectedVersion: grant.task.version,
          reason: "The product direction changed.",
          idempotencyKey: "cancel-active-task",
        },
        human,
        services,
      ),
    );
    const lateCompletion = await Effect.runPromise(
      Effect.either(
        completeTask(
          {
            projectId,
            taskId: task.id,
            leaseToken: grant.leaseToken,
            expectedVersion: cancelled.task.version,
            report: completionReport("cancel"),
            idempotencyKey: "late-cancelled-completion",
          },
          registration,
          services,
        ),
      ),
    );
    const lateFailure = await Effect.runPromise(
      Effect.either(
        failTask(
          {
            projectId,
            taskId: task.id,
            leaseToken: grant.leaseToken,
            expectedVersion: cancelled.task.version,
            report: failureReport("cancel"),
            idempotencyKey: "late-cancelled-failure",
          },
          registration,
          services,
        ),
      ),
    );
    const restored = await Effect.runPromise(
      restoreCancelledTask(
        {
          taskId: task.id,
          expectedVersion: cancelled.task.version,
          reason: "The direction is corrected and work may resume.",
          idempotencyKey: "restore-cancelled-task",
        },
        human,
        services,
      ),
    );
    const nextClaim = await claim(restored.task, registration, "after-restore");

    expect(cancelled).toMatchObject({
      task: { lifecycle: "cancelled", cancelledFromLifecycle: "in_progress", claim: null },
      attempt: { id: grant.attempt.id, status: "cancelled" },
      claim: {
        id: grant.claim.id,
        status: "cancelled",
        invalidationReason: "The product direction changed.",
      },
      event: { kind: "task.cancelled", actor: human },
    });
    for (const result of [lateCompletion, lateFailure]) {
      expect(Either.isLeft(result) && result.left).toMatchObject({
        _tag: "TaskLeaseError",
        reason: "inactive",
        leaseStatus: "cancelled",
        invalidationReason: "The product direction changed.",
      });
    }
    expect(restored).toMatchObject({
      task: { lifecycle: "ready", cancelledFromLifecycle: null },
      event: {
        kind: "task.restored",
        actor: human,
        payload: { reason: "The direction is corrected and work may resume." },
      },
    });
    expect(nextClaim.attempt.id).not.toBe(grant.attempt.id);
  });

  it("restores cancelled review without rewriting its completed attempt", async () => {
    const registration = await registerAgent("cancel-review", "Review Cancellation Agent");
    const task = await createReadyTask("cancel-review");
    const completed = await completeClaim(
      await claim(task, registration, "cancel-review"),
      registration,
      "cancel-review",
    );
    const cancelled = await Effect.runPromise(
      cancelTask(
        {
          taskId: task.id,
          expectedVersion: completed.task.version,
          reason: "Pause the review while requirements are checked.",
          idempotencyKey: "cancel-review-task",
        },
        human,
        services,
      ),
    );
    const restored = await Effect.runPromise(
      restoreCancelledTask(
        {
          taskId: task.id,
          expectedVersion: cancelled.task.version,
          reason: "Requirements are confirmed.",
          idempotencyKey: "restore-review-task",
        },
        human,
        services,
      ),
    );
    const attempts = await Effect.runPromise(listTaskAttempts({ projectId }, services));

    expect(cancelled.task).toMatchObject({
      lifecycle: "cancelled",
      cancelledFromLifecycle: "review",
      reviewAttemptId: completed.attempt.id,
    });
    expect(restored.task).toMatchObject({
      lifecycle: "review",
      cancelledFromLifecycle: null,
      reviewAttemptId: completed.attempt.id,
    });
    expect(attempts).toEqual([completed.attempt]);
  });

  it("reopens done work and creates a distinct attempt only when claimed again", async () => {
    await setReviewMode("direct", "reopen");
    const registration = await registerAgent("reopen", "Reopen Agent");
    const task = await createReadyTask("reopen");
    const completed = await completeClaim(
      await claim(task, registration, "reopen"),
      registration,
      "reopen",
    );
    const reopened = await Effect.runPromise(
      reopenTask(
        {
          taskId: task.id,
          destination: "ready",
          expectedVersion: completed.task.version,
          reason: "The edge case was discovered after completion.",
          idempotencyKey: "reopen-completed-task",
        },
        human,
        services,
      ),
    );
    const beforeClaim = await Effect.runPromise(listTaskAttempts({ projectId }, services));
    const nextClaim = await claim(reopened.task, registration, "reopened");
    const afterClaim = await Effect.runPromise(listTaskAttempts({ projectId }, services));

    expect(reopened).toMatchObject({
      task: { lifecycle: "ready" },
      attempt: completed.attempt,
      event: {
        kind: "task.reopened",
        actor: human,
        payload: {
          reason: "The edge case was discovered after completion.",
          priorAttemptId: completed.attempt.id,
        },
      },
    });
    expect(beforeClaim).toEqual([completed.attempt]);
    expect(afterClaim.map(({ id }) => id)).toEqual([completed.attempt.id, nextClaim.attempt.id]);
  });

  it("rolls completion state and report data back when its audit event fails", async () => {
    const registration = await registerAgent("completion-rollback", "Rollback Agent");
    const task = await createReadyTask("completion-rollback");
    const grant = await claim(task, registration, "completion-rollback");
    projectStore.database.exec(`
      create trigger reject_completion_event
      before insert on events when NEW.kind = 'task.review.requested'
      begin select raise(abort, 'completion event rejected'); end;
    `);

    const result = await Effect.runPromise(
      Effect.either(
        completeTask(
          {
            projectId,
            taskId: task.id,
            leaseToken: grant.leaseToken,
            expectedVersion: grant.task.version,
            report: completionReport("completion-rollback"),
            idempotencyKey: "completion-rollback",
          },
          registration,
          services,
        ),
      ),
    );
    const state = projectStore.database
      .prepare<
        [string],
        {
          lifecycle: string;
          taskVersion: number;
          attemptStatus: string;
          summary: string;
          leaseStatus: string;
        }
      >(
        `select tasks.lifecycle,
                tasks.version as taskVersion,
                attempts.status as attemptStatus,
                attempts.summary,
                leases.status as leaseStatus
         from tasks
         join attempts on attempts.task_id = tasks.id
         join leases on leases.attempt_id = attempts.id
         where tasks.id = ?`,
      )
      .get(task.id);
    const recordCount = projectStore.database
      .prepare<[string], number>("select count(*) from idempotency_records where key = ?")
      .pluck()
      .get("completion-rollback");

    expect(Either.isLeft(result) && result.left).toMatchObject({
      _tag: "TaskPersistenceError",
    });
    expect(state).toEqual({
      lifecycle: "in_progress",
      taskVersion: grant.task.version,
      attemptStatus: "active",
      summary: "",
      leaseStatus: "active",
    });
    expect(recordCount).toBe(0);
  });

  it("rolls a review change entry and transition back when audit persistence fails", async () => {
    const registration = await registerAgent("changes-rollback", "Change Rollback Agent");
    const task = await createReadyTask("changes-rollback");
    const completed = await completeClaim(
      await claim(task, registration, "changes-rollback"),
      registration,
      "changes-rollback",
    );
    projectStore.database.exec(`
      create trigger reject_review_change_event
      before insert on events when NEW.kind = 'task.review.changes_requested'
      begin select raise(abort, 'review change event rejected'); end;
    `);

    const result = await Effect.runPromise(
      Effect.either(
        requestTaskChanges(
          {
            entryId: "rolled-back-change-entry",
            taskId: task.id,
            attemptId: completed.attempt.id,
            expectedVersion: completed.task.version,
            summary: "This request must roll back.",
            requestedChanges: ["Add the missing assertion."],
            idempotencyKey: "changes-rollback",
          },
          human,
          services,
        ),
      ),
    );
    const persistedTask = (await Effect.runPromise(listTasks({ projectId }, services)))[0];
    const entryCount = projectStore.database
      .prepare<[string], number>("select count(*) from activity_entries where id = ?")
      .pluck()
      .get("rolled-back-change-entry");
    const recordCount = projectStore.database
      .prepare<[string], number>("select count(*) from idempotency_records where key = ?")
      .pluck()
      .get("changes-rollback");

    expect(Either.isLeft(result) && result.left).toMatchObject({
      _tag: "TaskPersistenceError",
    });
    expect(persistedTask).toMatchObject({
      lifecycle: "review",
      version: completed.task.version,
      reviewAttemptId: completed.attempt.id,
    });
    expect(entryCount).toBe(0);
    expect(recordCount).toBe(0);
  });

  it("rejects stale versions and expired leases without closing a valid retry", async () => {
    const registration = await registerAgent("stale", "Stale Agent");
    const task = await createReadyTask("stale");
    const grant = await claim(task, registration, "stale");
    now = "2026-09-04T09:01:00.000Z";
    const renewed = await Effect.runPromise(
      renewTaskLease(
        {
          leaseToken: grant.leaseToken,
          expectedVersion: grant.task.version,
          leaseDurationSeconds: 30,
          idempotencyKey: "renew-stale-claim",
        },
        registration,
        services,
      ),
    );
    const stale = await Effect.runPromise(
      Effect.either(
        completeTask(
          {
            projectId,
            taskId: task.id,
            leaseToken: grant.leaseToken,
            expectedVersion: grant.task.version,
            report: completionReport("stale"),
            idempotencyKey: "complete-stale-version",
          },
          registration,
          services,
        ),
      ),
    );
    let clockReads = 0;
    const justBeforeExpiry = new Date(Date.parse(renewed.claim.expiresAt) - 1).toISOString();
    services = {
      store: services.store,
      clock: {
        today: () => "2026-09-04",
        now: () => (clockReads++ === 0 ? justBeforeExpiry : renewed.claim.expiresAt),
      },
    };
    const expired = await Effect.runPromise(
      Effect.either(
        completeTask(
          {
            projectId,
            taskId: task.id,
            leaseToken: grant.leaseToken,
            expectedVersion: renewed.task.version,
            report: completionReport("expired"),
            idempotencyKey: "complete-expired-lease",
          },
          registration,
          services,
        ),
      ),
    );

    expect(Either.isLeft(stale) && stale.left).toMatchObject({
      _tag: "TaskVersionConflictError",
      expectedVersion: grant.task.version,
      currentVersion: renewed.task.version,
    });
    expect(Either.isLeft(expired) && expired.left).toMatchObject({
      _tag: "TaskLeaseError",
      reason: "expired",
    });
    expect(clockReads).toBeGreaterThanOrEqual(2);
  });
});
