import { useMemo } from "react";
import * as stylex from "@stylexjs/stylex";
import { AlertCircle, Bot, Circle, UserRound } from "lucide-react";

import type { ActivityEntry, ProjectEvent } from "../../domain/activity";
import type { Task } from "../../domain/tasks";
import { tokens } from "../../styles/tokens.stylex";

function eventTitle(kind: string) {
  return kind
    .split(".")
    .map((part) => part.replaceAll("_", " "))
    .join(" · ");
}

function eventActor(event: ProjectEvent, entry?: ActivityEntry) {
  if (event.actor.type === "human") return "Human";
  if (event.actor.type === "system") return "Helm";
  if (entry?.author.type === "agent" && entry.authorDisplayName) return entry.authorDisplayName;
  return `Agent ${event.actor.id}`;
}

function eventEntry(event: ProjectEvent, entriesById: ReadonlyMap<string, ActivityEntry>) {
  const payloadEntryId = event.payload.entryId;
  const entryId =
    typeof payloadEntryId === "string"
      ? payloadEntryId
      : event.entity.type === "activity_entry"
        ? event.entity.id
        : null;
  return entryId ? entriesById.get(entryId) : undefined;
}

function eventDetail(event: ProjectEvent, entry?: ActivityEntry) {
  if (entry?.withdrawnAt) {
    return entry.withdrawalReason
      ? `Content withdrawn — ${entry.withdrawalReason}`
      : "Content withdrawn.";
  }
  if (entry?.contentText.trim()) return entry.contentText;

  for (const key of ["message", "reason", "summary", "title"] as const) {
    const value = event.payload[key];
    if (typeof value === "string" && value.trim()) return value;
  }
  return null;
}

function formatTimestamp(value: string) {
  const timestamp = new Date(value);
  if (Number.isNaN(timestamp.getTime())) return value;
  return new Intl.DateTimeFormat(undefined, {
    dateStyle: "medium",
    timeStyle: "short",
  }).format(timestamp);
}

export function ProjectActivityFeed({
  events,
  tasks,
  entries,
}: {
  events: readonly ProjectEvent[];
  tasks: readonly Task[];
  entries: readonly ActivityEntry[];
}) {
  const taskNames = useMemo(
    () => new Map(tasks.map((task) => [task.id, `#${task.sequence} ${task.title}`])),
    [tasks],
  );
  const orderedEvents = useMemo(
    () => events.toSorted((left, right) => right.cursor - left.cursor),
    [events],
  );
  const entriesById = useMemo(() => new Map(entries.map((entry) => [entry.id, entry])), [entries]);

  return (
    <section aria-labelledby="project-activity-heading" {...stylex.props(styles.root)}>
      <div {...stylex.props(styles.header)}>
        <div>
          <p {...stylex.props(styles.eyebrow)}>Durable event log</p>
          <h1 id="project-activity-heading" {...stylex.props(styles.heading)}>
            Project activity
          </h1>
        </div>
        <span {...stylex.props(styles.count)}>{orderedEvents.length} recent events</span>
      </div>
      <p {...stylex.props(styles.intro)}>
        Routine work stays quiet. Blockers, lease expiry, review, and failures are classified for
        attention without interrupting the work queue.
      </p>
      <div aria-label="Project events" {...stylex.props(styles.feed)}>
        {orderedEvents.length === 0 ? (
          <p {...stylex.props(styles.empty)}>No project events yet.</p>
        ) : (
          orderedEvents.map((event) => {
            const taskId = event.changes.taskIds[0];
            const taskName = taskId ? taskNames.get(taskId) : null;
            const entry = eventEntry(event, entriesById);
            const detail = eventDetail(event, entry);
            return (
              <article
                key={event.id}
                {...stylex.props(
                  styles.event,
                  event.importance === "attention" && styles.attention,
                  event.importance === "critical" && styles.critical,
                )}
              >
                <span {...stylex.props(styles.icon)} aria-hidden="true">
                  {event.importance === "routine" ? (
                    <Circle size={11} />
                  ) : (
                    <AlertCircle size={17} />
                  )}
                </span>
                <div {...stylex.props(styles.body)}>
                  <div {...stylex.props(styles.eventHeader)}>
                    <strong>{eventTitle(event.kind)}</strong>
                    {event.importance !== "routine" ? (
                      <span {...stylex.props(styles.importance)}>{event.importance}</span>
                    ) : null}
                  </div>
                  {taskName ? <p {...stylex.props(styles.task)}>{taskName}</p> : null}
                  {detail ? <p {...stylex.props(styles.detail)}>{detail}</p> : null}
                  <div {...stylex.props(styles.meta)}>
                    {event.actor.type === "agent" ? (
                      <Bot size={13} aria-hidden="true" />
                    ) : (
                      <UserRound size={13} aria-hidden="true" />
                    )}
                    <span>{eventActor(event, entry)}</span>
                    <time dateTime={event.occurredAt}>{formatTimestamp(event.occurredAt)}</time>
                    <span>cursor {event.cursor}</span>
                  </div>
                </div>
              </article>
            );
          })
        )}
      </div>
    </section>
  );
}

