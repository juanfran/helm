import { useMemo, useState, type FormEvent } from "react";
import { Dialog } from "@base-ui/react/dialog";
import * as stylex from "@stylexjs/stylex";
import { AlertTriangle, History, RotateCcw, ShieldCheck, XCircle } from "lucide-react";

import { Button } from "../../components/ui/button";
import type {
  ApproveTaskReviewInput,
  CancelTaskInput,
  ReopenTaskInput,
  RequestTaskChangesInput,
  RestoreCancelledTaskInput,
  Task,
  TaskAttemptSummary,
} from "../../domain/tasks";
import type { TaskTransitionCommandResponse } from "../../server/task-adapter";
import { tokens } from "../../styles/tokens.stylex";

export type TaskExecutionPanelProps = {
  task: Task;
  attempts: readonly TaskAttemptSummary[];
  onApproveReview: (input: ApproveTaskReviewInput) => Promise<TaskTransitionCommandResponse>;
  onRequestChanges: (input: RequestTaskChangesInput) => Promise<TaskTransitionCommandResponse>;
  onCancelTask: (input: CancelTaskInput) => Promise<TaskTransitionCommandResponse>;
  onRestoreTask: (input: RestoreCancelledTaskInput) => Promise<TaskTransitionCommandResponse>;
  onReopenTask: (input: ReopenTaskInput) => Promise<TaskTransitionCommandResponse>;
};

type PendingAction = "approve" | "changes" | "cancel" | "restore" | "reopen" | null;

function lines(value: string) {
  return value
    .split("\n")
    .map((line) => line.trim())
    .filter(Boolean);
}

function formatTimestamp(value: string) {
  const timestamp = new Date(value);
  if (Number.isNaN(timestamp.getTime())) return value;
  return new Intl.DateTimeFormat(undefined, {
    dateStyle: "medium",
    timeStyle: "short",
  }).format(timestamp);
}

function lifecycleLabel(lifecycle: NonNullable<Task["cancelledFromLifecycle"]>) {
  if (lifecycle === "in_progress") return "Ready";
  return lifecycle.charAt(0).toUpperCase() + lifecycle.slice(1);
}

function restoreDestination(task: Task) {
  return task.cancelledFromLifecycle === "in_progress" ? "ready" : task.cancelledFromLifecycle;
}

function ReportList({ label, values }: { label: string; values: readonly string[] }) {
  return (
    <div {...stylex.props(styles.reportField)}>
      <dt {...stylex.props(styles.reportTerm)}>{label}</dt>
      <dd {...stylex.props(styles.reportValue)}>
        {values.length > 0 ? (
          <ul {...stylex.props(styles.reportList)}>
            {values.map((value, index) => (
              <li key={String(index) + ":" + value}>{value}</li>
            ))}
          </ul>
        ) : (
          <span {...stylex.props(styles.muted)}>None reported.</span>
        )}
      </dd>
    </div>
  );
}

