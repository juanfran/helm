import { useMemo } from "react";
import * as stylex from "@stylexjs/stylex";
import {
  Activity,
  AlertTriangle,
  Bot,
  CalendarClock,
  CheckCircle2,
  Clock3,
  History,
  Inbox,
  RotateCcw,
  ShieldAlert,
} from "lucide-react";

import type { ProjectEvent } from "../../domain/activity";
import type { AgentRunSummary } from "../../domain/agents";
import type { Task, TaskAttemptSummary } from "../../domain/tasks";
import { tokens } from "../../styles/tokens.stylex";
import { formatProjectTimestamp, projectEventTitle } from "../activity/project-event-presentation";
import {
  buildOperationalDashboard,
  type OperationalActiveRun,
  type OperationalAttemptFailure,
  type OperationalEventSummary,
  type OperationalProjectLease,
  type OperationalReopenedTask,
} from "./operational-dashboard-projection";

function formatDate(value: string) {
  const date = new Date(`${value}T00:00:00`);
  if (Number.isNaN(date.getTime())) return value;
  return new Intl.DateTimeFormat(undefined, { dateStyle: "medium" }).format(date);
}

function taskLabel(task: Task) {
  return `#${task.sequence} ${task.title}`;
}

export function OperationalDashboard({
  tasks,
  attempts,
  events,
  activeAgentRuns,
  onSelectTask,
}: {
  tasks: readonly Task[];
  attempts: readonly TaskAttemptSummary[];
  events: readonly ProjectEvent[];
  activeAgentRuns: readonly AgentRunSummary[];
  onSelectTask: (taskId: string) => void;
}) {
  const dashboard = useMemo(
    () => buildOperationalDashboard({ tasks, attempts, events, activeAgentRuns }),
    [activeAgentRuns, attempts, events, tasks],
  );

  return (
    <section aria-labelledby="operations-heading" {...stylex.props(styles.root)}>
      <div {...stylex.props(styles.intro)}>
        <div>
          <p {...stylex.props(styles.eyebrow)}>Operational control plane</p>
          <h1 id="operations-heading" {...stylex.props(styles.heading)}>
            What needs attention now
          </h1>
        </div>
        <p {...stylex.props(styles.introCopy)}>
          Every count comes from the same live task, attempt, and event projections used by the
          workspace. Capability-routed work keeps the eligibility returned by Helm rather than a
          client-side guess.
        </p>
      </div>

      <section aria-label="Operational counts" {...stylex.props(styles.metrics)}>
        <Metric label="Claimable" value={dashboard.counts.claimable} icon={<Inbox size={17} />} />
        <Metric label="Active" value={dashboard.counts.active} icon={<Activity size={17} />} />
        <Metric label="Review" value={dashboard.counts.review} icon={<CheckCircle2 size={17} />} />
        <Metric label="Blocked" value={dashboard.counts.blocked} icon={<ShieldAlert size={17} />} />
        <Metric label="Failed" value={dashboard.counts.failed} icon={<AlertTriangle size={17} />} />
        <Metric
          label="Scheduled"
          value={dashboard.counts.scheduled}
          icon={<CalendarClock size={17} />}
        />
        <Metric label="Agent runs" value={dashboard.counts.activeRuns} icon={<Bot size={17} />} />
        <Metric
          label="Live leases"
          value={dashboard.counts.activeLeases}
          icon={<Clock3 size={17} />}
        />
      </section>

      <div {...stylex.props(styles.grid)}>
        <DashboardPanel
          eyebrow="Work supply"
          title="Claimable now"
          count={dashboard.claimable.length}
          empty="No work is currently claimable in this eligibility projection."
        >
          {dashboard.claimable.map((task) => (
            <TaskRow key={task.id} task={task} onSelectTask={onSelectTask}>
              {task.eligibility?.orderingExplanation}
            </TaskRow>
          ))}
        </DashboardPanel>

        <DashboardPanel
          eyebrow="Execution"
          title="Active agents and leases"
          count={dashboard.activeRuns.length}
          empty={
            dashboard.active.length > 0
              ? `${dashboard.active.length} active task${dashboard.active.length === 1 ? " has" : "s have"} no current agent-run projection.`
              : "No active agent runs are connected."
          }
        >
          {dashboard.activeRuns.map((run) => (
            <AgentRunRow key={run.id} run={run} onSelectTask={onSelectTask} />
          ))}
        </DashboardPanel>

        <DashboardPanel
          eyebrow="Human gate"
          title="Awaiting review"
          count={dashboard.review.length}
          empty="Nothing is waiting for review."
        >
          {dashboard.review.map((task) => (
            <TaskRow key={task.id} task={task} onSelectTask={onSelectTask}>
              Open to approve or request changes
            </TaskRow>
          ))}
        </DashboardPanel>

        <DashboardPanel
          eyebrow="Impediments"
          title="Blocked work"
          count={dashboard.blocked.length}
          empty="No ready work is blocked."
        >
          {dashboard.blocked.map((task) => (
            <TaskRow key={task.id} task={task} onSelectTask={onSelectTask}>
              {task.eligibility?.reasons.join(" · ")}
            </TaskRow>
          ))}
        </DashboardPanel>

        <DashboardPanel
          eyebrow="Recovery"
          title="Latest failures"
          count={dashboard.failures.length}
          empty="No task's latest attempt has failed."
        >
          {dashboard.failures.map((failure) => (
            <FailureRow key={failure.attempt.id} failure={failure} onSelectTask={onSelectTask} />
          ))}
        </DashboardPanel>

        <DashboardPanel
          eyebrow="Forward look"
          title="Upcoming starts"
          count={dashboard.scheduled.length}
          empty="No work is scheduled for a future start."
        >
          {dashboard.scheduled.map((task) => (
            <TaskRow key={task.id} task={task} onSelectTask={onSelectTask}>
              {task.notBefore ? `Starts ${formatDate(task.notBefore)}` : "Scheduled"}
            </TaskRow>
          ))}
        </DashboardPanel>

        <DashboardPanel
          eyebrow="Iteration"
          title="Recently reopened"
          count={dashboard.reopened.length}
          empty="No work has been reopened in the retained event history."
        >
          {dashboard.reopened.map((reopened) => (
            <ReopenedRow key={reopened.taskId} reopened={reopened} onSelectTask={onSelectTask} />
          ))}
        </DashboardPanel>

        <DashboardPanel
          eyebrow="Durable cursor"
          title="Recent activity"
          count={dashboard.recentEvents.length}
          empty="No project activity has been recorded."
        >
          {dashboard.recentEvents.slice(0, 12).map((event) => (
            <EventRow key={event.id} event={event} tasks={tasks} onSelectTask={onSelectTask} />
          ))}
        </DashboardPanel>
      </div>
    </section>
  );
}

