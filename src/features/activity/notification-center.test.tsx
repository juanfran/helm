// @vitest-environment jsdom

import { cleanup, render, screen, within } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

import type { ProjectEvent } from "../../domain/activity";
import { emptyRichTextDocument, type Task } from "../../domain/tasks";
import { NotificationCenter, selectImportantNotifications } from "./notification-center";

const task: Task = {
  id: "task-1",
  projectId: "project-1",
  sequence: 3,
  parentTaskId: null,
  childTaskIds: [],
  title: "Review the release",
  lifecycle: "review",
  priority: "high",
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
  expectedOutcome: "Reviewed",
  acceptanceCriteria: "Accepted",
  agentContext: "",
  checklist: [],
  reviewAttemptId: "attempt-1",
  cancelledFromLifecycle: null,
  version: 2,
  archivedAt: null,
  createdAt: "2026-09-04T08:00:00.000Z",
  updatedAt: "2026-09-04T09:00:00.000Z",
};

function event(cursor: number, kind: string, importance: ProjectEvent["importance"]): ProjectEvent {
  return {
    id: `event-${cursor}`,
    cursor,
    projectId: task.projectId,
    kind,
    importance,
    actor: { type: "agent", id: "run-secret" },
    entity: { type: "task", id: task.id },
    payload: { summary: `${kind} detail` },
    changes: {
      projectIds: [task.projectId],
      taskIds: [task.id],
      activityEntryIds: [],
      agentRunIds: ["run-secret"],
      scopes: ["tasks"],
    },
    occurredAt: `2026-09-04T09:0${cursor}:00.000Z`,
  };
}

beforeEach(() => localStorage.clear());
afterEach(cleanup);

describe("notification center", () => {
  it("selects only persisted important events newest first", () => {
    expect(
      selectImportantNotifications([
        event(3, "task.entry.comment.created", "routine"),
        event(1, "task.blocker.created", "attention"),
        event(2, "task.attempt.failed", "critical"),
      ]).map(({ cursor }) => cursor),
    ).toEqual([2, 1]);
  });

  it("keeps routine activity out, marks history read on open, and counts a streamed event", async () => {
    const user = userEvent.setup();
    const initialEvents = [
      event(1, "task.entry.comment.created", "routine"),
      event(2, "task.review.requested", "attention"),
    ];
    const view = render(
      <NotificationCenter projectId={task.projectId} events={initialEvents} tasks={[task]} />,
    );

    const trigger = screen.getByRole("button", { name: "Notifications, 1 unread" });
    await user.click(trigger);
    const list = screen.getByLabelText("Important project events");
    expect(within(list).getByText("task · review · requested")).toBeTruthy();
    expect(within(list).queryByText("task · entry · comment · created")).toBeNull();
    await user.click(screen.getByRole("button", { name: "Close notifications" }));
    expect(screen.getByRole("button", { name: "Notifications, none unread" })).toBeTruthy();

    view.rerender(
      <NotificationCenter
        projectId={task.projectId}
        events={[...initialEvents, event(3, "task.attempt.failed", "critical")]}
        tasks={[task]}
      />,
    );
    expect(screen.getByRole("button", { name: "Notifications, 1 unread" })).toBeTruthy();
  });

  it("opens the related task without exposing opaque agent or lease identifiers", async () => {
    const user = userEvent.setup();
    const onSelectTask = vi.fn();
    render(
      <NotificationCenter
        projectId={task.projectId}
        events={[event(4, "task.attempt.failed", "critical")]}
        tasks={[task]}
        onSelectTask={onSelectTask}
      />,
    );

    await user.click(screen.getByRole("button", { name: /Notifications/ }));
    const popup = screen.getByLabelText("Important project events");
    expect(popup.textContent).not.toContain("run-secret");
    await user.click(within(popup).getByRole("button"));
    expect(onSelectTask).toHaveBeenCalledWith(task.id);
  });
});
