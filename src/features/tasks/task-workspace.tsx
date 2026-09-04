import {
  useEffect,
  useMemo,
  useState,
  type ComponentType,
  type CSSProperties,
  type FormEvent,
  type ReactNode,
} from "react";
import * as stylex from "@stylexjs/stylex";
import {
  Activity,
  Bot,
  CheckCircle2,
  Clock3,
  Inbox,
  Plus,
  ShipWheel,
  SlidersHorizontal,
} from "lucide-react";

import type {
  ActivityEntry,
  CreateHumanActivityEntryInput,
  CreateManualBlockerInput,
  ManualBlocker,
  ProjectEvent,
  ResolveManualBlockerInput,
  WithdrawActivityEntryInput,
} from "../../domain/activity";
import type { AgentRunSummary } from "../../domain/agents";
import type { SetTaskReviewModeOverrideInput } from "../../domain/customization";
import { type Project, type SetProjectReviewModeInput, type Theme } from "../../domain/projects";
import {
  emptyRichTextDocument,
  compareTaskOrder,
  type ApproveTaskReviewInput,
  type ArchiveTaskInput,
  type CancelTaskInput,
  type CreateTaskInput,
  type CreateTaskRelationInput,
  type InvalidateTaskClaimInput,
  type PrepareTaskInput,
  type ReopenTaskInput,
  type RequestTaskChangesInput,
  type RestoreCancelledTaskInput,
  type Task,
  type TaskAttemptSummary,
  type TaskClaim,
  type TaskLifecycle,
  type TaskTag,
  type UpdateTaskPlanningInput,
} from "../../domain/tasks";
import type { ProjectCommandResponse } from "../../server/project-adapter";
import type {
  ActivityEntryCommandResponse,
  ManualBlockerCommandResponse,
} from "../../server/activity-adapter";
import type {
  TaskCommandResponse,
  TaskLeaseCommandResponse,
  TaskRelationCommandResponse,
  TaskTransitionCommandResponse,
} from "../../server/task-adapter";
import {
  createRetryableLazyModuleLoader,
  type RetryableLazyModuleLoader,
} from "../../components/retryable-lazy-module";
import { useExplicitLazyModule } from "../../components/use-explicit-lazy-module";
import { tokens } from "../../styles/tokens.stylex";
import type { BulkTaskControlsProps } from "./bulk-task-controls";
import type {
  RichTextEditorModuleLoader,
  TaskCollaborationModuleLoader,
  TaskDetailPanelProps,
} from "./task-detail-panel";
import { useVisibleTaskSelection } from "./visible-task-selection";

const operationalDashboardModule = createRetryableLazyModuleLoader(() =>
  import("../dashboard/operational-dashboard").then(({ OperationalDashboard }) => ({
    default: OperationalDashboard,
  })),
);
const bulkTaskControlsModule = createRetryableLazyModuleLoader(() =>
  import("./bulk-task-controls").then(({ BulkTaskControls }) => ({ default: BulkTaskControls })),
);
const projectActivityFeedModule = createRetryableLazyModuleLoader(() =>
  import("../activity/project-activity-feed").then(({ ProjectActivityFeed }) => ({
    default: ProjectActivityFeed,
  })),
);
const projectReviewModeControlModule = createRetryableLazyModuleLoader(() =>
  import("../projects/project-review-mode-control").then(({ ProjectReviewModeControl }) => ({
    default: ProjectReviewModeControl,
  })),
);
const notificationCenterModule = createRetryableLazyModuleLoader(() =>
  import("../activity/notification-center").then(({ NotificationCenter }) => ({
    default: NotificationCenter,
  })),
);
const themeControlModule = createRetryableLazyModuleLoader(() =>
  import("../projects/theme-control").then(({ ThemeControl }) => ({ default: ThemeControl })),
);
const taskDetailPanelModule = createRetryableLazyModuleLoader(() =>
  import("./task-detail-panel").then(({ TaskDetailPanel }) => ({
    default: TaskDetailPanel,
  })),
);

type TaskDetailPanelModuleLoader = RetryableLazyModuleLoader<{
  default: ComponentType<TaskDetailPanelProps>;
}>;

