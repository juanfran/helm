import {
  Children,
  cloneElement,
  isValidElement,
  useId,
  useMemo,
  useState,
  type ComponentType,
  type FormEvent,
  type ReactNode,
} from "react";
import * as stylex from "@stylexjs/stylex";
import { Archive, Bot, CheckCircle2, Clock3, GitBranch, Link2, Plus, X } from "lucide-react";

import {
  createRetryableLazyModuleLoader,
  type RetryableLazyModuleLoader,
} from "../../components/retryable-lazy-module";
import { useExplicitLazyModule } from "../../components/use-explicit-lazy-module";
import type {
  ActivityEntry,
  CreateHumanActivityEntryInput,
  CreateManualBlockerInput,
  ManualBlocker,
  ResolveManualBlockerInput,
  WithdrawActivityEntryInput,
} from "../../domain/activity";
import type {
  CustomFieldDefinition,
  CustomFieldValue,
  SetTaskReviewModeOverrideInput,
  TaskCustomFieldAssignment,
} from "../../domain/customization";
import {
  emptyRichTextDocument,
  taskPrioritySchema,
  taskRelationTypeSchema,
  taskSizeSchema,
  tagInputSchema,
  type ArchiveTaskInput,
  type CreateTaskInput,
  type CreateTaskRelationInput,
  type InvalidateTaskClaimInput,
  type PrepareTaskInput,
  type RichTextDocument,
  type Task,
  type TaskAttemptSummary,
  type TaskClaim,
  type TaskLifecycle,
  type TagInput,
  type TaskTag,
  type UpdateTaskPlanningInput,
} from "../../domain/tasks";
import type {
  ActivityEntryCommandResponse,
  ManualBlockerCommandResponse,
} from "../../server/activity-adapter";
import type {
  TaskCommandResponse,
  TaskLeaseCommandResponse,
  TaskRelationCommandResponse,
} from "../../server/task-adapter";
import { tokens } from "../../styles/tokens.stylex";
import { reconcileChecklist, useTaskDraft } from "./task-draft";
import { TaskExecutionPanel, type TaskExecutionPanelProps } from "./task-execution-panel";

const defaultRichTextEditorModule = createRetryableLazyModuleLoader(() =>
  import("./rich-text-editor").then(({ RichTextEditor }) => ({ default: RichTextEditor })),
);
const taskCollaborationModule = createRetryableLazyModuleLoader(() =>
  import("../activity/task-collaboration").then(({ TaskCollaboration }) => ({
    default: TaskCollaboration,
  })),
);

export type TaskCollaborationModuleLoader = typeof taskCollaborationModule;

export type RichTextEditorModuleLoader = RetryableLazyModuleLoader<{
  default: ComponentType<{
    value: RichTextDocument;
    onChange: (document: RichTextDocument) => void;
    editable?: boolean;
  }>;
}>;

export type TaskDetailPanelProps = {
  task: Task;
  tasks: readonly Task[];
  attempts: readonly TaskAttemptSummary[];
  tagDefinitions: readonly TaskTag[];
  activityEntries: readonly ActivityEntry[];
  manualBlockers: readonly ManualBlocker[];
  richTextEditorModuleLoader?: RichTextEditorModuleLoader;
  collaborationModuleLoader?: TaskCollaborationModuleLoader;
  onCreateTask: (input: CreateTaskInput) => Promise<TaskCommandResponse>;
  onPrepare: (input: PrepareTaskInput) => Promise<TaskCommandResponse>;
  onUpdatePlanning: (input: UpdateTaskPlanningInput) => Promise<TaskCommandResponse>;
  onSetReviewModeOverride: (input: SetTaskReviewModeOverrideInput) => Promise<TaskCommandResponse>;
  onApproveReview: TaskExecutionPanelProps["onApproveReview"];
  onRequestChanges: TaskExecutionPanelProps["onRequestChanges"];
  onCancelTask: TaskExecutionPanelProps["onCancelTask"];
  onRestoreTask: TaskExecutionPanelProps["onRestoreTask"];
  onReopenTask: TaskExecutionPanelProps["onReopenTask"];
  onCreateRelation: (input: CreateTaskRelationInput) => Promise<TaskRelationCommandResponse>;
  onArchive: (input: ArchiveTaskInput) => Promise<TaskCommandResponse>;
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
};

