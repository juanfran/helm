import { useMemo, useState } from "react";
import * as stylex from "@stylexjs/stylex";
import { AlertTriangle, Check, MessageSquare, Send, Undo2 } from "lucide-react";

import { Button } from "../../components/ui/button";
import type {
  ActivityEntry,
  ActivityEntryKind,
  CreateHumanActivityEntryInput,
  CreateManualBlockerInput,
  ManualBlocker,
  ResolveManualBlockerInput,
  WithdrawActivityEntryInput,
} from "../../domain/activity";
import { authoredActivityEntryKindSchema } from "../../domain/activity";
import type { Task } from "../../domain/tasks";
import type {
  ActivityEntryCommandResponse,
  ManualBlockerCommandResponse,
} from "../../server/activity-adapter";
import { tokens } from "../../styles/tokens.stylex";

type TaskCollaborationProps = {
  task: Task;
  entries: readonly ActivityEntry[];
  blockers: readonly ManualBlocker[];
  onCreateEntry: (input: CreateHumanActivityEntryInput) => Promise<ActivityEntryCommandResponse>;
  onWithdrawEntry: (input: WithdrawActivityEntryInput) => Promise<ActivityEntryCommandResponse>;
  onCreateBlocker: (input: CreateManualBlockerInput) => Promise<ManualBlockerCommandResponse>;
  onResolveBlocker: (input: ResolveManualBlockerInput) => Promise<ManualBlockerCommandResponse>;
};

const authoredKinds: ReadonlyArray<{ value: Exclude<ActivityEntryKind, "system">; label: string }> =
  [
    { value: "comment", label: "Comment" },
    { value: "progress", label: "Progress" },
    { value: "decision", label: "Decision" },
    { value: "change_request", label: "Change request" },
  ];

function documentFromPlainText(value: string): CreateHumanActivityEntryInput["content"] {
  return {
    version: 1,
    doc: {
      type: "doc",
      content: value.split("\n").map((line) => ({
        type: "paragraph",
        content: line.length > 0 ? [{ type: "text", text: line }] : undefined,
      })),
    },
  };
}

function entryAuthor(entry: ActivityEntry) {
  if (entry.authorDisplayName) return entry.authorDisplayName;
  if (entry.author.type === "human") return "You";
  if (entry.author.type === "system") return "Helm";
  return entry.agentProfileId ? `Agent ${entry.agentProfileId}` : "Agent";
}

function formatTimestamp(value: string) {
  const timestamp = new Date(value);
  if (Number.isNaN(timestamp.getTime())) return value;
  return new Intl.DateTimeFormat(undefined, {
    dateStyle: "medium",
    timeStyle: "short",
  }).format(timestamp);
}

