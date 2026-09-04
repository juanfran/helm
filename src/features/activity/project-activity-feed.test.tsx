// @vitest-environment jsdom

import { cleanup, render, screen, within } from "@testing-library/react";
import { afterEach, describe, expect, it } from "vitest";

import type { ProjectEvent } from "../../domain/activity";
import { emptyRichTextDocument, taskAttemptSummarySchema, taskSchema } from "../../domain/tasks";
import { ProjectActivityFeed } from "./project-activity-feed";

afterEach(cleanup);

function event(cursor: number, importance: ProjectEvent["importance"]): ProjectEvent {
  return {
    id: `event-${cursor}`,
    cursor,
    projectId: "project-1",
    kind: cursor === 2 ? "task.blocker.created" : "task.created",
    importance,
    actor: { type: cursor === 2 ? "agent" : "human", id: cursor === 2 ? "run-1" : "local-human" },
    entity: { type: "task", id: "task-1" },
    payload: cursor === 2 ? { reason: "Waiting for access" } : {},
    changes: {
      projectIds: ["project-1"],
      taskIds: ["task-1"],
      activityEntryIds: [],
      agentRunIds: [],
      scopes: ["tasks"],
    },
    occurredAt: `2026-09-04T10:00:0${cursor}.000Z`,
  };
}

describe("project activity feed", () => {
  it("shows the latest event first and calls out important work", () => {
    const task = taskSchema.parse({
      id: "task-1",
      projectId: "project-1",
      sequence: 4,
      title: "Provision access",
      lifecycle: "ready",
      description: emptyRichTextDocument,
      descriptionText: "",
      expectedOutcome: "Access is ready",
      acceptanceCriteria: "Login succeeds",
      agentContext: "",
      checklist: [{ id: "check-1", text: "Log in", checked: false }],
      version: 1,
      archivedAt: null,
      createdAt: "2026-09-04T09:00:00.000Z",
      updatedAt: "2026-09-04T09:00:00.000Z",
    });
    render(
      <ProjectActivityFeed
        events={[event(1, "routine"), event(2, "attention")]}
        tasks={[task]}
        entries={[]}
        attempts={[]}
      />,
    );

    const rows = within(screen.getByLabelText("Project events")).getAllByRole("article");
    expect(rows[0]?.textContent).toContain("task · blocker · created");
    expect(rows[0]?.textContent).toContain("attention");
    expect(rows[0]?.textContent).toContain("Waiting for access");
    expect(rows[0]?.textContent).toContain("#4 Provision access");
    expect(rows[1]?.textContent).not.toContain("attention");
  });

  it("shows semantic entry content and replaces it with withdrawal metadata", () => {
    const semanticEvent: ProjectEvent = {
      ...event(3, "routine"),
      kind: "task.entry.decision.created",
      actor: { type: "agent", id: "run-1" },
      entity: { type: "activity_entry", id: "entry-3" },
      payload: { entryId: "entry-3", taskId: "task-1" },
      changes: {
        projectIds: ["project-1"],
        taskIds: ["task-1"],
        activityEntryIds: ["entry-3"],
        agentRunIds: ["run-1"],
        scopes: ["tasks", "activity"],
      },
    };
    const entry = {
      id: "entry-3",
      projectId: "project-1",
      taskId: "task-1",
      attemptId: null,
      kind: "decision" as const,
      author: { type: "agent" as const, id: "run-1" },
      authorDisplayName: "Planning agent",
      agentProfileId: "profile-1",
      content: emptyRichTextDocument,
      contentText: "Keep the durable cursor as the ordering authority.",
      createdAt: "2026-09-04T10:00:03.000Z",
      withdrawnAt: null,
      withdrawnBy: null,
      withdrawalReason: null,
    };
    const { rerender } = render(
      <ProjectActivityFeed events={[semanticEvent]} tasks={[]} entries={[entry]} attempts={[]} />,
    );

    expect(screen.getByText("Keep the durable cursor as the ordering authority.")).toBeTruthy();
    expect(screen.getByText("Planning agent")).toBeTruthy();

    rerender(
      <ProjectActivityFeed
        events={[semanticEvent]}
        tasks={[]}
        attempts={[]}
        entries={[
          {
            ...entry,
            content: null,
            contentText: "",
            withdrawnAt: "2026-09-04T10:05:00.000Z",
            withdrawnBy: { type: "human", id: "local-human" },
            withdrawalReason: "Superseded by the final decision.",
          },
        ]}
      />,
    );

    expect(screen.queryByText("Keep the durable cursor as the ordering authority.")).toBeNull();
    expect(screen.getByText("Content withdrawn — Superseded by the final decision.")).toBeTruthy();
  });

  it("uses attempt attribution without exposing the agent run identifier", () => {
    const attemptEvent: ProjectEvent = {
      ...event(4, "attention"),
      kind: "task.review.requested",
      actor: { type: "agent", id: "run-secret-1" },
      payload: { attemptId: "attempt-1", summary: "Ready for review" },
    };
    const attempt = taskAttemptSummarySchema.parse({
      id: "attempt-1",
      taskId: "task-1",
      attemptNumber: 1,
      agentRunId: "run-secret-1",
      agentProfileId: "profile-1",
      agentDisplayName: "Implementation agent",
      status: "completed",
      summary: "Ready for review",
      createdAt: "2026-09-04T10:00:00.000Z",
      completedAt: "2026-09-04T10:05:00.000Z",
    });

    render(
      <ProjectActivityFeed events={[attemptEvent]} tasks={[]} entries={[]} attempts={[attempt]} />,
    );

    expect(screen.getByText("Implementation agent")).toBeTruthy();
    expect(screen.queryByText(/run-secret-1/)).toBeNull();
  });
});
