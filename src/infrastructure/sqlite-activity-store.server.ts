import { createHash } from "node:crypto";

import Database from "better-sqlite3";
import { and, asc, desc, eq, gt, inArray, isNull, lt, max } from "drizzle-orm";
import { drizzle } from "drizzle-orm/better-sqlite3";
import { Effect } from "effect";
import { z } from "zod";

import {
  ActivityAttributionError,
  ActivityEntryNotFoundError,
  ActivityEntryWithdrawnError,
  ActivityIdempotencyConflictError,
  ActivityPersistenceError,
  ManualBlockerNotFoundError,
  ManualBlockerStateError,
  type ActivityCommandError,
} from "../application/activity-errors";
import type { ActivityAuthor, ActivityStore } from "../application/activity";
import {
  TaskLeaseError,
  TaskNotFoundError,
  TaskVersionConflictError,
} from "../application/task-errors";
import {
  activityEntries,
  agentProfiles,
  agentRuns,
  attempts,
  events,
  idempotencyRecords,
  leases,
  manualBlockers,
  schema,
  tasks,
} from "../db/schema";
import {
  activityEntryMutationResultSchema,
  activityEntrySchema,
  activityEventPageSchema,
  importanceForEventKind,
  manualBlockerMutationResultSchema,
  manualBlockerSchema,
  normalizeEventChangeHints,
  projectEventSchema,
  type ActivityActor,
  type ActivityEntry,
  type ActivityEntryMutationResult,
  type CreateAgentActivityEntryInput,
  type CreateAgentManualBlockerInput,
  type CreateHumanActivityEntryInput,
  type CreateManualBlockerInput,
  type CreateSystemActivityEntryInput,
  type EventChangeHints,
  type ListManualBlockersInput,
  type ManualBlocker,
  type ManualBlockerMutationResult,
  type ProjectEvent,
  type ResolveManualBlockerInput,
  type WithdrawActivityEntryInput,
} from "../domain/activity";
import { richTextToPlainText, type JsonValue } from "../domain/rich-text";

type DrizzleDatabase = ReturnType<typeof drizzle<typeof schema>>;
type DrizzleTransaction = Parameters<Parameters<DrizzleDatabase["transaction"]>[0]>[0];
type DatabaseSession = DrizzleDatabase | DrizzleTransaction;
type ActivityEntryRow = typeof activityEntries.$inferSelect;
type EventRow = typeof events.$inferSelect;
type ManualBlockerRow = typeof manualBlockers.$inferSelect;

type CreateEntryInput =
  | CreateHumanActivityEntryInput
  | CreateAgentActivityEntryInput
  | CreateSystemActivityEntryInput;
type LeaseBoundActivityInput = {
  readonly taskId: string;
  readonly leaseToken: string;
};
const idempotencyReferenceSchema = z.object({
  entryId: z.string().optional(),
  blockerId: z.string().optional(),
  eventCursor: z.number().int().positive(),
  taskVersion: z.number().int().positive(),
  result: z.unknown().optional(),
});

function persistenceError(error: unknown) {
  return new ActivityPersistenceError({
    message: error instanceof Error ? error.message : "The activity database operation failed.",
  });
}

function commandError(error: unknown): ActivityCommandError {
  if (
    error instanceof ActivityAttributionError ||
    error instanceof ActivityEntryNotFoundError ||
    error instanceof ActivityEntryWithdrawnError ||
    error instanceof ActivityIdempotencyConflictError ||
    error instanceof ManualBlockerNotFoundError ||
    error instanceof ManualBlockerStateError ||
    error instanceof TaskNotFoundError ||
    error instanceof TaskVersionConflictError ||
    error instanceof TaskLeaseError ||
    error instanceof ActivityPersistenceError
  ) {
    return error;
  }
  return persistenceError(error);
}

function hashInput(command: string, input: unknown, actor: ActivityActor) {
  return createHash("sha256")
    .update(`${command}:${JSON.stringify({ input, actor })}`)
    .digest("hex");
}

