// @vitest-environment jsdom

import { cleanup, render, screen, within } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { afterEach, describe, expect, it, vi } from "vitest";

import type { ProjectEvent } from "../../domain/activity";
import { emptyRichTextDocument, type Task, type TaskAttemptSummary } from "../../domain/tasks";
import { TaskExecutionPanel } from "./task-execution-panel";

const task: Task = {
  id: "task-1",
  projectId: "project-1",
  sequence: 1,
  parentTaskId: null,
  childTaskIds: [],
  title: "Review the implementation",
  lifecycle: "review",
  priority: "normal",
  position: 1,
  notBefore: null,
  dueAt: null,
  size: null,
  tags: [],
  requiredCapabilities: [],
  referencedPaths: [],
  claim: null,
  upstreamRelations: [],
  downstreamRelations: [],
  description: emptyRichTextDocument,
  descriptionText: "",
  expectedOutcome: "The feature works.",
  acceptanceCriteria: "Checks pass.",
  agentContext: "",
  checklist: [{ id: "check-1", text: "Run checks", checked: false }],
  reviewAttemptId: "attempt-2",
  cancelledFromLifecycle: null,
  version: 8,
  archivedAt: null,
  createdAt: "2026-09-04T08:00:00.000Z",
  updatedAt: "2026-09-04T10:00:00.000Z",
};

const previousAttempt: TaskAttemptSummary = {
  id: "attempt-1",
  taskId: task.id,
  attemptNumber: 1,
  agentRunId: "internal-run-1",
  agentProfileId: "internal-profile-1",
  agentDisplayName: "Build Agent",
  status: "failed",
  summary: "The first approach failed.",
  changedAreas: ["src/old.ts"],
  verificationResults: [
    { name: "pnpm test", status: "failed", details: "One regression remained." },
  ],
  references: [],
  risks: ["Retry with the shared command."],
  followUpWork: [],
  failureClassification: "verification",
  createdAt: "2026-09-04T08:30:00.000Z",
  completedAt: "2026-09-04T09:00:00.000Z",
};

const reviewAttempt: TaskAttemptSummary = {
  id: "attempt-2",
  taskId: task.id,
  attemptNumber: 2,
  agentRunId: "internal-run-2",
  agentProfileId: "internal-profile-2",
  agentDisplayName: "Review Agent",
  status: "completed",
  summary: "Implemented the review flow.",
  changedAreas: ["src/features/tasks", "src/routes/index.tsx"],
  verificationResults: [{ name: "pnpm check", status: "passed", details: "All checks passed." }],
  references: ["issue #9"],
  risks: ["Narrow-screen layout needs monitoring."],
  followUpWork: ["Add policy overrides later."],
  failureClassification: null,
  createdAt: "2026-09-04T09:10:00.000Z",
  completedAt: "2026-09-04T10:00:00.000Z",
};

function event(kind: string): ProjectEvent {
  return {
    id: "event-1",
    cursor: 1,
    projectId: task.projectId,
    kind,
    importance: "routine",
    actor: { type: "human", id: "local-human" },
    entity: { type: "task", id: task.id },
    payload: {},
    changes: {
      projectIds: [task.projectId],
      taskIds: [task.id],
      activityEntryIds: [],
      agentRunIds: [],
      scopes: ["tasks"],
    },
    occurredAt: "2026-09-04T10:10:00.000Z",
  };
}

function success(nextTask: Task, attempt: TaskAttemptSummary | null = reviewAttempt) {
  return {
    ok: true as const,
    result: {
      task: nextTask,
      attempt,
      claim: null,
      entry: null,
      event: event("task.transitioned"),
    },
  };
}

function props(overrides: Partial<React.ComponentProps<typeof TaskExecutionPanel>> = {}) {
  return {
    task,
    attempts: [previousAttempt, reviewAttempt],
    onApproveReview: vi.fn().mockResolvedValue(success({ ...task, lifecycle: "done" })),
    onRequestChanges: vi.fn().mockResolvedValue(success({ ...task, lifecycle: "ready" })),
    onCancelTask: vi.fn().mockResolvedValue(success({ ...task, lifecycle: "cancelled" })),
    onRestoreTask: vi.fn().mockResolvedValue(success({ ...task, lifecycle: "review" })),
    onReopenTask: vi.fn().mockResolvedValue(success({ ...task, lifecycle: "ready" })),
    ...overrides,
  };
}

afterEach(() => {
  cleanup();
  vi.restoreAllMocks();
});

