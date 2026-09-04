// @vitest-environment jsdom

import { cleanup, render, screen, within } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { afterEach, describe, expect, it, vi } from "vitest";

import type {
  ActivityEntry,
  CreateHumanActivityEntryInput,
  CreateManualBlockerInput,
  ManualBlocker,
  ProjectEvent,
  ResolveManualBlockerInput,
  WithdrawActivityEntryInput,
} from "../../domain/activity";
import { emptyRichTextDocument, taskSchema } from "../../domain/tasks";
import type {
  ActivityEntryCommandResponse,
  ManualBlockerCommandResponse,
} from "../../server/activity-adapter";
import { TaskCollaboration } from "./task-collaboration";

const task = taskSchema.parse({
  id: "task-1",
  projectId: "project-1",
  sequence: 1,
  title: "Collaborate",
  lifecycle: "ready",
  description: emptyRichTextDocument,
  descriptionText: "",
  expectedOutcome: "Shared understanding",
  acceptanceCriteria: "Timeline is durable",
  agentContext: "",
  checklist: [{ id: "check-1", text: "Review timeline", checked: false }],
  version: 7,
  archivedAt: null,
  createdAt: "2026-09-04T09:00:00.000Z",
  updatedAt: "2026-09-04T09:00:00.000Z",
});

const entry: ActivityEntry = {
  id: "entry-1",
  projectId: task.projectId,
  taskId: task.id,
  attemptId: null,
  kind: "comment",
  author: { type: "human", id: "local-human" },
  authorDisplayName: "You",
  agentProfileId: null,
  content: emptyRichTextDocument,
  contentText: "Initial context",
  createdAt: "2026-09-04T10:00:00.000Z",
  withdrawnAt: null,
  withdrawnBy: null,
  withdrawalReason: null,
};

const blocker: ManualBlocker = {
  id: "blocker-1",
  projectId: task.projectId,
  taskId: task.id,
  reason: "Need product approval",
  status: "active",
  createdBy: { type: "human", id: "local-human" },
  createdAt: "2026-09-04T10:05:00.000Z",
  resolvedBy: null,
  resolvedAt: null,
  resolution: null,
};

const projectEvent: ProjectEvent = {
  id: "event-1",
  cursor: 1,
  projectId: task.projectId,
  kind: "task.entry.comment.created",
  importance: "routine",
  actor: { type: "human", id: "local-human" },
  entity: { type: "activity_entry", id: entry.id },
  payload: {},
  changes: {
    projectIds: [task.projectId],
    taskIds: [task.id],
    activityEntryIds: [entry.id],
    agentRunIds: [],
    scopes: ["activity", "tasks"],
  },
  occurredAt: "2026-09-04T10:00:00.000Z",
};

afterEach(cleanup);

function props(
  entries: readonly ActivityEntry[] = [entry],
  blockers: readonly ManualBlocker[] = [],
) {
  return {
    task,
    entries,
    blockers,
    onCreateEntry: vi.fn(
      async (_input: CreateHumanActivityEntryInput): Promise<ActivityEntryCommandResponse> => ({
        ok: true,
        result: { entry, event: projectEvent, taskVersion: 8 },
      }),
    ),
    onWithdrawEntry: vi.fn(
      async (_input: WithdrawActivityEntryInput): Promise<ActivityEntryCommandResponse> => ({
        ok: true,
        result: { entry, event: projectEvent, taskVersion: 8 },
      }),
    ),
    onCreateBlocker: vi.fn(
      async (_input: CreateManualBlockerInput): Promise<ManualBlockerCommandResponse> => ({
        ok: true,
        result: { blocker, event: projectEvent, taskVersion: 8 },
      }),
    ),
    onResolveBlocker: vi.fn(
      async (_input: ResolveManualBlockerInput): Promise<ManualBlockerCommandResponse> => ({
        ok: true,
        result: { blocker, event: projectEvent, taskVersion: 8 },
      }),
    ),
  };
}