function Metric({ label, value, icon }: { label: string; value: number; icon: React.ReactNode }) {
  return (
    <article {...stylex.props(styles.metric)}>
      <span {...stylex.props(styles.metricIcon)} aria-hidden="true">
        {icon}
      </span>
      <strong {...stylex.props(styles.metricValue)}>{value}</strong>
      <span {...stylex.props(styles.metricLabel)}>{label}</span>
    </article>
  );
}

function DashboardPanel({
  eyebrow,
  title,
  count,
  empty,
  children,
}: {
  eyebrow: string;
  title: string;
  count: number;
  empty: string;
  children: React.ReactNode;
}) {
  const headingId = `dashboard-${title.toLowerCase().replaceAll(/[^a-z0-9]+/g, "-")}`;
  return (
    <section aria-labelledby={headingId} {...stylex.props(styles.panel)}>
      <div {...stylex.props(styles.panelHeader)}>
        <div>
          <p {...stylex.props(styles.panelEyebrow)}>{eyebrow}</p>
          <h2 id={headingId} {...stylex.props(styles.panelTitle)}>
            {title}
          </h2>
        </div>
        <span {...stylex.props(styles.panelCount)}>{count}</span>
      </div>
      <div {...stylex.props(styles.rows)}>
        {count === 0 ? <p {...stylex.props(styles.empty)}>{empty}</p> : children}
      </div>
    </section>
  );
}

