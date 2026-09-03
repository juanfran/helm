// @vitest-environment jsdom

import { cleanup, render, screen } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { afterEach, describe, expect, it, vi } from "vitest";

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

afterEach(cleanup);

function props(tasks: readonly Task[] = [backlog]) {
  return {
    project,
    theme: "system" as const,
    tasks,
    onCreateTask: vi.fn(),
    onPrepareTask: vi.fn(),
    onUpdateTaskPlanning: vi.fn(),
    onCompleteTask: vi.fn(),
    onReopenTask: vi.fn(),
    onCreateTaskRelation: vi.fn(),
    onArchiveTask: vi.fn(),
    onChangeTheme: vi.fn(),
  };
}

describe("task workspace", () => {
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

    await user.type(screen.getByLabelText(/Expected outcome/), "The task is complete.");
    await user.type(screen.getByLabelText(/Acceptance criteria/), "The test passes.");
    await user.type(screen.getByLabelText(/Agent context/), "Keep the seam shared.");
    await user.type(screen.getByLabelText(/Checklist/), "Run pnpm check");
    await user.click(screen.getByRole("button", { name: "Move to ready" }));

    expect(workspace.onPrepareTask).toHaveBeenCalledWith({
      taskId: backlog.id,
      title: backlog.title,
      description: emptyRichTextDocument,
      expectedOutcome: "The task is complete.",
      acceptanceCriteria: "The test passes.",
      agentContext: "Keep the seam shared.",
      checklist: [{ id: "item-1", text: "Run pnpm check", checked: false }],
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
    await user.type(screen.getByLabelText("Tags"), "frontend");
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
});
