import type { ActivityEntry, ProjectEvent } from "../../domain/activity";
import type { TaskAttemptSummary } from "../../domain/tasks";

export function projectEventTitle(kind: string) {
  return kind
    .split(".")
    .map((part) => part.replaceAll("_", " "))
    .join(" · ");
}

export function projectEventTaskId(event: ProjectEvent) {
  return event.changes.taskIds[0] ?? (event.entity.type === "task" ? event.entity.id : null);
}

export function projectEventEntry(
  event: ProjectEvent,
  entriesById: ReadonlyMap<string, ActivityEntry>,
) {
  const payloadEntryId = event.payload.entryId;
  const entryId =
    typeof payloadEntryId === "string"
      ? payloadEntryId
      : event.entity.type === "activity_entry"
        ? event.entity.id
        : null;
  return entryId ? entriesById.get(entryId) : undefined;
}

export function projectEventAttempt(
  event: ProjectEvent,
  entry: ActivityEntry | undefined,
  attemptsById: ReadonlyMap<string, TaskAttemptSummary>,
) {
  const payloadAttemptId = event.payload.attemptId;
  const attemptId =
    typeof payloadAttemptId === "string"
      ? payloadAttemptId
      : (entry?.attemptId ?? (event.entity.type === "task_attempt" ? event.entity.id : null));
  return attemptId ? attemptsById.get(attemptId) : undefined;
}

export function projectEventActor(
  event: ProjectEvent,
  entry?: ActivityEntry,
  attempt?: TaskAttemptSummary,
) {
  if (event.actor.type === "human") return "Human";
  if (event.actor.type === "system") return "Helm";
  if (entry?.author.type === "agent" && entry.authorDisplayName) return entry.authorDisplayName;
  if (attempt?.agentDisplayName) return attempt.agentDisplayName;
  return "Agent";
}

export function projectEventDetail(event: ProjectEvent, entry?: ActivityEntry) {
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

export function formatProjectTimestamp(value: string) {
  const timestamp = new Date(value);
  if (Number.isNaN(timestamp.getTime())) return value;
  return new Intl.DateTimeFormat(undefined, {
    dateStyle: "medium",
    timeStyle: "short",
  }).format(timestamp);
}