export function TaskCollaboration({
  task,
  entries,
  blockers,
  onCreateEntry,
  onWithdrawEntry,
  onCreateBlocker,
  onResolveBlocker,
}: TaskCollaborationProps) {
  const orderedEntries = useMemo(
    () =>
      entries
        .filter((entry) => entry.taskId === task.id)
        .toSorted((left, right) =>
          left.createdAt === right.createdAt
            ? left.id.localeCompare(right.id)
            : left.createdAt.localeCompare(right.createdAt),
        ),
    [entries, task.id],
  );
  const taskBlockers = useMemo(
    () =>
      blockers
        .filter((blocker) => blocker.taskId === task.id)
        .toSorted((left, right) => right.createdAt.localeCompare(left.createdAt)),
    [blockers, task.id],
  );
  const activeBlockers = taskBlockers.filter((blocker) => blocker.status === "active");
  const [kind, setKind] = useState<Exclude<ActivityEntryKind, "system">>("comment");
  const [draft, setDraft] = useState("");
  const [blockerReason, setBlockerReason] = useState("");
  const [withdrawTarget, setWithdrawTarget] = useState<string | null>(null);
  const [withdrawalReason, setWithdrawalReason] = useState("");
  const [resolveTarget, setResolveTarget] = useState<string | null>(null);
  const [resolution, setResolution] = useState("");
  const [pending, setPending] = useState(false);
  const [error, setError] = useState<string | null>(null);

  async function submitEntry() {
    const contentText = draft.trim();
    if (!contentText) return;
    setPending(true);
    setError(null);
    try {
      const response = await onCreateEntry({
        entryId: crypto.randomUUID(),
        projectId: task.projectId,
        taskId: task.id,
        kind,
        content: documentFromPlainText(contentText),
        expectedTaskVersion: task.version,
        idempotencyKey: crypto.randomUUID(),
      });
      if (response.ok) setDraft("");
      else setError(response.error.message);
    } catch {
      setError("Helm could not add the activity entry.");
    } finally {
      setPending(false);
    }
  }

  async function submitBlocker() {
    const reason = blockerReason.trim();
    if (!reason) return;
    setPending(true);
    setError(null);
    try {
      const response = await onCreateBlocker({
        blockerId: crypto.randomUUID(),
        projectId: task.projectId,
        taskId: task.id,
        reason,
        expectedTaskVersion: task.version,
        idempotencyKey: crypto.randomUUID(),
      });
      if (response.ok) setBlockerReason("");
      else setError(response.error.message);
    } catch {
      setError("Helm could not report the blocker.");
    } finally {
      setPending(false);
    }
  }

  async function withdrawEntry(entryId: string) {
    const reason = withdrawalReason.trim();
    if (!reason) return;
    setPending(true);
    setError(null);
    try {
      const response = await onWithdrawEntry({
        projectId: task.projectId,
        entryId,
        expectedTaskVersion: task.version,
        reason,
        idempotencyKey: crypto.randomUUID(),
      });
      if (response.ok) {
        setWithdrawTarget(null);
        setWithdrawalReason("");
      } else setError(response.error.message);
    } catch {
      setError("Helm could not withdraw the entry.");
    } finally {
      setPending(false);
    }
  }

  async function resolveBlocker(blockerId: string) {
    const resolutionText = resolution.trim();
    if (!resolutionText) return;
    setPending(true);
    setError(null);
    try {
      const response = await onResolveBlocker({
        blockerId,
        projectId: task.projectId,
        taskId: task.id,
        resolution: resolutionText,
        expectedTaskVersion: task.version,
        idempotencyKey: crypto.randomUUID(),
      });
      if (response.ok) {
        setResolveTarget(null);
        setResolution("");
      } else setError(response.error.message);
    } catch {
      setError("Helm could not resolve the blocker.");
    } finally {
      setPending(false);
    }
  }

  return (
    <section aria-labelledby="collaboration-heading" {...stylex.props(styles.root)}>
      <div {...stylex.props(styles.headingRow)}>
        <div>
          <p {...stylex.props(styles.eyebrow)}>Human + agent record</p>
          <h2 id="collaboration-heading" {...stylex.props(styles.heading)}>
            Collaboration
          </h2>
        </div>
        <span {...stylex.props(styles.entryCount)}>{orderedEntries.length} entries</span>
      </div>

      {activeBlockers.length > 0 ? (
        <output {...stylex.props(styles.blockerBanner)}>
          <AlertTriangle size={18} aria-hidden="true" />
          <span>
            {activeBlockers.length} manual {activeBlockers.length === 1 ? "blocker" : "blockers"}
            {" — this task is not claimable."}
          </span>
        </output>
      ) : null}

      <div aria-label="Task activity" {...stylex.props(styles.timeline)}>
        {orderedEntries.length === 0 ? (
          <p {...stylex.props(styles.empty)}>No collaboration history yet.</p>
        ) : (
          orderedEntries.map((entry) => (
            <article key={entry.id} {...stylex.props(styles.entry)}>
              <div {...stylex.props(styles.entryHeader)}>
                <span {...stylex.props(styles.kind)}>{entry.kind.replace("_", " ")}</span>
                <strong>{entryAuthor(entry)}</strong>
                <time dateTime={entry.createdAt}>{formatTimestamp(entry.createdAt)}</time>
              </div>
              <p
                {...stylex.props(
                  styles.entryText,
                  Boolean(entry.withdrawnAt) && styles.withdrawnText,
                )}
              >
                {entry.withdrawnAt ? "Content withdrawn." : entry.contentText}
              </p>
              {entry.withdrawnAt ? (
                <p {...stylex.props(styles.withdrawal)}>
                  Withdrawn {formatTimestamp(entry.withdrawnAt)} — {entry.withdrawalReason}
                </p>
              ) : entry.kind !== "system" ? (
                <Button
                  type="button"
                  variant="quiet"
                  disabled={pending}
                  onClick={() => setWithdrawTarget(entry.id)}
                >
                  <Undo2 size={14} aria-hidden="true" /> Withdraw
                </Button>
              ) : null}
              {withdrawTarget === entry.id ? (
                <div {...stylex.props(styles.inlineAction)}>
                  <input
                    aria-label={`Withdrawal reason for ${entry.contentText}`}
                    value={withdrawalReason}
                    onChange={(event) => setWithdrawalReason(event.target.value)}
                    placeholder="Why is this being withdrawn?"
                    maxLength={1_000}
                    {...stylex.props(styles.input)}
                  />
                  <Button
                    type="button"
                    disabled={pending || withdrawalReason.trim().length === 0}
                    onClick={() => void withdrawEntry(entry.id)}
                  >
                    Confirm withdrawal
                  </Button>
                </div>
              ) : null}
            </article>
          ))
        )}
      </div>

      <div {...stylex.props(styles.composer)}>
        <div {...stylex.props(styles.composerHeader)}>
          <MessageSquare size={17} aria-hidden="true" />
          <label htmlFor={`activity-kind-${task.id}`}>Add to the record</label>
          <select
            id={`activity-kind-${task.id}`}
            aria-label="Activity type"
            value={kind}
            onChange={(event) => setKind(authoredActivityEntryKindSchema.parse(event.target.value))}
            {...stylex.props(styles.select)}
          >
            {authoredKinds.map((option) => (
              <option key={option.value} value={option.value}>
                {option.label}
              </option>
            ))}
          </select>
        </div>
        <textarea
          aria-label="Activity update"
          value={draft}
          onChange={(event) => setDraft(event.target.value)}
          rows={3}
          maxLength={20_000}
          placeholder="Share context, progress, a decision, or a requested change…"
          {...stylex.props(styles.textarea)}
        />
        <Button
          type="button"
          disabled={pending || draft.trim().length === 0}
          onClick={() => void submitEntry()}
        >
          <Send size={15} aria-hidden="true" /> Add {kind.replace("_", " ")}
        </Button>
      </div>

      <div {...stylex.props(styles.blockers)}>
        <h3>Manual blockers</h3>
        <p {...stylex.props(styles.hint)}>
          Use a blocker only when a person or external decision is required. It immediately affects
          work eligibility and remains in history after resolution.
        </p>
        {taskBlockers.map((blocker) => (
          <article key={blocker.id} {...stylex.props(styles.blocker)}>
            <div>
              <strong>{blocker.status === "active" ? "Active blocker" : "Resolved blocker"}</strong>
              <p>{blocker.reason}</p>
              {blocker.resolution ? (
                <p {...stylex.props(styles.resolution)}>Resolution: {blocker.resolution}</p>
              ) : null}
            </div>
            {blocker.status === "active" ? (
              <Button
                type="button"
                variant="quiet"
                disabled={pending}
                onClick={() => setResolveTarget(blocker.id)}
              >
                <Check size={14} aria-hidden="true" /> Resolve
              </Button>
            ) : null}
            {resolveTarget === blocker.id ? (
              <div {...stylex.props(styles.inlineAction)}>
                <input
                  aria-label={`Resolution for ${blocker.reason}`}
                  value={resolution}
                  onChange={(event) => setResolution(event.target.value)}
                  placeholder="How was it resolved?"
                  maxLength={2_000}
                  {...stylex.props(styles.input)}
                />
                <Button
                  type="button"
                  disabled={pending || resolution.trim().length === 0}
                  onClick={() => void resolveBlocker(blocker.id)}
                >
                  Save resolution
                </Button>
              </div>
            ) : null}
          </article>
        ))}
        <div {...stylex.props(styles.inlineAction)}>
          <input
            aria-label="Manual blocker reason"
            value={blockerReason}
            onChange={(event) => setBlockerReason(event.target.value)}
            placeholder="What needs human attention?"
            maxLength={2_000}
            {...stylex.props(styles.input)}
          />
          <Button
            type="button"
            variant="quiet"
            disabled={pending || blockerReason.trim().length === 0}
            onClick={() => void submitBlocker()}
          >
            <AlertTriangle size={14} aria-hidden="true" /> Report blocker
          </Button>
        </div>
      </div>

      {error ? (
        <p role="alert" {...stylex.props(styles.error)}>
          {error}
        </p>
      ) : null}
    </section>
  );
}