type TaskWorkspaceProps = {
  project: Project;
  theme: Theme;
  tasks: readonly Task[];
  attempts: readonly TaskAttemptSummary[];
  tagDefinitions: readonly TaskTag[];
  activityEntries: readonly ActivityEntry[];
  manualBlockers: readonly ManualBlocker[];
  projectEvents: readonly ProjectEvent[];
  importantEvents?: readonly ProjectEvent[];
  activeAgentRuns?: readonly AgentRunSummary[];
  initialSelectedTaskId?: string | null;
  taskDetailModuleLoader?: TaskDetailPanelModuleLoader;
  dashboardModuleLoader?: typeof operationalDashboardModule;
  activityModuleLoader?: typeof projectActivityFeedModule;
  bulkModuleLoader?: typeof bulkTaskControlsModule;
  notificationsModuleLoader?: typeof notificationCenterModule;
  appearanceModuleLoader?: typeof themeControlModule;
  richTextEditorModuleLoader?: RichTextEditorModuleLoader;
  collaborationModuleLoader?: TaskCollaborationModuleLoader;
  liveStatus: "connecting" | "live" | "retrying";
  projectSwitcher?: { preload: () => void; surface: ReactNode };
  customizationControl?: ReactNode;
  portabilityControl?: ReactNode;
  renderSearchLink?: (props: { className?: string; style?: CSSProperties }) => ReactNode;
  onCreateTask: (input: CreateTaskInput) => Promise<TaskCommandResponse>;
  onPrepareTask: (input: PrepareTaskInput) => Promise<TaskCommandResponse>;
  onUpdateTaskPlanning: (input: UpdateTaskPlanningInput) => Promise<TaskCommandResponse>;
  onSetTaskReviewModeOverride: (
    input: SetTaskReviewModeOverrideInput,
  ) => Promise<TaskCommandResponse>;
  onApproveTaskReview: (input: ApproveTaskReviewInput) => Promise<TaskTransitionCommandResponse>;
  onRequestTaskChanges: (input: RequestTaskChangesInput) => Promise<TaskTransitionCommandResponse>;
  onCancelTask: (input: CancelTaskInput) => Promise<TaskTransitionCommandResponse>;
  onRestoreCancelledTask: (
    input: RestoreCancelledTaskInput,
  ) => Promise<TaskTransitionCommandResponse>;
  onReopenTask: (input: ReopenTaskInput) => Promise<TaskTransitionCommandResponse>;
  onCreateTaskRelation: (input: CreateTaskRelationInput) => Promise<TaskRelationCommandResponse>;
  onArchiveTask: (input: ArchiveTaskInput) => Promise<TaskCommandResponse>;
  onInvalidateClaim: (input: InvalidateTaskClaimInput) => Promise<TaskLeaseCommandResponse>;
  onCreateActivityEntry: (
    input: CreateHumanActivityEntryInput,
  ) => Promise<ActivityEntryCommandResponse>;
  onWithdrawActivityEntry: (
    input: WithdrawActivityEntryInput,
  ) => Promise<ActivityEntryCommandResponse>;
  onCreateManualBlocker: (input: CreateManualBlockerInput) => Promise<ManualBlockerCommandResponse>;
  onResolveManualBlocker: (
    input: ResolveManualBlockerInput,
  ) => Promise<ManualBlockerCommandResponse>;
  onPreviewBulkTasks: BulkTaskControlsProps["onPreview"];
  onExecuteBulkTasks: BulkTaskControlsProps["onExecute"];
  onChangeTheme: (theme: Theme) => Promise<void>;
  onChangeProjectReviewMode: (input: SetProjectReviewModeInput) => Promise<ProjectCommandResponse>;
};

const noActiveAgentRuns: readonly AgentRunSummary[] = [];