function TaskRow({
  task,
  onSelectTask,
  children,
}: {
  task: Task;
  onSelectTask: (taskId: string) => void;
  children?: React.ReactNode;
}) {
  return (
    <button type="button" onClick={() => onSelectTask(task.id)} {...stylex.props(styles.rowButton)}>
      <span {...stylex.props(styles.rowHeading)}>
        <strong>{taskLabel(task)}</strong>
        <span {...stylex.props(styles.priority)}>{task.priority}</span>
      </span>
      {children ? <span {...stylex.props(styles.rowDetail)}>{children}</span> : null}
    </button>
  );
}

function AgentRunRow({
  run,
  onSelectTask,
}: {
  run: OperationalActiveRun;
  onSelectTask: (taskId: string) => void;
}) {
  return (
    <article {...stylex.props(styles.run)}>
      <div {...stylex.props(styles.rowHeading)}>
        <strong>{run.displayName}</strong>
        <span {...stylex.props(styles.runState)}>
          {run.projectLeases.length > 0
            ? `${run.projectLeases.length} live lease${run.projectLeases.length === 1 ? "" : "s"}`
            : "Connected · idle here"}
        </span>
      </div>
      {run.capabilities.length > 0 ? (
        <p {...stylex.props(styles.capabilities)}>{run.capabilities.join(" · ")}</p>
      ) : null}
      {run.projectLeases.map((lease) => (
        <LeaseRow key={lease.taskId} lease={lease} onSelectTask={onSelectTask} />
      ))}
    </article>
  );
}

function LeaseRow({
  lease,
  onSelectTask,
}: {
  lease: OperationalProjectLease;
  onSelectTask: (taskId: string) => void;
}) {
  return (
    <button
      type="button"
      onClick={() => onSelectTask(lease.taskId)}
      {...stylex.props(styles.leaseButton)}
    >
      <span>
        #{lease.taskSequence} {lease.taskTitle}
      </span>
      <span {...stylex.props(styles.leaseExpiry)}>
        <Clock3 size={12} aria-hidden="true" />
        expires <time dateTime={lease.expiresAt}>{formatProjectTimestamp(lease.expiresAt)}</time>
      </span>
    </button>
  );
}

function FailureRow({
  failure,
  onSelectTask,
}: {
  failure: OperationalAttemptFailure;
  onSelectTask: (taskId: string) => void;
}) {
  const content = (
    <>
      <span {...stylex.props(styles.rowHeading)}>
        <strong>
          {failure.task
            ? taskLabel(failure.task)
            : `Unavailable task · attempt ${failure.attempt.attemptNumber}`}
        </strong>
        <span {...stylex.props(styles.danger)}>
          {failure.attempt.failureClassification ?? "failed"}
        </span>
      </span>
      <span {...stylex.props(styles.rowDetail)}>
        {failure.attempt.summary || "Attempt failed."}
      </span>
    </>
  );
  return failure.task ? (
    <button
      type="button"
      onClick={() => onSelectTask(failure.task!.id)}
      {...stylex.props(styles.rowButton)}
    >
      {content}
    </button>
  ) : (
    <article {...stylex.props(styles.staticRow)}>{content}</article>
  );
}

