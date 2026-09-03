import { z } from "zod";

export const actorSchema = z.object({
  type: z.enum(["human", "agent", "system"]),
  id: z.string().trim().min(1),
});
export type Actor = z.infer<typeof actorSchema>;

type JsonValue = string | number | boolean | null | JsonValue[] | { [key: string]: JsonValue };

const jsonValueSchema: z.ZodType<JsonValue> = z.lazy(() =>
  z.union([
    z.string(),
    z.number(),
    z.boolean(),
    z.null(),
    z.array(jsonValueSchema),
    z.record(z.string(), jsonValueSchema),
  ]),
);

type TipTapNode = {
  type: string;
  text?: string;
  attrs?: Record<string, JsonValue>;
  marks?: Array<{ type: string; attrs?: Record<string, JsonValue> }>;
  content?: TipTapNode[];
};

const tipTapNodeSchema: z.ZodType<TipTapNode> = z.lazy(() =>
  z.object({
    type: z.string(),
    text: z.string().optional(),
    attrs: z.record(z.string(), jsonValueSchema).optional(),
    marks: z
      .array(
        z.object({
          type: z.string(),
          attrs: z.record(z.string(), jsonValueSchema).optional(),
        }),
      )
      .optional(),
    content: z.array(tipTapNodeSchema).optional(),
  }),
);

export const richTextDocumentSchema = z.object({
  version: z.literal(1),
  doc: z.object({
    type: z.literal("doc"),
    content: z.array(tipTapNodeSchema).optional(),
  }),
});
export type RichTextDocument = z.infer<typeof richTextDocumentSchema>;

export const emptyRichTextDocument: RichTextDocument = {
  version: 1,
  doc: { type: "doc", content: [] },
};

export const checklistItemSchema = z.object({
  id: z.string().trim().min(1),
  text: z.string().trim().min(1),
  checked: z.boolean(),
});
export type ChecklistItem = z.infer<typeof checklistItemSchema>;

export const taskLifecycleSchema = z.enum(["backlog", "ready", "done", "cancelled"]);
export type TaskLifecycle = z.infer<typeof taskLifecycleSchema>;

export const taskPrioritySchema = z.enum(["urgent", "high", "normal", "low"]);
export type TaskPriority = z.infer<typeof taskPrioritySchema>;

export const taskSizeSchema = z.enum(["xs", "s", "m", "l", "xl"]);
export type TaskSize = z.infer<typeof taskSizeSchema>;

export const taskDateSchema = z
  .string()
  .trim()
  .regex(/^\d{4}-\d{2}-\d{2}$/, "Use an ISO date in YYYY-MM-DD format.");

export const capabilityNameSchema = z
  .string()
  .trim()
  .min(1)
  .max(80)
  .regex(/^[a-z0-9][a-z0-9._:-]*$/i, "Use letters, numbers, dots, underscores, colons, or dashes.");

export const tagSchema = z.object({
  id: z.string(),
  name: z.string(),
  description: z.string(),
  color: z.string(),
  exclusiveGroup: z.string().nullable(),
});
export type TaskTag = z.infer<typeof tagSchema>;

