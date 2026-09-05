// @vitest-environment jsdom

import { cleanup, fireEvent, render, screen, waitFor, within } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { afterEach, describe, expect, it, vi } from "vitest";

import type { ProjectEvent } from "../../domain/activity";
import type { Project } from "../../domain/projects";
import { compareTaskOrder, emptyRichTextDocument, type Task } from "../../domain/tasks";
import { createRetryableLazyModuleLoader } from "../../components/retryable-lazy-module";
import { TaskWorkspace } from "./task-workspace";

const project: Project = {
  id: "project-1",
  sequence: 1,
  name: "helm",
  repositoryRoot: "/projects/helm",
  reviewMode: "required",
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
  customFields: [],
  reviewModeOverride: null,
  reviewPolicy: null,
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
  reviewAttemptId: null,
  cancelledFromLifecycle: null,
  version: 1,
  archivedAt: null,
  createdAt: "2026-09-03T10:10:00.000Z",
  updatedAt: "2026-09-03T10:10:00.000Z",
};

function TestDescriptionEditor() {
  return (
    <div>
      <div aria-label="Description formatting">Editor formatting</div>
      <textarea aria-label="Recovered description editor" />
    </div>
  );
}

function TestDashboard({
  tasks,
  onSelectTask,
}: {
  tasks: readonly Task[];
  onSelectTask: (taskId: string) => void;
}) {
  return (
    <section>
      <h2>Awaiting review</h2>
      {tasks
        .filter((task) => task.lifecycle === "review")
        .map((task) => (
          <button key={task.id} type="button" onClick={() => onSelectTask(task.id)}>
            {task.title}
          </button>
        ))}
    </section>
  );
}

function TestProjectActivity({ events }: { events: readonly ProjectEvent[] }) {
  return (
    <section>
      <h2>Project activity</h2>
      {events.map((event) => (
        <article key={event.id}>
          <p>{typeof event.payload.reason === "string" ? event.payload.reason : ""}</p>
          <p>{event.importance}</p>
        </article>
      ))}
    </section>
  );
}

function TestTaskDetail({ task }: { task: Task }) {
  return <section aria-label={`Loaded task #${task.sequence}`}>Loaded task details</section>;
}

function TestNotifications() {
  return <section aria-label="Loaded notifications">Notification controls</section>;
}

function TestAppearance() {
  return <section aria-label="Loaded appearance">Appearance controls</section>;
}

function TestBulkControls() {
  return <section aria-label="Loaded bulk actions">Bulk controls</section>;
}

function TestCollaboration() {
  return <section aria-label="Loaded collaboration">Collaboration controls</section>;
}

function deferred<T>() {
  let resolve!: (value: T) => void;
  let reject!: (reason?: unknown) => void;
  const promise = new Promise<T>((resolvePromise, rejectPromise) => {
    resolve = resolvePromise;
    reject = rejectPromise;
  });
  return { promise, reject, resolve };
}

afterEach(() => {
  cleanup();
  sessionStorage.clear();
  vi.restoreAllMocks();
  Object.defineProperty(window, "innerWidth", { configurable: true, value: 1024 });
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
    attempts: [],
    tagDefinitions: tasks.flatMap((task) => task.tags),
    activityEntries: [],
    manualBlockers: [],
    projectEvents: [],
    initialSelectedTaskId: tasks.toSorted(compareTaskOrder)[0]?.id ?? null,
    taskDetailModuleLoader: createRetryableLazyModuleLoader(() =>
      import("./task-detail-panel").then(({ TaskDetailPanel }) => ({ default: TaskDetailPanel })),
    ),
    liveStatus: "live" as const,
    onCreateTask: vi.fn(),
    onPrepareTask: vi.fn(),
    onUpdateTaskPlanning: vi.fn(),
    onSetTaskReviewModeOverride: vi.fn(),
    onApproveTaskReview: vi.fn(),
    onRequestTaskChanges: vi.fn(),
    onCancelTask: vi.fn(),
    onRestoreCancelledTask: vi.fn(),
    onReopenTask: vi.fn(),
    onCreateTaskRelation: vi.fn(),
    onArchiveTask: vi.fn(),
    onInvalidateClaim: vi.fn(),
    onCreateActivityEntry: vi.fn(),
    onWithdrawActivityEntry: vi.fn(),
    onCreateManualBlocker: vi.fn(),
    onResolveManualBlocker: vi.fn(),
    onPreviewBulkTasks: vi.fn(),
    onExecuteBulkTasks: vi.fn(),
    onChangeTheme: vi.fn(),
    onChangeProjectReviewMode: vi.fn(),
  };
}

