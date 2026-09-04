import { z } from "zod";

import { jsonValueSchema, richTextDocumentSchema } from "./rich-text";

export const activityEntryKindSchema = z.enum([
  "comment",
  "progress",
  "decision",
  "change_request",
  "system",
]);
export type ActivityEntryKind = z.infer<typeof activityEntryKindSchema>;

export const authoredActivityEntryKindSchema = z.enum([
  "comment",
  "progress",
  "decision",
  "change_request",
]);

export const activityActorSchema = z.object({
  type: z.enum(["human", "agent", "system"]),
  id: z.string().min(1),
});
export type ActivityActor = z.infer<typeof activityActorSchema>;

export const activityEntrySchema = z.object({
  id: z.string(),
  projectId: z.string(),
  taskId: z.string(),
  attemptId: z.string().nullable(),
  kind: activityEntryKindSchema,
  author: activityActorSchema,
  authorDisplayName: z.string(),
  agentProfileId: z.string().nullable(),
  content: richTextDocumentSchema.nullable(),
  contentText: z.string(),
  createdAt: z.string(),
  withdrawnAt: z.string().nullable(),
  withdrawnBy: activityActorSchema.nullable(),
  withdrawalReason: z.string().nullable(),
});
export type ActivityEntry = z.infer<typeof activityEntrySchema>;

export const manualBlockerSchema = z.object({
  id: z.string(),
  projectId: z.string(),
  taskId: z.string(),
  reason: z.string(),
  status: z.enum(["active", "resolved"]),
  createdBy: activityActorSchema,
  createdAt: z.string(),
  resolvedBy: activityActorSchema.nullable(),
  resolvedAt: z.string().nullable(),
  resolution: z.string().nullable(),
});
export type ManualBlocker = z.infer<typeof manualBlockerSchema>;

export const eventImportanceSchema = z.enum(["routine", "attention", "critical"]);
export type EventImportance = z.infer<typeof eventImportanceSchema>;

export const eventScopeSchema = z.enum([
  "projects",
  "tasks",
  "activity",
  "agents",
  "preferences",
  "views",
]);
export type EventScope = z.infer<typeof eventScopeSchema>;

export const eventChangeHintsSchema = z.object({
  projectIds: z.array(z.string()),
  taskIds: z.array(z.string()),
  activityEntryIds: z.array(z.string()),
  agentRunIds: z.array(z.string()),
  savedViewIds: z.array(z.string()).optional(),
  scopes: z.array(eventScopeSchema),
});
export type EventChangeHints = z.infer<typeof eventChangeHintsSchema>;

export const emptyEventChangeHints: EventChangeHints = {
  projectIds: [],
  taskIds: [],
  activityEntryIds: [],
  agentRunIds: [],
  savedViewIds: [],
  scopes: [],
};

function sortedUnique(values: readonly string[] | undefined) {
  return [...new Set(values ?? [])].toSorted((left, right) => left.localeCompare(right));
}

export function normalizeEventChangeHints(hints: Partial<EventChangeHints> = {}): EventChangeHints {
  return eventChangeHintsSchema.parse({
    projectIds: sortedUnique(hints.projectIds),
    taskIds: sortedUnique(hints.taskIds),
    activityEntryIds: sortedUnique(hints.activityEntryIds),
    agentRunIds: sortedUnique(hints.agentRunIds),
    savedViewIds: sortedUnique(hints.savedViewIds),
    scopes: sortedUnique(hints.scopes).map((scope) => eventScopeSchema.parse(scope)),
  });
}

const criticalEventKinds = new Set(["task.attempt.failed"]);
const attentionEventKinds = new Set([
  "task.blocker.created",
  "task.lease.expired",
  "task.review.requested",
  "task.review.changes_requested",
  "task.entry.change_request.created",
]);

export function importanceForEventKind(kind: string): EventImportance {
  if (criticalEventKinds.has(kind)) return "critical";
  if (attentionEventKinds.has(kind)) return "attention";
  return "routine";
}

export const projectEventSchema = z.object({
  id: z.string(),
  cursor: z.number().int().positive(),
  projectId: z.string().nullable(),
  kind: z.string(),
  importance: eventImportanceSchema,
  actor: activityActorSchema,
  entity: z.object({ type: z.string(), id: z.string() }),
  payload: z.record(z.string(), jsonValueSchema),
  changes: eventChangeHintsSchema,
  occurredAt: z.string(),
});
export type ProjectEvent = z.infer<typeof projectEventSchema>;

export const activityEventPageSchema = z.object({
  events: z.array(projectEventSchema),
  direction: z.enum(["forward", "backward"]),
  nextCursor: z.number().int().nonnegative(),
  previousCursor: z.number().int().positive().nullable(),
  hasMore: z.boolean(),
  latestCursor: z.number().int().nonnegative(),
});
export type ActivityEventPage = z.infer<typeof activityEventPageSchema>;

const opaqueClientIdSchema = z
  .string()
  .trim()
  .min(1)
  .max(200)
  .regex(/^[a-z0-9][a-z0-9._:-]*$/i, "Use an opaque identifier without whitespace.");
const idempotencyKeySchema = z.string().trim().min(1).max(200);
const expectedTaskVersionSchema = z.number().int().positive();
const activityLeaseTokenSchema = z.string().trim().min(1).max(500);

const authoredEntryFields = {
  entryId: opaqueClientIdSchema,
  projectId: z.string().trim().min(1),
  taskId: z.string().trim().min(1),
  content: richTextDocumentSchema,
  expectedTaskVersion: expectedTaskVersionSchema,
  idempotencyKey: idempotencyKeySchema,
};

