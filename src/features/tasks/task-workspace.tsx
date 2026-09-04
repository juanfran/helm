import { useMemo, useState, type CSSProperties, type FormEvent, type ReactNode } from "react";
import * as stylex from "@stylexjs/stylex";
import {
  Activity,
  Archive,
  Bot,
  CheckCircle2,
  Clock3,
  GitBranch,
  Inbox,
  Link2,
  Plus,
  ShipWheel,
  SlidersHorizontal,
  X,
} from "lucide-react";

import { Button } from "../../components/ui/button";
import type {
  ActivityEntry,
  CreateHumanActivityEntryInput,
  CreateManualBlockerInput,
  ManualBlocker,
  ProjectEvent,
  ResolveManualBlockerInput,
  WithdrawActivityEntryInput,
} from "../../domain/activity";
import {
  themeSchema,
  type Project,
  type SetProjectReviewModeInput,
  type Theme,
} from "../../domain/projects";
import {
  emptyRichTextDocument,
  compareTaskOrder,
  taskPrioritySchema,
  taskRelationTypeSchema,
  taskSizeSchema,
  tagInputSchema,
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
  type RichTextDocument,
  type Task,
  type TaskAttemptSummary,
  type TaskClaim,
  type TaskLifecycle,
  type TagInput,
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
import { tokens } from "../../styles/tokens.stylex";
import { ProjectActivityFeed } from "../activity/project-activity-feed";
import { TaskCollaboration } from "../activity/task-collaboration";
import { ProjectReviewModeControl } from "../projects/project-review-mode-control";
import { RichTextEditor } from "./rich-text-editor";
import { TaskExecutionPanel } from "./task-execution-panel";

type TaskWorkspaceProps = {
  project: Project;
  theme: Theme;
  tasks: readonly Task[];
  attempts: readonly TaskAttemptSummary[];
  tagDefinitions: readonly TaskTag[];
  activityEntries: readonly ActivityEntry[];
  manualBlockers: readonly ManualBlocker[];
  projectEvents: readonly ProjectEvent[];
  liveStatus: "connecting" | "live" | "retrying";
  renderSearchLink?: (props: { className?: string; style?: CSSProperties }) => ReactNode;
  onCreateTask: (input: CreateTaskInput) => Promise<TaskCommandResponse>;
  onPrepareTask: (input: PrepareTaskInput) => Promise<TaskCommandResponse>;
  onUpdateTaskPlanning: (input: UpdateTaskPlanningInput) => Promise<TaskCommandResponse>;
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
  onChangeTheme: (theme: Theme) => Promise<void>;
  onChangeProjectReviewMode: (input: SetProjectReviewModeInput) => Promise<ProjectCommandResponse>;
};

type TagDraft = TagInput & { draftId: string };

export function TaskWorkspace({
  project,
  theme,
  tasks,
  attempts,
  tagDefinitions,
  activityEntries,
  manualBlockers,
  projectEvents,
  liveStatus,
  renderSearchLink,
  onCreateTask,
  onPrepareTask,
  onUpdateTaskPlanning,
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
  onChangeTheme,
  onChangeProjectReviewMode,
}: TaskWorkspaceProps) {
  const orderedTasks = useMemo(() => tasks.toSorted(compareTaskOrder), [tasks]);
  const [captureTitle, setCaptureTitle] = useState("");
  const [workspaceView, setWorkspaceView] = useState<"tasks" | "activity">("tasks");
  const [selectedId, setSelectedId] = useState<string | null>(orderedTasks[0]?.id ?? null);
  const [pendingCapture, setPendingCapture] = useState(false);
  const [captureError, setCaptureError] = useState<string | null>(null);
  const selectedTask =
    orderedTasks.find((task) => task.id === selectedId) ?? orderedTasks[0] ?? null;
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
        setSelectedId(response.task.id);
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
            onClick={() => setWorkspaceView("activity")}
            {...stylex.props(
              styles.viewButton,
              workspaceView === "activity" && styles.viewButtonActive,
            )}
          >
            Activity
          </button>
          {renderSearchLink?.(stylex.props(styles.viewButton, styles.viewLink))}
        </nav>
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
        <label {...stylex.props(styles.appearance)}>
          <span>Appearance</span>
          <select
            aria-label="Appearance"
            value={theme}
            onChange={(event) => void onChangeTheme(themeSchema.parse(event.target.value))}
            {...stylex.props(styles.select)}
          >
            <option value="system">System</option>
            <option value="light">Light</option>
            <option value="dark">Dark</option>
          </select>
        </label>
      </header>

      <div {...stylex.props(styles.workspace)}>
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
          <ProjectReviewModeControl
            key={`${project.id}:${project.version}`}
            project={project}
            onChange={onChangeProjectReviewMode}
          />
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
            <Button
              type="submit"
              aria-label="Add backlog task"
              disabled={pendingCapture || captureTitle.trim().length === 0}
            >
              <Plus size={17} aria-hidden="true" />
            </Button>
          </form>
          {captureError ? (
            <p role="alert" {...stylex.props(styles.error)}>
              {captureError}
            </p>
          ) : null}
          <nav aria-label="Tasks" {...stylex.props(styles.taskList)}>
            {orderedTasks.map((task) => (
              <button
                key={task.id}
                type="button"
                onClick={() => {
                  setSelectedId(task.id);
                  setWorkspaceView("tasks");
                }}
                aria-current={task.id === selectedTask?.id ? "true" : undefined}
                {...stylex.props(
                  styles.taskRow,
                  task.id === selectedTask?.id && styles.taskRowSelected,
                )}
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
            ))}
          </nav>
        </aside>

        <section {...stylex.props(styles.detail)}>
          {workspaceView === "activity" ? (
            <ProjectActivityFeed
              events={projectEvents}
              tasks={orderedTasks}
              entries={activityEntries}
              attempts={attempts}
            />
          ) : selectedTask ? (
            <div {...stylex.props(styles.detailStack)}>
              <TaskExecutionPanel
                key={selectedTask.id}
                task={selectedTask}
                attempts={attempts}
                onApproveReview={onApproveTaskReview}
                onRequestChanges={onRequestTaskChanges}
                onCancelTask={onCancelTask}
                onRestoreTask={onRestoreCancelledTask}
                onReopenTask={onReopenTask}
              />
              <PreparationPanel
                key={`${selectedTask.id}:${selectedTask.version}`}
                task={selectedTask}
                tasks={orderedTasks}
                tagDefinitions={tagDefinitions}
                activityEntries={activityEntries}
                manualBlockers={manualBlockers}
                onCreateTask={onCreateTask}
                onPrepare={onPrepareTask}
                onUpdatePlanning={onUpdateTaskPlanning}
                onCreateRelation={onCreateTaskRelation}
                onArchive={onArchiveTask}
                onInvalidateClaim={onInvalidateClaim}
                onCreateActivityEntry={onCreateActivityEntry}
                onWithdrawActivityEntry={onWithdrawActivityEntry}
                onCreateManualBlocker={onCreateManualBlocker}
                onResolveManualBlocker={onResolveManualBlocker}
              />
            </div>
          ) : (
            <div {...stylex.props(styles.empty)}>
              <Inbox size={32} aria-hidden="true" />
              <h2>Capture the first task</h2>
              <p>A title is enough. Preparation can happen when the work is understood.</p>
            </div>
          )}
        </section>
      </div>
    </main>
  );
}

