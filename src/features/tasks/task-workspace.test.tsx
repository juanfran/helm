// @vitest-environment jsdom

import { cleanup, render, screen, waitFor, within } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { afterEach, describe, expect, it, vi } from "vitest";

import type { ProjectEvent } from "../../domain/activity";
import type { Project } from "../../domain/projects";
import { emptyRichTextDocument, type Task } from "../../domain/tasks";
import { TaskWorkspace } from "./task-workspace";

const project: Project = {
  id: "project-1",
  sequence: 1,
  name: "helm",
  repositoryRoot: "/projects/helm",
  version: 1,
  createdAt: "2026-09-03T10:00:00.000Z",
  updatedAt: "2026-09-03T10:00:00.000Z",
};

const backlog: Task = {
  id: "task-1",
  projectId: project.id,
  sequence: 1,
  parentTaskId: null,
  childTaskIds: [],
  title: "Captured task",
  lifecycle: "backlog",
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
  expectedOutcome: "",
  acceptanceCriteria: "",
  agentContext: "",
  checklist: [],
  version: 1,
  archivedAt: null,
  createdAt: "2026-09-03T10:10:00.000Z",
  updatedAt: "2026-09-03T10:10:00.000Z",
};

afterEach(() => {
  cleanup();
  vi.restoreAllMocks();
});

function claimedTask(): Task {
  return {
    ...backlog,
    title: "Claimed task",
    lifecycle: "in_progress",
    version: 7,
    claim: {
      id: "internal-lease-id",
      taskId: backlog.id,
      attemptId: "internal-attempt-id",
      agentRunId: "internal-run-id",
      agentProfileId: "internal-profile-id",
      agentDisplayName: "Build Agent",
      status: "active",
      acquiredAt: "2026-09-03T10:15:00.000Z",
      expiresAt: "2026-09-03T10:30:00.000Z",
      invalidatedAt: null,
      invalidationReason: null,
    },
    eligibility: {
      claimable: false,
      status: "claimed",
      reasons: ["Claimed by Build Agent."],
      orderingExplanation: "normal lane, position 1",
      missingCapabilities: [],
      blockingTaskIds: [],
    },
  };
}

function props(tasks: readonly Task[] = [backlog]) {
  return {
    project,
    theme: "system" as const,
    tasks,
    tagDefinitions: tasks.flatMap((task) => task.tags),
    activityEntries: [],
    manualBlockers: [],
    projectEvents: [],
    liveStatus: "live" as const,
    onCreateTask: vi.fn(),
    onPrepareTask: vi.fn(),
    onUpdateTaskPlanning: vi.fn(),
    onCompleteTask: vi.fn(),
    onReopenTask: vi.fn(),
    onCreateTaskRelation: vi.fn(),
    onArchiveTask: vi.fn(),
    onInvalidateClaim: vi.fn(),
    onCreateActivityEntry: vi.fn(),
    onWithdrawActivityEntry: vi.fn(),
    onCreateManualBlocker: vi.fn(),
    onResolveManualBlocker: vi.fn(),
    onChangeTheme: vi.fn(),
  };
}