function withoutIdempotencyKey<T extends { idempotencyKey: string }>(input: T) {
  const { idempotencyKey: _idempotencyKey, ...commandInput } = input;
  return commandInput;
}

function tokenHash(token: string) {
  return createHash("sha256").update(token).digest("hex");
}

function currentTask(db: DatabaseSession, taskId: string, projectId: string) {
  const row = db.select().from(tasks).where(eq(tasks.id, taskId)).limit(1).get();
  if (!row || row.projectId !== projectId) {
    throw new TaskNotFoundError({
      taskId,
      message: "That task does not exist in this project.",
    });
  }
  return row;
}

function assertExpectedVersion(task: typeof tasks.$inferSelect, expectedVersion: number) {
  if (task.version === expectedVersion) return;
  throw new TaskVersionConflictError({
    taskId: task.id,
    expectedVersion,
    currentVersion: task.version,
    changeSummary: `Task #${task.sequence} changed since version ${expectedVersion}.`,
    message: `Expected task version ${expectedVersion}, but the current version is ${task.version}.`,
  });
}

function assertHuman(actor: ActivityActor) {
  if (actor.type !== "human" || actor.id !== "local-human") {
    throw new ActivityAttributionError({
      message: "Only the local human actor may use this activity command.",
    });
  }
}

function assertAgentLease(
  db: DatabaseSession,
  input: LeaseBoundActivityInput,
  author: ActivityAuthor,
  now: string,
) {
  if (
    author.actor.type !== "agent" ||
    !author.agentRunId ||
    !author.agentProfileId ||
    author.actor.id !== author.agentRunId
  ) {
    throw new ActivityAttributionError({
      message: "Agent attribution must come from a run.",
    });
  }
  const run = db.select().from(agentRuns).where(eq(agentRuns.id, author.agentRunId)).limit(1).get();
  const profile = db
    .select({ id: agentProfiles.id, displayName: agentProfiles.displayName })
    .from(agentProfiles)
    .where(eq(agentProfiles.id, author.agentProfileId))
    .limit(1)
    .get();
  if (!run || run.status !== "active" || run.profileId !== author.agentProfileId || !profile) {
    throw new TaskLeaseError({
      taskId: input.taskId,
      reason: "inactive_run",
      message: "The agent run is not active.",
    });
  }
  const lease = db
    .select()
    .from(leases)
    .where(eq(leases.tokenHash, tokenHash(input.leaseToken)))
    .limit(1)
    .get();
  if (!lease) {
    throw new TaskLeaseError({
      taskId: input.taskId,
      reason: "not_found",
      message: "That lease token is not recognized.",
    });
  }
  if (lease.agentRunId !== author.agentRunId || lease.taskId !== input.taskId) {
    throw new TaskLeaseError({
      taskId: input.taskId,
      leaseId: lease.id,
      reason: "owner_mismatch",
      message: "That lease belongs to a different task or agent run.",
    });
  }
  if (lease.status !== "active") {
    throw new TaskLeaseError({
      taskId: input.taskId,
      leaseId: lease.id,
      reason: lease.status === "expired" ? "expired" : "inactive",
      message: "That lease is no longer active.",
    });
  }
  if (lease.expiresAt <= now) {
    throw new TaskLeaseError({
      taskId: input.taskId,
      leaseId: lease.id,
      reason: "expired",
      message: "That lease has expired.",
    });
  }
  const attempt = db
    .select({ status: attempts.status })
    .from(attempts)
    .where(eq(attempts.id, lease.attemptId))
    .limit(1)
    .get();
  if (attempt?.status !== "active") {
    throw new TaskLeaseError({
      taskId: input.taskId,
      leaseId: lease.id,
      reason: "inactive",
      message: "The lease attempt is no longer active.",
    });
  }
  return { lease, displayName: profile.displayName };
}