export const createHumanActivityEntryInputSchema = z.object({
  ...authoredEntryFields,
  kind: authoredActivityEntryKindSchema,
});
export type CreateHumanActivityEntryInput = z.infer<typeof createHumanActivityEntryInputSchema>;

export const createAgentActivityEntryInputSchema = z.discriminatedUnion("kind", [
  z.object({
    ...authoredEntryFields,
    kind: z.literal("progress"),
    leaseToken: activityLeaseTokenSchema,
  }),
  z.object({
    ...authoredEntryFields,
    kind: z.enum(["comment", "decision", "change_request"]),
  }),
]);
export type CreateAgentActivityEntryInput = z.infer<typeof createAgentActivityEntryInputSchema>;

export const createSystemActivityEntryInputSchema = z.object({
  entryId: opaqueClientIdSchema,
  projectId: z.string().trim().min(1),
  taskId: z.string().trim().min(1),
  kind: z.literal("system"),
  content: richTextDocumentSchema,
  expectedTaskVersion: expectedTaskVersionSchema,
  idempotencyKey: idempotencyKeySchema,
});
export type CreateSystemActivityEntryInput = z.infer<typeof createSystemActivityEntryInputSchema>;

export const withdrawActivityEntryInputSchema = z.object({
  projectId: z.string().trim().min(1),
  entryId: z.string().trim().min(1),
  expectedTaskVersion: expectedTaskVersionSchema,
  reason: z.string().trim().min(1).max(1_000),
  idempotencyKey: idempotencyKeySchema,
});
export type WithdrawActivityEntryInput = z.infer<typeof withdrawActivityEntryInputSchema>;

export const listActivityEntriesInputSchema = z.object({
  projectId: z.string().trim().min(1),
  taskId: z.string().trim().min(1).optional(),
  entryIds: z.array(z.string().trim().min(1)).min(1).max(200).optional(),
  limit: z.number().int().positive().max(200).optional().default(100),
});
export type ListActivityEntriesInput = z.infer<typeof listActivityEntriesInputSchema>;

export const listManualBlockersInputSchema = z.object({
  projectId: z.string().trim().min(1),
  taskId: z.string().trim().min(1).optional(),
  includeResolved: z.boolean().optional().default(true),
  limit: z.number().int().positive().max(200).optional().default(100),
});
export type ListManualBlockersInput = z.infer<typeof listManualBlockersInputSchema>;

export const readActivityEventsInputSchema = z.object({
  projectId: z.string().trim().min(1).nullable().optional().default(null),
  importance: z.array(eventImportanceSchema).min(1).max(3).optional(),
  direction: z.enum(["forward", "backward"]).optional().default("forward"),
  afterCursor: z.number().int().nonnegative().optional().default(0),
  beforeCursor: z.number().int().positive().nullable().optional().default(null),
  limit: z.number().int().positive().max(200).optional().default(100),
});
export type ReadActivityEventsInput = z.infer<typeof readActivityEventsInputSchema>;

const blockerCommandFields = {
  blockerId: opaqueClientIdSchema,
  projectId: z.string().trim().min(1),
  taskId: z.string().trim().min(1),
  expectedTaskVersion: expectedTaskVersionSchema,
  idempotencyKey: idempotencyKeySchema,
};

export const createManualBlockerInputSchema = z.object({
  ...blockerCommandFields,
  reason: z.string().trim().min(1).max(2_000),
});
export type CreateManualBlockerInput = z.infer<typeof createManualBlockerInputSchema>;

export const createAgentManualBlockerInputSchema = createManualBlockerInputSchema.extend({
  leaseToken: activityLeaseTokenSchema,
});
export type CreateAgentManualBlockerInput = z.infer<typeof createAgentManualBlockerInputSchema>;

export const resolveManualBlockerInputSchema = z.object({
  ...blockerCommandFields,
  resolution: z.string().trim().min(1).max(2_000),
});
export type ResolveManualBlockerInput = z.infer<typeof resolveManualBlockerInputSchema>;

export const activityEntryMutationResultSchema = z.object({
  entry: activityEntrySchema,
  event: projectEventSchema,
  taskVersion: z.number().int().positive(),
});
export type ActivityEntryMutationResult = z.infer<typeof activityEntryMutationResultSchema>;

export const manualBlockerMutationResultSchema = z.object({
  blocker: manualBlockerSchema,
  event: projectEventSchema,
  taskVersion: z.number().int().positive(),
});
export type ManualBlockerMutationResult = z.infer<typeof manualBlockerMutationResultSchema>;

export const compiledCreateHumanActivityEntryInputSchema = z.compile(
  createHumanActivityEntryInputSchema,
);
export const compiledCreateAgentActivityEntryInputSchema = z.compile(
  createAgentActivityEntryInputSchema,
);
export const compiledCreateSystemActivityEntryInputSchema = z.compile(
  createSystemActivityEntryInputSchema,
);
export const compiledWithdrawActivityEntryInputSchema = z.compile(withdrawActivityEntryInputSchema);
export const compiledListActivityEntriesInputSchema = z.compile(listActivityEntriesInputSchema);
export const compiledListManualBlockersInputSchema = z.compile(listManualBlockersInputSchema);
export const compiledReadActivityEventsInputSchema = z.compile(readActivityEventsInputSchema);
export const compiledCreateManualBlockerInputSchema = z.compile(createManualBlockerInputSchema);
export const compiledCreateAgentManualBlockerInputSchema = z.compile(
  createAgentManualBlockerInputSchema,
);
export const compiledResolveManualBlockerInputSchema = z.compile(resolveManualBlockerInputSchema);