function AttemptCard({
  attempt,
  prominent = false,
}: {
  attempt: TaskAttemptSummary;
  prominent?: boolean;
}) {
  return (
    <article {...stylex.props(styles.attempt, prominent && styles.attemptProminent)}>
      <header {...stylex.props(styles.attemptHeader)}>
        <div>
          <p {...stylex.props(styles.attemptEyebrow)}>Attempt {attempt.attemptNumber}</p>
          <strong>{attempt.agentDisplayName ?? "Unattributed agent"}</strong>
        </div>
        <span
          {...stylex.props(
            styles.attemptStatus,
            (attempt.status === "failed" || attempt.status === "cancelled") &&
              styles.attemptStatusDanger,
          )}
        >
          {attempt.status.replace("_", " ")}
        </span>
      </header>
      <p {...stylex.props(styles.summary)}>
        {attempt.summary.trim() || "Work is still in progress."}
      </p>
      {attempt.failureClassification ? (
        <p {...stylex.props(styles.failure)}>
          Failure classification: {attempt.failureClassification}
        </p>
      ) : null}
      <dl {...stylex.props(styles.report)}>
        <ReportList label="Changed areas" values={attempt.changedAreas} />
        <div {...stylex.props(styles.reportField)}>
          <dt {...stylex.props(styles.reportTerm)}>Verification</dt>
          <dd {...stylex.props(styles.reportValue)}>
            {attempt.verificationResults.length > 0 ? (
              <ul {...stylex.props(styles.verificationList)}>
                {attempt.verificationResults.map((result, index) => (
                  <li key={String(index) + ":" + result.name}>
                    <strong>{result.name}</strong>
                    <span
                      {...stylex.props(
                        styles.verificationStatus,
                        result.status === "failed" && styles.verificationFailed,
                      )}
                    >
                      {result.status.replace("_", " ")}
                    </span>
                    {result.details ? (
                      <p {...stylex.props(styles.verificationDetail)}>{result.details}</p>
                    ) : null}
                  </li>
                ))}
              </ul>
            ) : (
              <span {...stylex.props(styles.muted)}>None reported.</span>
            )}
          </dd>
        </div>
        <ReportList label="References" values={attempt.references} />
        <ReportList label="Risks" values={attempt.risks} />
        <ReportList label="Follow-up work" values={attempt.followUpWork} />
      </dl>
      <p {...stylex.props(styles.timestamp)}>
        Started <time dateTime={attempt.createdAt}>{formatTimestamp(attempt.createdAt)}</time>
        {attempt.completedAt ? (
          <>
            {" · Finished "}
            <time dateTime={attempt.completedAt}>{formatTimestamp(attempt.completedAt)}</time>
          </>
        ) : null}
      </p>
    </article>
  );
}