function assertAgentRun(db: DatabaseSession, input: CreateEntryInput, author: ActivityAuthor) {
  if (
    author.actor.type !== "agent" ||
    !author.agentRunId ||
    !author.agentProfileId ||
    author.actor.id !== author.agentRunId
  ) {
    throw new ActivityAttributionError({
      message: "Agent attribution must come from a run.",
    });
  }
  const run = db.select().from(agentRuns).where(eq(agentRuns.id, author.agentRunId)).limit(1).get();
  const profile = db
    .select({ displayName: agentProfiles.displayName })
    .from(agentProfiles)
    .where(eq(agentProfiles.id, author.agentProfileId))
    .limit(1)
    .get();
  if (!run || run.status !== "active" || run.profileId !== author.agentProfileId || !profile) {
    throw new TaskLeaseError({
      taskId: input.taskId,
      reason: "inactive_run",
      message: "The agent run is not active.",
    });
  }
  return profile.displayName;
}

function entryFromRow(row: ActivityEntryRow): ActivityEntry {
  const withdrawnBy =
    row.withdrawnByType && row.withdrawnById
      ? { type: row.withdrawnByType, id: row.withdrawnById }
      : null;
  return activityEntrySchema.parse({
    id: row.id,
    projectId: row.projectId,
    taskId: row.taskId,
    attemptId: row.attemptId,
    kind: row.kind,
    author: { type: row.authorType, id: row.authorId },
    authorDisplayName: row.authorDisplayName,
    agentProfileId: row.agentProfileId,
    content: row.withdrawnAt ? null : JSON.parse(row.contentJson),
    contentText: row.withdrawnAt ? "" : row.contentText,
    createdAt: row.createdAt,
    withdrawnAt: row.withdrawnAt,
    withdrawnBy,
    withdrawalReason: row.withdrawalReason,
  });
}

function blockerFromRow(row: ManualBlockerRow): ManualBlocker {
  const resolvedBy =
    row.resolvedByType && row.resolvedById
      ? { type: row.resolvedByType, id: row.resolvedById }
      : null;
  return manualBlockerSchema.parse({
    id: row.id,
    projectId: row.projectId,
    taskId: row.taskId,
    reason: row.reason,
    status: row.status,
    createdBy: { type: row.createdByType, id: row.createdById },
    createdAt: row.createdAt,
    resolvedBy,
    resolvedAt: row.resolvedAt,
    resolution: row.resolution,
  });
}

function publicEventPayload(row: EventRow) {
  const payload = projectEventSchema.shape.payload.parse(JSON.parse(row.payloadJson));
  if (row.kind.startsWith("agent.run.") && Object.hasOwn(payload, "mcpSessionId")) {
    const sanitized = { ...payload };
    delete sanitized.mcpSessionId;
    return sanitized;
  }
  return payload;
}

function eventFromRow(row: EventRow): ProjectEvent {
  return projectEventSchema.parse({
    id: String(row.cursor),
    cursor: row.cursor,
    projectId: row.projectId,
    kind: row.kind,
    importance: row.importance,
    actor: { type: row.actorType, id: row.actorId },
    entity: { type: row.entityType, id: row.entityId },
    payload: publicEventPayload(row),
    changes: JSON.parse(row.changesJson),
    occurredAt: row.occurredAt,
  });
}

function appendEvent(
  db: DatabaseSession,
  event: {
    projectId: string | null;
    kind: string;
    actor: ActivityActor;
    entityType: string;
    entityId: string;
    payload: Record<string, JsonValue>;
    changes: Partial<EventChangeHints>;
    occurredAt: string;
  },
) {
  const row = db
    .insert(events)
    .values({
      projectId: event.projectId,
      kind: event.kind,
      importance: importanceForEventKind(event.kind),
      actorType: event.actor.type,
      actorId: event.actor.id,
      entityType: event.entityType,
      entityId: event.entityId,
      payloadJson: JSON.stringify(event.payload),
      changesJson: JSON.stringify(normalizeEventChangeHints(event.changes)),
      occurredAt: event.occurredAt,
    })
    .returning()
    .get();
  return eventFromRow(row);
}