export function TaskWorkspace({
  project,
  theme,
  tasks,
  attempts,
  tagDefinitions,
  activityEntries,
  manualBlockers,
  projectEvents,
  importantEvents = projectEvents,
  activeAgentRuns = noActiveAgentRuns,
  initialSelectedTaskId = null,
  taskDetailModuleLoader = taskDetailPanelModule,
  dashboardModuleLoader = operationalDashboardModule,
  activityModuleLoader = projectActivityFeedModule,
  bulkModuleLoader = bulkTaskControlsModule,
  notificationsModuleLoader = notificationCenterModule,
  appearanceModuleLoader = themeControlModule,
  richTextEditorModuleLoader,
  collaborationModuleLoader,
  liveStatus,
  projectSwitcher,
  customizationControl,
  portabilityControl,
  renderSearchLink,
  onCreateTask,
  onPrepareTask,
  onUpdateTaskPlanning,
  onSetTaskReviewModeOverride,
  onApproveTaskReview,
  onRequestTaskChanges,
  onCancelTask,
  onRestoreCancelledTask,
  onReopenTask,
  onCreateTaskRelation,
  onArchiveTask,
  onInvalidateClaim,
  onCreateActivityEntry,
  onWithdrawActivityEntry,
  onCreateManualBlocker,
  onResolveManualBlocker,
  onPreviewBulkTasks,
  onExecuteBulkTasks,
  onChangeTheme,
  onChangeProjectReviewMode,
}: TaskWorkspaceProps) {
  const orderedTasks = useMemo(() => tasks.toSorted(compareTaskOrder), [tasks]);
  const [captureTitle, setCaptureTitle] = useState("");
  const [workspaceView, setWorkspaceView] = useState<
    "dashboard" | "tasks" | "activity" | "settings"
  >("tasks");
  const [selectedId, setSelectedId] = useState<string | null>(() =>
    orderedTasks.some((task) => task.id === initialSelectedTaskId) ? initialSelectedTaskId : null,
  );
  const [bulkSelectedTaskIds, setBulkSelectedTaskIds] = useState<ReadonlySet<string>>(
    () => new Set(),
  );
  const [projectSwitcherRequested, setProjectSwitcherRequested] = useState(false);
  const [pendingCapture, setPendingCapture] = useState(false);
  const [captureError, setCaptureError] = useState<string | null>(null);
  const selectedTask = orderedTasks.find((task) => task.id === selectedId) ?? null;
  const visibleTaskIds = useMemo(() => orderedTasks.map((task) => task.id), [orderedTasks]);
  const bulkSelection = useVisibleTaskSelection({
    visibleTaskIds,
    selectedTaskIds: bulkSelectedTaskIds,
    onSelectedTaskIdsChange: setBulkSelectedTaskIds,
  });
  const dashboardModule = useExplicitLazyModule(dashboardModuleLoader);
  const activityModule = useExplicitLazyModule(activityModuleLoader);
  const bulkModule = useExplicitLazyModule(bulkModuleLoader);
  const reviewPolicyModule = useExplicitLazyModule(projectReviewModeControlModule);
  const notificationsModule = useExplicitLazyModule(notificationsModuleLoader);
  const appearanceModule = useExplicitLazyModule(appearanceModuleLoader);
  const taskDetailModule = useExplicitLazyModule(taskDetailModuleLoader);
  const bulkMode = bulkModule.state.status !== "idle";
  const taskDetailStatus = taskDetailModule.state.status;
  const activateTaskDetail = taskDetailModule.activate;
  useEffect(() => {
    if (
      initialSelectedTaskId &&
      selectedId === initialSelectedTaskId &&
      taskDetailStatus === "idle"
    ) {
      activateTaskDetail();
    }
  }, [activateTaskDetail, initialSelectedTaskId, selectedId, taskDetailStatus]);
  const counts = useMemo(
    () => ({
      backlog: tasks.filter((task) => task.lifecycle === "backlog").length,
      ready: tasks.filter((task) => task.lifecycle === "ready").length,
      active: tasks.filter((task) => task.lifecycle === "in_progress").length,
      review: tasks.filter((task) => task.lifecycle === "review").length,
      done: tasks.filter((task) => task.lifecycle === "done").length,
      claimable: tasks.filter((task) => task.eligibility?.claimable).length,
    }),
    [tasks],
  );
  const notificationIntentLabel = importantEvents.some((event) => event.importance !== "routine")
    ? "Notifications, attention available"
    : "Notifications, none unread";

  function selectTask(taskId: string) {
    setSelectedId(taskId);
    setWorkspaceView("tasks");
    if (taskDetailModule.state.status === "idle") taskDetailModule.activate();
  }

  async function capture(event: FormEvent<HTMLFormElement>) {
    event.preventDefault();
    setPendingCapture(true);
    setCaptureError(null);
    try {
      const response = await onCreateTask({
        projectId: project.id,
        parentTaskId: null,
        lifecycle: "backlog",
        title: captureTitle,
        description: emptyRichTextDocument,
        expectedOutcome: "",
        acceptanceCriteria: "",
        agentContext: "",
        checklist: [],
        referencedPaths: [],
        expectedVersion: 0,
        idempotencyKey: crypto.randomUUID(),
      });
      if (response.ok) {
        setCaptureTitle("");
        selectTask(response.task.id);
      } else {
        setCaptureError(response.error.message);
      }
    } catch {
      setCaptureError("Helm could not capture the task.");
    } finally {
      setPendingCapture(false);
    }
  }

  return (
    <main {...stylex.props(styles.page)}>
      <header {...stylex.props(styles.header)}>
        <div {...stylex.props(styles.brand)}>
          <span {...stylex.props(styles.mark)} aria-hidden="true">
            <ShipWheel size={16} />
          </span>
          <div>
            <strong>Helm</strong>
            <span {...stylex.props(styles.projectName)}>{project.name}</span>
          </div>
        </div>
        <nav aria-label="Workspace views" {...stylex.props(styles.viewNavigation)}>
          <button
            type="button"
            aria-pressed={workspaceView === "dashboard"}
            onFocus={dashboardModule.preload}
            onPointerEnter={dashboardModule.preload}
            onClick={() => {
              setWorkspaceView("dashboard");
              if (dashboardModule.state.status === "idle") dashboardModule.activate();
            }}
            {...stylex.props(
              styles.viewButton,
              workspaceView === "dashboard" && styles.viewButtonActive,
            )}
          >
            Dashboard
          </button>
          <button
            type="button"
            aria-pressed={workspaceView === "tasks"}
            onClick={() => setWorkspaceView("tasks")}
            {...stylex.props(
              styles.viewButton,
              workspaceView === "tasks" && styles.viewButtonActive,
            )}
          >
            Tasks
          </button>
          <button
            type="button"
            aria-pressed={workspaceView === "activity"}
            onFocus={activityModule.preload}
            onPointerEnter={activityModule.preload}
            onClick={() => {
              setWorkspaceView("activity");
              if (activityModule.state.status === "idle") activityModule.activate();
            }}
            {...stylex.props(
              styles.viewButton,
              workspaceView === "activity" && styles.viewButtonActive,
            )}
          >
            Activity
          </button>
          {customizationControl || portabilityControl ? (
            <button
              type="button"
              aria-pressed={workspaceView === "settings"}
              onFocus={reviewPolicyModule.preload}
              onPointerEnter={reviewPolicyModule.preload}
              onClick={() => {
                setWorkspaceView("settings");
                if (reviewPolicyModule.state.status === "idle") reviewPolicyModule.activate();
              }}
              {...stylex.props(
                styles.viewButton,
                workspaceView === "settings" && styles.viewButtonActive,
              )}
            >
              Settings
            </button>
          ) : null}
          {renderSearchLink?.(stylex.props(styles.viewButton, styles.viewLink))}
        </nav>
        <div {...stylex.props(styles.headerUtilities)}>
          <span
            aria-live="polite"
            {...stylex.props(styles.liveStatus, liveStatus === "live" && styles.liveStatusReady)}
          >
            <span {...stylex.props(styles.liveDot)} aria-hidden="true" />
            {liveStatus === "live"
              ? "Live"
              : liveStatus === "retrying"
                ? "Reconnecting"
                : "Connecting"}
          </span>
          <button
            type="button"
            aria-controls="workspace-notifications"
            aria-disabled={
              notificationsModule.state.status === "loading" ||
              notificationsModule.state.status === "ready"
            }
            aria-expanded={notificationsModule.state.status === "ready"}
            aria-label={notificationIntentLabel}
            onFocus={notificationsModule.preload}
            onPointerEnter={notificationsModule.preload}
            onClick={() => {
              if (notificationsModule.state.status === "idle") notificationsModule.activate();
              if (notificationsModule.state.status === "error") notificationsModule.retry();
            }}
            {...stylex.props(styles.utilityButton)}
          >
            Notifications
          </button>
          <div id="workspace-notifications">
            {notificationsModule.state.status === "ready" ? (
              <notificationsModule.state.module.default
                projectId={project.id}
                events={importantEvents}
                tasks={orderedTasks}
                onSelectTask={selectTask}
              />
            ) : notificationsModule.state.status === "error" ? (
              <LazyWorkspaceFailure surface="notifications" onRetry={notificationsModule.retry} />
            ) : notificationsModule.state.status === "loading" ? (
              <LazyWorkspaceFallback surface="notifications" />
            ) : null}
          </div>
          <button
            type="button"
            aria-controls="workspace-appearance"
            aria-disabled={
              appearanceModule.state.status === "loading" ||
              appearanceModule.state.status === "ready"
            }
            aria-expanded={appearanceModule.state.status === "ready"}
            onFocus={appearanceModule.preload}
            onPointerEnter={appearanceModule.preload}
            onClick={() => {
              if (appearanceModule.state.status === "idle") appearanceModule.activate();
              if (appearanceModule.state.status === "error") appearanceModule.retry();
            }}
            {...stylex.props(styles.utilityButton)}
          >
            Appearance
          </button>
          <div id="workspace-appearance">
            {appearanceModule.state.status === "ready" ? (
              <appearanceModule.state.module.default theme={theme} onChange={onChangeTheme} />
            ) : appearanceModule.state.status === "error" ? (
              <LazyWorkspaceFailure surface="appearance" onRetry={appearanceModule.retry} />
            ) : appearanceModule.state.status === "loading" ? (
              <LazyWorkspaceFallback surface="appearance" />
            ) : null}
          </div>
        </div>
      </header>

      {projectSwitcher ? (
        <div {...stylex.props(styles.projectToolbar)}>
          <button
            type="button"
            aria-disabled={projectSwitcherRequested}
            aria-expanded={projectSwitcherRequested}
            onFocus={projectSwitcher.preload}
            onPointerEnter={projectSwitcher.preload}
            onClick={() => {
              if (!projectSwitcherRequested) setProjectSwitcherRequested(true);
            }}
            {...stylex.props(styles.intentButton)}
          >
            Switch project
          </button>
          {projectSwitcherRequested ? projectSwitcher.surface : null}
        </div>
      ) : null}

      <div
        {...stylex.props(styles.workspace, workspaceView !== "tasks" && styles.workspaceOverview)}
      >
        {workspaceView === "tasks" ? (
          <aside {...stylex.props(styles.sidebar)}>
            <div {...stylex.props(styles.queueHeader)}>
              <div>
                <p {...stylex.props(styles.eyebrow)}>Work queue</p>
                <h1 {...stylex.props(styles.heading)}>Tasks</h1>
              </div>
              <span {...stylex.props(styles.total)}>{orderedTasks.length}</span>
            </div>
            <section aria-label="Task counts" {...stylex.props(styles.counts)}>
              <span>
                <Inbox size={14} aria-hidden="true" /> {counts.backlog} backlog
              </span>
              <span>
                <CheckCircle2 size={14} aria-hidden="true" /> {counts.ready} ready
              </span>
              <span>
                <Activity size={14} aria-hidden="true" /> {counts.active} active
              </span>
              <span>
                <Clock3 size={14} aria-hidden="true" /> {counts.review} review
              </span>
              <span>
                <CheckCircle2 size={14} aria-hidden="true" /> {counts.done} done
              </span>
              <span>
                <SlidersHorizontal size={14} aria-hidden="true" /> {counts.claimable} claimable
              </span>
            </section>
            <form onSubmit={capture} {...stylex.props(styles.capture)} aria-label="Quick capture">
              <label htmlFor="capture-title" {...stylex.props(styles.srOnly)}>
                Task title
              </label>
              <input
                id="capture-title"
                value={captureTitle}
                onChange={(event) => setCaptureTitle(event.target.value)}
                placeholder="Capture a task…"
                maxLength={300}
                required
                {...stylex.props(styles.input)}
              />
              <button
                type="submit"
                aria-label="Add backlog task"
                disabled={pendingCapture || captureTitle.trim().length === 0}
                {...stylex.props(styles.button, styles.iconButton)}
              >
                <Plus size={17} aria-hidden="true" />
              </button>
            </form>
            {captureError ? (
              <p role="alert" {...stylex.props(styles.error)}>
                {captureError}
              </p>
            ) : null}
            <button
              type="button"
              aria-controls="workspace-bulk-actions"
              aria-disabled={
                bulkModule.state.status === "loading" || bulkModule.state.status === "ready"
              }
              aria-expanded={bulkModule.state.status === "ready"}
              onFocus={bulkModule.preload}
              onPointerEnter={bulkModule.preload}
              onClick={() => {
                if (bulkModule.state.status === "idle") bulkModule.activate();
                if (bulkModule.state.status === "error") bulkModule.retry();
              }}
              {...stylex.props(styles.intentButton)}
            >
              Bulk actions
            </button>
            <div id="workspace-bulk-actions">
              {bulkModule.state.status === "ready" ? (
                <bulkModule.state.module.default
                  projectId={project.id}
                  tagDefinitions={tagDefinitions}
                  selection={bulkSelection}
                  onPreview={onPreviewBulkTasks}
                  onExecute={onExecuteBulkTasks}
                />
              ) : bulkModule.state.status === "error" ? (
                <LazyWorkspaceFailure surface="bulk" onRetry={bulkModule.retry} />
              ) : bulkModule.state.status === "loading" ? (
                <LazyWorkspaceFallback surface="bulk" />
              ) : null}
            </div>
            <ul aria-label="Tasks" {...stylex.props(styles.taskList)}>
              {orderedTasks.map((task) => (
                <li
                  key={task.id}
                  {...stylex.props(
                    styles.taskRow,
                    bulkMode && styles.taskRowBulkMode,
                    bulkSelection.isTaskSelected(task.id) && styles.taskRowBulkSelected,
                    task.id === selectedTask?.id && styles.taskRowSelected,
                  )}
                >
                  {bulkMode ? (
                    <input
                      type="checkbox"
                      aria-label={`Select task #${task.sequence}: ${task.title}`}
                      aria-checked={bulkSelection.isTaskSelected(task.id)}
                      checked={bulkSelection.isTaskSelected(task.id)}
                      onChange={(event) =>
                        bulkSelection.setTaskSelected(task.id, event.target.checked)
                      }
                      {...stylex.props(styles.bulkCheckbox)}
                    />
                  ) : null}
                  <button
                    type="button"
                    onFocus={taskDetailModule.preload}
                    onPointerEnter={taskDetailModule.preload}
                    onClick={() => selectTask(task.id)}
                    aria-current={task.id === selectedTask?.id ? "true" : undefined}
                    aria-label={`Open task #${task.sequence}: ${task.title}`}
                    {...stylex.props(styles.taskDetailButton)}
                  >
                    <span {...stylex.props(styles.taskReference)}>#{task.sequence}</span>
                    <span {...stylex.props(styles.taskTitleGroup)}>
                      <span {...stylex.props(styles.taskTitle)}>{task.title}</span>
                      <span {...stylex.props(styles.taskMeta)}>
                        {[
                          task.priority,
                          task.dueAt ? `due ${task.dueAt}` : null,
                          task.size ? `size ${task.size}` : null,
                        ]
                          .filter(Boolean)
                          .join(" · ")}
                      </span>
                      {task.claim ? <ClaimLeaseSummary claim={task.claim} compact /> : null}
                    </span>
                    <span {...stylex.props(styles[task.lifecycle])}>
                      {taskLifecycleLabel(task.lifecycle)}
                    </span>
                    {task.eligibility ? (
                      <span {...stylex.props(styles.eligibility)}>{task.eligibility.status}</span>
                    ) : null}
                  </button>
                </li>
              ))}
            </ul>
          </aside>
        ) : null}

        <section
          data-task-detail={workspaceView === "tasks" ? "true" : undefined}
          {...stylex.props(styles.detail, workspaceView !== "tasks" && styles.overviewDetail)}
        >
          {workspaceView === "settings" ? (
            <div {...stylex.props(styles.detailStack, styles.settingsStack)}>
              {reviewPolicyModule.state.status === "ready" ? (
                <reviewPolicyModule.state.module.default
                  key={`settings:${project.id}:${project.version}`}
                  project={project}
                  onChange={onChangeProjectReviewMode}
                />
              ) : reviewPolicyModule.state.status === "error" ? (
                <LazyWorkspaceFailure surface="reviewPolicy" onRetry={reviewPolicyModule.retry} />
              ) : (
                <LazyWorkspaceFallback surface="reviewPolicy" />
              )}
              {customizationControl}
              {portabilityControl}
            </div>
          ) : workspaceView === "dashboard" ? (
            dashboardModule.state.status === "ready" ? (
              <dashboardModule.state.module.default
                tasks={orderedTasks}
                attempts={attempts}
                events={projectEvents}
                activeAgentRuns={activeAgentRuns}
                onSelectTask={selectTask}
              />
            ) : dashboardModule.state.status === "error" ? (
              <LazyWorkspaceFailure surface="dashboard" onRetry={dashboardModule.retry} />
            ) : (
              <LazyWorkspaceFallback surface="dashboard" />
            )
          ) : workspaceView === "activity" ? (
            activityModule.state.status === "ready" ? (
              <activityModule.state.module.default
                events={projectEvents}
                tasks={orderedTasks}
                entries={activityEntries}
                attempts={attempts}
              />
            ) : activityModule.state.status === "error" ? (
              <LazyWorkspaceFailure surface="activity" onRetry={activityModule.retry} />
            ) : (
              <LazyWorkspaceFallback surface="activity" />
            )
          ) : selectedTask ? (
            <div {...stylex.props(styles.detailStack)}>
              {taskDetailModule.state.status === "ready" ? (
                <taskDetailModule.state.module.default
                  key={`${selectedTask.id}:${selectedTask.version}`}
                  task={selectedTask}
                  tasks={orderedTasks}
                  attempts={attempts}
                  tagDefinitions={tagDefinitions}
                  activityEntries={activityEntries}
                  manualBlockers={manualBlockers}
                  richTextEditorModuleLoader={richTextEditorModuleLoader}
                  collaborationModuleLoader={collaborationModuleLoader}
                  onApproveReview={onApproveTaskReview}
                  onRequestChanges={onRequestTaskChanges}
                  onCancelTask={onCancelTask}
                  onRestoreTask={onRestoreCancelledTask}
                  onReopenTask={onReopenTask}
                  onCreateTask={onCreateTask}
                  onPrepare={onPrepareTask}
                  onUpdatePlanning={onUpdateTaskPlanning}
                  onSetReviewModeOverride={onSetTaskReviewModeOverride}
                  onCreateRelation={onCreateTaskRelation}
                  onArchive={onArchiveTask}
                  onInvalidateClaim={onInvalidateClaim}
                  onCreateActivityEntry={onCreateActivityEntry}
                  onWithdrawActivityEntry={onWithdrawActivityEntry}
                  onCreateManualBlocker={onCreateManualBlocker}
                  onResolveManualBlocker={onResolveManualBlocker}
                />
              ) : (
                <>
                  <TaskDetailReadingSummary task={selectedTask} />
                  {taskDetailModule.state.status === "error" ? (
                    <LazyWorkspaceFailure surface="taskDetail" onRetry={taskDetailModule.retry} />
                  ) : (
                    <LazyWorkspaceFallback surface="taskDetail" />
                  )}
                </>
              )}
            </div>
          ) : (
            <div {...stylex.props(styles.empty)}>
              <Inbox size={32} aria-hidden="true" />
              <h2>{orderedTasks.length === 0 ? "Capture the first task" : "Select a task"}</h2>
              <p>
                {orderedTasks.length === 0
                  ? "A title is enough. Preparation can happen when the work is understood."
                  : "Choose a task from the work queue to read its details or make changes."}
              </p>
            </div>
          )}
        </section>
      </div>
    </main>
  );
}