export function TaskExecutionPanel({
  task,
  attempts,
  onApproveReview,
  onRequestChanges,
  onCancelTask,
  onRestoreTask,
  onReopenTask,
}: TaskExecutionPanelProps) {
  const taskAttempts = useMemo(
    () =>
      attempts
        .filter((attempt) => attempt.taskId === task.id)
        .toSorted((left, right) =>
          left.attemptNumber === right.attemptNumber
            ? left.id.localeCompare(right.id)
            : left.attemptNumber - right.attemptNumber,
        ),
    [attempts, task.id],
  );
  const highlightedAttempt = task.reviewAttemptId
    ? taskAttempts.find((attempt) => attempt.id === task.reviewAttemptId)
    : taskAttempts.at(-1);
  const reviewEvidenceReady = Boolean(
    task.reviewAttemptId && highlightedAttempt?.status === "completed",
  );
  const priorAttempts = highlightedAttempt
    ? taskAttempts.filter((attempt) => attempt.id !== highlightedAttempt.id)
    : taskAttempts;
  const [approvalSummary, setApprovalSummary] = useState("");
  const [changeSummary, setChangeSummary] = useState("");
  const [requestedChanges, setRequestedChanges] = useState("");
  const [cancelReason, setCancelReason] = useState("");
  const [restoreReason, setRestoreReason] = useState("");
  const [reopenReason, setReopenReason] = useState("");
  const [reopenDestination, setReopenDestination] = useState<"ready" | "backlog">("ready");
  const [pendingAction, setPendingAction] = useState<PendingAction>(null);
  const [error, setError] = useState<string | null>(null);
  const pending = pendingAction !== null;

  async function approve(event: FormEvent<HTMLFormElement>) {
    event.preventDefault();
    if (!task.reviewAttemptId || !reviewEvidenceReady || !approvalSummary.trim()) return;
    setPendingAction("approve");
    setError(null);
    try {
      const response = await onApproveReview({
        taskId: task.id,
        attemptId: task.reviewAttemptId,
        expectedVersion: task.version,
        summary: approvalSummary.trim(),
        idempotencyKey: crypto.randomUUID(),
      });
      if (response.ok) setApprovalSummary("");
      else setError(response.error.message);
    } catch {
      setError("Helm could not approve this review.");
    } finally {
      setPendingAction(null);
    }
  }

  async function requestChanges(event: FormEvent<HTMLFormElement>) {
    event.preventDefault();
    const requested = lines(requestedChanges);
    if (
      !task.reviewAttemptId ||
      !reviewEvidenceReady ||
      !changeSummary.trim() ||
      requested.length === 0
    )
      return;
    setPendingAction("changes");
    setError(null);
    try {
      const response = await onRequestChanges({
        entryId: crypto.randomUUID(),
        taskId: task.id,
        attemptId: task.reviewAttemptId,
        expectedVersion: task.version,
        summary: changeSummary.trim(),
        requestedChanges: requested,
        idempotencyKey: crypto.randomUUID(),
      });
      if (response.ok) {
        setChangeSummary("");
        setRequestedChanges("");
      } else setError(response.error.message);
    } catch {
      setError("Helm could not request changes.");
    } finally {
      setPendingAction(null);
    }
  }

  async function cancel(event: FormEvent<HTMLFormElement>) {
    event.preventDefault();
    if (!cancelReason.trim()) return;
    setPendingAction("cancel");
    setError(null);
    try {
      const response = await onCancelTask({
        taskId: task.id,
        expectedVersion: task.version,
        reason: cancelReason.trim(),
        idempotencyKey: crypto.randomUUID(),
      });
      if (response.ok) setCancelReason("");
      else setError(response.error.message);
    } catch {
      setError("Helm could not cancel this task.");
    } finally {
      setPendingAction(null);
    }
  }

  async function restore(event: FormEvent<HTMLFormElement>) {
    event.preventDefault();
    if (!restoreReason.trim()) return;
    setPendingAction("restore");
    setError(null);
    try {
      const response = await onRestoreTask({
        taskId: task.id,
        expectedVersion: task.version,
        reason: restoreReason.trim(),
        idempotencyKey: crypto.randomUUID(),
      });
      if (response.ok) setRestoreReason("");
      else setError(response.error.message);
    } catch {
      setError("Helm could not restore this task.");
    } finally {
      setPendingAction(null);
    }
  }

  async function reopen(event: FormEvent<HTMLFormElement>) {
    event.preventDefault();
    if (!reopenReason.trim()) return;
    setPendingAction("reopen");
    setError(null);
    try {
      const response = await onReopenTask({
        taskId: task.id,
        destination: reopenDestination,
        expectedVersion: task.version,
        reason: reopenReason.trim(),
        idempotencyKey: crypto.randomUUID(),
      });
      if (response.ok) setReopenReason("");
      else setError(response.error.message);
    } catch {
      setError("Helm could not reopen this task.");
    } finally {
      setPendingAction(null);
    }
  }

  const cancellable =
    !task.archivedAt && ["backlog", "ready", "in_progress", "review"].includes(task.lifecycle);
  const destination = restoreDestination(task);
  const headingId = "execution-heading-" + task.id;

  return (
    <section aria-labelledby={headingId} {...stylex.props(styles.root)}>
      <div {...stylex.props(styles.headingRow)}>
        <div>
          <p {...stylex.props(styles.eyebrow)}>Execution record</p>
          <h2 id={headingId} {...stylex.props(styles.heading)}>
            {task.lifecycle === "review" ? "Review completed work" : "History and actions"}
          </h2>
        </div>
        <span {...stylex.props(styles.attemptCount)}>
          <History size={14} aria-hidden="true" /> {taskAttempts.length}{" "}
          {taskAttempts.length === 1 ? "attempt" : "attempts"}
        </span>
      </div>

      {highlightedAttempt ? (
        <AttemptCard attempt={highlightedAttempt} prominent={task.lifecycle === "review"} />
      ) : task.lifecycle === "review" ? (
        <p role="alert" {...stylex.props(styles.error)}>
          The completion report for this review is not available yet.
        </p>
      ) : (
        <p {...stylex.props(styles.muted)}>No execution attempts yet.</p>
      )}

      {priorAttempts.length > 0 ? (
        <details {...stylex.props(styles.history)}>
          <summary>Previous attempts ({priorAttempts.length})</summary>
          <div {...stylex.props(styles.historyList)}>
            {priorAttempts.map((attempt) => (
              <AttemptCard key={attempt.id} attempt={attempt} />
            ))}
          </div>
        </details>
      ) : null}

      {task.lifecycle === "review" ? (
        <section aria-label="Review actions" {...stylex.props(styles.actionGroup)}>
          <div>
            <p {...stylex.props(styles.eyebrow)}>Human decision</p>
            <h3 {...stylex.props(styles.actionHeading)}>Review actions</h3>
          </div>
          <div {...stylex.props(styles.reviewActions)}>
            <form
              aria-label="Approve task review"
              onSubmit={approve}
              {...stylex.props(styles.actionForm)}
            >
              <fieldset
                disabled={pending || !reviewEvidenceReady}
                {...stylex.props(styles.fieldset)}
              >
                <label htmlFor={"approval-summary-" + task.id}>Approval summary</label>
                <textarea
                  id={"approval-summary-" + task.id}
                  value={approvalSummary}
                  onChange={(event) => setApprovalSummary(event.target.value)}
                  rows={3}
                  maxLength={5_000}
                  required
                  placeholder="Why does this result satisfy the task?"
                  {...stylex.props(styles.textarea)}
                />
                <Button type="submit" disabled={pending || approvalSummary.trim().length === 0}>
                  <ShieldCheck size={15} aria-hidden="true" />
                  {pendingAction === "approve" ? "Approving…" : "Approve"}
                </Button>
              </fieldset>
            </form>
            <form
              aria-label="Request task changes"
              onSubmit={requestChanges}
              {...stylex.props(styles.actionForm)}
            >
              <fieldset
                disabled={pending || !reviewEvidenceReady}
                {...stylex.props(styles.fieldset)}
              >
                <label htmlFor={"change-summary-" + task.id}>Change request summary</label>
                <input
                  id={"change-summary-" + task.id}
                  value={changeSummary}
                  onChange={(event) => setChangeSummary(event.target.value)}
                  maxLength={5_000}
                  required
                  {...stylex.props(styles.input)}
                />
                <label htmlFor={"requested-changes-" + task.id}>Requested changes</label>
                <textarea
                  id={"requested-changes-" + task.id}
                  value={requestedChanges}
                  onChange={(event) => setRequestedChanges(event.target.value)}
                  rows={4}
                  maxLength={20_000}
                  required
                  placeholder="One concrete change per line"
                  {...stylex.props(styles.textarea)}
                />
                <Button
                  type="submit"
                  variant="quiet"
                  disabled={
                    pending ||
                    changeSummary.trim().length === 0 ||
                    lines(requestedChanges).length === 0
                  }
                >
                  <RotateCcw size={15} aria-hidden="true" />
                  {pendingAction === "changes" ? "Requesting…" : "Request changes"}
                </Button>
              </fieldset>
            </form>
          </div>
        </section>
      ) : null}

      {task.lifecycle === "cancelled" && !task.archivedAt ? (
        <form
          aria-label="Restore cancelled task"
          onSubmit={restore}
          {...stylex.props(styles.actionForm)}
        >
          <fieldset disabled={pending || !destination} {...stylex.props(styles.fieldset)}>
            <div>
              <p {...stylex.props(styles.eyebrow)}>Cancelled work</p>
              <h3 {...stylex.props(styles.actionHeading)}>Restore task</h3>
            </div>
            <p id={"restore-help-" + task.id} {...stylex.props(styles.hint)}>
              {destination
                ? "This returns the task to " +
                  lifecycleLabel(destination) +
                  " while preserving cancellation history."
                : "Helm cannot determine the task state that preceded cancellation."}
            </p>
            <label htmlFor={"restore-reason-" + task.id}>Restore reason</label>
            <textarea
              id={"restore-reason-" + task.id}
              aria-describedby={"restore-help-" + task.id}
              value={restoreReason}
              onChange={(event) => setRestoreReason(event.target.value)}
              rows={3}
              maxLength={5_000}
              required
              {...stylex.props(styles.textarea)}
            />
            <Button type="submit" disabled={pending || !destination || !restoreReason.trim()}>
              <RotateCcw size={15} aria-hidden="true" />
              {pendingAction === "restore"
                ? "Restoring…"
                : "Restore to " + (destination ? lifecycleLabel(destination) : "previous state")}
            </Button>
          </fieldset>
        </form>
      ) : null}

      {task.lifecycle === "done" && !task.archivedAt ? (
        <form
          aria-label="Reopen completed task"
          onSubmit={reopen}
          {...stylex.props(styles.actionForm)}
        >
          <fieldset disabled={pending} {...stylex.props(styles.fieldset)}>
            <div>
              <p {...stylex.props(styles.eyebrow)}>Further work</p>
              <h3 {...stylex.props(styles.actionHeading)}>Reopen task</h3>
            </div>
            <label htmlFor={"reopen-destination-" + task.id}>Destination</label>
            <select
              id={"reopen-destination-" + task.id}
              value={reopenDestination}
              onChange={(event) =>
                setReopenDestination(event.target.value === "backlog" ? "backlog" : "ready")
              }
              {...stylex.props(styles.select)}
            >
              <option value="ready">Ready for a new attempt</option>
              <option value="backlog">Backlog for preparation</option>
            </select>
            <label htmlFor={"reopen-reason-" + task.id}>Reopen reason</label>
            <textarea
              id={"reopen-reason-" + task.id}
              value={reopenReason}
              onChange={(event) => setReopenReason(event.target.value)}
              rows={3}
              maxLength={1_000}
              required
              {...stylex.props(styles.textarea)}
            />
            <Button type="submit" disabled={pending || !reopenReason.trim()}>
              <RotateCcw size={15} aria-hidden="true" />
              {pendingAction === "reopen" ? "Reopening…" : "Reopen"}
            </Button>
          </fieldset>
        </form>
      ) : null}

      {cancellable ? (
        <Dialog.Root>
          <Dialog.Trigger render={<Button variant="quiet" />}>Cancel task…</Dialog.Trigger>
          <Dialog.Portal>
            <Dialog.Backdrop {...stylex.props(styles.backdrop)} />
            <Dialog.Popup {...stylex.props(styles.dialog)}>
              <Dialog.Title {...stylex.props(styles.actionHeading)}>Cancel this task?</Dialog.Title>
              <Dialog.Description {...stylex.props(styles.hint)}>
                Explain why this work should stop. The task and its history will be kept.
              </Dialog.Description>
              <form aria-label="Cancel task" onSubmit={cancel} {...stylex.props(styles.cancelForm)}>
                {error ? (
                  <p role="alert" {...stylex.props(styles.error)}>
                    {error}
                  </p>
                ) : null}
                <fieldset disabled={pending} {...stylex.props(styles.fieldset)}>
                  <div>
                    <Dialog.Close render={<Button variant="quiet" />}>Keep task</Dialog.Close>
                  </div>
                  <p id={"cancel-help-" + task.id} {...stylex.props(styles.hint)}>
                    {task.lifecycle === "in_progress" || task.claim
                      ? "Cancellation immediately invalidates the active lease, closes its attempt without success, and rejects late agent results."
                      : "Cancellation preserves the task and its history. A later restore is explicitly attributed."}
                  </p>
                  <label htmlFor={"cancel-reason-" + task.id}>Cancellation reason</label>
                  <textarea
                    id={"cancel-reason-" + task.id}
                    aria-describedby={"cancel-help-" + task.id}
                    value={cancelReason}
                    onChange={(event) => setCancelReason(event.target.value)}
                    rows={3}
                    maxLength={5_000}
                    required
                    {...stylex.props(styles.textarea)}
                  />
                  <Button
                    type="submit"
                    variant="danger"
                    disabled={pending || cancelReason.trim().length === 0}
                  >
                    <XCircle size={15} aria-hidden="true" />
                    {pendingAction === "cancel" ? "Cancelling task…" : "Cancel task"}
                  </Button>
                </fieldset>
              </form>
            </Dialog.Popup>
          </Dialog.Portal>
        </Dialog.Root>
      ) : null}

      {error ? (
        <p role="alert" {...stylex.props(styles.error)}>
          <AlertTriangle size={15} aria-hidden="true" /> {error}
        </p>
      ) : null}
    </section>
  );
}