function existingIdempotencyReference(
  db: DatabaseSession,
  command: string,
  key: string,
  hash: string,
) {
  const record = db
    .select()
    .from(idempotencyRecords)
    .where(eq(idempotencyRecords.key, key))
    .limit(1)
    .get();
  if (!record) return null;
  if (record.command !== command || record.inputHash !== hash) {
    throw new ActivityIdempotencyConflictError({
      key,
      message: "That idempotency key was already used for a different command.",
    });
  }
  return idempotencyReferenceSchema.parse(JSON.parse(record.resultJson));
}

function referencedEvent(db: DatabaseSession, cursor: number) {
  const row = db.select().from(events).where(eq(events.cursor, cursor)).limit(1).get();
  if (!row) throw new Error(`The recorded event cursor ${cursor} no longer exists.`);
  return eventFromRow(row);
}

function referencedEntryResult(
  db: DatabaseSession,
  reference: {
    entryId?: string;
    eventCursor: number;
    taskVersion: number;
    result?: unknown;
  },
) {
  if (reference.result !== undefined) {
    return activityEntryMutationResultSchema.parse(reference.result);
  }
  const row = reference.entryId
    ? db
        .select()
        .from(activityEntries)
        .where(eq(activityEntries.id, reference.entryId))
        .limit(1)
        .get()
    : null;
  if (!row) throw new Error("The recorded activity entry no longer exists.");
  return activityEntryMutationResultSchema.parse({
    entry: entryFromRow(row),
    event: referencedEvent(db, reference.eventCursor),
    taskVersion: reference.taskVersion,
  });
}

function referencedBlockerResult(
  db: DatabaseSession,
  reference: {
    blockerId?: string;
    eventCursor: number;
    taskVersion: number;
    result?: unknown;
  },
) {
  if (reference.result !== undefined) {
    return manualBlockerMutationResultSchema.parse(reference.result);
  }
  const row = reference.blockerId
    ? db
        .select()
        .from(manualBlockers)
        .where(eq(manualBlockers.id, reference.blockerId))
        .limit(1)
        .get()
    : null;
  if (!row) throw new Error("The recorded manual blocker no longer exists.");
  return manualBlockerMutationResultSchema.parse({
    blocker: blockerFromRow(row),
    event: referencedEvent(db, reference.eventCursor),
    taskVersion: reference.taskVersion,
  });
}

function recordIdempotency(
  db: DatabaseSession,
  input: { idempotencyKey: string },
  command: string,
  hash: string,
  reference: Record<string, unknown>,
  now: string,
) {
  db.insert(idempotencyRecords)
    .values({
      key: input.idempotencyKey,
      command,
      inputHash: hash,
      resultJson: JSON.stringify(reference),
      createdAt: now,
    })
    .run();
}