function ReopenedRow({
  reopened,
  onSelectTask,
}: {
  reopened: OperationalReopenedTask;
  onSelectTask: (taskId: string) => void;
}) {
  const content = (
    <>
      <span {...stylex.props(styles.rowHeading)}>
        <strong>{reopened.task ? taskLabel(reopened.task) : "Unavailable task"}</strong>
        <RotateCcw size={14} aria-hidden="true" />
      </span>
      <span {...stylex.props(styles.rowDetail)}>
        {reopened.event.detail ?? "Reopened for another attempt"}
      </span>
    </>
  );
  return reopened.task ? (
    <button
      type="button"
      onClick={() => onSelectTask(reopened.task!.id)}
      {...stylex.props(styles.rowButton)}
    >
      {content}
    </button>
  ) : (
    <article {...stylex.props(styles.staticRow)}>{content}</article>
  );
}

function EventRow({
  event,
  tasks,
  onSelectTask,
}: {
  event: OperationalEventSummary;
  tasks: readonly Task[];
  onSelectTask: (taskId: string) => void;
}) {
  const task = tasks.find((candidate) => candidate.id === event.taskIds[0]);
  const content = (
    <>
      <span {...stylex.props(styles.rowHeading)}>
        <strong {...stylex.props(styles.eventKind)}>{projectEventTitle(event.kind)}</strong>
        <History size={14} aria-hidden="true" />
      </span>
      <span {...stylex.props(styles.rowDetail)}>
        {task ? `${taskLabel(task)} · ` : ""}
        {formatProjectTimestamp(event.occurredAt)}
      </span>
    </>
  );
  return task ? (
    <button type="button" onClick={() => onSelectTask(task.id)} {...stylex.props(styles.rowButton)}>
      {content}
    </button>
  ) : (
    <article {...stylex.props(styles.staticRow)}>{content}</article>
  );
}