const styles = stylex.create({
  backdrop: { position: "fixed", inset: 0, backgroundColor: "rgba(0,0,0,0.4)", zIndex: 80 },
  dialog: {
    position: "fixed",
    top: "50%",
    left: "50%",
    transform: "translate(-50%, -50%)",
    width: "min(520px, calc(100vw - 32px))",
    maxHeight: "calc(100vh - 32px)",
    overflowY: "auto",
    padding: tokens.space5,
    borderRadius: tokens.radius3,
    backgroundColor: tokens.surface,
    color: tokens.foreground,
    boxShadow: tokens.shadow,
    zIndex: 81,
  },
  root: { display: "grid", gap: tokens.space4, marginBlockEnd: tokens.space6 },
  headingRow: {
    alignItems: "end",
    display: "flex",
    flexWrap: "wrap",
    gap: tokens.space3,
    justifyContent: "space-between",
  },
  eyebrow: {
    color: tokens.accent,
    fontSize: 11,
    fontWeight: 750,
    letterSpacing: "0.09em",
    margin: 0,
    textTransform: "uppercase",
  },
  heading: { fontSize: 22, letterSpacing: "-0.025em", margin: 0 },
  attemptCount: {
    alignItems: "center",
    color: tokens.foregroundMuted,
    display: "inline-flex",
    fontSize: 12,
    gap: tokens.space1,
  },
  attempt: {
    backgroundColor: tokens.surfaceMuted,
    borderColor: tokens.border,
    borderRadius: tokens.radius3,
    borderStyle: "solid",
    borderWidth: 1,
    display: "grid",
    gap: tokens.space3,
    padding: tokens.space4,
  },
  attemptProminent: { borderInlineStartColor: tokens.accent, borderInlineStartWidth: 4 },
  attemptHeader: {
    alignItems: "start",
    display: "flex",
    gap: tokens.space3,
    justifyContent: "space-between",
  },
  attemptEyebrow: {
    color: tokens.foregroundMuted,
    fontSize: 11,
    margin: 0,
    textTransform: "uppercase",
  },
  attemptStatus: {
    borderColor: tokens.border,
    borderRadius: "999px",
    borderStyle: "solid",
    borderWidth: 1,
    color: tokens.accent,
    fontSize: 10,
    fontWeight: 750,
    paddingBlock: 2,
    paddingInline: 8,
    textTransform: "uppercase",
  },
  attemptStatusDanger: { color: tokens.danger },
  summary: { fontSize: 15, lineHeight: 1.55, margin: 0, whiteSpace: "pre-wrap" },
  failure: { color: tokens.danger, fontSize: 13, fontWeight: 650, margin: 0 },
  report: {
    display: "grid",
    gap: tokens.space3,
    gridTemplateColumns: "repeat(2, minmax(0, 1fr))",
    margin: 0,
    "@media (max-width: 680px)": { gridTemplateColumns: "1fr" },
  },
  reportField: { display: "grid", gap: tokens.space1, minWidth: 0, overflowWrap: "anywhere" },
  reportTerm: { fontSize: 12, fontWeight: 750 },
  reportValue: { fontSize: 13, margin: 0 },
  reportList: {
    display: "grid",
    gap: tokens.space1,
    margin: 0,
    paddingInlineStart: tokens.space4,
  },
  verificationList: {
    display: "grid",
    gap: tokens.space2,
    listStyle: "none",
    margin: 0,
    padding: 0,
  },
  verificationStatus: {
    color: tokens.accent,
    display: "block",
    fontSize: 11,
    textTransform: "uppercase",
  },
  verificationFailed: { color: tokens.danger },
  verificationDetail: { color: tokens.foregroundMuted, margin: 0 },
  timestamp: { color: tokens.foregroundMuted, fontSize: 11, margin: 0 },
  muted: { color: tokens.foregroundMuted, fontSize: 13, margin: 0 },
  history: {
    borderBlockEndColor: tokens.border,
    borderBlockEndStyle: "solid",
    borderBlockEndWidth: 1,
    paddingBlockEnd: tokens.space4,
  },
  historyList: { display: "grid", gap: tokens.space3, marginBlockStart: tokens.space3 },
  actionGroup: { display: "grid", gap: tokens.space3 },
  actionHeading: { fontSize: 17, margin: 0 },
  reviewActions: {
    display: "grid",
    gap: tokens.space3,
    gridTemplateColumns: "repeat(2, minmax(0, 1fr))",
    "@media (max-width: 760px)": { gridTemplateColumns: "1fr" },
  },
  actionForm: {
    backgroundColor: tokens.surfaceMuted,
    borderColor: tokens.border,
    borderRadius: tokens.radius2,
    borderStyle: "solid",
    borderWidth: 1,
    padding: tokens.space4,
  },
  cancelForm: {
    backgroundColor: "color-mix(in srgb, currentColor 4%, transparent)",
    borderColor: tokens.danger,
    borderRadius: tokens.radius2,
    borderStyle: "solid",
    borderWidth: 1,
    padding: tokens.space4,
  },
  fieldset: {
    borderWidth: 0,
    display: "grid",
    gap: tokens.space2,
    margin: 0,
    minWidth: 0,
    padding: 0,
  },
  input: {
    backgroundColor: tokens.background,
    borderColor: tokens.border,
    borderRadius: tokens.radius2,
    borderStyle: "solid",
    borderWidth: 1,
    color: tokens.foreground,
    minHeight: 38,
    paddingInline: tokens.space3,
    width: "100%",
    ":focus-visible": { borderColor: tokens.accent, outline: "none" },
  },
  textarea: {
    backgroundColor: tokens.background,
    borderColor: tokens.border,
    borderRadius: tokens.radius2,
    borderStyle: "solid",
    borderWidth: 1,
    color: tokens.foreground,
    font: "inherit",
    lineHeight: 1.5,
    padding: tokens.space3,
    resize: "vertical",
    width: "100%",
    ":focus-visible": { borderColor: tokens.accent, outline: "none" },
  },
  select: {
    backgroundColor: tokens.background,
    borderColor: tokens.border,
    borderRadius: tokens.radius2,
    borderStyle: "solid",
    borderWidth: 1,
    color: tokens.foreground,
    minHeight: 38,
    paddingInline: tokens.space2,
    width: "100%",
  },
  hint: { color: tokens.foregroundMuted, fontSize: 12, lineHeight: 1.5, margin: 0 },
  error: {
    alignItems: "center",
    color: tokens.danger,
    display: "flex",
    fontSize: 13,
    gap: tokens.space2,
    margin: 0,
  },
});