function createEntry(
  db: DatabaseSession,
  input: CreateEntryInput,
  author: ActivityAuthor,
  now: string,
): ActivityEntryMutationResult {
  const command = `activity.entry.create.${input.kind}`;
  const hash = hashInput(command, withoutIdempotencyKey(input), author.actor);
  const reference = existingIdempotencyReference(db, command, input.idempotencyKey, hash);
  if (reference) return referencedEntryResult(db, reference);

  const task = currentTask(db, input.taskId, input.projectId);
  assertExpectedVersion(task, input.expectedTaskVersion);
  let attemptId: string | null = null;
  let authorDisplayName: string;
  if ("leaseToken" in input) {
    const { lease, displayName } = assertAgentLease(db, input, author, now);
    attemptId = lease.attemptId;
    authorDisplayName = displayName;
  } else if (input.kind === "system") {
    if (author.actor.type !== "system" || author.actor.id !== "helm") {
      throw new ActivityAttributionError({
        message: "System attribution is reserved for Helm.",
      });
    }
    authorDisplayName = "Helm";
  } else if (author.actor.type === "agent") {
    authorDisplayName = assertAgentRun(db, input, author);
  } else {
    assertHuman(author.actor);
    authorDisplayName = "You";
  }
  if (task.archivedAt) {
    throw new ActivityAttributionError({
      message: "Archived tasks cannot receive new activity.",
    });
  }
  const duplicate = db
    .select({ id: activityEntries.id })
    .from(activityEntries)
    .where(eq(activityEntries.id, input.entryId))
    .limit(1)
    .get();
  if (duplicate) {
    throw new ActivityIdempotencyConflictError({
      key: input.idempotencyKey,
      message: "That activity entry identifier already belongs to another command.",
    });
  }

  const row: typeof activityEntries.$inferInsert = {
    id: input.entryId,
    projectId: input.projectId,
    taskId: input.taskId,
    attemptId,
    kind: input.kind,
    authorType: author.actor.type,
    authorId: author.actor.id,
    authorDisplayName,
    agentProfileId: author.agentProfileId,
    agentRunId: author.agentRunId,
    contentJson: JSON.stringify(input.content),
    contentText: richTextToPlainText(input.content),
    createdAt: now,
    withdrawnAt: null,
    withdrawnByType: null,
    withdrawnById: null,
    withdrawalReason: null,
  };
  db.insert(activityEntries).values(row).run();
  const event = appendEvent(db, {
    projectId: input.projectId,
    kind: `task.entry.${input.kind}.created`,
    actor: author.actor,
    entityType: "activity_entry",
    entityId: input.entryId,
    payload: {
      entryId: input.entryId,
      taskId: input.taskId,
      attemptId,
      kind: input.kind,
      taskVersion: task.version,
    },
    changes: {
      projectIds: [input.projectId],
      taskIds: [input.taskId],
      activityEntryIds: [input.entryId],
      scopes: ["activity", "tasks"],
    },
    occurredAt: now,
  });
  const inserted = db
    .select()
    .from(activityEntries)
    .where(eq(activityEntries.id, input.entryId))
    .limit(1)
    .get();
  if (!inserted) throw new Error("The activity entry could not be reloaded.");
  const result = activityEntryMutationResultSchema.parse({
    entry: entryFromRow(inserted),
    event,
    taskVersion: task.version,
  });
  recordIdempotency(
    db,
    input,
    command,
    hash,
    {
      entryId: input.entryId,
      eventCursor: event.cursor,
      taskVersion: task.version,
      result,
    },
    now,
  );
  return result;
}