describe("task execution panel", () => {
  it("renders the structured report and submits attributed approval or requested changes", async () => {
    const user = userEvent.setup();
    const panel = props();
    render(<TaskExecutionPanel {...panel} />);

    expect(screen.getByText("Implemented the review flow.")).toBeTruthy();
    expect(screen.getByText("Attempt 2")).toBeTruthy();
    expect(screen.getByText("src/features/tasks")).toBeTruthy();
    expect(screen.getByText("pnpm check")).toBeTruthy();
    expect(screen.getByText("issue #9")).toBeTruthy();
    expect(screen.getByText("Narrow-screen layout needs monitoring.")).toBeTruthy();
    expect(screen.getByText("Add policy overrides later.")).toBeTruthy();
    expect(screen.getByText("Review Agent")).toBeTruthy();
    expect(document.body.textContent).not.toContain("internal-run");
    expect(screen.getByText("Previous attempts (1)")).toBeTruthy();

    const approveForm = screen.getByRole("form", { name: "Approve task review" });
    const approveButton = within(approveForm).getByRole("button", { name: "Approve" });
    expect(approveButton).toHaveProperty("disabled", true);
    await user.type(
      within(approveForm).getByLabelText("Approval summary"),
      "The evidence satisfies the acceptance criteria.",
    );
    await user.click(approveButton);
    expect(panel.onApproveReview).toHaveBeenCalledWith({
      taskId: task.id,
      attemptId: reviewAttempt.id,
      expectedVersion: task.version,
      summary: "The evidence satisfies the acceptance criteria.",
      idempotencyKey: expect.any(String),
    });

    const changesForm = screen.getByRole("form", { name: "Request task changes" });
    await user.type(within(changesForm).getByLabelText("Change request summary"), "Tighten tests");
    await user.type(
      within(changesForm).getByLabelText("Requested changes"),
      "Cover stale versions\nVerify keyboard focus",
    );
    await user.click(within(changesForm).getByRole("button", { name: "Request changes" }));
    expect(panel.onRequestChanges).toHaveBeenCalledWith({
      entryId: expect.any(String),
      taskId: task.id,
      attemptId: reviewAttempt.id,
      expectedVersion: task.version,
      summary: "Tighten tests",
      requestedChanges: ["Cover stale versions", "Verify keyboard focus"],
      idempotencyKey: expect.any(String),
    });
  });

  it("requires an explicit cancellation reason and warns when an active lease is invalidated", async () => {
    const user = userEvent.setup();
    const claimed: Task = {
      ...task,
      lifecycle: "in_progress",
      reviewAttemptId: null,
      claim: {
        id: "lease-1",
        taskId: task.id,
        attemptId: reviewAttempt.id,
        agentRunId: "run-1",
        agentProfileId: "profile-1",
        agentDisplayName: "Build Agent",
        status: "active",
        acquiredAt: "2026-09-04T09:00:00.000Z",
        expiresAt: "2026-09-04T10:30:00.000Z",
        invalidatedAt: null,
        invalidationReason: null,
      },
    };
    const panel = props({ task: claimed, attempts: [reviewAttempt] });
    render(<TaskExecutionPanel {...panel} />);

    const cancelForm = screen.getByRole("form", { name: "Cancel task" });
    expect(cancelForm.textContent).toContain("rejects late agent results");
    const cancelButton = within(cancelForm).getByRole("button", { name: "Cancel task" });
    expect(cancelButton).toHaveProperty("disabled", true);

    await user.type(
      within(cancelForm).getByLabelText("Cancellation reason"),
      "The requested work is no longer needed.",
    );
    await user.click(cancelButton);

    expect(panel.onCancelTask).toHaveBeenCalledWith({
      taskId: task.id,
      expectedVersion: task.version,
      reason: "The requested work is no longer needed.",
      idempotencyKey: expect.any(String),
    });
  });

  it("restores cancelled work to its recorded lifecycle and reopens done work with a destination", async () => {
    const user = userEvent.setup();
    const cancelled: Task = {
      ...task,
      lifecycle: "cancelled",
      cancelledFromLifecycle: "review",
    };
    const restorePanel = props({ task: cancelled });
    const rendered = render(<TaskExecutionPanel {...restorePanel} />);

    expect(screen.queryByRole("form", { name: "Cancel task" })).toBeNull();
    const restoreForm = screen.getByRole("form", { name: "Restore cancelled task" });
    expect(restoreForm.textContent).toContain("Restore to Review");
    await user.type(within(restoreForm).getByLabelText("Restore reason"), "Cancelled by mistake.");
    await user.click(within(restoreForm).getByRole("button", { name: "Restore to Review" }));
    expect(restorePanel.onRestoreTask).toHaveBeenCalledWith({
      taskId: task.id,
      expectedVersion: task.version,
      reason: "Cancelled by mistake.",
      idempotencyKey: expect.any(String),
    });

    const donePanel = props({ task: { ...task, lifecycle: "done", reviewAttemptId: null } });
    rendered.rerender(<TaskExecutionPanel {...donePanel} />);
    expect(screen.queryByRole("form", { name: "Cancel task" })).toBeNull();
    const reopenForm = screen.getByRole("form", { name: "Reopen completed task" });
    await user.selectOptions(within(reopenForm).getByLabelText("Destination"), "backlog");
    await user.type(within(reopenForm).getByLabelText("Reopen reason"), "The scope has changed.");
    await user.click(within(reopenForm).getByRole("button", { name: "Reopen" }));

    expect(donePanel.onReopenTask).toHaveBeenCalledWith({
      taskId: task.id,
      destination: "backlog",
      expectedVersion: task.version,
      reason: "The scope has changed.",
      idempotencyKey: expect.any(String),
    });
  });

  it("keeps a requested-change draft visible after a version conflict", async () => {
    const user = userEvent.setup();
    const panel = props({
      onRequestChanges: vi.fn().mockResolvedValue({
        ok: false,
        error: {
          type: "TaskVersionConflictError",
          message: "Task version conflict: expected 8, current 9.",
        },
      }),
    });
    render(<TaskExecutionPanel {...panel} />);

    await user.type(screen.getByLabelText("Change request summary"), "Needs another pass");
    await user.type(screen.getByLabelText("Requested changes"), "Rebase on the latest task");
    await user.click(screen.getByRole("button", { name: "Request changes" }));

    expect(await screen.findByRole("alert")).toHaveProperty(
      "textContent",
      expect.stringContaining("expected 8, current 9"),
    );
    expect(screen.getByLabelText("Requested changes")).toHaveProperty(
      "value",
      "Rebase on the latest task",
    );
  });
});