const styles = stylex.create({
  root: {
    display: "grid",
    gap: tokens.space6,
    marginInline: "auto",
    maxWidth: 1280,
    padding: "clamp(20px, 4vw, 48px)",
    width: "100%",
  },
  intro: {
    alignItems: "end",
    display: "grid",
    gap: tokens.space5,
    gridTemplateColumns: "minmax(0, 1fr) minmax(260px, 520px)",
    "@media (max-width: 760px)": { alignItems: "start", gridTemplateColumns: "1fr" },
  },
  eyebrow: {
    color: tokens.accent,
    fontSize: 11,
    fontWeight: 800,
    letterSpacing: "0.1em",
    margin: 0,
    textTransform: "uppercase",
  },
  heading: {
    fontSize: "clamp(2rem, 5vw, 4rem)",
    letterSpacing: "-0.05em",
    lineHeight: 1,
    marginBlock: tokens.space2,
  },
  introCopy: { color: tokens.foregroundMuted, lineHeight: 1.55, margin: 0 },
  metrics: {
    display: "grid",
    gap: tokens.space2,
    gridTemplateColumns: "repeat(8, minmax(92px, 1fr))",
    overflowX: "auto",
    paddingBlockEnd: tokens.space1,
    "@media (max-width: 980px)": { gridTemplateColumns: "repeat(4, minmax(120px, 1fr))" },
    "@media (max-width: 560px)": { gridTemplateColumns: "repeat(2, minmax(120px, 1fr))" },
  },
  metric: {
    backgroundColor: tokens.surface,
    borderColor: tokens.border,
    borderRadius: tokens.radius2,
    borderStyle: "solid",
    borderWidth: 1,
    display: "grid",
    gap: tokens.space1,
    minWidth: 0,
    padding: tokens.space3,
  },
  metricIcon: { color: tokens.foregroundMuted },
  metricValue: { fontSize: 24, letterSpacing: "-0.04em" },
  metricLabel: { color: tokens.foregroundMuted, fontSize: 11, fontWeight: 700 },
  grid: {
    alignItems: "start",
    display: "grid",
    gap: tokens.space4,
    gridTemplateColumns: "repeat(2, minmax(0, 1fr))",
    "@media (max-width: 760px)": { gridTemplateColumns: "1fr" },
  },
  panel: {
    backgroundColor: tokens.surface,
    borderColor: tokens.border,
    borderRadius: tokens.radius3,
    borderStyle: "solid",
    borderWidth: 1,
    minWidth: 0,
    overflow: "hidden",
  },
  panelHeader: {
    alignItems: "end",
    borderBlockEndColor: tokens.border,
    borderBlockEndStyle: "solid",
    borderBlockEndWidth: 1,
    display: "flex",
    gap: tokens.space3,
    justifyContent: "space-between",
    padding: tokens.space4,
  },
  panelEyebrow: {
    color: tokens.foregroundMuted,
    fontSize: 10,
    fontWeight: 800,
    letterSpacing: "0.08em",
    margin: 0,
    textTransform: "uppercase",
  },
  panelTitle: { fontSize: 18, letterSpacing: "-0.02em", margin: 0 },
  panelCount: { color: tokens.foregroundMuted, fontSize: 12 },
  rows: { display: "grid" },
  empty: { color: tokens.foregroundMuted, fontSize: 13, margin: 0, padding: tokens.space5 },
  rowButton: {
    backgroundColor: "transparent",
    borderBlockEndColor: tokens.border,
    borderBlockEndStyle: "solid",
    borderBlockEndWidth: 1,
    borderInlineWidth: 0,
    borderBlockStartWidth: 0,
    color: tokens.foreground,
    cursor: "pointer",
    display: "grid",
    font: "inherit",
    gap: tokens.space1,
    padding: tokens.space3,
    textAlign: "start",
    width: "100%",
    ":hover": { backgroundColor: tokens.surfaceMuted },
    ":focus-visible": {
      outlineColor: tokens.accent,
      outlineOffset: -3,
      outlineStyle: "solid",
      outlineWidth: 2,
    },
  },
  staticRow: {
    borderBlockEndColor: tokens.border,
    borderBlockEndStyle: "solid",
    borderBlockEndWidth: 1,
    display: "grid",
    gap: tokens.space1,
    padding: tokens.space3,
  },
  rowHeading: {
    alignItems: "center",
    display: "flex",
    fontSize: 13,
    gap: tokens.space2,
    justifyContent: "space-between",
    minWidth: 0,
  },
  rowDetail: {
    color: tokens.foregroundMuted,
    fontSize: 11,
    lineHeight: 1.45,
    overflowWrap: "anywhere",
  },
  priority: { color: tokens.foregroundMuted, fontSize: 10, textTransform: "uppercase" },
  danger: { color: tokens.danger, fontSize: 10, textTransform: "uppercase" },
  run: {
    borderBlockEndColor: tokens.border,
    borderBlockEndStyle: "solid",
    borderBlockEndWidth: 1,
    display: "grid",
    gap: tokens.space2,
    padding: tokens.space3,
  },
  runState: { color: tokens.accent, fontSize: 10, fontWeight: 750, textTransform: "uppercase" },
  capabilities: { color: tokens.foregroundMuted, fontSize: 11, margin: 0 },
  leaseButton: {
    alignItems: "start",
    backgroundColor: tokens.surfaceMuted,
    borderColor: tokens.border,
    borderRadius: 6,
    borderStyle: "solid",
    borderWidth: 1,
    color: tokens.foreground,
    cursor: "pointer",
    display: "grid",
    font: "inherit",
    fontSize: 12,
    gap: tokens.space1,
    padding: tokens.space2,
    textAlign: "start",
    ":focus-visible": {
      outlineColor: tokens.accent,
      outlineOffset: 2,
      outlineStyle: "solid",
      outlineWidth: 2,
    },
  },
  leaseExpiry: {
    alignItems: "center",
    color: tokens.foregroundMuted,
    display: "flex",
    flexWrap: "wrap",
    fontSize: 10,
    gap: tokens.space1,
  },
  note: { color: tokens.foregroundMuted, fontSize: 12, margin: 0, padding: tokens.space3 },
  eventKind: { textTransform: "capitalize" },
});