function TaskDetailReadingSummary({ task }: { task: Task }) {
  return (
    <article aria-label={`Task #${task.sequence} summary`} {...stylex.props(styles.readingSummary)}>
      <header {...stylex.props(styles.readingSummaryHeader)}>
        <div>
          <p {...stylex.props(styles.eyebrow)}>Task #{task.sequence}</p>
          <h2 {...stylex.props(styles.readingSummaryTitle)}>{task.title}</h2>
        </div>
        <span {...stylex.props(styles.readingSummaryMeta)}>
          {task.priority} · {taskLifecycleLabel(task.lifecycle)}
        </span>
      </header>
      <section aria-labelledby={`task-reading-description-${task.id}`}>
        <h3 id={`task-reading-description-${task.id}`} {...stylex.props(styles.readingFieldTitle)}>
          Description
        </h3>
        <p aria-label="Task description" {...stylex.props(styles.readingText)}>
          {task.descriptionText || "No description has been added."}
        </p>
      </section>
      {task.expectedOutcome ? (
        <section>
          <h3 {...stylex.props(styles.readingFieldTitle)}>Expected outcome</h3>
          <p {...stylex.props(styles.readingText)}>{task.expectedOutcome}</p>
        </section>
      ) : null}
      {task.acceptanceCriteria ? (
        <section>
          <h3 {...stylex.props(styles.readingFieldTitle)}>Acceptance criteria</h3>
          <p {...stylex.props(styles.readingText)}>{task.acceptanceCriteria}</p>
        </section>
      ) : null}
      {task.checklist.length > 0 ? (
        <section>
          <h3 {...stylex.props(styles.readingFieldTitle)}>Checklist</h3>
          <ul {...stylex.props(styles.readingChecklist)}>
            {task.checklist.map((item) => (
              <li key={item.id}>{item.text}</li>
            ))}
          </ul>
        </section>
      ) : null}
    </article>
  );
}