export function TaskDetailPanel({
  task,
  tasks,
  attempts,
  tagDefinitions,
  activityEntries,
  manualBlockers,
  richTextEditorModuleLoader = defaultRichTextEditorModule,
  collaborationModuleLoader = taskCollaborationModule,
  onCreateTask,
  onPrepare,
  onUpdatePlanning,
  onSetReviewModeOverride,
  onApproveReview,
  onRequestChanges,
  onCancelTask,
  onRestoreTask,
  onReopenTask,
  onCreateRelation,
  onArchive,
  onInvalidateClaim,
  onCreateActivityEntry,
  onWithdrawActivityEntry,
  onCreateManualBlocker,
  onResolveManualBlocker,
}: TaskDetailPanelProps) {
  return (
    <div {...stylex.props(styles.detailStack)}>
      {task.lifecycle === "review" ? (
        <TaskExecutionPanel
          key={task.id}
          task={task}
          attempts={attempts}
          onApproveReview={onApproveReview}
          onRequestChanges={onRequestChanges}
          onCancelTask={onCancelTask}
          onRestoreTask={onRestoreTask}
          onReopenTask={onReopenTask}
        />
      ) : null}
      <PreparationPanel
        key={`preparation:${task.id}`}
        task={task}
        tasks={tasks}
        tagDefinitions={tagDefinitions}
        activityEntries={activityEntries}
        manualBlockers={manualBlockers}
        richTextEditorModuleLoader={richTextEditorModuleLoader}
        collaborationModuleLoader={collaborationModuleLoader}
        onCreateTask={onCreateTask}
        onPrepare={onPrepare}
        onUpdatePlanning={onUpdatePlanning}
        onSetReviewModeOverride={onSetReviewModeOverride}
        onCreateRelation={onCreateRelation}
        onArchive={onArchive}
        onInvalidateClaim={onInvalidateClaim}
        onCreateActivityEntry={onCreateActivityEntry}
        onWithdrawActivityEntry={onWithdrawActivityEntry}
        onCreateManualBlocker={onCreateManualBlocker}
        onResolveManualBlocker={onResolveManualBlocker}
      />
      {task.lifecycle !== "review" ? (
        <TaskExecutionPanel
          key={task.id}
          task={task}
          attempts={attempts}
          onApproveReview={onApproveReview}
          onRequestChanges={onRequestChanges}
          onCancelTask={onCancelTask}
          onRestoreTask={onRestoreTask}
          onReopenTask={onReopenTask}
        />
      ) : null}
    </div>
  );
}

type LazyDetailSurface = "collaboration" | "editor";

const lazyDetailLabels = {
  collaboration: "Loading collaboration controls",
  editor: "Loading task editor",
} as const satisfies Record<LazyDetailSurface, string>;

function LazyDetailFallback({ surface }: { surface: LazyDetailSurface }) {
  const label = lazyDetailLabels[surface];
  return (
    <output
      aria-live="polite"
      aria-label={label}
      {...stylex.props(
        styles.lazyFallback,
        surface === "collaboration" && styles.collaborationFallback,
        surface === "editor" && styles.editorFallback,
      )}
    >
      {label}…
    </output>
  );
}

function LazyDetailFailure({
  surface,
  onRetry,
}: {
  surface: LazyDetailSurface;
  onRetry: () => void;
}) {
  const label = lazyDetailLabels[surface].replace("Loading ", "");
  return (
    <section
      role="alert"
      aria-label={`${label} unavailable`}
      {...stylex.props(
        styles.lazyFallback,
        styles.lazyFailure,
        surface === "collaboration" && styles.collaborationFallback,
        surface === "editor" && styles.editorFallback,
      )}
    >
      <span>{label} could not load.</span>
      <button type="button" onClick={onRetry} {...stylex.props(styles.button, styles.buttonQuiet)}>
        Retry
      </button>
    </section>
  );
}