function withdrawEntry(
  db: DatabaseSession,
  input: WithdrawActivityEntryInput,
  actor: ActivityActor,
  now: string,
): ActivityEntryMutationResult {
  assertHuman(actor);
  const command = "activity.entry.withdraw";
  const hash = hashInput(command, withoutIdempotencyKey(input), actor);
  const reference = existingIdempotencyReference(db, command, input.idempotencyKey, hash);
  if (reference) return referencedEntryResult(db, reference);

  const row = db
    .select()
    .from(activityEntries)
    .where(eq(activityEntries.id, input.entryId))
    .limit(1)
    .get();
  if (!row || row.projectId !== input.projectId) {
    throw new ActivityEntryNotFoundError({
      entryId: input.entryId,
      message: "That activity entry does not exist in this project.",
    });
  }
  const task = currentTask(db, row.taskId, input.projectId);
  assertExpectedVersion(task, input.expectedTaskVersion);
  if (row.withdrawnAt) {
    throw new ActivityEntryWithdrawnError({
      entryId: row.id,
      message: "That activity entry has already been withdrawn.",
    });
  }
  db.update(activityEntries)
    .set({
      withdrawnAt: now,
      withdrawnByType: actor.type,
      withdrawnById: actor.id,
      withdrawalReason: input.reason,
    })
    .where(and(eq(activityEntries.id, row.id), isNull(activityEntries.withdrawnAt)))
    .run();
  const withdrawn = db
    .select()
    .from(activityEntries)
    .where(eq(activityEntries.id, row.id))
    .limit(1)
    .get();
  if (!withdrawn) throw new Error("The withdrawn entry could not be reloaded.");
  const event = appendEvent(db, {
    projectId: input.projectId,
    kind: "task.entry.withdrawn",
    actor,
    entityType: "activity_entry",
    entityId: row.id,
    payload: {
      entryId: row.id,
      taskId: row.taskId,
      reason: input.reason,
      taskVersion: task.version,
    },
    changes: {
      projectIds: [input.projectId],
      taskIds: [row.taskId],
      activityEntryIds: [row.id],
      scopes: ["activity", "tasks"],
    },
    occurredAt: now,
  });
  const result = activityEntryMutationResultSchema.parse({
    entry: entryFromRow(withdrawn),
    event,
    taskVersion: task.version,
  });
  recordIdempotency(
    db,
    input,
    command,
    hash,
    {
      entryId: row.id,
      eventCursor: event.cursor,
      taskVersion: task.version,
      result,
    },
    now,
  );
  return result;
}

function createBlocker(
  db: DatabaseSession,
  input: CreateManualBlockerInput | CreateAgentManualBlockerInput,
  author: ActivityAuthor,
  now: string,
): ManualBlockerMutationResult {
  const command = "task.blocker.create";
  const hash = hashInput(command, withoutIdempotencyKey(input), author.actor);
  const reference = existingIdempotencyReference(db, command, input.idempotencyKey, hash);
  if (reference) return referencedBlockerResult(db, reference);
  const task = currentTask(db, input.taskId, input.projectId);
  assertExpectedVersion(task, input.expectedTaskVersion);
  let leaseContext:
    | {
        readonly leaseId: string;
        readonly attemptId: string;
        readonly agentRunId: string;
      }
    | undefined;
  if (author.actor.type === "agent") {
    if (!("leaseToken" in input)) {
      throw new ActivityAttributionError({
        message: "Agent blockers require the active task lease.",
      });
    }
    const { lease } = assertAgentLease(db, input, author, now);
    leaseContext = {
      leaseId: lease.id,
      attemptId: lease.attemptId,
      agentRunId: lease.agentRunId,
    };
  } else {
    assertHuman(author.actor);
  }
  if (task.archivedAt) {
    throw new ManualBlockerStateError({
      blockerId: input.blockerId,
      status: "archived",
      message: "Archived tasks cannot receive a blocker.",
    });
  }
  const duplicate = db
    .select({ id: manualBlockers.id })
    .from(manualBlockers)
    .where(eq(manualBlockers.id, input.blockerId))
    .limit(1)
    .get();
  if (duplicate) {
    throw new ActivityIdempotencyConflictError({
      key: input.idempotencyKey,
      message: "That blocker identifier already belongs to another command.",
    });
  }
  const row: typeof manualBlockers.$inferInsert = {
    id: input.blockerId,
    projectId: input.projectId,
    taskId: input.taskId,
    reason: input.reason,
    status: "active",
    createdByType: author.actor.type,
    createdById: author.actor.id,
    createdAt: now,
    resolvedByType: null,
    resolvedById: null,
    resolvedAt: null,
    resolution: null,
  };
  db.insert(manualBlockers).values(row).run();
  db.update(tasks)
    .set({ version: task.version + 1, updatedAt: now })
    .where(and(eq(tasks.id, task.id), eq(tasks.version, task.version)))
    .run();
  const taskVersion = task.version + 1;
  const event = appendEvent(db, {
    projectId: input.projectId,
    kind: "task.blocker.created",
    actor: author.actor,
    entityType: "manual_blocker",
    entityId: input.blockerId,
    payload: {
      blockerId: input.blockerId,
      taskId: input.taskId,
      reason: input.reason,
      previousVersion: task.version,
      version: taskVersion,
      ...leaseContext,
    },
    changes: {
      projectIds: [input.projectId],
      taskIds: [input.taskId],
      agentRunIds: leaseContext ? [leaseContext.agentRunId] : [],
      scopes: leaseContext ? ["activity", "tasks", "agents"] : ["activity", "tasks"],
    },
    occurredAt: now,
  });
  const inserted = db
    .select()
    .from(manualBlockers)
    .where(eq(manualBlockers.id, input.blockerId))
    .limit(1)
    .get();
  if (!inserted) throw new Error("The manual blocker could not be reloaded.");
  const result = manualBlockerMutationResultSchema.parse({
    blocker: blockerFromRow(inserted),
    event,
    taskVersion,
  });
  recordIdempotency(
    db,
    input,
    command,
    hash,
    {
      blockerId: input.blockerId,
      eventCursor: event.cursor,
      taskVersion,
      result,
    },
    now,
  );
  return result;
}