function PreparationPanel({
  task,
  tasks,
  tagDefinitions,
  activityEntries,
  manualBlockers,
  onCreateTask,
  onPrepare,
  onUpdatePlanning,
  onCreateRelation,
  onArchive,
  onInvalidateClaim,
  onCreateActivityEntry,
  onWithdrawActivityEntry,
  onCreateManualBlocker,
  onResolveManualBlocker,
}: {
  task: Task;
  tasks: readonly Task[];
  tagDefinitions: readonly TaskTag[];
  activityEntries: readonly ActivityEntry[];
  manualBlockers: readonly ManualBlocker[];
  onCreateTask: TaskWorkspaceProps["onCreateTask"];
  onPrepare: TaskWorkspaceProps["onPrepareTask"];
  onUpdatePlanning: TaskWorkspaceProps["onUpdateTaskPlanning"];
  onCreateRelation: TaskWorkspaceProps["onCreateTaskRelation"];
  onArchive: TaskWorkspaceProps["onArchiveTask"];
  onInvalidateClaim: TaskWorkspaceProps["onInvalidateClaim"];
  onCreateActivityEntry: TaskWorkspaceProps["onCreateActivityEntry"];
  onWithdrawActivityEntry: TaskWorkspaceProps["onWithdrawActivityEntry"];
  onCreateManualBlocker: TaskWorkspaceProps["onCreateManualBlocker"];
  onResolveManualBlocker: TaskWorkspaceProps["onResolveManualBlocker"];
}) {
  const [title, setTitle] = useState(task.title);
  const [description, setDescription] = useState<RichTextDocument>(task.description);
  const [expectedOutcome, setExpectedOutcome] = useState(task.expectedOutcome);
  const [acceptanceCriteria, setAcceptanceCriteria] = useState(task.acceptanceCriteria);
  const [agentContext, setAgentContext] = useState(task.agentContext);
  const [checklist, setChecklist] = useState(task.checklist.map((item) => item.text).join("\n"));
  const [priority, setPriority] = useState(task.priority);
  const [position, setPosition] = useState(String(task.position));
  const [notBefore, setNotBefore] = useState(task.notBefore ?? "");
  const [dueAt, setDueAt] = useState(task.dueAt ?? "");
  const [size, setSize] = useState(task.size ?? "");
  const knownTags = useMemo(
    () => new Map(tagDefinitions.map((tag) => [tag.name, tag])),
    [tagDefinitions],
  );
  const [tagInputs, setTagInputs] = useState<TagDraft[]>(
    task.tags.map(({ id, name, description: tagDescription, color, exclusiveGroup }) => ({
      draftId: id,
      name,
      description: tagDescription,
      color,
      exclusiveGroup,
    })),
  );
  const [requiredCapabilities, setRequiredCapabilities] = useState(
    task.requiredCapabilities.join("\n"),
  );
  const [referencedPaths, setReferencedPaths] = useState(task.referencedPaths.join("\n"));
  const [childTitle, setChildTitle] = useState("");
  const [relationTargetId, setRelationTargetId] = useState(
    tasks.find((candidate) => candidate.id !== task.id)?.id ?? "",
  );
  const [relationType, setRelationType] = useState("blocks");
  const [claimReason, setClaimReason] = useState("");
  const [claimPendingDisposition, setClaimPendingDisposition] = useState<
    InvalidateTaskClaimInput["disposition"] | null
  >(null);
  const [pending, setPending] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const parentTask = task.parentTaskId
    ? tasks.find((candidate) => candidate.id === task.parentTaskId)
    : null;
  const childTasks = task.childTaskIds
    .map((childId) => tasks.find((candidate) => candidate.id === childId))
    .filter((child) => child !== undefined);
  const relationTarget = tasks.find((candidate) => candidate.id === relationTargetId);
  const editable = task.lifecycle === "backlog" || task.lifecycle === "ready";
  const executionReadOnly =
    task.lifecycle === "in_progress" ||
    task.lifecycle === "review" ||
    task.lifecycle === "cancelled";

  function currentPlanningFields() {
    return {
      priority,
      position: Number(position),
      notBefore: notBefore || null,
      dueAt: dueAt || null,
      size: taskSizeSchema.nullable().parse(size || null),
      tags: tagInputs
        .filter((tag) => tag.name.trim().length > 0)
        .map(({ draftId: _draftId, ...tag }) => tagInputSchema.parse(tag)),
      requiredCapabilities: parseLines(requiredCapabilities),
    };
  }

  async function prepare(event: FormEvent<HTMLFormElement>) {
    event.preventDefault();
    if (!editable) return;
    setPending(true);
    setError(null);
    try {
      const response = await onPrepare({
        taskId: task.id,
        title,
        description,
        expectedOutcome,
        acceptanceCriteria,
        agentContext,
        referencedPaths: parseLines(referencedPaths),
        checklist: checklist
          .split("\n")
          .map((line) => line.trim())
          .filter(Boolean)
          .map((text, index) => ({ id: `item-${index + 1}`, text, checked: false })),
        ...currentPlanningFields(),
        expectedVersion: task.version,
        idempotencyKey: crypto.randomUUID(),
      });
      if (!response.ok) setError(response.error.message);
    } catch {
      setError("Helm could not prepare the task.");
    } finally {
      setPending(false);
    }
  }

  async function updatePlanning() {
    if (!editable) return;
    setPending(true);
    setError(null);
    try {
      const response = await onUpdatePlanning({
        taskId: task.id,
        ...currentPlanningFields(),
        expectedVersion: task.version,
        idempotencyKey: crypto.randomUUID(),
      });
      if (!response.ok) setError(response.error.message);
    } catch {
      setError("Helm could not update task planning.");
    } finally {
      setPending(false);
    }
  }

  async function archive() {
    if (executionReadOnly) return;
    setPending(true);
    setError(null);
    try {
      const response = await onArchive({
        taskId: task.id,
        expectedVersion: task.version,
        reason: "Archived from the task workspace",
        idempotencyKey: crypto.randomUUID(),
      });
      if (!response.ok) setError(response.error.message);
    } catch {
      setError("Helm could not archive the task.");
    } finally {
      setPending(false);
    }
  }

  async function createChild() {
    if (executionReadOnly) return;
    setPending(true);
    setError(null);
    try {
      const response = await onCreateTask({
        projectId: task.projectId,
        parentTaskId: task.id,
        lifecycle: "backlog",
        title: childTitle,
        description: emptyRichTextDocument,
        expectedOutcome: "",
        acceptanceCriteria: "",
        agentContext: "",
        checklist: [],
        referencedPaths: [],
        expectedVersion: 0,
        idempotencyKey: crypto.randomUUID(),
      });
      if (response.ok) setChildTitle("");
      else setError(response.error.message);
    } catch {
      setError("Helm could not create the child task.");
    } finally {
      setPending(false);
    }
  }

  async function createRelation() {
    if (executionReadOnly || !relationTarget) return;
    setPending(true);
    setError(null);
    try {
      const response = await onCreateRelation({
        projectId: task.projectId,
        sourceTaskId: task.id,
        targetTaskId: relationTarget.id,
        type: taskRelationTypeSchema.parse(relationType),
        expectedSourceVersion: task.version,
        expectedTargetVersion: relationTarget.version,
        idempotencyKey: crypto.randomUUID(),
      });
      if (!response.ok) setError(response.error.message);
    } catch {
      setError("Helm could not create the task relation.");
    } finally {
      setPending(false);
    }
  }

  async function invalidateClaim(disposition: InvalidateTaskClaimInput["disposition"]) {
    if (!task.claim || claimReason.trim().length === 0) return;
    const confirmed = window.confirm(
      disposition === "cancelled"
        ? `Stop ${task.claim.agentDisplayName}'s claim? Their lease will stop immediately and the current attempt will be marked abandoned.`
        : `Make this task available for reassignment? ${task.claim.agentDisplayName}'s lease will stop immediately and the current attempt will be marked abandoned.`,
    );
    if (!confirmed) return;

    setPending(true);
    setClaimPendingDisposition(disposition);
    setError(null);
    try {
      const response = await onInvalidateClaim({
        taskId: task.id,
        expectedVersion: task.version,
        disposition,
        reason: claimReason.trim(),
        idempotencyKey: crypto.randomUUID(),
      });
      if (!response.ok) setError(response.error.message);
    } catch {
      setError("Helm could not change the current claim.");
    } finally {
      setPending(false);
      setClaimPendingDisposition(null);
    }
  }

  function addTag() {
    const colors = ["#2563eb", "#16a34a", "#c2410c", "#7c3aed", "#0f766e"];
    setTagInputs((current) => [
      ...current,
      {
        draftId: crypto.randomUUID(),
        name: "",
        description: "",
        color: colors[current.length % colors.length] ?? "#2563eb",
        exclusiveGroup: null,
      },
    ]);
  }

  function updateTagName(index: number, name: string) {
    setTagInputs((current) =>
      current.map((tag, tagIndex) => {
        if (tagIndex !== index) return tag;
        const known = knownTags.get(name.trim());
        return known
          ? {
              draftId: tag.draftId,
              name: known.name,
              description: known.description,
              color: known.color,
              exclusiveGroup: known.exclusiveGroup,
            }
          : { ...tag, name };
      }),
    );
  }

  function updateTag(index: number, update: Partial<TagInput>) {
    setTagInputs((current) =>
      current.map((tag, tagIndex) => (tagIndex === index ? { ...tag, ...update } : tag)),
    );
  }

  return (
    <div {...stylex.props(styles.detailStack)}>
      <form onSubmit={prepare} {...stylex.props(styles.form)} aria-label="Prepare task">
        <div {...stylex.props(styles.detailHeader)}>
          <div>
            <p {...stylex.props(styles.eyebrow)}>Task #{task.sequence}</p>
            <p {...stylex.props(styles.version)}>Version {task.version}</p>
          </div>
          <span {...stylex.props(styles.headerActions)}>
            <Button
              type="button"
              variant="quiet"
              disabled={pending || executionReadOnly}
              onClick={() => void archive()}
            >
              <Archive size={15} aria-hidden="true" /> Archive
            </Button>
          </span>
        </div>
        {task.claim ? (
          <section
            aria-label="Current claim"
            aria-live="polite"
            aria-busy={claimPendingDisposition !== null}
            {...stylex.props(styles.claimCard)}
          >
            <ClaimLeaseSummary claim={task.claim} />
            <fieldset disabled={pending} {...stylex.props(styles.claimActions)}>
              <legend {...stylex.props(styles.fieldLabel)}>Change current claim</legend>
              <label htmlFor={`claim-reason-${task.id}`} {...stylex.props(styles.claimReasonLabel)}>
                Reason
              </label>
              <textarea
                id={`claim-reason-${task.id}`}
                value={claimReason}
                onChange={(event) => setClaimReason(event.target.value)}
                aria-describedby={`claim-warning-${task.id}`}
                rows={2}
                maxLength={1_000}
                required
                {...stylex.props(styles.textarea)}
              />
              <p id={`claim-warning-${task.id}`} {...stylex.props(styles.hint)}>
                These claim controls return the task to Ready. Cancelling the task itself uses the
                separate lifecycle action above.
              </p>
              <div {...stylex.props(styles.claimActionButtons)}>
                <Button
                  type="button"
                  variant="quiet"
                  disabled={pending || claimReason.trim().length === 0}
                  onClick={() => void invalidateClaim("cancelled")}
                >
                  {claimPendingDisposition === "cancelled" ? "Stopping claim…" : "Stop claim"}
                </Button>
                <Button
                  type="button"
                  disabled={pending || claimReason.trim().length === 0}
                  onClick={() => void invalidateClaim("reassigned")}
                >
                  {claimPendingDisposition === "reassigned"
                    ? "Making available…"
                    : "Make available for reassignment"}
                </Button>
              </div>
            </fieldset>
          </section>
        ) : null}
        <section {...stylex.props(styles.relations)} aria-label="Task relations">
          <div>
            <p {...stylex.props(styles.fieldLabel)}>Hierarchy</p>
            <p {...stylex.props(styles.hint)}>
              Parent: {parentTask ? `#${parentTask.sequence} ${parentTask.title}` : "None"}
            </p>
            <p {...stylex.props(styles.hint)}>
              Children:{" "}
              {childTasks.length > 0
                ? childTasks.map((child) => `#${child.sequence} ${child.title}`).join(", ")
                : "None"}
            </p>
          </div>
          <div>
            <p {...stylex.props(styles.fieldLabel)}>Upstream</p>
            <RelationList
              empty="No upstream relations"
              relations={task.upstreamRelations.map(
                (relation) =>
                  `${relation.type} from #${relation.sourceSequence} ${relation.sourceTitle}`,
              )}
            />
          </div>
          <div>
            <p {...stylex.props(styles.fieldLabel)}>Downstream</p>
            <RelationList
              empty="No downstream relations"
              relations={task.downstreamRelations.map(
                (relation) =>
                  `${relation.type} to #${relation.targetSequence} ${relation.targetTitle}`,
              )}
            />
          </div>
        </section>
        <fieldset
          disabled={executionReadOnly}
          {...stylex.props(styles.taskActions, executionReadOnly && styles.readOnlyGroup)}
        >
          <legend {...stylex.props(styles.srOnly)}>Task structure actions</legend>
          <div {...stylex.props(styles.inlineForm)}>
            <input
              aria-label="Child task title"
              value={childTitle}
              onChange={(event) => setChildTitle(event.target.value)}
              placeholder="Child task title"
              maxLength={300}
              {...stylex.props(styles.input)}
            />
            <Button
              type="button"
              disabled={pending || childTitle.trim().length === 0}
              onClick={() => void createChild()}
            >
              <GitBranch size={16} aria-hidden="true" />
              Add child
            </Button>
          </div>
          <div {...stylex.props(styles.inlineForm)}>
            <select
              aria-label="Relation type"
              value={relationType}
              onChange={(event) => setRelationType(event.target.value)}
              {...stylex.props(styles.select, styles.fullWidth)}
            >
              <option value="blocks">Blocks</option>
              <option value="related_to">Related to</option>
              <option value="duplicates">Duplicates</option>
              <option value="discovered_from">Discovered from</option>
            </select>
            <select
              aria-label="Relation target"
              value={relationTargetId}
              onChange={(event) => setRelationTargetId(event.target.value)}
              {...stylex.props(styles.select, styles.fullWidth)}
            >
              <option value="">Select target</option>
              {tasks
                .filter((candidate) => candidate.id !== task.id)
                .map((candidate) => (
                  <option key={candidate.id} value={candidate.id}>
                    #{candidate.sequence} {candidate.title}
                  </option>
                ))}
            </select>
            <Button
              type="button"
              disabled={pending || !relationTargetId}
              onClick={() => void createRelation()}
            >
              <Link2 size={16} aria-hidden="true" />
              Add relation
            </Button>
          </div>
        </fieldset>
        <fieldset
          disabled={!editable}
          {...stylex.props(styles.editableFields, !editable && styles.readOnlyGroup)}
        >
          <legend {...stylex.props(styles.srOnly)}>Editable task details</legend>
          <Field label="Title" required>
            <input
              aria-label="Title"
              value={title}
              onChange={(event) => setTitle(event.target.value)}
              maxLength={300}
              required
              {...stylex.props(styles.input)}
            />
          </Field>
          <Field label="Description" hint="Rich text is saved as a versioned TipTap document.">
            <RichTextEditor value={description} onChange={setDescription} editable={editable} />
          </Field>
          <div {...stylex.props(styles.planningGrid)}>
            <Field label="Priority">
              <select
                aria-label="Priority"
                value={priority}
                onChange={(event) => setPriority(taskPrioritySchema.parse(event.target.value))}
                {...stylex.props(styles.select, styles.fullWidth)}
              >
                <option value="urgent">Urgent</option>
                <option value="high">High</option>
                <option value="normal">Normal</option>
                <option value="low">Low</option>
              </select>
            </Field>
            <Field label="Position">
              <input
                aria-label="Position"
                type="number"
                min={0}
                value={position}
                onChange={(event) => setPosition(event.target.value)}
                {...stylex.props(styles.input)}
              />
            </Field>
            <Field label="Start date">
              <input
                aria-label="Start date"
                type="date"
                value={notBefore}
                onChange={(event) => setNotBefore(event.target.value)}
                {...stylex.props(styles.input)}
              />
            </Field>
            <Field label="Due date">
              <input
                aria-label="Due date"
                type="date"
                value={dueAt}
                onChange={(event) => setDueAt(event.target.value)}
                {...stylex.props(styles.input)}
              />
            </Field>
            <Field label="Size">
              <select
                aria-label="Size"
                value={size}
                onChange={(event) => setSize(event.target.value)}
                {...stylex.props(styles.select, styles.fullWidth)}
              >
                <option value="">Unestimated</option>
                <option value="xs">XS</option>
                <option value="s">S</option>
                <option value="m">M</option>
                <option value="l">L</option>
                <option value="xl">XL</option>
              </select>
            </Field>
          </div>
          <Field
            label="Tags"
            hint="Tag definitions are shared across the project. Existing metadata stays canonical."
          >
            <fieldset {...stylex.props(styles.tagEditor)}>
              <legend {...stylex.props(styles.srOnly)}>Tags</legend>
              {tagInputs.map((tag, index) => {
                const known = knownTags.has(tag.name);
                return (
                  <div key={tag.draftId} {...stylex.props(styles.tagRow)}>
                    <input
                      aria-label={`Tag ${index + 1} name`}
                      value={tag.name}
                      onChange={(event) => updateTagName(index, event.target.value)}
                      placeholder="Tag name"
                      maxLength={80}
                      {...stylex.props(styles.input)}
                    />
                    <input
                      aria-label={`Tag ${index + 1} description`}
                      value={tag.description}
                      onChange={(event) => updateTag(index, { description: event.target.value })}
                      placeholder="Description"
                      maxLength={1_000}
                      disabled={known}
                      {...stylex.props(styles.input)}
                    />
                    <input
                      aria-label={`Tag ${index + 1} color`}
                      type="color"
                      value={tag.color}
                      onChange={(event) => updateTag(index, { color: event.target.value })}
                      disabled={known}
                      {...stylex.props(styles.colorInput)}
                    />
                    <input
                      aria-label={`Tag ${index + 1} exclusive group`}
                      value={tag.exclusiveGroup ?? ""}
                      onChange={(event) =>
                        updateTag(index, { exclusiveGroup: event.target.value || null })
                      }
                      placeholder="Exclusive group"
                      maxLength={80}
                      disabled={known}
                      {...stylex.props(styles.input)}
                    />
                    <Button
                      type="button"
                      variant="quiet"
                      aria-label={`Remove tag ${tag.name || index + 1}`}
                      disabled={pending}
                      onClick={() =>
                        setTagInputs((current) =>
                          current.filter((_, tagIndex) => tagIndex !== index),
                        )
                      }
                    >
                      <X size={15} aria-hidden="true" />
                    </Button>
                  </div>
                );
              })}
              <Button type="button" variant="quiet" disabled={pending} onClick={addTag}>
                <Plus size={15} aria-hidden="true" /> Add tag
              </Button>
            </fieldset>
          </Field>
          <Field label="Required capabilities">
            <textarea
              aria-label="Required capabilities"
              value={requiredCapabilities}
              onChange={(event) => setRequiredCapabilities(event.target.value)}
              rows={3}
              {...stylex.props(styles.textarea)}
            />
          </Field>
          <Field
            label="Referenced paths"
            hint="One normalized repository-relative file or directory path per line."
          >
            <textarea
              aria-label="Referenced paths"
              value={referencedPaths}
              onChange={(event) => setReferencedPaths(event.target.value)}
              rows={3}
              placeholder="src/domain/tasks.ts"
              {...stylex.props(styles.textarea)}
            />
          </Field>
          {task.eligibility ? (
            <p {...stylex.props(styles.hint)}>
              {task.eligibility.status}: {task.eligibility.reasons.join(" ")}{" "}
              {task.eligibility.orderingExplanation}
            </p>
          ) : null}
          <Field label="Expected outcome" required>
            <textarea
              aria-label="Expected outcome"
              value={expectedOutcome}
              onChange={(event) => setExpectedOutcome(event.target.value)}
              rows={3}
              required
              {...stylex.props(styles.textarea)}
            />
          </Field>
          <Field label="Acceptance criteria" required>
            <textarea
              aria-label="Acceptance criteria"
              value={acceptanceCriteria}
              onChange={(event) => setAcceptanceCriteria(event.target.value)}
              rows={4}
              required
              {...stylex.props(styles.textarea)}
            />
          </Field>
          <Field label="Agent context" hint="Paths, constraints, and execution-specific guidance.">
            <textarea
              aria-label="Agent context"
              value={agentContext}
              onChange={(event) => setAgentContext(event.target.value)}
              rows={3}
              {...stylex.props(styles.textarea)}
            />
          </Field>
          <Field label="Checklist" hint="One required verification step per line." required>
            <textarea
              aria-label="Checklist"
              value={checklist}
              onChange={(event) => setChecklist(event.target.value)}
              rows={4}
              required
              {...stylex.props(styles.textarea)}
            />
          </Field>
        </fieldset>
        {error ? (
          <p role="alert" {...stylex.props(styles.error)}>
            {error}
          </p>
        ) : null}
        <div {...stylex.props(styles.formFooter)}>
          <p>Ready requires an outcome, acceptance criteria, and at least one checklist item.</p>
          <span {...stylex.props(styles.footerActions)}>
            {editable ? (
              <>
                <Button
                  type="button"
                  variant="quiet"
                  disabled={pending}
                  onClick={() => void updatePlanning()}
                >
                  <SlidersHorizontal size={16} aria-hidden="true" />
                  Save planning
                </Button>
                <Button type="submit" disabled={pending}>
                  <CheckCircle2 size={16} aria-hidden="true" />
                  {pending
                    ? "Saving…"
                    : task.lifecycle === "ready"
                      ? "Save preparation"
                      : "Move to ready"}
                </Button>
              </>
            ) : (
              <span {...stylex.props(styles.hint)}>{readOnlyExplanation(task.lifecycle)}</span>
            )}
          </span>
        </div>
      </form>
      <TaskCollaboration
        task={task}
        entries={activityEntries}
        blockers={manualBlockers}
        onCreateEntry={onCreateActivityEntry}
        onWithdrawEntry={onWithdrawActivityEntry}
        onCreateBlocker={onCreateManualBlocker}
        onResolveBlocker={onResolveManualBlocker}
      />
    </div>
  );
}