describe("task workspace", () => {
  it("switches to the durable project activity view", async () => {
    const user = userEvent.setup();
    const activityEvent: ProjectEvent = {
      id: "event-1",
      cursor: 1,
      projectId: project.id,
      kind: "task.blocker.created",
      importance: "attention",
      actor: { type: "human", id: "local-human" },
      entity: { type: "manual_blocker", id: "blocker-1" },
      payload: { reason: "Needs approval" },
      changes: {
        projectIds: [project.id],
        taskIds: [backlog.id],
        activityEntryIds: [],
        agentRunIds: [],
        scopes: ["tasks", "activity"],
      },
      occurredAt: "2026-09-04T10:15:00.000Z",
    };
    render(<TaskWorkspace {...props()} projectEvents={[activityEvent]} />);

    await user.click(screen.getByRole("button", { name: "Activity" }));

    expect(screen.getByRole("heading", { name: "Project activity" })).toBeTruthy();
    expect(screen.getByText("Needs approval")).toBeTruthy();
    expect(screen.getByText("attention")).toBeTruthy();
  });

  it("orders the live task list with the shared Helm ranking rules", () => {
    const low: Task = {
      ...backlog,
      id: "a-low",
      sequence: 2,
      title: "Low priority",
      priority: "low",
      position: 0,
    };
    const urgentLater: Task = {
      ...backlog,
      id: "b-urgent-later",
      sequence: 3,
      title: "Urgent later",
      priority: "urgent",
      position: 2,
    };
    const urgentFirst: Task = {
      ...backlog,
      id: "z-urgent-first",
      sequence: 1,
      title: "Urgent first",
      priority: "urgent",
      position: 1,
    };

    render(<TaskWorkspace {...props([low, urgentLater, urgentFirst])} />);

    const taskButtons = within(screen.getByRole("navigation", { name: "Tasks" })).getAllByRole(
      "button",
    );
    expect(taskButtons.map((button) => button.textContent)).toEqual([
      expect.stringContaining("Urgent first"),
      expect.stringContaining("Urgent later"),
      expect.stringContaining("Low priority"),
    ]);
    expect(taskButtons[0]?.getAttribute("aria-current")).toBe("true");
  });

  it("captures a title-only backlog task from the quick entry", async () => {
    const user = userEvent.setup();
    const workspace = props([]);
    workspace.onCreateTask.mockResolvedValue({ ok: true, task: backlog });
    render(<TaskWorkspace {...workspace} />);

    await user.type(screen.getByLabelText("Task title"), "Captured task");
    await user.click(screen.getByRole("button", { name: "Add backlog task" }));

    expect(workspace.onCreateTask).toHaveBeenCalledWith({
      projectId: project.id,
      parentTaskId: null,
      lifecycle: "backlog",
      title: "Captured task",
      description: emptyRichTextDocument,
      expectedOutcome: "",
      acceptanceCriteria: "",
      agentContext: "",
      checklist: [],
      referencedPaths: [],
      expectedVersion: 0,
      idempotencyKey: expect.any(String),
    });
  });

  it("submits structurally separate preparation fields against the displayed version", async () => {
    const user = userEvent.setup();
    const workspace = props();
    workspace.onPrepareTask.mockResolvedValue({
      ok: true,
      task: { ...backlog, lifecycle: "ready", version: 2 },
    });
    render(<TaskWorkspace {...workspace} />);

    expect(screen.queryByRole("button", { name: "Done" })).toBeNull();

    await user.type(screen.getByLabelText(/Expected outcome/), "The task is complete.");
    await user.type(screen.getByLabelText(/Acceptance criteria/), "The test passes.");
    await user.type(screen.getByLabelText(/Agent context/), "Keep the seam shared.");
    await user.type(screen.getByLabelText(/Checklist/), "Run pnpm check");
    await user.type(screen.getByLabelText("Referenced paths"), "src/domain/tasks.ts");
    await user.click(screen.getByRole("button", { name: "Move to ready" }));

    expect(workspace.onPrepareTask).toHaveBeenCalledWith({
      taskId: backlog.id,
      title: backlog.title,
      description: emptyRichTextDocument,
      expectedOutcome: "The task is complete.",
      acceptanceCriteria: "The test passes.",
      agentContext: "Keep the seam shared.",
      checklist: [{ id: "item-1", text: "Run pnpm check", checked: false }],
      referencedPaths: ["src/domain/tasks.ts"],
      priority: "normal",
      position: 1,
      notBefore: null,
      dueAt: null,
      size: null,
      tags: [],
      requiredCapabilities: [],
      expectedVersion: 1,
      idempotencyKey: expect.any(String),
    });
  });

  it("updates planning metadata without changing preparation text", async () => {
    const user = userEvent.setup();
    const workspace = props();
    workspace.onUpdateTaskPlanning.mockResolvedValue({
      ok: true,
      task: { ...backlog, priority: "urgent", version: 2 },
    });
    render(<TaskWorkspace {...workspace} />);

    await user.selectOptions(screen.getByLabelText("Priority"), "urgent");
    await user.clear(screen.getByLabelText("Position"));
    await user.type(screen.getByLabelText("Position"), "4");
    await user.type(screen.getByLabelText("Start date"), "2026-09-10");
    await user.type(screen.getByLabelText("Due date"), "2026-09-12");
    await user.selectOptions(screen.getByLabelText("Size"), "m");
    await user.click(screen.getByRole("button", { name: "Add tag" }));
    await user.type(screen.getByLabelText("Tag 1 name"), "frontend");
    await user.type(screen.getByLabelText("Required capabilities"), "react");
    await user.click(screen.getByRole("button", { name: "Save planning" }));

    expect(workspace.onUpdateTaskPlanning).toHaveBeenCalledWith({
      taskId: backlog.id,
      priority: "urgent",
      position: 4,
      notBefore: "2026-09-10",
      dueAt: "2026-09-12",
      size: "m",
      tags: [{ name: "frontend", description: "", color: "#2563eb", exclusiveGroup: null }],
      requiredCapabilities: ["react"],
      expectedVersion: 1,
      idempotencyKey: expect.any(String),
    });
  });

  it("preserves canonical metadata when saving an existing project tag", async () => {
    const user = userEvent.setup();
    const canonicalTag = {
      id: "tag-1",
      name: "frontend",
      description: "Browser work",
      color: "#7c3aed",
      exclusiveGroup: "area",
    };
    const workspace = { ...props(), tagDefinitions: [canonicalTag] };
    workspace.onUpdateTaskPlanning.mockResolvedValue({ ok: true, task: backlog });
    render(<TaskWorkspace {...workspace} />);

    await user.click(screen.getByRole("button", { name: "Add tag" }));
    await user.type(screen.getByLabelText("Tag 1 name"), "frontend");
    expect(screen.getByLabelText("Tag 1 description")).toHaveProperty("disabled", true);
    await user.click(screen.getByRole("button", { name: "Save planning" }));

    expect(workspace.onUpdateTaskPlanning).toHaveBeenCalledWith(
      expect.objectContaining({
        tags: [
          {
            name: "frontend",
            description: "Browser work",
            color: "#7c3aed",
            exclusiveGroup: "area",
          },
        ],
      }),
    );
  });

  it("shows task relations and submits child and relation commands", async () => {
    const user = userEvent.setup();
    const dependent: Task = {
      ...backlog,
      id: "task-2",
      sequence: 2,
      title: "Dependent task",
      version: 3,
      upstreamRelations: [
        {
          id: "relation-1",
          projectId: project.id,
          sourceTaskId: backlog.id,
          sourceSequence: backlog.sequence,
          sourceTitle: backlog.title,
          targetTaskId: "task-2",
          targetSequence: 2,
          targetTitle: "Dependent task",
          type: "blocks",
          createdAt: "2026-09-03T10:20:00.000Z",
        },
      ],
    };
    const parent: Task = {
      ...backlog,
      lifecycle: "ready",
      childTaskIds: [dependent.id],
      downstreamRelations: dependent.upstreamRelations,
    };
    const workspace = props([parent, dependent]);
    workspace.onCreateTask.mockResolvedValue({ ok: true, task: { ...backlog, id: "task-child" } });
    workspace.onCreateTaskRelation.mockResolvedValue({
      ok: true,
      relation: dependent.upstreamRelations[0],
    });
    workspace.onCompleteTask.mockResolvedValue({
      ok: true,
      task: { ...parent, lifecycle: "done" },
    });
    render(<TaskWorkspace {...workspace} />);

    expect(screen.getByText(/Children:/).textContent).toContain("#2 Dependent task");
    expect(screen.getByText(/blocks to #2 Dependent task/)).toBeTruthy();

    await user.type(screen.getByLabelText("Child task title"), "New child");
    await user.click(screen.getByRole("button", { name: "Add child" }));
    await user.click(screen.getByRole("button", { name: "Add relation" }));
    await user.click(screen.getByRole("button", { name: "Done" }));

    expect(workspace.onCreateTask).toHaveBeenCalledWith(
      expect.objectContaining({
        projectId: project.id,
        parentTaskId: parent.id,
        lifecycle: "backlog",
        title: "New child",
      }),
    );
    expect(workspace.onCreateTaskRelation).toHaveBeenCalledWith({
      projectId: project.id,
      sourceTaskId: parent.id,
      targetTaskId: dependent.id,
      type: "blocks",
      expectedSourceVersion: parent.version,
      expectedTargetVersion: dependent.version,
      idempotencyKey: expect.any(String),
    });
    expect(workspace.onCompleteTask).toHaveBeenCalledWith({
      taskId: parent.id,
      expectedVersion: parent.version,
      idempotencyKey: expect.any(String),
    });
  });

  it("surfaces a version conflict and archives with the current task version", async () => {
    const user = userEvent.setup();
    const preparedBacklog: Task = {
      ...backlog,
      expectedOutcome: "Expected",
      acceptanceCriteria: "Accepted",
      checklist: [{ id: "check", text: "Verify", checked: false }],
    };
    const workspace = props([preparedBacklog]);
    workspace.onPrepareTask.mockResolvedValue({
      ok: false,
      error: {
        type: "TaskVersionConflictError",
        message: "Task version conflict: expected 1, current 2.",
        currentVersion: 2,
        expectedVersion: 1,
      },
    });
    workspace.onArchiveTask.mockResolvedValue({
      ok: true,
      task: { ...backlog, archivedAt: "2026-09-03T11:00:00.000Z", version: 2 },
    });
    render(<TaskWorkspace {...workspace} />);

    await user.click(screen.getByRole("button", { name: "Move to ready" }));
    expect(screen.getByRole("alert").textContent).toContain("expected 1, current 2");

    await user.click(screen.getByRole("button", { name: /Archive/ }));
    expect(workspace.onArchiveTask).toHaveBeenCalledWith({
      taskId: backlog.id,
      expectedVersion: 1,
      reason: "Archived from the task workspace",
      idempotencyKey: expect.any(String),
    });
  });

  it("requires reopening a done task before offering preparation actions", async () => {
    const user = userEvent.setup();
    const doneTask: Task = { ...backlog, lifecycle: "done" };
    const workspace = props([doneTask]);
    workspace.onReopenTask.mockResolvedValue({
      ok: true,
      task: { ...doneTask, lifecycle: "ready", version: 2 },
    });
    render(<TaskWorkspace {...workspace} />);

    expect(screen.queryByRole("button", { name: "Done" })).toBeNull();
    expect(screen.queryByRole("button", { name: "Save planning" })).toBeNull();
    expect(screen.queryByRole("button", { name: "Move to ready" })).toBeNull();
    expect(screen.getByText("Reopen this task before editing it.")).toBeTruthy();
    expect(screen.getByRole("group", { name: "Editable task details" })).toHaveProperty(
      "disabled",
      true,
    );
    expect(screen.getByLabelText("Child task title").matches(":disabled")).toBe(false);
    expect(screen.getByLabelText("Relation type").matches(":disabled")).toBe(false);
    await user.click(screen.getByRole("button", { name: "Reopen" }));

    expect(workspace.onReopenTask).toHaveBeenCalledWith({
      taskId: doneTask.id,
      expectedVersion: doneTask.version,
      reason: "Reopened from the task workspace",
      idempotencyKey: expect.any(String),
    });
  });

  it("shows active work and exposes only safe claim ownership and expiry details", () => {
    const activeTask = claimedTask();

    render(<TaskWorkspace {...props([activeTask])} />);

    expect(screen.getByRole("region", { name: "Task counts" }).textContent).toContain("1 active");
    const taskButton = within(screen.getByRole("navigation", { name: "Tasks" })).getByRole(
      "button",
      { name: /Claimed task/ },
    );
    expect(taskButton.textContent).toContain("Claimed by Build Agent");
    expect(taskButton.textContent).toContain("Lease expires");

    const claimRegion = screen.getByRole("region", { name: "Current claim" });
    expect(claimRegion.textContent).toContain("Claimed by Build Agent");
    expect(claimRegion.querySelector("time")?.getAttribute("datetime")).toBe(
      "2026-09-03T10:30:00.000Z",
    );
    expect(document.body.textContent).not.toContain("internal-lease-id");
    expect(document.body.textContent).not.toContain("internal-attempt-id");
    expect(document.body.textContent).not.toContain("internal-run-id");
    expect(document.body.textContent).not.toContain("internal-profile-id");
  });

  it.each([
    {
      disposition: "cancelled",
      buttonName: "Cancel claim",
      pendingName: "Cancelling claim…",
      reason: "The execution is no longer needed.",
      confirmation: "Their lease will stop immediately",
    },
    {
      disposition: "reassigned",
      buttonName: "Make available for reassignment",
      pendingName: "Making available…",
      reason: "A different capability is required.",
      confirmation: "Build Agent's lease will stop immediately",
    },
  ] as const)(
    "confirms and submits a $disposition claim disposition with an explicit reason",
    async ({ disposition, buttonName, pendingName, reason, confirmation }) => {
      const user = userEvent.setup();
      const task = claimedTask();
      const workspace = props([task]);
      let resolveResponse: ((response: unknown) => void) | undefined;
      workspace.onInvalidateClaim.mockReturnValue(
        new Promise((resolve) => {
          resolveResponse = resolve;
        }),
      );
      const confirm = vi.spyOn(window, "confirm").mockReturnValue(true);
      render(<TaskWorkspace {...workspace} />);

      const claimRegion = screen.getByRole("region", { name: "Current claim" });
      const action = within(claimRegion).getByRole("button", { name: buttonName });
      expect(action).toHaveProperty("disabled", true);

      await user.type(within(claimRegion).getByRole("textbox", { name: "Reason" }), reason);
      await user.click(action);

      expect(confirm).toHaveBeenCalledWith(expect.stringContaining(confirmation));
      expect(workspace.onInvalidateClaim).toHaveBeenCalledWith({
        taskId: task.id,
        expectedVersion: task.version,
        disposition,
        reason,
        idempotencyKey: expect.any(String),
      });
      expect(claimRegion.getAttribute("aria-busy")).toBe("true");
      expect(within(claimRegion).getByRole("button", { name: pendingName })).toHaveProperty(
        "disabled",
        true,
      );

      resolveResponse?.({
        ok: true,
        result: {
          task: { ...task, lifecycle: "ready", version: task.version + 1, claim: null },
          claim: {
            ...task.claim,
            status: disposition,
            invalidatedAt: "2026-09-03T10:20:00.000Z",
            invalidationReason: reason,
          },
        },
      });
      await waitFor(() => expect(claimRegion.getAttribute("aria-busy")).toBe("false"));
    },
  );

  it("surfaces a claim invalidation error in the task form", async () => {
    const user = userEvent.setup();
    const workspace = props([claimedTask()]);
    workspace.onInvalidateClaim.mockResolvedValue({
      ok: false,
      error: {
        type: "TaskVersionConflictError",
        message: "The claim changed before confirmation.",
      },
    });
    vi.spyOn(window, "confirm").mockReturnValue(true);
    render(<TaskWorkspace {...workspace} />);

    await user.type(screen.getByRole("textbox", { name: "Reason" }), "The owner changed.");
    await user.click(screen.getByRole("button", { name: "Cancel claim" }));

    expect(await screen.findByRole("alert")).toHaveProperty(
      "textContent",
      "The claim changed before confirmation.",
    );
  });

  it.each([
    ["in_progress", "Agent execution is active"],
    ["review", "This task is awaiting review"],
  ] as const)("keeps %s task mutations read-only", (lifecycle, explanation) => {
    const task: Task = { ...backlog, lifecycle };

    render(<TaskWorkspace {...props([task])} />);

    expect(screen.getByText(new RegExp(explanation))).toBeTruthy();
    expect(screen.getByRole("group", { name: "Editable task details" })).toHaveProperty(
      "disabled",
      true,
    );
    expect(screen.getByRole("group", { name: "Task structure actions" })).toHaveProperty(
      "disabled",
      true,
    );
    expect(screen.getByRole("button", { name: /Archive/ })).toHaveProperty("disabled", true);
    expect(screen.queryByRole("button", { name: "Save planning" })).toBeNull();
    expect(screen.queryByRole("button", { name: "Move to ready" })).toBeNull();
    expect(screen.queryByRole("button", { name: "Done" })).toBeNull();
  });
});