export const tagInputSchema = z.object({
  name: z.string().trim().min(1).max(80),
  description: z.string().trim().max(1_000),
  color: z
    .string()
    .trim()
    .regex(/^#[0-9a-f]{6}$/i, "Use a six-digit hex color."),
  exclusiveGroup: z.string().trim().min(1).max(80).nullable().optional().default(null),
});
export type TagInput = z.infer<typeof tagInputSchema>;

export const taskRelationTypeSchema = z.enum([
  "blocks",
  "related_to",
  "duplicates",
  "discovered_from",
]);
export type TaskRelationType = z.infer<typeof taskRelationTypeSchema>;

export const taskRelationSchema = z.object({
  id: z.string(),
  projectId: z.string(),
  sourceTaskId: z.string(),
  sourceSequence: z.number().int().positive(),
  sourceTitle: z.string(),
  targetTaskId: z.string(),
  targetSequence: z.number().int().positive(),
  targetTitle: z.string(),
  type: taskRelationTypeSchema,
  createdAt: z.string(),
});
export type TaskRelation = z.infer<typeof taskRelationSchema>;

export const taskEligibilitySchema = z.object({
  claimable: z.boolean(),
  status: z.enum([
    "not_ready",
    "scheduled",
    "blocked",
    "capability_mismatch",
    "claimable",
    "complete",
    "archived",
  ]),
  reasons: z.array(z.string()),
  orderingExplanation: z.string(),
  missingCapabilities: z.array(z.string()),
  blockingTaskIds: z.array(z.string()).default([]),
});
export type TaskEligibility = z.infer<typeof taskEligibilitySchema>;

export const taskSchema = z.object({
  id: z.string(),
  projectId: z.string(),
  sequence: z.number().int().positive(),
  parentTaskId: z.string().nullable().default(null),
  childTaskIds: z.array(z.string()).default([]),
  title: z.string(),
  lifecycle: taskLifecycleSchema,
  priority: taskPrioritySchema.default("normal"),
  position: z.number().int().nonnegative().default(0),
  notBefore: taskDateSchema.nullable().default(null),
  dueAt: taskDateSchema.nullable().default(null),
  size: taskSizeSchema.nullable().default(null),
  tags: z.array(tagSchema).default([]),
  requiredCapabilities: z.array(capabilityNameSchema).default([]),
  upstreamRelations: z.array(taskRelationSchema).default([]),
  downstreamRelations: z.array(taskRelationSchema).default([]),
  eligibility: taskEligibilitySchema.optional(),
  description: richTextDocumentSchema,
  descriptionText: z.string(),
  expectedOutcome: z.string(),
  acceptanceCriteria: z.string(),
  agentContext: z.string(),
  checklist: z.array(checklistItemSchema),
  version: z.number().int().positive(),
  archivedAt: z.string().nullable(),
  createdAt: z.string(),
  updatedAt: z.string(),
});
export type Task = z.infer<typeof taskSchema>;

const taskFieldsSchema = z.object({
  title: z.string().trim().min(1).max(300),
  description: richTextDocumentSchema,
  expectedOutcome: z.string().trim().max(10_000),
  acceptanceCriteria: z.string().trim().max(20_000),
  agentContext: z.string().trim().max(20_000),
  checklist: z.array(checklistItemSchema).max(200),
});

const optionalTaskPlanningFieldsSchema = z.object({
  priority: taskPrioritySchema.optional(),
  position: z.number().int().nonnegative().optional(),
  notBefore: taskDateSchema.nullable().optional(),
  dueAt: taskDateSchema.nullable().optional(),
  size: taskSizeSchema.nullable().optional(),
  tags: z.array(tagInputSchema).max(50).optional(),
  requiredCapabilities: z.array(capabilityNameSchema).max(50).optional(),
});

export const createTaskInputSchema = taskFieldsSchema.extend({
  projectId: z.string().trim().min(1),
  parentTaskId: z.string().trim().min(1).nullable().optional().default(null),
  lifecycle: z.enum(["backlog", "ready"]),
  expectedVersion: z.literal(0),
  idempotencyKey: z.string().trim().min(1).max(200),
  ...optionalTaskPlanningFieldsSchema.shape,
});
export type CreateTaskInput = z.infer<typeof createTaskInputSchema>;

export const prepareTaskInputSchema = taskFieldsSchema.extend({
  taskId: z.string().trim().min(1),
  expectedVersion: z.number().int().positive(),
  idempotencyKey: z.string().trim().min(1).max(200),
  ...optionalTaskPlanningFieldsSchema.shape,
});
export type PrepareTaskInput = z.infer<typeof prepareTaskInputSchema>;

export const archiveTaskInputSchema = z.object({
  taskId: z.string().trim().min(1),
  expectedVersion: z.number().int().positive(),
  reason: z.string().trim().min(1).max(1_000),
  idempotencyKey: z.string().trim().min(1).max(200),
});
export type ArchiveTaskInput = z.infer<typeof archiveTaskInputSchema>;

export const completeTaskInputSchema = z.object({
  taskId: z.string().trim().min(1),
  expectedVersion: z.number().int().positive(),
  idempotencyKey: z.string().trim().min(1).max(200),
});
export type CompleteTaskInput = z.infer<typeof completeTaskInputSchema>;

export const reopenTaskInputSchema = z.object({
  taskId: z.string().trim().min(1),
  expectedVersion: z.number().int().positive(),
  reason: z.string().trim().min(1).max(1_000),
  idempotencyKey: z.string().trim().min(1).max(200),
});
export type ReopenTaskInput = z.infer<typeof reopenTaskInputSchema>;

export const updateTaskPlanningInputSchema = z.object({
  taskId: z.string().trim().min(1),
  priority: taskPrioritySchema,
  position: z.number().int().nonnegative(),
  notBefore: taskDateSchema.nullable(),
  dueAt: taskDateSchema.nullable(),
  size: taskSizeSchema.nullable(),
  tags: z.array(tagInputSchema).max(50),
  requiredCapabilities: z.array(capabilityNameSchema).max(50),
  expectedVersion: z.number().int().positive(),
  idempotencyKey: z.string().trim().min(1).max(200),
});
export type UpdateTaskPlanningInput = z.infer<typeof updateTaskPlanningInputSchema>;

export const createTaskRelationInputSchema = z.object({
  projectId: z.string().trim().min(1),
  sourceTaskId: z.string().trim().min(1),
  targetTaskId: z.string().trim().min(1),
  type: taskRelationTypeSchema,
  expectedSourceVersion: z.number().int().positive(),
  expectedTargetVersion: z.number().int().positive(),
  idempotencyKey: z.string().trim().min(1).max(200),
});
export type CreateTaskRelationInput = z.infer<typeof createTaskRelationInputSchema>;

export const listTasksInputSchema = z.object({
  projectId: z.string().trim().min(1),
  includeArchived: z.boolean().optional().default(false),
  agentCapabilities: z.array(capabilityNameSchema).optional().default([]),
  now: taskDateSchema.optional(),
});
export type ListTasksInput = z.infer<typeof listTasksInputSchema>;

export const discoverTasksInputSchema = z.object({
  projectId: z.string().trim().min(1),
  agentCapabilities: z.array(capabilityNameSchema).optional().default([]),
  now: taskDateSchema.optional(),
  limit: z.number().int().positive().max(100).optional().default(25),
});
export type DiscoverTasksInput = z.infer<typeof discoverTasksInputSchema>;

export const compiledCreateTaskInputSchema = z.compile(createTaskInputSchema);
export const compiledPrepareTaskInputSchema = z.compile(prepareTaskInputSchema);
export const compiledArchiveTaskInputSchema = z.compile(archiveTaskInputSchema);
export const compiledCompleteTaskInputSchema = z.compile(completeTaskInputSchema);
export const compiledReopenTaskInputSchema = z.compile(reopenTaskInputSchema);
export const compiledUpdateTaskPlanningInputSchema = z.compile(updateTaskPlanningInputSchema);
export const compiledCreateTaskRelationInputSchema = z.compile(createTaskRelationInputSchema);
export const compiledListTasksInputSchema = z.compile(listTasksInputSchema);
export const compiledDiscoverTasksInputSchema = z.compile(discoverTasksInputSchema);

function nodePlainText(value: unknown): string {
  const parsed = tipTapNodeSchema.safeParse(value);
  if (!parsed.success) return "";
  if (parsed.data.type === "hardBreak") return "\n";
  if (parsed.data.text) return parsed.data.text;
  const children = parsed.data.content ?? [];
  const separator = ["doc", "bulletList", "orderedList", "listItem", "blockquote"].includes(
    parsed.data.type,
  )
    ? "\n"
    : "";
  return children.map(nodePlainText).filter(Boolean).join(separator);
}

export function richTextToPlainText(document: RichTextDocument) {
  return nodePlainText(document.doc)
    .replace(/[ \t]+\n/g, "\n")
    .replace(/\n{3,}/g, "\n\n")
    .trim();
}

export const readyPreparationFields = [
  "expectedOutcome",
  "acceptanceCriteria",
  "checklist",
] as const;

export function missingReadyPreparation(input: {
  expectedOutcome: string;
  acceptanceCriteria: string;
  checklist: readonly ChecklistItem[];
}) {
  return readyPreparationFields.filter((field) => {
    if (field === "checklist") return input.checklist.length === 0;
    return input[field].trim().length === 0;
  });
}

export function duplicateExclusiveTagGroups(
  tags: readonly { name: string; exclusiveGroup?: string | null }[],
) {
  const groups = new Map<string, string[]>();
  for (const tag of tags) {
    if (!tag.exclusiveGroup) continue;
    groups.set(tag.exclusiveGroup, [...(groups.get(tag.exclusiveGroup) ?? []), tag.name]);
  }
  return [...groups.entries()]
    .filter(([, names]) => names.length > 1)
    .map(([group, names]) => ({ group, tagNames: names }));
}

export const taskPriorityRank: Record<TaskPriority, number> = {
  urgent: 0,
  high: 1,
  normal: 2,
  low: 3,
};

export function todayIsoDate() {
  return new Date().toISOString().slice(0, 10);
}