function PreparationPanel({
  task,
  tasks,
  tagDefinitions,
  activityEntries,
  manualBlockers,
  richTextEditorModuleLoader,
  collaborationModuleLoader,
  onCreateTask,
  onPrepare,
  onSetReviewModeOverride,
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
  richTextEditorModuleLoader: RichTextEditorModuleLoader;
  collaborationModuleLoader: TaskCollaborationModuleLoader;
  onCreateTask: TaskDetailPanelProps["onCreateTask"];
  onPrepare: TaskDetailPanelProps["onPrepare"];
  onUpdatePlanning: TaskDetailPanelProps["onUpdatePlanning"];
  onSetReviewModeOverride: TaskDetailPanelProps["onSetReviewModeOverride"];
  onCreateRelation: TaskDetailPanelProps["onCreateRelation"];
  onArchive: TaskDetailPanelProps["onArchive"];
  onInvalidateClaim: TaskDetailPanelProps["onInvalidateClaim"];
  onCreateActivityEntry: TaskDetailPanelProps["onCreateActivityEntry"];
  onWithdrawActivityEntry: TaskDetailPanelProps["onWithdrawActivityEntry"];
  onCreateManualBlocker: TaskDetailPanelProps["onCreateManualBlocker"];
  onResolveManualBlocker: TaskDetailPanelProps["onResolveManualBlocker"];
}) {
  const draft = useTaskDraft(task);
  const [title, setTitle] = draft.field("title");
  const [description, setDescription] = draft.field("description");
  const [expectedOutcome, setExpectedOutcome] = draft.field("expectedOutcome");
  const [acceptanceCriteria, setAcceptanceCriteria] = draft.field("acceptanceCriteria");
  const [agentContext, setAgentContext] = draft.field("agentContext");
  const [checklist, setChecklist] = draft.field("checklist");
  const [priority, setPriority] = draft.field("priority");
  const [position, setPosition] = draft.field("position");
  const [notBefore, setNotBefore] = draft.field("notBefore");
  const [dueAt, setDueAt] = draft.field("dueAt");
  const [size, setSize] = draft.field("size");
  const [tagInputs, setTagInputs] = draft.field("tagInputs");
  const [requiredCapabilities, setRequiredCapabilities] = draft.field("requiredCapabilities");
  const [customFieldValues, setCustomFieldValues] = draft.field("customFieldValues");
  const knownTags = useMemo(
    () => new Map(tagDefinitions.map((tag) => [tag.name, tag])),
    [tagDefinitions],
  );
  const [reviewModeOverride, setReviewModeOverride] = useState<"required" | "direct" | null>(
    task.reviewModeOverride,
  );
  const [reviewModeReason, setReviewModeReason] = useState("");
  const [referencedPaths, setReferencedPaths] = draft.field("referencedPaths");
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
  const editorModule = useExplicitLazyModule(richTextEditorModuleLoader);
  const collaborationModule = useExplicitLazyModule(collaborationModuleLoader);
  const parentTask = task.parentTaskId
    ? tasks.find((candidate) => candidate.id === task.parentTaskId)
    : null;
  const childTasks = task.childTaskIds
    .map((childId) => tasks.find((candidate) => candidate.id === childId))
    .filter((child) => child !== undefined);
  const relationTarget = tasks.find((candidate) => candidate.id === relationTargetId);
  const editable = !task.archivedAt && (task.lifecycle === "backlog" || task.lifecycle === "ready");
  const executionReadOnly =
    Boolean(task.archivedAt) ||
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
      ...(task.customFields.some(({ definition }) => definition.retiredAt === null)
        ? {
            customFields: task.customFields
              .filter(({ definition }) => definition.retiredAt === null)
              .map(({ definition }) => ({
                fieldId: definition.id,
                value: customFieldValues[definition.id] ?? null,
              })),
          }
        : {}),
    };
  }

  async function prepare(event: FormEvent<HTMLFormElement>) {
    event.preventDefault();
    if (task.lifecycle !== "backlog" && !event.currentTarget.reportValidity()) return;
    await savePreparation(task.lifecycle === "backlog");
  }

  async function savePreparation(saveAsDraft: boolean) {
    if (!editable || pending || draft.conflict) return;
    setPending(true);
    setError(null);
    try {
      const response = await onPrepare({
        taskId: task.id,
        saveAsDraft,
        title,
        description,
        expectedOutcome,
        acceptanceCriteria,
        agentContext,
        referencedPaths: parseLines(referencedPaths),
        checklist: reconcileChecklist(checklist, task.checklist),
        ...currentPlanningFields(),
        expectedVersion: draft.baseVersion,
        idempotencyKey: crypto.randomUUID(),
      });
      if (!response.ok) setError(response.error.message);
      else draft.accept(response.task);
    } catch {
      setError("Helm could not prepare the task.");
    } finally {
      setPending(false);
    }
  }

  async function changeReviewModeOverride() {
    if (!editable || reviewModeOverride === task.reviewModeOverride) return;
    if (!reviewModeReason.trim()) {
      setError("Explain why the task review policy is changing.");
      return;
    }
    setPending(true);
    setError(null);
    try {
      const response = await onSetReviewModeOverride({
        projectId: task.projectId,
        taskId: task.id,
        reviewModeOverride,
        expectedTaskVersion: task.version,
        reason: reviewModeReason.trim(),
        idempotencyKey: crypto.randomUUID(),
      });
      if (!response.ok) setError(response.error.message);
    } catch {
      setError("Helm could not change the task review policy.");
    } finally {
      setPending(false);
    }
  }

  async function archive() {
    if (
      !window.confirm(
        "Archive this task? It will leave the work queue but remain available in archived search.",
      )
    )
      return;
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
      <form noValidate onSubmit={prepare} {...stylex.props(styles.form)} aria-label="Prepare task">
        {task.archivedAt ? <p {...stylex.props(styles.hint)}>Archived task</p> : null}
        <fieldset disabled={!editable || pending} {...stylex.props(styles.editableFields)}>
          <legend {...stylex.props(styles.srOnly)}>Task summary</legend>
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
          <section aria-labelledby={`task-description-${task.id}`} {...stylex.props(styles.field)}>
            <div {...stylex.props(styles.descriptionHeader)}>
              <div>
                <h3 id={`task-description-${task.id}`} {...stylex.props(styles.fieldLabel)}>
                  Description
                </h3>
                <p {...stylex.props(styles.hint)}>Background and context for this task.</p>
              </div>
              {editable ? (
                <button
                  type="button"
                  aria-controls={`task-description-editor-${task.id}`}
                  aria-disabled={editorModule.state.status === "loading"}
                  aria-expanded={editorModule.state.status === "ready"}
                  onFocus={editorModule.preload}
                  onPointerEnter={editorModule.preload}
                  onClick={() => {
                    if (editorModule.state.status === "idle") editorModule.activate();
                    if (editorModule.state.status === "error") editorModule.retry();
                  }}
                  {...stylex.props(styles.button, styles.buttonQuiet)}
                >
                  Edit description
                </button>
              ) : null}
            </div>
            <p aria-label="Task description" {...stylex.props(styles.readableDescription)}>
              {task.descriptionText || "No description has been added."}
            </p>
            <div id={`task-description-editor-${task.id}`}>
              {editorModule.state.status === "ready" ? (
                <editorModule.state.module.default
                  value={description}
                  onChange={setDescription}
                  editable={editable}
                />
              ) : editorModule.state.status === "error" ? (
                <LazyDetailFailure surface="editor" onRetry={editorModule.retry} />
              ) : editorModule.state.status === "loading" ? (
                <LazyDetailFallback surface="editor" />
              ) : null}
            </div>
          </section>
        </fieldset>
        {draft.dirty ? (
          <output {...stylex.props(styles.draftStatus)}>
            Unsaved changes ·{" "}
            {draft.storageAvailable
              ? "Draft kept in this tab"
              : "Browser storage unavailable; save before leaving"}
          </output>
        ) : (
          <output {...stylex.props(styles.hint)}>All changes saved</output>
        )}
        {draft.conflict ? (
          <section role="alert" {...stylex.props(styles.conflict)}>
            <strong>This task changed while you were editing.</strong>
            <p>
              Your draft is safe. Review the latest task before saving. Keeping your edits replaces
              only fields you changed.
            </p>
            <div {...stylex.props(styles.footerActions)}>
              <button
                type="button"
                {...stylex.props(styles.button, styles.buttonQuiet)}
                onClick={() => {
                  if (window.confirm("Discard your unsaved edits and use the latest saved task?"))
                    draft.discard();
                }}
              >
                Use latest saved task
              </button>
              {editable ? (
                <button type="button" {...stylex.props(styles.button)} onClick={draft.rebase}>
                  Keep my edited fields
                </button>
              ) : (
                <span>
                  This task is {task.lifecycle.replaceAll("_", " ")}. Your draft remains available
                  here.
                </span>
              )}
            </div>
          </section>
        ) : null}
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
                Stopping a claim returns the task to Ready. Use Cancel task below to stop the work
                entirely.
              </p>
              <div {...stylex.props(styles.claimActionButtons)}>
                <button
                  type="button"
                  disabled={pending || claimReason.trim().length === 0}
                  onClick={() => void invalidateClaim("cancelled")}
                  {...stylex.props(styles.button, styles.buttonQuiet)}
                >
                  {claimPendingDisposition === "cancelled" ? "Stopping claim…" : "Stop claim"}
                </button>
                <button
                  type="button"
                  disabled={pending || claimReason.trim().length === 0}
                  onClick={() => void invalidateClaim("reassigned")}
                  {...stylex.props(styles.button)}
                >
                  {claimPendingDisposition === "reassigned"
                    ? "Making available…"
                    : "Make available for reassignment"}
                </button>
              </div>
            </fieldset>
          </section>
        ) : null}
        <fieldset
          disabled={!editable || pending}
          {...stylex.props(styles.editableFields, !editable && styles.readOnlyGroup)}
        >
          <legend {...stylex.props(styles.srOnly)}>Editable task details</legend>
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
        <details {...stylex.props(styles.disclosure)}>
          <summary {...stylex.props(styles.summary)}>Planning and agent instructions</summary>
          <fieldset disabled={!editable || pending} {...stylex.props(styles.editableFields)}>
            <legend {...stylex.props(styles.srOnly)}>Planning and agent instructions</legend>
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
            <Field label="Review policy" hint="Explain any exception to the project review policy.">
              <div {...stylex.props(styles.reviewPolicyCommand)}>
                <select
                  aria-label="Task review policy override"
                  value={reviewModeOverride ?? ""}
                  onChange={(event) =>
                    setReviewModeOverride(
                      event.target.value === ""
                        ? null
                        : event.target.value === "required"
                          ? "required"
                          : "direct",
                    )
                  }
                  {...stylex.props(styles.select, styles.fullWidth)}
                >
                  <option value="">Inherit project or tags</option>
                  <option value="required">Require human review</option>
                  <option value="direct">Complete directly</option>
                </select>
                <input
                  aria-label="Review policy change reason"
                  value={reviewModeReason}
                  onChange={(event) => setReviewModeReason(event.target.value)}
                  placeholder="Why should this task differ?"
                  maxLength={1_000}
                  disabled={reviewModeOverride === task.reviewModeOverride}
                  {...stylex.props(styles.input)}
                />
                <button
                  type="button"
                  disabled={
                    pending ||
                    reviewModeOverride === task.reviewModeOverride ||
                    reviewModeReason.trim().length === 0
                  }
                  onClick={() => void changeReviewModeOverride()}
                  {...stylex.props(styles.button, styles.buttonQuiet)}
                >
                  Apply review policy
                </button>
              </div>
            </Field>
            {task.customFields.length > 0 ? (
              <section aria-label="Custom fields" {...stylex.props(styles.customFields)}>
                <div>
                  <p {...stylex.props(styles.fieldLabel)}>Custom fields</p>
                  <p {...stylex.props(styles.hint)}>
                    Project-defined typed values are shared with filters, bulk actions, and agents.
                  </p>
                </div>
                <div {...stylex.props(styles.planningGrid)}>
                  {task.customFields.map((assignment) => (
                    <CustomFieldControl
                      key={assignment.definition.id}
                      assignment={assignment}
                      explicitValue={customFieldValues[assignment.definition.id] ?? null}
                      disabled={!editable || assignment.definition.retiredAt !== null}
                      onChange={(value) =>
                        setCustomFieldValues((current) => ({
                          ...current,
                          [assignment.definition.id]: value,
                        }))
                      }
                    />
                  ))}
                </div>
              </section>
            ) : null}
            <Field label="Tags" hint="Use tags to organize related work.">
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
                      <button
                        type="button"
                        aria-label={`Remove tag ${tag.name || index + 1}`}
                        disabled={pending}
                        onClick={() =>
                          setTagInputs((current) =>
                            current.filter((_, tagIndex) => tagIndex !== index),
                          )
                        }
                        {...stylex.props(styles.button, styles.buttonQuiet, styles.iconButton)}
                      >
                        <X size={15} aria-hidden="true" />
                      </button>
                    </div>
                  );
                })}
                <button
                  type="button"
                  disabled={pending}
                  onClick={addTag}
                  {...stylex.props(styles.button, styles.buttonQuiet)}
                >
                  <Plus size={15} aria-hidden="true" /> Add tag
                </button>
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
              hint="One file or folder path per line, relative to the repository."
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
            <Field
              label="Agent context"
              hint="Paths, constraints, and execution-specific guidance."
            >
              <textarea
                aria-label="Agent context"
                value={agentContext}
                onChange={(event) => setAgentContext(event.target.value)}
                rows={3}
                {...stylex.props(styles.textarea)}
              />
            </Field>
          </fieldset>
          {task.reviewPolicy ? (
            <section aria-label="Effective review policy" {...stylex.props(styles.policyCard)}>
              <div>
                <p {...stylex.props(styles.fieldLabel)}>Effective review policy</p>
                <strong>
                  {task.reviewPolicy.mode === "required" ? "Human review" : "Direct completion"}
                </strong>
              </div>
              <p {...stylex.props(styles.hint)}>{task.reviewPolicy.explanation}</p>
            </section>
          ) : null}
        </details>
        <details {...stylex.props(styles.disclosure)}>
          <summary {...stylex.props(styles.summary)}>Subtasks and relationships</summary>
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
              <button
                type="button"
                disabled={pending || childTitle.trim().length === 0}
                onClick={() => void createChild()}
                {...stylex.props(styles.button)}
              >
                <GitBranch size={16} aria-hidden="true" />
                Add child
              </button>
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
              <button
                type="button"
                disabled={pending || !relationTargetId}
                onClick={() => void createRelation()}
                {...stylex.props(styles.button)}
              >
                <Link2 size={16} aria-hidden="true" />
                Add relation
              </button>
            </div>
          </fieldset>
        </details>
        {error ? (
          <p role="alert" {...stylex.props(styles.error)}>
            {error}
          </p>
        ) : null}
        <div {...stylex.props(styles.formFooter)}>
          <p>
            {task.lifecycle === "backlog"
              ? "Save a draft now. Mark ready when the instructions are complete."
              : "Save all changes to this task."}
          </p>
          <span {...stylex.props(styles.footerActions)}>
            {editable ? (
              <>
                <button
                  type="submit"
                  disabled={pending || draft.conflict}
                  {...stylex.props(styles.button, styles.buttonQuiet)}
                >
                  {pending
                    ? "Saving…"
                    : task.lifecycle === "backlog"
                      ? "Save draft"
                      : "Save changes"}
                </button>
                {task.lifecycle === "backlog" ? (
                  <button
                    type="button"
                    onClick={(event) => {
                      if (event.currentTarget.form?.reportValidity()) void savePreparation(false);
                    }}
                    disabled={pending || draft.conflict}
                    {...stylex.props(styles.button)}
                  >
                    <CheckCircle2 size={16} aria-hidden="true" />
                    {pending ? "Saving…" : "Move to ready"}
                  </button>
                ) : null}
              </>
            ) : (
              <span {...stylex.props(styles.hint)}>{readOnlyExplanation(task.lifecycle)}</span>
            )}
          </span>
        </div>
      </form>
      <button
        type="button"
        aria-controls={`task-collaboration-${task.id}`}
        aria-disabled={
          collaborationModule.state.status === "loading" ||
          collaborationModule.state.status === "ready"
        }
        aria-expanded={collaborationModule.state.status === "ready"}
        onFocus={collaborationModule.preload}
        onPointerEnter={collaborationModule.preload}
        onClick={() => {
          if (collaborationModule.state.status === "idle") collaborationModule.activate();
          if (collaborationModule.state.status === "error") collaborationModule.retry();
        }}
        {...stylex.props(styles.intentButton)}
      >
        Open collaboration
      </button>
      <div id={`task-collaboration-${task.id}`}>
        {collaborationModule.state.status === "ready" ? (
          <collaborationModule.state.module.default
            task={task}
            entries={activityEntries}
            blockers={manualBlockers}
            onCreateEntry={onCreateActivityEntry}
            onWithdrawEntry={onWithdrawActivityEntry}
            onCreateBlocker={onCreateManualBlocker}
            onResolveBlocker={onResolveManualBlocker}
          />
        ) : collaborationModule.state.status === "error" ? (
          <LazyDetailFailure surface="collaboration" onRetry={collaborationModule.retry} />
        ) : collaborationModule.state.status === "loading" ? (
          <LazyDetailFallback surface="collaboration" />
        ) : null}
      </div>
      <div>
        <button
          type="button"
          disabled={pending || executionReadOnly}
          onClick={() => void archive()}
          {...stylex.props(styles.button, styles.buttonQuiet)}
        >
          <Archive size={15} aria-hidden="true" /> Archive
        </button>
      </div>
    </div>
  );
}