type LazyWorkspaceSurface =
  | "activity"
  | "appearance"
  | "bulk"
  | "dashboard"
  | "notifications"
  | "reviewPolicy"
  | "taskDetail";

const lazyWorkspaceLabels = {
  activity: "Loading project activity",
  appearance: "Loading appearance control",
  bulk: "Loading bulk controls",
  dashboard: "Loading dashboard",
  notifications: "Loading notifications",
  reviewPolicy: "Loading review policy",
  taskDetail: "Loading task details",
} as const satisfies Record<LazyWorkspaceSurface, string>;

function LazyWorkspaceFallback({ surface }: { surface: LazyWorkspaceSurface }) {
  const label = lazyWorkspaceLabels[surface];
  return (
    <output
      aria-live="polite"
      aria-label={label}
      {...stylex.props(
        styles.lazyFallback,
        surface === "activity" && styles.activityFallback,
        surface === "appearance" && styles.utilityFallback,
        surface === "bulk" && styles.bulkFallback,
        surface === "dashboard" && styles.dashboardFallback,
        surface === "notifications" && styles.utilityFallback,
        surface === "reviewPolicy" && styles.reviewPolicyFallback,
        surface === "taskDetail" && styles.taskDetailFallback,
      )}
    >
      {label}…
    </output>
  );
}