describe("task collaboration", () => {
  it("adds a semantic rich-text entry against the displayed task version", async () => {
    const user = userEvent.setup();
    const workspace = props();
    render(<TaskCollaboration {...workspace} />);

    await user.selectOptions(screen.getByLabelText("Activity type"), "decision");
    await user.type(screen.getByLabelText("Activity update"), "Ship the narrow slice.");
    await user.click(screen.getByRole("button", { name: "Add decision" }));

    expect(workspace.onCreateEntry).toHaveBeenCalledWith({
      entryId: expect.any(String),
      projectId: task.projectId,
      taskId: task.id,
      kind: "decision",
      content: {
        version: 1,
        doc: {
          type: "doc",
          content: [
            {
              type: "paragraph",
              content: [{ type: "text", text: "Ship the narrow slice." }],
            },
          ],
        },
      },
      expectedTaskVersion: 7,
      idempotencyKey: expect.any(String),
    });
  });

  it("withdraws an entry with an explicit reason and keeps its history visible", async () => {
    const user = userEvent.setup();
    const workspace = props();
    render(<TaskCollaboration {...workspace} />);

    await user.click(screen.getByRole("button", { name: "Withdraw" }));
    await user.type(screen.getByLabelText("Withdrawal reason for Initial context"), "Superseded");
    await user.click(screen.getByRole("button", { name: "Confirm withdrawal" }));

    expect(workspace.onWithdrawEntry).toHaveBeenCalledWith({
      projectId: task.projectId,
      entryId: entry.id,
      expectedTaskVersion: 7,
      reason: "Superseded",
      idempotencyKey: expect.any(String),
    });

    const withdrawn = {
      ...entry,
      content: null,
      contentText: "",
      withdrawnAt: "2026-09-04T11:00:00.000Z",
      withdrawalReason: "Superseded",
    };
    cleanup();
    render(<TaskCollaboration {...props([withdrawn])} />);
    expect(screen.getByText(/Withdrawn .* — Superseded/)).toBeTruthy();
    expect(screen.getByText("Content withdrawn.")).toBeTruthy();
    expect(screen.queryByText("Initial context")).toBeNull();
  });

  it("lets the local human withdraw an agent-authored entry", async () => {
    const user = userEvent.setup();
    const agentEntry: ActivityEntry = {
      ...entry,
      id: "entry-agent",
      author: { type: "agent", id: "run-1" },
      authorDisplayName: "Planning agent",
      agentProfileId: "profile-1",
      contentText: "Agent-authored correction",
    };
    const workspace = props([agentEntry]);
    render(<TaskCollaboration {...workspace} />);

    await user.click(screen.getByRole("button", { name: "Withdraw" }));
    await user.type(
      screen.getByLabelText("Withdrawal reason for Agent-authored correction"),
      "Superseded",
    );
    await user.click(screen.getByRole("button", { name: "Confirm withdrawal" }));

    expect(workspace.onWithdrawEntry).toHaveBeenCalledWith({
      projectId: task.projectId,
      entryId: agentEntry.id,
      expectedTaskVersion: task.version,
      reason: "Superseded",
      idempotencyKey: expect.any(String),
    });
  });

  it("reports and resolves a durable manual blocker", async () => {
    const user = userEvent.setup();
    const workspace = props([], [blocker]);
    render(<TaskCollaboration {...workspace} />);

    expect(screen.getByText(/this task is not claimable/)).toBeTruthy();
    await user.type(screen.getByLabelText("Manual blocker reason"), "Need legal review");
    await user.click(screen.getByRole("button", { name: "Report blocker" }));
    expect(workspace.onCreateBlocker).toHaveBeenCalledWith({
      blockerId: expect.any(String),
      projectId: task.projectId,
      taskId: task.id,
      reason: "Need legal review",
      expectedTaskVersion: 7,
      idempotencyKey: expect.any(String),
    });

    const blockerCard = screen.getByText("Need product approval").closest("article");
    if (!blockerCard) throw new Error("Expected the blocker card.");
    await user.click(within(blockerCard).getByRole("button", { name: "Resolve" }));
    await user.type(
      within(blockerCard).getByLabelText("Resolution for Need product approval"),
      "Approved in review",
    );
    await user.click(within(blockerCard).getByRole("button", { name: "Save resolution" }));

    expect(workspace.onResolveBlocker).toHaveBeenCalledWith({
      blockerId: blocker.id,
      projectId: task.projectId,
      taskId: task.id,
      resolution: "Approved in review",
      expectedTaskVersion: 7,
      idempotencyKey: expect.any(String),
    });
  });
});