function parseLines(value: string) {
  return value
    .split("\n")
    .map((line) => line.trim())
    .filter(Boolean);
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

function customFieldValueText(value: CustomFieldValue | null) {
  if (value === null) return "unset";
  if (value.type === "boolean") return value.value ? "yes" : "no";
  return String(value.value);
}

function customFieldHint(assignment: TaskCustomFieldAssignment) {
  const details = [assignment.definition.display.description];
  if (assignment.definition.retiredAt) {
    details.push("Retired; the historical value is read-only.");
  } else if (assignment.definition.defaultValue) {
    details.push(`Default: ${customFieldValueText(assignment.definition.defaultValue)}.`);
  } else {
    details.push("No project default.");
  }
  return details.filter(Boolean).join(" ");
}

function CustomFieldControl({
  assignment,
  explicitValue,
  disabled,
  onChange,
}: {
  assignment: TaskCustomFieldAssignment;
  explicitValue: CustomFieldValue | null;
  disabled: boolean;
  onChange: (value: CustomFieldValue | null) => void;
}) {
  const definition: CustomFieldDefinition = assignment.definition;
  const label = definition.display.label;
  const common = {
    disabled,
    "aria-label": `Custom field: ${label}`,
  } as const;
  let control: ReactNode;

  switch (definition.type) {
    case "text":
      control = (
        <input
          {...common}
          value={explicitValue?.type === "text" ? explicitValue.value : ""}
          placeholder={
            definition.defaultValue?.type === "text" ? definition.defaultValue.value : undefined
          }
          minLength={definition.validation.minLength}
          maxLength={definition.validation.maxLength}
          onChange={(event) => onChange({ type: "text", value: event.target.value })}
          {...stylex.props(styles.input)}
        />
      );
      break;
    case "number":
      control = (
        <input
          {...common}
          type="number"
          value={explicitValue?.type === "number" ? explicitValue.value : ""}
          placeholder={
            definition.defaultValue?.type === "number"
              ? String(definition.defaultValue.value)
              : undefined
          }
          min={definition.validation.min ?? undefined}
          max={definition.validation.max ?? undefined}
          step={definition.validation.integer ? 1 : "any"}
          onChange={(event) =>
            onChange(
              event.target.value === ""
                ? null
                : { type: "number", value: Number(event.target.value) },
            )
          }
          {...stylex.props(styles.input)}
        />
      );
      break;
    case "boolean":
      control = (
        <select
          {...common}
          value={explicitValue?.type === "boolean" ? String(explicitValue.value) : ""}
          onChange={(event) =>
            onChange(
              event.target.value === ""
                ? null
                : { type: "boolean", value: event.target.value === "true" },
            )
          }
          {...stylex.props(styles.select, styles.fullWidth)}
        >
          <option value="">Use project default</option>
          <option value="true">Yes</option>
          <option value="false">No</option>
        </select>
      );
      break;
    case "date":
      control = (
        <input
          {...common}
          type="date"
          value={explicitValue?.type === "date" ? explicitValue.value : ""}
          min={definition.validation.min ?? undefined}
          max={definition.validation.max ?? undefined}
          onChange={(event) =>
            onChange(event.target.value === "" ? null : { type: "date", value: event.target.value })
          }
          {...stylex.props(styles.input)}
        />
      );
      break;
    case "single_select":
      control = (
        <select
          {...common}
          value={explicitValue?.type === "single_select" ? explicitValue.value : ""}
          onChange={(event) =>
            onChange(
              event.target.value === ""
                ? null
                : { type: "single_select", value: event.target.value },
            )
          }
          {...stylex.props(styles.select, styles.fullWidth)}
        >
          <option value="">Use project default</option>
          {definition.validation.options.map((option) => (
            <option key={option.id} value={option.id}>
              {option.label}
            </option>
          ))}
        </select>
      );
      break;
  }

  return (
    <Field
      label={`${label}${definition.retiredAt ? " (retired)" : ""}`}
      hint={customFieldHint(assignment)}
    >
      {definition.retiredAt ? (
        <output aria-label={`Custom field: ${label}`} {...stylex.props(styles.readOnlyValue)}>
          {customFieldValueText(assignment.value)}
        </output>
      ) : (
        <div {...stylex.props(styles.customFieldInput)}>
          {control}
          <button
            type="button"
            disabled={disabled || explicitValue === null}
            onClick={() => onChange(null)}
            {...stylex.props(styles.button, styles.buttonQuiet)}
          >
            Use default
          </button>
        </div>
      )}
    </Field>
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
  const id = useId();
  const child =
    Children.count(children) === 1 &&
    isValidElement<{ id?: string; "aria-describedby"?: string }>(children)
      ? children
      : null;
  const directControl =
    child && typeof child.type === "string" && ["input", "select", "textarea"].includes(child.type);
  return (
    <div {...stylex.props(styles.field)}>
      <label
        htmlFor={directControl ? (child.props.id ?? id) : undefined}
        {...stylex.props(styles.fieldLabel)}
      >
        {label} {required ? <span {...stylex.props(styles.required)}>Required</span> : null}
      </label>
      {directControl
        ? cloneElement(child, {
            id: child.props.id ?? id,
            "aria-describedby": hint ? `${id}-hint` : child.props["aria-describedby"],
          })
        : children}
      {hint ? (
        <span id={`${id}-hint`} {...stylex.props(styles.hint)}>
          {hint}
        </span>
      ) : null}
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
  collaborationFallback: { minHeight: 240 },
  editorFallback: { minHeight: 184 },
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
    minHeight: 40,
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
  select: {
    minWidth: 0,
    width: "100%",
    backgroundColor: tokens.surface,
    borderColor: tokens.border,
    borderRadius: 6,
    color: tokens.foreground,
    minHeight: 32,
  },
  fullWidth: { width: "100%" },
  input: {
    minWidth: 0,
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
  detailStack: {
    display: "grid",
    gap: tokens.space5,
    marginInline: "auto",
    maxWidth: 960,
    minWidth: 0,
    width: "100%",
  },
  disclosure: {
    borderBlockStart: `1px solid ${tokens.border}`,
    paddingBlockStart: tokens.space3,
    minWidth: 0,
  },
  summary: {
    cursor: "pointer",
    fontSize: 14,
    fontWeight: 650,
    paddingBlock: tokens.space3,
    ":focus-visible": { outline: `2px solid ${tokens.accent}`, outlineOffset: 2 },
  },
  draftStatus: { color: tokens.accent, fontSize: 12, margin: 0 },
  conflict: {
    backgroundColor: tokens.surfaceMuted,
    border: `1px solid ${tokens.accent}`,
    borderRadius: tokens.radius2,
    padding: tokens.space4,
    fontSize: 13,
  },
  form: {
    display: "grid",
    gap: tokens.space5,
    margin: "0 auto",
    maxWidth: 960,
    width: "100%",
    minWidth: 0,
  },
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
  descriptionHeader: {
    alignItems: "start",
    display: "flex",
    gap: tokens.space3,
    justifyContent: "space-between",
  },
  readableDescription: {
    backgroundColor: tokens.surfaceMuted,
    borderColor: tokens.border,
    borderRadius: tokens.radius2,
    borderStyle: "solid",
    borderWidth: 1,
    color: tokens.foreground,
    lineHeight: 1.55,
    margin: 0,
    minHeight: 72,
    padding: tokens.space3,
    whiteSpace: "pre-wrap",
  },
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
  policyCard: {
    alignItems: "center",
    backgroundColor: tokens.surfaceMuted,
    borderColor: tokens.border,
    borderRadius: tokens.radius2,
    borderStyle: "solid",
    borderWidth: 1,
    display: "grid",
    gap: tokens.space4,
    gridTemplateColumns: "minmax(150px, auto) minmax(0, 1fr)",
    padding: tokens.space3,
    "@media (max-width: 560px)": { gridTemplateColumns: "1fr" },
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
  field: { display: "grid", gap: tokens.space2, minWidth: 0 },
  fieldLabel: { fontSize: 13, fontWeight: 700, margin: 0 },
  planningGrid: {
    display: "grid",
    gap: tokens.space3,
    gridTemplateColumns: "repeat(auto-fit, minmax(min(100%, 180px), 1fr))",
  },
  customFields: {
    borderBlockColor: tokens.border,
    borderBlockStyle: "solid",
    borderBlockWidth: 1,
    display: "grid",
    gap: tokens.space3,
    paddingBlock: tokens.space4,
  },
  customFieldInput: {
    alignItems: "center",
    display: "grid",
    gap: tokens.space2,
    gridTemplateColumns: "minmax(0, 1fr) auto",
  },
  reviewPolicyCommand: { display: "grid", gap: tokens.space2 },
  readOnlyValue: {
    backgroundColor: tokens.surfaceMuted,
    borderColor: tokens.border,
    borderRadius: tokens.radius2,
    borderStyle: "solid",
    borderWidth: 1,
    color: tokens.foregroundMuted,
    minHeight: 40,
    padding: tokens.space3,
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
    minWidth: 0,
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
  hint: { color: tokens.foregroundMuted, fontSize: 11, lineHeight: 1.5, margin: 0 },
  error: { color: tokens.danger, fontSize: 13, margin: 0 },
  formFooter: {
    position: "sticky",
    bottom: 0,
    backgroundColor: tokens.surface,
    paddingBlock: tokens.space3,
    gap: tokens.space3,
    flexWrap: "wrap",
    zIndex: 2,
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