function LazyWorkspaceFailure({
  surface,
  onRetry,
}: {
  surface: LazyWorkspaceSurface;
  onRetry: () => void;
}) {
  const label = lazyWorkspaceLabels[surface].replace("Loading ", "");
  return (
    <section
      role="alert"
      aria-label={`${label} unavailable`}
      {...stylex.props(
        styles.lazyFallback,
        styles.lazyFailure,
        surface === "activity" && styles.activityFallback,
        surface === "appearance" && styles.utilityFallback,
        surface === "bulk" && styles.bulkFallback,
        surface === "dashboard" && styles.dashboardFallback,
        surface === "notifications" && styles.utilityFallback,
        surface === "reviewPolicy" && styles.reviewPolicyFallback,
        surface === "taskDetail" && styles.taskDetailFallback,
      )}
    >
      <span>{label} could not load.</span>
      <button type="button" onClick={onRetry} {...stylex.props(styles.button, styles.buttonQuiet)}>
        Retry
      </button>
    </section>
  );
}

function taskLifecycleLabel(lifecycle: TaskLifecycle) {
  return lifecycle === "in_progress" ? "in progress" : lifecycle;
}

function formatClaimExpiry(value: string) {
  const date = new Date(value);
  if (Number.isNaN(date.getTime())) return value;
  return new Intl.DateTimeFormat(undefined, {
    dateStyle: "medium",
    timeStyle: "short",
  }).format(date);
}

function ClaimLeaseSummary({ claim, compact = false }: { claim: TaskClaim; compact?: boolean }) {
  return (
    <span {...stylex.props(styles.claimSummary, compact && styles.claimSummaryCompact)}>
      {compact ? <Bot size={12} aria-hidden="true" /> : <Bot size={18} aria-hidden="true" />}
      <span>
        Claimed by <strong>{claim.agentDisplayName}</strong>
        <span aria-hidden="true"> · </span>
        <span {...stylex.props(styles.claimExpiry)}>
          <Clock3 size={compact ? 11 : 14} aria-hidden="true" /> Lease expires{" "}
          <time dateTime={claim.expiresAt} title={claim.expiresAt}>
            {formatClaimExpiry(claim.expiresAt)}
          </time>
        </span>
      </span>
    </span>
  );
}