function resolveBlocker(
  db: DatabaseSession,
  input: ResolveManualBlockerInput,
  actor: ActivityActor,
  now: string,
): ManualBlockerMutationResult {
  assertHuman(actor);
  const command = "task.blocker.resolve";
  const hash = hashInput(command, withoutIdempotencyKey(input), actor);
  const reference = existingIdempotencyReference(db, command, input.idempotencyKey, hash);
  if (reference) return referencedBlockerResult(db, reference);
  const row = db
    .select()
    .from(manualBlockers)
    .where(eq(manualBlockers.id, input.blockerId))
    .limit(1)
    .get();
  if (!row || row.projectId !== input.projectId || row.taskId !== input.taskId) {
    throw new ManualBlockerNotFoundError({
      blockerId: input.blockerId,
      message: "That manual blocker does not exist for this task.",
    });
  }
  const task = currentTask(db, input.taskId, input.projectId);
  assertExpectedVersion(task, input.expectedTaskVersion);
  if (row.status !== "active") {
    throw new ManualBlockerStateError({
      blockerId: row.id,
      status: row.status,
      message: "That manual blocker is already resolved.",
    });
  }
  db.update(manualBlockers)
    .set({
      status: "resolved",
      resolvedByType: actor.type,
      resolvedById: actor.id,
      resolvedAt: now,
      resolution: input.resolution,
    })
    .where(and(eq(manualBlockers.id, row.id), eq(manualBlockers.status, "active")))
    .run();
  db.update(tasks)
    .set({ version: task.version + 1, updatedAt: now })
    .where(and(eq(tasks.id, task.id), eq(tasks.version, task.version)))
    .run();
  const resolved = db
    .select()
    .from(manualBlockers)
    .where(eq(manualBlockers.id, row.id))
    .limit(1)
    .get();
  if (!resolved) throw new Error("The resolved blocker could not be reloaded.");
  const taskVersion = task.version + 1;
  const event = appendEvent(db, {
    projectId: input.projectId,
    kind: "task.blocker.resolved",
    actor,
    entityType: "manual_blocker",
    entityId: row.id,
    payload: {
      blockerId: row.id,
      taskId: row.taskId,
      resolution: input.resolution,
      previousVersion: task.version,
      version: taskVersion,
    },
    changes: {
      projectIds: [input.projectId],
      taskIds: [row.taskId],
      scopes: ["activity", "tasks"],
    },
    occurredAt: now,
  });
  const result = manualBlockerMutationResultSchema.parse({
    blocker: blockerFromRow(resolved),
    event,
    taskVersion,
  });
  recordIdempotency(
    db,
    input,
    command,
    hash,
    { blockerId: row.id, eventCursor: event.cursor, taskVersion, result },
    now,
  );
  return result;
}