function useNarrowViewport() {
  Object.defineProperty(window, "innerWidth", { configurable: true, value: 390 });
  window.dispatchEvent(new Event("resize"));
}

async function waitForTaskDetail() {
  const form = await screen.findByRole("form", { name: "Prepare task" });
  fireEvent.click(screen.getByText("Planning and agent instructions", { selector: "summary" }));
  fireEvent.click(screen.getByText("Subtasks and relationships", { selector: "summary" }));
  return form;
}

describe("task workspace", () => {
  it("keeps the task route useful without loading interaction-only modules", () => {
    const { initialSelectedTaskId: _initialSelectedTaskId, ...workspace } = props();
    const loadTaskDetail = vi.fn(async () => ({ default: TestTaskDetail }));
    const loadDashboard = vi.fn(async () => ({ default: TestDashboard }));
    const loadActivity = vi.fn(async () => ({ default: TestProjectActivity }));
    const loadEditor = vi.fn(async () => ({ default: TestDescriptionEditor }));
    render(
      <TaskWorkspace
        {...workspace}
        taskDetailModuleLoader={createRetryableLazyModuleLoader(loadTaskDetail)}
        dashboardModuleLoader={createRetryableLazyModuleLoader(loadDashboard)}
        activityModuleLoader={createRetryableLazyModuleLoader(loadActivity)}
        richTextEditorModuleLoader={createRetryableLazyModuleLoader(loadEditor)}
      />,
    );

    expect(screen.getByRole("heading", { name: "Tasks" })).toBeTruthy();
    expect(screen.getByRole("heading", { name: "Select a task" })).toBeTruthy();
    expect(screen.getByLabelText("Task title")).toBeTruthy();
    expect(screen.getByRole("button", { name: "Open task #1: Captured task" })).toBeTruthy();
    expect(screen.getByRole("button", { name: "Bulk actions" })).toBeTruthy();
    expect(screen.getByRole("button", { name: "Appearance" })).toBeTruthy();
    expect(screen.getByRole("button", { name: "Notifications, none unread" })).toBeTruthy();
    expect(screen.queryByRole("status", { name: /Loading/ })).toBeNull();
    expect(loadTaskDetail).not.toHaveBeenCalled();
    expect(loadEditor).not.toHaveBeenCalled();
    expect(loadDashboard).not.toHaveBeenCalled();
    expect(loadActivity).not.toHaveBeenCalled();
  });

  it("keeps workspace launch controls focused through lazy failure, loading, and readiness", async () => {
    const notificationGate = deferred<{ default: typeof TestNotifications }>();
    const appearanceGate = deferred<{ default: typeof TestAppearance }>();
    const bulkGate = deferred<{ default: typeof TestBulkControls }>();
    const loadNotifications = vi
      .fn<() => Promise<{ default: typeof TestNotifications }>>()
      .mockRejectedValueOnce(new Error("Notifications chunk unavailable"))
      .mockImplementationOnce(() => notificationGate.promise);
    const loadAppearance = vi.fn(() => appearanceGate.promise);
    const loadBulk = vi.fn(() => bulkGate.promise);
    render(
      <TaskWorkspace
        {...props([])}
        notificationsModuleLoader={createRetryableLazyModuleLoader(loadNotifications)}
        appearanceModuleLoader={createRetryableLazyModuleLoader(loadAppearance)}
        bulkModuleLoader={createRetryableLazyModuleLoader(loadBulk)}
      />,
    );

    const notifications = screen.getByRole("button", {
      name: "Notifications, none unread",
    });
    notifications.focus();
    fireEvent.click(notifications);
    expect(await screen.findByRole("alert", { name: "notifications unavailable" })).toBeTruthy();
    expect(document.activeElement).toBe(notifications);
    fireEvent.click(notifications);
    expect(screen.getByRole("status", { name: "Loading notifications" })).toBeTruthy();
    expect(document.activeElement).toBe(notifications);
    notificationGate.resolve({ default: TestNotifications });
    expect(await screen.findByRole("region", { name: "Loaded notifications" })).toBeTruthy();
    expect(notifications.isConnected).toBe(false);

    const appearance = screen.getByRole("button", { name: "Appearance" });
    appearance.focus();
    await waitFor(() => expect(loadAppearance).toHaveBeenCalledTimes(1));
    fireEvent.click(appearance);
    expect(screen.getByRole("status", { name: "Loading appearance control" })).toBeTruthy();
    expect(document.activeElement).toBe(appearance);
    appearanceGate.resolve({ default: TestAppearance });
    expect(await screen.findByRole("region", { name: "Loaded appearance" })).toBeTruthy();
    expect(appearance.isConnected).toBe(false);

    const bulk = screen.getByRole("button", { name: "Bulk actions" });
    bulk.focus();
    await waitFor(() => expect(loadBulk).toHaveBeenCalledTimes(1));
    fireEvent.click(bulk);
    expect(screen.getByRole("status", { name: "Loading bulk controls" })).toBeTruthy();
    expect(document.activeElement).toBe(bulk);
    bulkGate.resolve({ default: TestBulkControls });
    expect(await screen.findByRole("region", { name: "Loaded bulk actions" })).toBeTruthy();
    expect(document.activeElement).toBe(bulk);
  });

  it("preloads task details on intent and keeps the selected summary and trigger usable", async () => {
    const detailedTask = {
      ...backlog,
      descriptionText: "A readable summary remains while task controls load.",
      expectedOutcome: "The detail boundary does not blank the workspace.",
      acceptanceCriteria: "Keyboard focus stays on the selected task.",
      checklist: [{ id: "check-1", text: "Verify the loading summary", checked: false }],
    };
    const detailGate = deferred<{ default: typeof TestTaskDetail }>();
    const loadTaskDetail = vi.fn(() => detailGate.promise);
    const {
      initialSelectedTaskId: _initialSelectedTaskId,
      taskDetailModuleLoader: _taskDetailModuleLoader,
      ...workspace
    } = props([detailedTask]);
    render(
      <TaskWorkspace
        {...workspace}
        taskDetailModuleLoader={createRetryableLazyModuleLoader(loadTaskDetail)}
      />,
    );

    const taskTrigger = screen.getByRole("button", { name: "Open task #1: Captured task" });
    taskTrigger.focus();
    await waitFor(() => expect(loadTaskDetail).toHaveBeenCalledTimes(1));
    expect(taskTrigger.getAttribute("aria-current")).toBeNull();
    expect(screen.getByRole("heading", { name: "Select a task" })).toBeTruthy();

    fireEvent.click(taskTrigger);
    expect(document.activeElement).toBe(
      screen.getByRole("heading", { name: "Captured task", level: 2 }),
    );
    expect(taskTrigger.getAttribute("aria-current")).toBe("true");
    expect(screen.getByRole("article", { name: "Task #1 summary" }).textContent).toContain(
      detailedTask.descriptionText,
    );
    expect(screen.getByText(detailedTask.expectedOutcome)).toBeTruthy();
    expect(screen.getByText(detailedTask.acceptanceCriteria)).toBeTruthy();
    expect(screen.getByText("Verify the loading summary")).toBeTruthy();
    expect(screen.getByRole("status", { name: "Loading task details" })).toBeTruthy();

    detailGate.resolve({ default: TestTaskDetail });
    expect(await screen.findByRole("region", { name: "Loaded task #1" })).toBeTruthy();
    expect(document.activeElement).toBe(
      screen.getByRole("heading", { name: "Captured task", level: 2 }),
    );
  });

  it("preserves the readable task summary when detail loading fails and retries", async () => {
    const failedTask = {
      ...backlog,
      descriptionText: "The task remains readable after a chunk failure.",
      expectedOutcome: "Recovery does not require reselecting the task.",
    };
    const loadTaskDetail = vi
      .fn<() => Promise<{ default: typeof TestTaskDetail }>>()
      .mockRejectedValueOnce(new Error("Task detail chunk unavailable"))
      .mockResolvedValueOnce({ default: TestTaskDetail });
    const {
      initialSelectedTaskId: _initialSelectedTaskId,
      taskDetailModuleLoader: _taskDetailModuleLoader,
      ...workspace
    } = props([failedTask]);
    render(
      <TaskWorkspace
        {...workspace}
        taskDetailModuleLoader={createRetryableLazyModuleLoader(loadTaskDetail)}
      />,
    );

    fireEvent.click(screen.getByRole("button", { name: "Open task #1: Captured task" }));
    const failure = await screen.findByRole("alert", { name: "task details unavailable" });
    expect(screen.getByLabelText("Task description")).toHaveProperty(
      "textContent",
      failedTask.descriptionText,
    );
    expect(screen.getByText(failedTask.expectedOutcome)).toBeTruthy();

    fireEvent.click(within(failure).getByRole("button", { name: "Retry" }));
    expect(await screen.findByRole("region", { name: "Loaded task #1" })).toBeTruthy();
    expect(loadTaskDetail).toHaveBeenCalledTimes(2);
  });

  it("preloads the task editor on intent and reveals it only after activation", async () => {
    const editorGate = deferred<{ default: typeof TestDescriptionEditor }>();
    const loadEditor = vi.fn(() => editorGate.promise);
    const editorModule = createRetryableLazyModuleLoader(loadEditor);
    const describedTask = {
      ...backlog,
      descriptionText: "The route must remain readable before editing begins.",
    };
    render(<TaskWorkspace {...props([describedTask])} richTextEditorModuleLoader={editorModule} />);

    expect(await screen.findByLabelText("Task description")).toHaveProperty(
      "textContent",
      describedTask.descriptionText,
    );
    expect(screen.queryByRole("status", { name: "Loading task editor" })).toBeNull();
    expect(screen.queryByLabelText("Description formatting")).toBeNull();
    const editButton = await screen.findByRole("button", { name: "Edit description" });
    editButton.focus();
    await waitFor(() => expect(loadEditor).toHaveBeenCalledTimes(1));
    expect(screen.queryByLabelText("Description formatting")).toBeNull();

    fireEvent.click(editButton);
    expect(screen.getByRole("status", { name: "Loading task editor" })).toBeTruthy();
    expect(document.activeElement).toBe(editButton);
    editorGate.resolve({ default: TestDescriptionEditor });
    expect(await screen.findByLabelText("Description formatting")).toBeTruthy();
    expect(document.activeElement).toBe(editButton);
  });

  it("keeps editor failure recovery outside disabled task fields", async () => {
    const loadEditor = vi
      .fn<() => Promise<{ default: typeof TestDescriptionEditor }>>()
      .mockRejectedValueOnce(new Error("Editor chunk unavailable"))
      .mockResolvedValueOnce({ default: TestDescriptionEditor });
    const editorModule = createRetryableLazyModuleLoader(loadEditor);
    render(<TaskWorkspace {...props()} richTextEditorModuleLoader={editorModule} />);

    fireEvent.click(await screen.findByRole("button", { name: "Edit description" }));
    const failure = await screen.findByRole("alert", { name: "task editor unavailable" });
    const retry = within(failure).getByRole("button", { name: "Retry" });
    expect(retry.matches(":disabled")).toBe(false);

    fireEvent.click(retry);
    expect(
      await screen.findByRole("textbox", { name: "Recovered description editor" }),
    ).toBeTruthy();
    expect(loadEditor).toHaveBeenCalledTimes(2);
  });

  it("keeps the collaboration trigger focused through failure, retry, and readiness", async () => {
    const collaborationGate = deferred<{ default: typeof TestCollaboration }>();
    const loadCollaboration = vi
      .fn<() => Promise<{ default: typeof TestCollaboration }>>()
      .mockRejectedValueOnce(new Error("Collaboration chunk unavailable"))
      .mockImplementationOnce(() => collaborationGate.promise);
    render(
      <TaskWorkspace
        {...props()}
        collaborationModuleLoader={createRetryableLazyModuleLoader(loadCollaboration)}
      />,
    );

    await waitForTaskDetail();
    const trigger = screen.getByRole("button", { name: "Open collaboration" });
    trigger.focus();
    fireEvent.click(trigger);
    expect(
      await screen.findByRole("alert", { name: "collaboration controls unavailable" }),
    ).toBeTruthy();
    expect(document.activeElement).toBe(trigger);

    fireEvent.click(trigger);
    expect(screen.getByRole("status", { name: "Loading collaboration controls" })).toBeTruthy();
    expect(document.activeElement).toBe(trigger);
    collaborationGate.resolve({ default: TestCollaboration });
    expect(await screen.findByRole("region", { name: "Loaded collaboration" })).toBeTruthy();
    expect(trigger.getAttribute("aria-disabled")).toBe("true");
    expect(trigger.getAttribute("aria-expanded")).toBe("true");
    expect(document.activeElement).toBe(trigger);
  });

  it("makes project data management available from Settings", async () => {
    const user = userEvent.setup();
    render(
      <TaskWorkspace
        {...props()}
        portabilityControl={
          <section aria-label="Project portability">Portability controls</section>
        }
      />,
    );

    await user.click(screen.getByRole("button", { name: "Settings" }));
    expect(screen.getByRole("region", { name: "Project portability" })).toBeTruthy();
  });

  it("preloads the project switcher and supports closing it", async () => {
    const preload = vi.fn();
    render(
      <TaskWorkspace
        {...props([])}
        projectSwitcher={{
          preload,
          surface: <section aria-label="Project switcher">Switcher controls</section>,
        }}
      />,
    );

    const trigger = screen.getByRole("button", { name: "Switch project" });
    trigger.focus();
    expect(preload).toHaveBeenCalledTimes(1);
    expect(screen.queryByRole("region", { name: "Project switcher" })).toBeNull();

    fireEvent.click(trigger);
    expect(await screen.findByRole("region", { name: "Project switcher" })).toBeTruthy();
    expect(
      screen.getByRole("button", { name: "Switch project" }).getAttribute("aria-expanded"),
    ).toBe("true");
    fireEvent.click(screen.getByRole("button", { name: "Close project switcher" }));
    await waitFor(() =>
      expect(
        screen.getByRole("button", { name: "Switch project" }).getAttribute("aria-expanded"),
      ).toBe("false"),
    );
  });

  it("drills from the live dashboard into narrow-screen review and comment actions", async () => {
    useNarrowViewport();
    const user = userEvent.setup();
    const reviewTask: Task = {
      ...backlog,
      id: "review-task",
      title: "Review agent delivery",
      lifecycle: "review",
      reviewAttemptId: "attempt-review",
      eligibility: {
        claimable: false,
        status: "not_ready",
        reasons: ["Awaiting human review."],
        orderingExplanation: "high lane",
        missingCapabilities: [],
        blockingTaskIds: [],
      },
    };
    const dashboardGate = deferred<{ default: typeof TestDashboard }>();
    const loadDashboard = vi.fn(() => dashboardGate.promise);
    const workspace = props([reviewTask]);
    workspace.onApproveTaskReview.mockResolvedValue({ ok: true, result: {} });
    workspace.onCreateActivityEntry.mockResolvedValue({ ok: true, result: {} });
    render(
      <TaskWorkspace
        {...workspace}
        dashboardModuleLoader={createRetryableLazyModuleLoader(loadDashboard)}
      />,
    );

    expect(screen.getByRole("button", { name: "Appearance" })).toBeTruthy();
    expect(screen.getByRole("button", { name: "Notifications, none unread" })).toBeTruthy();
    const dashboardButton = screen.getByRole("button", { name: "Dashboard" });
    expect(loadDashboard).not.toHaveBeenCalled();
    dashboardButton.focus();
    await waitFor(() => expect(loadDashboard).toHaveBeenCalledTimes(1));
    expect(dashboardButton.getAttribute("aria-pressed")).toBe("false");

    await user.click(dashboardButton);
    const dashboardFallback = screen.getByRole("status", { name: "Loading dashboard" });
    expect(dashboardFallback.getAttribute("aria-live")).toBe("polite");
    dashboardGate.resolve({ default: TestDashboard });

    const reviewPanel = (await screen.findByRole("heading", { name: "Awaiting review" })).closest(
      "section",
    );
    await user.click(within(reviewPanel!).getByRole("button", { name: /Review agent delivery/ }));

    expect(await screen.findByRole("form", { name: "Approve task review" })).toBeTruthy();
    expect(screen.getByRole("form", { name: "Request task changes" })).toBeTruthy();
    await user.click(screen.getByRole("button", { name: "Open collaboration" }));
    expect(await screen.findByRole("region", { name: "Collaboration" })).toBeTruthy();

    const approveForm = screen.getByRole("form", { name: "Approve task review" });
    await user.type(
      within(approveForm).getByLabelText("Approval summary"),
      "Verified from a phone-sized workspace.",
    );
    await user.click(within(approveForm).getByRole("button", { name: "Approve" }));
    expect(workspace.onApproveTaskReview).toHaveBeenCalledWith(
      expect.objectContaining({
        taskId: reviewTask.id,
        attemptId: "attempt-review",
        summary: "Verified from a phone-sized workspace.",
      }),
    );

    await user.type(screen.getByLabelText("Activity update"), "Human mobile note");
    await user.click(screen.getByRole("button", { name: "Add comment" }));
    expect(workspace.onCreateActivityEntry).toHaveBeenCalledWith(
      expect.objectContaining({ taskId: reviewTask.id, kind: "comment" }),
    );
  });

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
    const activityGate = deferred<{ default: typeof TestProjectActivity }>();
    const loadActivity = vi.fn(() => activityGate.promise);
    render(
      <TaskWorkspace
        {...props()}
        projectEvents={[activityEvent]}
        activityModuleLoader={createRetryableLazyModuleLoader(loadActivity)}
      />,
    );

    const activityButton = screen.getByRole("button", { name: "Activity" });
    expect(loadActivity).not.toHaveBeenCalled();
    activityButton.focus();
    await waitFor(() => expect(loadActivity).toHaveBeenCalledTimes(1));
    expect(activityButton.getAttribute("aria-pressed")).toBe("false");

    await user.click(activityButton);

    const activityFallback = screen.getByRole("status", { name: "Loading project activity" });
    expect(activityFallback.getAttribute("aria-live")).toBe("polite");
    activityGate.resolve({ default: TestProjectActivity });
    expect(await screen.findByRole("heading", { name: "Project activity" })).toBeTruthy();
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

    const taskButtons = within(screen.getByRole("list", { name: "Tasks" })).getAllByRole("button");
    expect(taskButtons.map((button) => button.textContent)).toEqual([
      expect.stringContaining("Urgent first"),
      expect.stringContaining("Urgent later"),
      expect.stringContaining("Low priority"),
    ]);
    expect(taskButtons[0]?.getAttribute("aria-current")).toBe("true");
  });

  it("keeps bulk selection separate from the task opened for detail", async () => {
    const user = userEvent.setup();
    const secondTask: Task = {
      ...backlog,
      id: "task-2",
      sequence: 2,
      title: "Second task",
      position: 2,
    };
    render(<TaskWorkspace {...props([backlog, secondTask])} />);

    await user.click(screen.getByRole("button", { name: "Bulk actions" }));
    const checkbox = screen.getByRole("checkbox", {
      name: "Select task #2: Second task",
    });
    await user.click(checkbox);

    expect(checkbox.getAttribute("aria-checked")).toBe("true");
    expect(
      screen
        .getByRole("button", { name: "Open task #1: Captured task" })
        .getAttribute("aria-current"),
    ).toBe("true");
    expect((await screen.findByRole("button", { name: "Bulk edit" })).matches(":disabled")).toBe(
      false,
    );
    expect(
      screen.getByRole("button", { name: "Open task #2: Second task" }).contains(checkbox),
    ).toBe(false);

    await user.click(screen.getByRole("button", { name: "Open task #2: Second task" }));
    expect(
      screen
        .getByRole("button", { name: "Open task #2: Second task" })
        .getAttribute("aria-current"),
    ).toBe("true");
    expect(checkbox.getAttribute("aria-checked")).toBe("true");
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

    await waitForTaskDetail();

    expect(screen.queryByRole("button", { name: "Done" })).toBeNull();

    await user.type(screen.getByLabelText(/Expected outcome/), "The task is complete.");
    await user.type(screen.getByLabelText(/Acceptance criteria/), "The test passes.");
    await user.type(screen.getByLabelText(/Agent context/), "Keep the seam shared.");
    await user.type(screen.getByLabelText(/Checklist/), "Run pnpm check");
    await user.type(screen.getByLabelText("Referenced paths"), "src/domain/tasks.ts");
    await user.click(screen.getByRole("button", { name: "Move to ready" }));

    expect(workspace.onPrepareTask).toHaveBeenCalledWith({
      saveAsDraft: false,
      taskId: backlog.id,
      title: backlog.title,
      description: emptyRichTextDocument,
      expectedOutcome: "The task is complete.",
      acceptanceCriteria: "The test passes.",
      agentContext: "Keep the seam shared.",
      checklist: [{ id: expect.any(String), text: "Run pnpm check", checked: false }],
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

  it("saves an incomplete draft on Enter without moving it to ready", async () => {
    const user = userEvent.setup();
    const workspace = props();
    workspace.onPrepareTask.mockResolvedValue({ ok: true, task: { ...backlog, version: 2 } });
    render(<TaskWorkspace {...workspace} />);
    await waitForTaskDetail();
    await user.type(screen.getByLabelText("Title", { exact: true }), "{Enter}");
    expect(workspace.onPrepareTask).toHaveBeenCalledWith(
      expect.objectContaining({
        saveAsDraft: true,
        expectedOutcome: "",
        checklist: [],
      }),
    );
  });

  it("reprioritizes work from the narrow-screen task controls", async () => {
    useNarrowViewport();
    const user = userEvent.setup();
    const workspace = props();
    workspace.onPrepareTask.mockResolvedValue({
      ok: true,
      task: { ...backlog, priority: "urgent", version: 2 },
    });
    render(<TaskWorkspace {...workspace} />);

    await waitForTaskDetail();

    await user.selectOptions(screen.getByLabelText("Priority"), "urgent");
    await user.clear(screen.getByLabelText("Position"));
    await user.type(screen.getByLabelText("Position"), "4");
    await user.type(screen.getByLabelText("Start date"), "2026-09-10");
    await user.type(screen.getByLabelText("Due date"), "2026-09-12");
    await user.selectOptions(screen.getByLabelText("Size"), "m");
    await user.click(screen.getByRole("button", { name: "Add tag" }));
    await user.type(screen.getByLabelText("Tag 1 name"), "frontend");
    await user.type(screen.getByLabelText("Required capabilities"), "react");
    await user.click(screen.getByRole("button", { name: "Save draft" }));

    expect(workspace.onPrepareTask).toHaveBeenCalledWith(
      expect.objectContaining({
        saveAsDraft: true,
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
      }),
    );
  });

  it("preserves canonical metadata when saving an existing project tag", async () => {
    const user = userEvent.setup();
    const canonicalTag = {
      id: "tag-1",
      name: "frontend",
      description: "Browser work",
      color: "#7c3aed",
      exclusiveGroup: "area",
      reviewModeOverride: null,
    };
    const workspace = { ...props(), tagDefinitions: [canonicalTag] };
    workspace.onPrepareTask.mockResolvedValue({ ok: true, task: backlog });
    render(<TaskWorkspace {...workspace} />);

    await waitForTaskDetail();

    await user.click(screen.getByRole("button", { name: "Add tag" }));
    await user.type(screen.getByLabelText("Tag 1 name"), "frontend");
    expect(screen.getByLabelText("Tag 1 description")).toHaveProperty("disabled", true);
    await user.click(screen.getByRole("button", { name: "Save draft" }));

    expect(workspace.onPrepareTask).toHaveBeenCalledWith(
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
    render(<TaskWorkspace {...workspace} />);

    await waitForTaskDetail();

    expect(screen.getByText(/Children:/).textContent).toContain("#2 Dependent task");
    expect(screen.getByText(/blocks to #2 Dependent task/)).toBeTruthy();

    await user.type(screen.getByLabelText("Child task title"), "New child");
    await user.click(screen.getByRole("button", { name: "Add child" }));
    await user.click(screen.getByRole("button", { name: "Add relation" }));

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
  });

  it("surfaces a version conflict and archives with the current task version", async () => {
    vi.spyOn(window, "confirm").mockReturnValue(true);
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

    await waitForTaskDetail();

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

  it("reopens completed work from the narrow-screen task controls", async () => {
    useNarrowViewport();
    const user = userEvent.setup();
    const doneTask: Task = { ...backlog, lifecycle: "done" };
    const workspace = props([doneTask]);
    workspace.onReopenTask.mockResolvedValue({
      ok: true,
      result: {},
    });
    render(<TaskWorkspace {...workspace} />);

    await waitForTaskDetail();

    expect(screen.queryByRole("button", { name: "Done" })).toBeNull();
    expect(screen.queryByRole("button", { name: "Save draft" })).toBeNull();
    expect(screen.queryByRole("button", { name: "Move to ready" })).toBeNull();
    expect(screen.getByText("Reopen this task before editing it.")).toBeTruthy();
    expect(screen.getByRole("group", { name: "Editable task details" })).toHaveProperty(
      "disabled",
      true,
    );
    expect(screen.getByLabelText("Child task title").matches(":disabled")).toBe(false);
    expect(screen.getByLabelText("Relation type").matches(":disabled")).toBe(false);
    const reopenForm = await screen.findByRole("form", { name: "Reopen completed task" });
    await user.selectOptions(within(reopenForm).getByLabelText("Destination"), "backlog");
    await user.type(
      within(reopenForm).getByLabelText("Reopen reason"),
      "Requirements changed after completion.",
    );
    await user.click(within(reopenForm).getByRole("button", { name: "Reopen" }));

    expect(workspace.onReopenTask).toHaveBeenCalledWith({
      taskId: doneTask.id,
      destination: "backlog",
      expectedVersion: doneTask.version,
      reason: "Requirements changed after completion.",
      idempotencyKey: expect.any(String),
    });
  });

  it("shows active work and exposes only safe claim ownership and expiry details", async () => {
    const activeTask = claimedTask();

    render(<TaskWorkspace {...props([activeTask])} />);

    await waitForTaskDetail();

    expect(screen.getByRole("region", { name: "Task counts" }).textContent).toContain("1 active");
    const taskButton = within(screen.getByRole("list", { name: "Tasks" })).getByRole("button", {
      name: /Open task #1: Claimed task/,
    });
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
      buttonName: "Stop claim",
      pendingName: "Stopping claim…",
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

      await waitForTaskDetail();

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

    await waitForTaskDetail();

    await user.type(screen.getByRole("textbox", { name: "Reason" }), "The owner changed.");
    await user.click(screen.getByRole("button", { name: "Stop claim" }));

    expect(await screen.findByRole("alert")).toHaveProperty(
      "textContent",
      "The claim changed before confirmation.",
    );
  });

  it("edits typed project fields and shows the effective review-policy explanation", async () => {
    const user = userEvent.setup();
    const customized: Task = {
      ...backlog,
      customFields: [
        {
          definition: {
            id: "field-owner",
            projectId: project.id,
            key: "owner",
            type: "text",
            validation: { minLength: 0, maxLength: 80 },
            defaultValue: { type: "text", value: "unassigned" },
            display: { label: "Owner", description: "Person responsible for the outcome." },
            position: 0,
            retiredAt: null,
            createdAt: "2026-09-03T10:00:00.000Z",
            updatedAt: "2026-09-03T10:00:00.000Z",
          },
          value: { type: "text", value: "unassigned" },
          source: "default",
        },
      ],
      reviewPolicy: {
        mode: "required",
        destination: "review",
        source: { level: "project", projectId: project.id },
        applicableTagRules: [],
        tagConflict: false,
        explanation:
          "Project policy requires human review because no task or tag override applies.",
      },
    };
    const workspace = props([customized]);
    workspace.onPrepareTask.mockResolvedValue({ ok: true, task: customized });
    workspace.onSetTaskReviewModeOverride.mockResolvedValue({
      ok: true,
      task: { ...customized, reviewModeOverride: "direct", version: 2 },
    });
    render(<TaskWorkspace {...workspace} />);

    await waitForTaskDetail();

    expect(screen.getByRole("region", { name: "Effective review policy" })).toHaveProperty(
      "textContent",
      expect.stringContaining("Project policy requires human review"),
    );
    const owner = screen.getByRole("textbox", { name: "Custom field: Owner" });
    expect(owner).toHaveProperty("placeholder", "unassigned");
    await user.type(owner, "Ada");
    await user.selectOptions(screen.getByLabelText("Task review policy override"), "direct");
    await user.type(screen.getByLabelText("Review policy change reason"), "Trusted task route.");
    await user.click(screen.getByRole("button", { name: "Apply review policy" }));
    expect(workspace.onSetTaskReviewModeOverride).toHaveBeenCalledWith({
      projectId: project.id,
      taskId: customized.id,
      reviewModeOverride: "direct",
      expectedTaskVersion: customized.version,
      reason: "Trusted task route.",
      idempotencyKey: expect.any(String),
    });
    await user.click(screen.getByRole("button", { name: "Save draft" }));

    expect(workspace.onPrepareTask).toHaveBeenCalledWith(
      expect.objectContaining({
        customFields: [{ fieldId: "field-owner", value: { type: "text", value: "Ada" } }],
      }),
    );
    expect(workspace.onPrepareTask).not.toHaveBeenCalledWith(
      expect.objectContaining({ reviewModeOverride: expect.anything() }),
    );
  });

  it("keeps a read-only task description available without loading the editor", async () => {
    const loadEditor = vi.fn(async () => ({ default: TestDescriptionEditor }));
    const editorModule = createRetryableLazyModuleLoader(loadEditor);
    const task = {
      ...claimedTask(),
      descriptionText: "The agent is executing the documented migration steps.",
    };

    render(<TaskWorkspace {...props([task])} richTextEditorModuleLoader={editorModule} />);

    await waitForTaskDetail();

    const description = screen.getByLabelText("Task description");
    expect(description).toHaveProperty("textContent", task.descriptionText);
    expect(description.textContent).toBe(task.descriptionText);
    expect(screen.queryByRole("button", { name: "Edit description" })).toBeNull();
    expect(loadEditor).not.toHaveBeenCalled();
  });

  it.each([
    ["in_progress", "Agent execution is active"],
    ["review", "This task is awaiting review"],
    ["cancelled", "Cancelled tasks are read-only"],
  ] as const)("keeps %s task mutations read-only", async (lifecycle, explanation) => {
    const task: Task = { ...backlog, lifecycle };

    render(<TaskWorkspace {...props([task])} />);

    await waitForTaskDetail();

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
    expect(screen.queryByRole("button", { name: "Save draft" })).toBeNull();
    expect(screen.queryByRole("button", { name: "Move to ready" })).toBeNull();
    expect(screen.queryByRole("button", { name: "Done" })).toBeNull();
  });
});