const styles = stylex.create({
  root: {
    display: "grid",
    gap: tokens.space4,
    marginInline: "auto",
    maxWidth: 880,
    padding: tokens.space7,
    width: "100%",
    "@media (max-width: 720px)": { padding: tokens.space4 },
  },
  header: {
    alignItems: "end",
    display: "flex",
    gap: tokens.space4,
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
  heading: { fontSize: 28, letterSpacing: "-0.03em", margin: 0 },
  count: { color: tokens.foregroundMuted, fontSize: 13 },
  intro: { color: tokens.foregroundMuted, lineHeight: 1.55, margin: 0, maxWidth: 680 },
  feed: { display: "grid", gap: tokens.space2 },
  empty: {
    backgroundColor: tokens.surface,
    borderColor: tokens.border,
    borderRadius: tokens.radius3,
    borderStyle: "solid",
    borderWidth: 1,
    color: tokens.foregroundMuted,
    margin: 0,
    padding: tokens.space6,
  },
  event: {
    backgroundColor: tokens.surface,
    borderColor: tokens.border,
    borderInlineStartColor: tokens.border,
    borderInlineStartWidth: 3,
    borderRadius: tokens.radius2,
    borderStyle: "solid",
    borderWidth: 1,
    display: "grid",
    gap: tokens.space3,
    gridTemplateColumns: "20px minmax(0, 1fr)",
    padding: tokens.space4,
  },
  attention: { borderInlineStartColor: "#b7791f" },
  critical: { borderInlineStartColor: tokens.danger },
  icon: { color: tokens.foregroundMuted, paddingBlockStart: 2 },
  body: { display: "grid", gap: tokens.space1, minWidth: 0 },
  eventHeader: {
    alignItems: "center",
    display: "flex",
    flexWrap: "wrap",
    gap: tokens.space2,
    textTransform: "capitalize",
  },
  importance: {
    borderColor: "currentColor",
    borderRadius: "999px",
    borderStyle: "solid",
    borderWidth: 1,
    color: tokens.danger,
    fontSize: 10,
    fontWeight: 750,
    letterSpacing: "0.06em",
    paddingBlock: 2,
    paddingInline: 7,
    textTransform: "uppercase",
  },
  task: { color: tokens.accent, fontSize: 13, fontWeight: 650, margin: 0 },
  detail: { lineHeight: 1.5, margin: 0, overflowWrap: "anywhere" },
  meta: {
    alignItems: "center",
    color: tokens.foregroundMuted,
    display: "flex",
    flexWrap: "wrap",
    fontSize: 12,
    gap: tokens.space2,
  },
});
