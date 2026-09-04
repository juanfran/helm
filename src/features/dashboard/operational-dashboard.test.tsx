// @vitest-environment jsdom

import { cleanup, render, screen, within } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { afterEach, describe, expect, it, vi } from "vitest";

import type { ProjectEvent } from "../../domain/activity";
import type { AgentRunSummary } from "../../domain/agents";
import {
  emptyRichTextDocument,
  taskSchema,
  type Task,
  type TaskAttemptSummary,
} from "../../domain/tasks";
import { OperationalDashboard } from "./operational-dashboard";

function task(overrides: Partial<Task> & Pick<Task, "id" | "sequence" | "title">): Task {
  return taskSchema.parse({
    projectId: "project-1",
    lifecycle: "ready",
    priority: "normal",
    position: overrides.sequence,
    description: emptyRichTextDocument,
    descriptionText: "",
    expectedOutcome: "Done",
    acceptanceCriteria: "Verified",
    agentContext: "",
    checklist: [{ id: "check", text: "Verify", checked: false }],
    version: 1,
    archivedAt: null,
    createdAt: "2026-09-04T08:00:00.000Z",
    updatedAt: "2026-09-04T08:00:00.000Z",
    ...overrides,
  });
}

const reviewTask = task({
  id: "review-task",
  sequence: 1,
  title: "Review the release",
  lifecycle: "review",
  reviewAttemptId: "attempt-review",
  eligibility: {
    claimable: false,
    status: "not_ready",
    reasons: ["Awaiting review."],
    orderingExplanation: "high lane",
    missingCapabilities: [],
    blockingTaskIds: [],
  },
});

const activeTask = task({
  id: "active-task",
  sequence: 2,
  title: "Build dashboard",
  lifecycle: "in_progress",
  eligibility: {
    claimable: false,
    status: "claimed",
    reasons: ["Claimed."],
    orderingExplanation: "normal lane",
    missingCapabilities: [],
    blockingTaskIds: [],
  },
  claim: {
    id: "lease-secret",
    taskId: "active-task",
    attemptId: "attempt-secret",
    agentRunId: "run-secret",
    agentProfileId: "profile-secret",
    agentDisplayName: "Build Agent",
    status: "active",
    acquiredAt: "2026-09-04T09:00:00.000Z",
    expiresAt: "2026-09-04T10:00:00.000Z",
    invalidatedAt: null,
    invalidationReason: null,
  },
});

const activeRun: AgentRunSummary = {
  id: "run-secret",
  profileId: "profile-secret",
  profileKey: "build-agent",
  displayName: "Build Agent",
  capabilities: ["typescript"],
  status: "active",
  clientName: "coding-agent",
  clientVersion: "1.0.0",
  createdAt: "2026-09-04T08:30:00.000Z",
  lastSeenAt: "2026-09-04T09:00:00.000Z",
  endedAt: null,
};

const failure: TaskAttemptSummary = {
  id: "failed-attempt",
  taskId: reviewTask.id,
  attemptNumber: 1,
  agentRunId: "run-secret",
  agentProfileId: "profile-secret",
  agentDisplayName: "Build Agent",
  status: "failed",
  summary: "Tests failed.",
  changedAreas: [],
  verificationResults: [],
  references: [],
  risks: [],
  followUpWork: [],
  failureClassification: "verification",
  createdAt: "2026-09-04T08:00:00.000Z",
  completedAt: "2026-09-04T08:10:00.000Z",
};

const reopenEvent: ProjectEvent = {
  id: "event-5",
  cursor: 5,
  projectId: "project-1",
  kind: "task.reopened",
  importance: "routine",
  actor: { type: "human", id: "local-human" },
  entity: { type: "task", id: reviewTask.id },
  payload: { reason: "Verification was incomplete." },
  changes: {
    projectIds: ["project-1"],
    taskIds: [reviewTask.id],
    activityEntryIds: [],
    agentRunIds: [],
    scopes: ["tasks"],
  },
  occurredAt: "2026-09-04T08:20:00.000Z",
};

afterEach(cleanup);

describe("operational dashboard", () => {
  it("renders canonical queues, agent lease expiry, failures, reopen history, and exact metrics", () => {
    render(
      <OperationalDashboard
        tasks={[reviewTask, activeTask]}
        attempts={[failure]}
        events={[reopenEvent]}
        activeAgentRuns={[activeRun]}
        onSelectTask={vi.fn()}
      />,
    );

    const counts = screen.getByLabelText("Operational counts");
    expect(within(counts).getByText("Active").previousElementSibling?.textContent).toBe("1");
    expect(within(counts).getByText("Review").previousElementSibling?.textContent).toBe("1");
    expect(within(counts).getByText("Failed").previousElementSibling?.textContent).toBe("1");
    expect(within(counts).getByText("Agent runs").previousElementSibling?.textContent).toBe("1");
    expect(within(counts).getByText("Live leases").previousElementSibling?.textContent).toBe("1");

    const execution = screen
      .getByRole("heading", { name: "Active agents and leases" })
      .closest("section");
    expect(execution).not.toBeNull();
    expect(within(execution!).getByText("Build Agent")).toBeTruthy();
    const expiry = within(execution!)
      .getByText(/expires/, { selector: "span" })
      .querySelector("time");
    expect(expiry?.getAttribute("datetime")).toBe("2026-09-04T10:00:00.000Z");

    expect(screen.getByText("Tests failed.")).toBeTruthy();
    expect(screen.getByText("Verification was incomplete.")).toBeTruthy();
    expect(document.body.textContent).not.toContain("run-secret");
    expect(document.body.textContent).not.toContain("lease-secret");
  });

  it("drills from an operational row into the existing task workflow", async () => {
    const user = userEvent.setup();
    const onSelectTask = vi.fn();
    render(
      <OperationalDashboard
        tasks={[reviewTask]}
        attempts={[]}
        events={[]}
        activeAgentRuns={[]}
        onSelectTask={onSelectTask}
      />,
    );

    const review = screen.getByRole("heading", { name: "Awaiting review" }).closest("section");
    await user.click(within(review!).getByRole("button", { name: /Review the release/ }));
    expect(onSelectTask).toHaveBeenCalledWith(reviewTask.id);
  });

  it("provides explicit empty states without changing the dashboard structure", () => {
    render(
      <OperationalDashboard
        tasks={[]}
        attempts={[]}
        events={[]}
        activeAgentRuns={[]}
        onSelectTask={vi.fn()}
      />,
    );

    expect(screen.getByText("No active agent runs are connected.")).toBeTruthy();
    expect(screen.getByText("Nothing is waiting for review.")).toBeTruthy();
    expect(screen.getByText("No project activity has been recorded.")).toBeTruthy();
  });
});