const styles = stylex.create({
  page: { minHeight: "100vh" },
  lazyFallback: {
    alignItems: "center",
    backgroundColor: tokens.surfaceMuted,
    borderColor: tokens.border,
    borderRadius: tokens.radius2,
    borderStyle: "solid",
    borderWidth: 1,
    color: tokens.foregroundMuted,
    display: "flex",
    fontSize: 13,
    justifyContent: "center",
    padding: tokens.space4,
    width: "100%",
  },
  lazyFailure: { flexDirection: "column", gap: tokens.space3 },
  activityFallback: { minHeight: 420 },
  bulkFallback: { minHeight: 44 },
  dashboardFallback: { minHeight: 520 },
  reviewPolicyFallback: { minHeight: 84 },
  taskDetailFallback: { minHeight: 160 },
  utilityFallback: { minHeight: 36, minWidth: 112, padding: tokens.space2, width: "auto" },
  header: {
    alignItems: "center",
    borderBlockEndColor: tokens.border,
    borderBlockEndStyle: "solid",
    borderBlockEndWidth: 1,
    display: "flex",
    justifyContent: "space-between",
    minHeight: 64,
    paddingInline: tokens.space6,
    "@media (max-width: 900px)": {
      flexWrap: "wrap",
      gap: tokens.space3,
      paddingBlock: tokens.space3,
    },
  },
  projectToolbar: {
    borderBlockEndColor: tokens.border,
    borderBlockEndStyle: "solid",
    borderBlockEndWidth: 1,
    paddingBlock: tokens.space3,
    paddingInline: tokens.space6,
    "@media (max-width: 600px)": { paddingInline: tokens.space4 },
  },
  brand: { alignItems: "center", display: "flex", gap: tokens.space3 },
  mark: {
    alignItems: "center",
    backgroundColor: tokens.foreground,
    borderRadius: 7,
    color: tokens.background,
    display: "inline-flex",
    height: 30,
    justifyContent: "center",
    width: 30,
  },
  projectName: { color: tokens.foregroundMuted, fontSize: 12, marginInlineStart: tokens.space2 },
  viewNavigation: {
    backgroundColor: tokens.surfaceMuted,
    borderRadius: tokens.radius2,
    display: "flex",
    gap: tokens.space1,
    padding: tokens.space1,
    overflowX: "auto",
    maxWidth: "100%",
  },
  headerUtilities: {
    alignItems: "center",
    display: "flex",
    gap: tokens.space3,
  },
  button: {
    alignItems: "center",
    backgroundColor: tokens.accent,
    borderColor: tokens.accent,
    borderRadius: tokens.radius2,
    borderStyle: "solid",
    borderWidth: 1,
    color: tokens.background,
    cursor: "pointer",
    display: "inline-flex",
    font: "inherit",
    fontSize: 14,
    fontWeight: 650,
    gap: tokens.space2,
    justifyContent: "center",
    minHeight: 36,
    paddingInline: tokens.space4,
    ":disabled": { cursor: "not-allowed", opacity: 0.45 },
    ":focus-visible": {
      outlineColor: tokens.accent,
      outlineOffset: 2,
      outlineStyle: "solid",
      outlineWidth: 2,
    },
  },
  buttonQuiet: {
    backgroundColor: tokens.surface,
    borderColor: tokens.border,
    color: tokens.foreground,
    ":hover": { borderColor: tokens.accent },
  },
  iconButton: { paddingInline: tokens.space3 },
  intentButton: {
    backgroundColor: tokens.surface,
    borderColor: tokens.border,
    borderRadius: tokens.radius2,
    borderStyle: "solid",
    borderWidth: 1,
    color: tokens.foreground,
    cursor: "pointer",
    font: "inherit",
    fontSize: 13,
    fontWeight: 650,
    minHeight: 40,
    paddingInline: tokens.space3,
    ":hover": { borderColor: tokens.accent },
    ":focus-visible": {
      outlineColor: tokens.accent,
      outlineOffset: 2,
      outlineStyle: "solid",
      outlineWidth: 2,
    },
  },
  utilityButton: {
    backgroundColor: tokens.surface,
    borderColor: tokens.border,
    borderRadius: tokens.radius2,
    borderStyle: "solid",
    borderWidth: 1,
    color: tokens.foreground,
    cursor: "pointer",
    font: "inherit",
    fontSize: 12,
    minHeight: 36,
    paddingInline: tokens.space3,
    ":hover": { borderColor: tokens.accent },
    ":focus-visible": {
      outlineColor: tokens.accent,
      outlineOffset: 2,
      outlineStyle: "solid",
      outlineWidth: 2,
    },
  },
  viewButton: {
    backgroundColor: "transparent",
    borderColor: "transparent",
    borderRadius: 6,
    borderStyle: "solid",
    borderWidth: 1,
    color: tokens.foregroundMuted,
    cursor: "pointer",
    font: "inherit",
    fontSize: 13,
    fontWeight: 650,
    minHeight: 30,
    paddingInline: tokens.space3,
    ":focus-visible": {
      outlineColor: tokens.accent,
      outlineOffset: 1,
      outlineStyle: "solid",
      outlineWidth: 2,
    },
  },
  viewButtonActive: {
    backgroundColor: tokens.surface,
    borderColor: tokens.border,
    color: tokens.foreground,
  },
  viewLink: { textDecoration: "none" },
  liveStatus: {
    alignItems: "center",
    color: tokens.foregroundMuted,
    display: "inline-flex",
    fontSize: 12,
    gap: tokens.space2,
  },
  liveStatusReady: { color: tokens.accent },
  liveDot: {
    backgroundColor: "currentColor",
    borderRadius: "50%",
    height: 7,
    width: 7,
  },
  workspace: {
    display: "grid",
    gridTemplateColumns: "minmax(300px, 380px) minmax(0, 1fr)",
    minHeight: "calc(100vh - 65px)",
    "@media (max-width: 760px)": { gridTemplateColumns: "1fr" },
  },
  workspaceOverview: { gridTemplateColumns: "minmax(0, 1fr)" },
  sidebar: {
    borderInlineEndColor: tokens.border,
    borderInlineEndStyle: "solid",
    borderInlineEndWidth: 1,
    padding: tokens.space5,
    "@media (max-width: 760px)": {
      borderInlineEndWidth: 0,
      borderBlockStartColor: tokens.border,
      borderBlockStartStyle: "solid",
      borderBlockStartWidth: 1,
      order: 2,
    },
  },
  queueHeader: { alignItems: "end", display: "flex", justifyContent: "space-between" },
  eyebrow: {
    color: tokens.accent,
    fontSize: 11,
    fontWeight: 750,
    letterSpacing: "0.09em",
    margin: 0,
    textTransform: "uppercase",
  },
  heading: { fontSize: 28, letterSpacing: "-0.04em", marginBlock: tokens.space1 },
  total: { color: tokens.foregroundMuted, fontSize: 13 },
  counts: {
    color: tokens.foregroundMuted,
    display: "flex",
    flexWrap: "wrap",
    fontSize: 12,
    gap: tokens.space4,
    marginBlock: tokens.space4,
  },
  capture: { display: "flex", gap: tokens.space2 },
  input: {
    backgroundColor: tokens.background,
    borderColor: tokens.border,
    borderRadius: tokens.radius2,
    borderStyle: "solid",
    borderWidth: 1,
    color: tokens.foreground,
    minHeight: 40,
    paddingInline: tokens.space3,
    width: "100%",
    ":focus": { borderColor: tokens.accent, outline: "none" },
  },
  taskList: {
    display: "grid",
    gap: tokens.space1,
    listStyle: "none",
    marginBlockStart: tokens.space5,
    padding: 0,
  },
  taskRow: {
    alignItems: "center",
    backgroundColor: "transparent",
    borderColor: "transparent",
    borderRadius: tokens.radius2,
    borderStyle: "solid",
    borderWidth: 1,
    color: tokens.foreground,
    display: "grid",
    gap: tokens.space2,
    gridTemplateColumns: "minmax(0, 1fr)",
    minHeight: 58,
    paddingInlineStart: tokens.space2,
  },
  taskRowBulkMode: { gridTemplateColumns: "18px minmax(0, 1fr)" },
  taskRowBulkSelected: { backgroundColor: tokens.surfaceMuted, borderColor: tokens.border },
  taskRowSelected: { backgroundColor: tokens.surface, borderColor: tokens.accent },
  taskDetailButton: {
    alignItems: "center",
    backgroundColor: "transparent",
    borderWidth: 0,
    color: tokens.foreground,
    cursor: "pointer",
    display: "grid",
    font: "inherit",
    gap: tokens.space2,
    gridTemplateColumns: "32px minmax(0, 1fr) auto",
    minHeight: 56,
    paddingInline: tokens.space1,
    textAlign: "start",
    width: "100%",
    ":hover": { backgroundColor: tokens.surfaceMuted },
    ":focus-visible": {
      outlineColor: tokens.accent,
      outlineOffset: -2,
      outlineStyle: "solid",
      outlineWidth: 2,
    },
  },
  taskReference: { color: tokens.foregroundMuted, fontSize: 11 },
  taskTitleGroup: { display: "grid", gap: 2, minWidth: 0 },
  taskTitle: {
    fontSize: 13,
    fontWeight: 650,
    overflow: "hidden",
    textOverflow: "ellipsis",
    whiteSpace: "nowrap",
  },
  taskMeta: {
    color: tokens.foregroundMuted,
    fontSize: 11,
    overflow: "hidden",
    textOverflow: "ellipsis",
    whiteSpace: "nowrap",
  },
  bulkCheckbox: {
    accentColor: tokens.accent,
    cursor: "pointer",
    height: 18,
    margin: 0,
    width: 18,
    ":focus-visible": {
      outlineColor: tokens.accent,
      outlineOffset: 2,
      outlineStyle: "solid",
      outlineWidth: 2,
    },
  },
  claimSummary: {
    alignItems: "center",
    color: tokens.foreground,
    display: "flex",
    fontSize: 13,
    gap: tokens.space2,
    lineHeight: 1.5,
  },
  claimSummaryCompact: {
    color: tokens.foregroundMuted,
    fontSize: 11,
    gap: tokens.space1,
  },
  claimExpiry: {
    alignItems: "center",
    color: tokens.foregroundMuted,
    display: "inline-flex",
    gap: tokens.space1,
  },
  backlog: { color: tokens.foregroundMuted, fontSize: 10, textTransform: "uppercase" },
  ready: { color: tokens.accent, fontSize: 10, fontWeight: 750, textTransform: "uppercase" },
  in_progress: {
    color: tokens.accent,
    fontSize: 10,
    fontWeight: 750,
    textTransform: "uppercase",
  },
  review: {
    color: tokens.foreground,
    fontSize: 10,
    fontWeight: 750,
    textTransform: "uppercase",
  },
  done: { color: tokens.accent, fontSize: 10, fontWeight: 750, textTransform: "uppercase" },
  cancelled: { color: tokens.danger, fontSize: 10, fontWeight: 750, textTransform: "uppercase" },
  eligibility: {
    color: tokens.foregroundMuted,
    fontSize: 10,
    gridColumn: "2 / 4",
    textTransform: "uppercase",
  },
  detail: {
    backgroundColor: tokens.surface,
    order: 1,
    padding: "clamp(24px, 5vw, 64px)",
    "@media (max-width: 600px)": { padding: tokens.space4 },
  },
  overviewDetail: { backgroundColor: tokens.background, padding: 0 },
  detailStack: { marginInline: "auto", maxWidth: 960, width: "100%" },
  settingsStack: { display: "grid", gap: tokens.space5 },
  empty: {
    alignItems: "center",
    color: tokens.foregroundMuted,
    display: "flex",
    flexDirection: "column",
    justifyContent: "center",
    minHeight: 420,
    textAlign: "center",
  },
  readingSummary: {
    backgroundColor: tokens.background,
    borderColor: tokens.border,
    borderRadius: tokens.radius3,
    borderStyle: "solid",
    borderWidth: 1,
    display: "grid",
    gap: tokens.space4,
    padding: tokens.space5,
  },
  readingSummaryHeader: {
    alignItems: "start",
    display: "flex",
    gap: tokens.space4,
    justifyContent: "space-between",
  },
  readingSummaryTitle: { fontSize: 26, letterSpacing: "-0.035em", marginBlock: tokens.space1 },
  readingSummaryMeta: {
    color: tokens.foregroundMuted,
    fontSize: 11,
    textTransform: "uppercase",
  },
  readingFieldTitle: { fontSize: 13, marginBlock: 0 },
  readingText: { lineHeight: 1.55, marginBlock: tokens.space1 },
  readingChecklist: { marginBlock: tokens.space1, paddingInlineStart: tokens.space5 },
  error: { color: tokens.danger, fontSize: 13, margin: 0 },
  srOnly: { height: 1, margin: -1, overflow: "hidden", position: "absolute", width: 1 },
});
