import type { ProjectEvent } from "../../domain/activity";

const actorTypes = {
  human: true,
  agent: true,
  system: true,
} as const satisfies Record<ProjectEvent["actor"]["type"], true>;
const eventImportances = {
  routine: true,
  attention: true,
  critical: true,
} as const satisfies Record<ProjectEvent["importance"], true>;
const eventScopes = {
  projects: true,
  tasks: true,
  activity: true,
  agents: true,
  preferences: true,
  views: true,
} as const satisfies Record<ProjectEvent["changes"]["scopes"][number], true>;

function hasOwnKey<TValue extends string>(
  values: Readonly<Record<TValue, true>>,
  value: unknown,
): value is TValue {
  return typeof value === "string" && Object.hasOwn(values, value);
}

function isActorType(value: unknown): value is ProjectEvent["actor"]["type"] {
  return hasOwnKey(actorTypes, value);
}

function isEventImportance(value: unknown): value is ProjectEvent["importance"] {
  return hasOwnKey(eventImportances, value);
}

function isEventScope(value: unknown): value is ProjectEvent["changes"]["scopes"][number] {
  return hasOwnKey(eventScopes, value);
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return value !== null && typeof value === "object" && !Array.isArray(value);
}

function isStringArray(value: unknown): value is string[] {
  return Array.isArray(value) && value.every((entry) => typeof entry === "string");
}

function isJsonRecord(value: unknown): value is ProjectEvent["payload"] {
  if (!isRecord(value)) return false;

  const pending = Object.values(value);
  while (pending.length > 0) {
    const candidate = pending.pop();
    if (
      candidate === null ||
      typeof candidate === "string" ||
      typeof candidate === "boolean" ||
      (typeof candidate === "number" && Number.isFinite(candidate))
    ) {
      continue;
    }
    if (Array.isArray(candidate)) {
      for (const child of candidate) pending.push(child);
      continue;
    }
    if (isRecord(candidate)) {
      for (const child of Object.values(candidate)) pending.push(child);
      continue;
    }
    return false;
  }
  return true;
}

/**
 * Parse the narrow event-stream wire shape without pulling the complete Zod domain graph into the
 * always-loaded client shell. HTTP commands and persistence continue to use the canonical schemas;
 * this boundary constructs the same stripped ProjectEvent shape from JSON received over EventSource.
 */
export function parseProjectEventWire(value: unknown): ProjectEvent | undefined {
  if (!isRecord(value)) return undefined;

  const { actor, changes, entity } = value;
  if (
    typeof value.id !== "string" ||
    typeof value.cursor !== "number" ||
    !Number.isInteger(value.cursor) ||
    value.cursor <= 0 ||
    (value.projectId !== null && typeof value.projectId !== "string") ||
    typeof value.kind !== "string" ||
    !isEventImportance(value.importance) ||
    !isRecord(actor) ||
    !isActorType(actor.type) ||
    typeof actor.id !== "string" ||
    actor.id.length === 0 ||
    !isRecord(entity) ||
    typeof entity.type !== "string" ||
    typeof entity.id !== "string" ||
    !isJsonRecord(value.payload) ||
    !isRecord(changes) ||
    !isStringArray(changes.projectIds) ||
    !isStringArray(changes.taskIds) ||
    !isStringArray(changes.activityEntryIds) ||
    !isStringArray(changes.agentRunIds) ||
    (changes.savedViewIds !== undefined && !isStringArray(changes.savedViewIds)) ||
    !Array.isArray(changes.scopes) ||
    !changes.scopes.every(isEventScope) ||
    typeof value.occurredAt !== "string"
  ) {
    return undefined;
  }

  return {
    id: value.id,
    cursor: value.cursor,
    projectId: value.projectId,
    kind: value.kind,
    importance: value.importance,
    actor: {
      type: actor.type,
      id: actor.id,
    },
    entity: { type: entity.type, id: entity.id },
    payload: value.payload,
    changes: {
      projectIds: changes.projectIds,
      taskIds: changes.taskIds,
      activityEntryIds: changes.activityEntryIds,
      agentRunIds: changes.agentRunIds,
      ...(changes.savedViewIds === undefined ? {} : { savedViewIds: changes.savedViewIds }),
      scopes: changes.scopes,
    },
    occurredAt: value.occurredAt,
  };
}