function parseLines(value: string) {
  return value
    .split("\n")
    .map((line) => line.trim())
    .filter(Boolean);
}

function taskLifecycleLabel(lifecycle: TaskLifecycle) {
  return lifecycle === "in_progress" ? "in progress" : lifecycle;
}

function readOnlyExplanation(lifecycle: TaskLifecycle) {
  switch (lifecycle) {
    case "in_progress":
      return "Agent execution is active. Task changes are locked while the claim is held.";
    case "review":
      return "This task is awaiting review. Task changes are locked until a review action is taken.";
    case "done":
      return "Reopen this task before editing it.";
    case "cancelled":
      return "Cancelled tasks are read-only.";
    case "backlog":
    case "ready":
      return "";
  }
  return "";
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

function Field({
  label,
  hint,
  required = false,
  children,
}: {
  label: string;
  hint?: string;
  required?: boolean;
  children: React.ReactNode;
}) {
  return (
    <div {...stylex.props(styles.field)}>
      <span {...stylex.props(styles.fieldLabel)}>
        {label} {required ? <span {...stylex.props(styles.required)}>Required</span> : null}
      </span>
      {children}
      {hint ? <span {...stylex.props(styles.hint)}>{hint}</span> : null}
    </div>
  );
}

function RelationList({ relations, empty }: { relations: readonly string[]; empty: string }) {
  return relations.length > 0 ? (
    <ul {...stylex.props(styles.relationList)}>
      {relations.map((relation) => (
        <li key={relation}>{relation}</li>
      ))}
    </ul>
  ) : (
    <p {...stylex.props(styles.hint)}>{empty}</p>
  );
}

const styles = stylex.create({
  page: { minHeight: "100vh" },
  header: {
    alignItems: "center",
    borderBlockEndColor: tokens.border,
    borderBlockEndStyle: "solid",
    borderBlockEndWidth: 1,
    display: "flex",
    justifyContent: "space-between",
    minHeight: 64,
    paddingInline: tokens.space6,
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
  appearance: {
    alignItems: "center",
    color: tokens.foregroundMuted,
    display: "flex",
    fontSize: 12,
    gap: tokens.space2,
  },
  select: {
    backgroundColor: tokens.surface,
    borderColor: tokens.border,
    borderRadius: 6,
    color: tokens.foreground,
    minHeight: 32,
  },
  fullWidth: { width: "100%" },
  workspace: {
    display: "grid",
    gridTemplateColumns: "minmax(300px, 380px) minmax(0, 1fr)",
    minHeight: "calc(100vh - 65px)",
    "@media (max-width: 760px)": { gridTemplateColumns: "1fr" },
  },
  sidebar: {
    borderInlineEndColor: tokens.border,
    borderInlineEndStyle: "solid",
    borderInlineEndWidth: 1,
    padding: tokens.space5,
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
  taskList: { display: "grid", gap: tokens.space1, marginBlockStart: tokens.space5 },
  taskRow: {
    alignItems: "center",
    backgroundColor: "transparent",
    borderColor: "transparent",
    borderRadius: tokens.radius2,
    borderStyle: "solid",
    borderWidth: 1,
    color: tokens.foreground,
    cursor: "pointer",
    display: "grid",
    gap: tokens.space2,
    gridTemplateColumns: "32px minmax(0, 1fr) auto",
    minHeight: 58,
    paddingInline: tokens.space2,
    textAlign: "start",
    ":hover": { backgroundColor: tokens.surfaceMuted },
  },
  taskRowSelected: { backgroundColor: tokens.surface, borderColor: tokens.border },
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
  detail: { backgroundColor: tokens.surface, padding: "clamp(24px, 5vw, 64px)" },
  detailStack: { marginInline: "auto", maxWidth: 960, width: "100%" },
  empty: {
    alignItems: "center",
    color: tokens.foregroundMuted,
    display: "flex",
    flexDirection: "column",
    justifyContent: "center",
    minHeight: 420,
    textAlign: "center",
  },
  form: { display: "grid", gap: tokens.space5, margin: "0 auto", maxWidth: 760 },
  claimCard: {
    backgroundColor: tokens.surfaceMuted,
    borderColor: tokens.border,
    borderRadius: tokens.radius2,
    borderStyle: "solid",
    borderWidth: 1,
    display: "grid",
    gap: tokens.space4,
    padding: tokens.space4,
  },
  claimActions: {
    borderBlockStartColor: tokens.border,
    borderBlockStartStyle: "solid",
    borderBlockStartWidth: 1,
    borderWidth: 0,
    display: "grid",
    gap: tokens.space2,
    margin: 0,
    minWidth: 0,
    padding: 0,
    paddingBlockStart: tokens.space3,
  },
  claimReasonLabel: { fontSize: 12, fontWeight: 650 },
  claimActionButtons: {
    display: "flex",
    flexWrap: "wrap",
    gap: tokens.space2,
  },
  taskActions: {
    borderWidth: 0,
    display: "grid",
    gap: tokens.space3,
    margin: 0,
    minWidth: 0,
    padding: 0,
  },
  readOnlyGroup: { opacity: 0.68 },
  editableFields: {
    borderWidth: 0,
    display: "grid",
    gap: tokens.space4,
    minWidth: 0,
    padding: 0,
  },
  detailHeader: {
    alignItems: "center",
    borderBlockEndColor: tokens.border,
    borderBlockEndStyle: "solid",
    borderBlockEndWidth: 1,
    display: "flex",
    justifyContent: "space-between",
    paddingBlockEnd: tokens.space4,
  },
  headerActions: { display: "flex", flexWrap: "wrap", gap: tokens.space2, justifyContent: "end" },
  version: { color: tokens.foregroundMuted, fontSize: 12, marginBlock: tokens.space1 },
  relations: {
    borderBlockEndColor: tokens.border,
    borderBlockEndStyle: "solid",
    borderBlockEndWidth: 1,
    display: "grid",
    gap: tokens.space3,
    gridTemplateColumns: "repeat(3, minmax(0, 1fr))",
    paddingBlockEnd: tokens.space4,
    "@media (max-width: 820px)": { gridTemplateColumns: "1fr" },
  },
  relationList: {
    color: tokens.foregroundMuted,
    display: "grid",
    fontSize: 12,
    gap: tokens.space1,
    margin: 0,
    paddingInlineStart: tokens.space4,
  },
  inlineForm: {
    alignItems: "center",
    display: "grid",
    gap: tokens.space2,
    gridTemplateColumns: "minmax(0, 1fr) auto",
    "@media (max-width: 640px)": { gridTemplateColumns: "1fr" },
  },
  field: { display: "grid", gap: tokens.space2 },
  fieldLabel: { fontSize: 13, fontWeight: 700 },
  planningGrid: {
    display: "grid",
    gap: tokens.space3,
    gridTemplateColumns: "repeat(5, minmax(112px, 1fr))",
    "@media (max-width: 980px)": { gridTemplateColumns: "repeat(2, minmax(0, 1fr))" },
    "@media (max-width: 560px)": { gridTemplateColumns: "1fr" },
  },
  tagEditor: {
    borderWidth: 0,
    display: "grid",
    gap: tokens.space2,
    margin: 0,
    minWidth: 0,
    padding: 0,
  },
  tagRow: {
    alignItems: "center",
    display: "grid",
    gap: tokens.space2,
    gridTemplateColumns: "minmax(120px, 0.8fr) minmax(160px, 1.4fr) 44px minmax(120px, 0.8fr) auto",
    "@media (max-width: 900px)": { gridTemplateColumns: "1fr 1fr auto" },
    "@media (max-width: 560px)": { gridTemplateColumns: "1fr" },
  },
  colorInput: {
    backgroundColor: tokens.background,
    borderColor: tokens.border,
    borderRadius: tokens.radius2,
    borderStyle: "solid",
    borderWidth: 1,
    height: 40,
    padding: 4,
    width: 44,
  },
  required: {
    color: tokens.foregroundMuted,
    fontSize: 10,
    fontWeight: 600,
    marginInlineStart: tokens.space2,
    textTransform: "uppercase",
  },
  textarea: {
    backgroundColor: tokens.background,
    borderColor: tokens.border,
    borderRadius: tokens.radius2,
    borderStyle: "solid",
    borderWidth: 1,
    color: tokens.foreground,
    lineHeight: 1.5,
    padding: tokens.space3,
    resize: "vertical",
    width: "100%",
    ":focus": { borderColor: tokens.accent, outline: "none" },
  },
  hint: { color: tokens.foregroundMuted, fontSize: 11 },
  error: { color: tokens.danger, fontSize: 13, margin: 0 },
  formFooter: {
    alignItems: "center",
    borderBlockStartColor: tokens.border,
    borderBlockStartStyle: "solid",
    borderBlockStartWidth: 1,
    color: tokens.foregroundMuted,
    display: "flex",
    fontSize: 12,
    justifyContent: "space-between",
    paddingBlockStart: tokens.space4,
  },
  footerActions: { display: "flex", flexWrap: "wrap", gap: tokens.space2, justifyContent: "end" },
  srOnly: { height: 1, margin: -1, overflow: "hidden", position: "absolute", width: 1 },
});