export function createSqliteActivityStore(database: Database.Database): ActivityStore {
  const db = drizzle(database, { schema });
  return {
    createEntry(input, author, now) {
      return Effect.try({
        try: () =>
          db.transaction((tx) => createEntry(tx, input, author, now), {
            behavior: "immediate",
          }),
        catch: commandError,
      });
    },
    withdrawEntry(input, actor, now) {
      return Effect.try({
        try: () =>
          db.transaction((tx) => withdrawEntry(tx, input, actor, now), {
            behavior: "immediate",
          }),
        catch: commandError,
      });
    },
    listEntries(input) {
      return Effect.try({
        try: () => {
          const conditions = and(
            eq(activityEntries.projectId, input.projectId),
            input.taskId ? eq(activityEntries.taskId, input.taskId) : undefined,
            input.entryIds ? inArray(activityEntries.id, input.entryIds) : undefined,
          );
          return db
            .select()
            .from(activityEntries)
            .where(conditions)
            .orderBy(desc(activityEntries.createdAt), desc(activityEntries.id))
            .limit(input.limit)
            .all()
            .toReversed()
            .map(entryFromRow);
        },
        catch: commandError,
      });
    },
    listManualBlockers(input: ListManualBlockersInput) {
      return Effect.try({
        try: () => {
          const projectCondition = eq(manualBlockers.projectId, input.projectId);
          const conditions = and(
            projectCondition,
            input.taskId ? eq(manualBlockers.taskId, input.taskId) : undefined,
            input.includeResolved ? undefined : eq(manualBlockers.status, "active"),
          );
          return db
            .select()
            .from(manualBlockers)
            .where(conditions)
            .orderBy(desc(manualBlockers.createdAt), desc(manualBlockers.id))
            .limit(input.limit)
            .all()
            .toReversed()
            .map(blockerFromRow);
        },
        catch: commandError,
      });
    },
    readEvents(input) {
      return Effect.try({
        try: () => {
          const projectCondition = input.projectId
            ? eq(events.projectId, input.projectId)
            : undefined;
          const cursorCondition =
            input.direction === "backward"
              ? input.beforeCursor
                ? lt(events.cursor, input.beforeCursor)
                : undefined
              : gt(events.cursor, input.afterCursor);
          const condition = and(
            projectCondition,
            cursorCondition,
            input.importance ? inArray(events.importance, input.importance) : undefined,
          );
          const queriedRows = db
            .select()
            .from(events)
            .where(condition)
            .orderBy(input.direction === "backward" ? desc(events.cursor) : asc(events.cursor))
            .limit(input.limit + 1)
            .all();
          const hasMore = queriedRows.length > input.limit;
          const boundedRows = queriedRows.slice(0, input.limit);
          const pageRows = input.direction === "backward" ? boundedRows.toReversed() : boundedRows;
          const latestCondition = input.projectId
            ? eq(events.projectId, input.projectId)
            : undefined;
          const latestCursor =
            db
              .select({ value: max(events.cursor) })
              .from(events)
              .where(latestCondition)
              .get()?.value ?? 0;
          return activityEventPageSchema.parse({
            events: pageRows.map(eventFromRow),
            direction: input.direction,
            nextCursor: pageRows.at(-1)?.cursor ?? input.afterCursor,
            previousCursor: pageRows.at(0)?.cursor ?? null,
            hasMore,
            latestCursor,
          });
        },
        catch: commandError,
      });
    },
    createManualBlocker(input, author, now) {
      return Effect.try({
        try: () =>
          db.transaction((tx) => createBlocker(tx, input, author, now), {
            behavior: "immediate",
          }),
        catch: commandError,
      });
    },
    resolveManualBlocker(input, actor, now) {
      return Effect.try({
        try: () =>
          db.transaction((tx) => resolveBlocker(tx, input, actor, now), {
            behavior: "immediate",
          }),
        catch: commandError,
      });
    },
  };
}