const styles = stylex.create({
  root: {
    borderBlockStartColor: tokens.border,
    borderBlockStartStyle: "solid",
    borderBlockStartWidth: 1,
    display: "grid",
    gap: tokens.space4,
    marginBlockStart: tokens.space6,
    paddingBlockStart: tokens.space6,
  },
  headingRow: {
    alignItems: "center",
    display: "flex",
    justifyContent: "space-between",
  },
  eyebrow: {
    color: tokens.foregroundMuted,
    fontSize: 11,
    fontWeight: 750,
    letterSpacing: "0.09em",
    margin: 0,
    textTransform: "uppercase",
  },
  heading: { fontSize: 20, margin: 0 },
  entryCount: { color: tokens.foregroundMuted, fontSize: 13 },
  blockerBanner: {
    alignItems: "center",
    backgroundColor: "color-mix(in srgb, currentColor 7%, transparent)",
    borderColor: tokens.danger,
    borderRadius: tokens.radius2,
    borderStyle: "solid",
    borderWidth: 1,
    color: tokens.danger,
    display: "flex",
    fontSize: 14,
    gap: tokens.space2,
    padding: tokens.space3,
  },
  timeline: { display: "grid", gap: tokens.space3 },
  empty: { color: tokens.foregroundMuted, fontSize: 14, margin: 0 },
  entry: {
    backgroundColor: tokens.surfaceMuted,
    borderRadius: tokens.radius2,
    display: "grid",
    gap: tokens.space2,
    padding: tokens.space3,
  },
  entryHeader: {
    alignItems: "center",
    color: tokens.foregroundMuted,
    display: "flex",
    flexWrap: "wrap",
    fontSize: 12,
    gap: tokens.space2,
  },
  kind: {
    borderColor: tokens.border,
    borderRadius: "999px",
    borderStyle: "solid",
    borderWidth: 1,
    color: tokens.foreground,
    fontSize: 11,
    fontWeight: 700,
    paddingBlock: 2,
    paddingInline: 7,
    textTransform: "capitalize",
  },
  entryText: { margin: 0, whiteSpace: "pre-wrap" },
  withdrawnText: { opacity: 0.55, textDecoration: "line-through" },
  withdrawal: { color: tokens.foregroundMuted, fontSize: 12, margin: 0 },
  composer: {
    backgroundColor: tokens.surface,
    borderColor: tokens.border,
    borderRadius: tokens.radius3,
    borderStyle: "solid",
    borderWidth: 1,
    display: "grid",
    gap: tokens.space3,
    padding: tokens.space4,
  },
  composerHeader: {
    alignItems: "center",
    display: "flex",
    fontSize: 14,
    fontWeight: 700,
    gap: tokens.space2,
  },
  select: {
    backgroundColor: tokens.background,
    borderColor: tokens.border,
    borderRadius: tokens.radius2,
    borderStyle: "solid",
    borderWidth: 1,
    color: tokens.foreground,
    marginInlineStart: "auto",
    minHeight: 34,
    paddingInline: tokens.space2,
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
  blockers: {
    backgroundColor: tokens.surfaceMuted,
    borderRadius: tokens.radius3,
    display: "grid",
    gap: tokens.space3,
    padding: tokens.space4,
  },
  hint: { color: tokens.foregroundMuted, fontSize: 13, margin: 0 },
  blocker: {
    alignItems: "start",
    backgroundColor: tokens.surface,
    borderColor: tokens.border,
    borderRadius: tokens.radius2,
    borderStyle: "solid",
    borderWidth: 1,
    display: "grid",
    gap: tokens.space2,
    padding: tokens.space3,
  },
  resolution: { color: tokens.foregroundMuted },
  inlineAction: {
    alignItems: "center",
    display: "flex",
    flexWrap: "wrap",
    gap: tokens.space2,
  },
  input: {
    backgroundColor: tokens.background,
    borderColor: tokens.border,
    borderRadius: tokens.radius2,
    borderStyle: "solid",
    borderWidth: 1,
    color: tokens.foreground,
    flex: "1 1 240px",
    font: "inherit",
    minHeight: 36,
    paddingInline: tokens.space3,
    ":focus-visible": { borderColor: tokens.accent, outline: "none" },
  },
  error: { color: tokens.danger, fontSize: 14, margin: 0 },
});
