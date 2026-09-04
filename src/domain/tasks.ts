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

export const taskDateSchema = z.iso.date({
  error: "Use a valid ISO date in YYYY-MM-DD format.",
});

function hasControlCharacter(value: string) {
  for (let index = 0; index < value.length; index += 1) {
    const codeUnit = value.charCodeAt(index);
    if (codeUnit <= 31 || codeUnit === 127) return true;
  }
  return false;
}

export const taskReferencedPathSchema = z
  .string()
  .trim()
  .min(1)
  .max(1_000)
  .refine((path) => {
    if (path.startsWith("/") || path.startsWith("\\") || /^[a-z]:/i.test(path)) return false;
    const segments = path.split(/[\\/]/);
    return (
      !path.includes("\\") &&
      segments.every((segment) => segment.length > 0 && segment !== "." && segment !== "..")
    );
  }, "Use a normalized path relative to the repository root.")
  .refine(
    (path) => path.split("/").every((segment) => new TextEncoder().encode(segment).length <= 255),
    "Each referenced-path segment must be at most 255 UTF-8 bytes.",
  )
  .refine(
    (path) => !hasControlCharacter(path),
    "Referenced paths may not contain control characters.",
  );

const taskReferencedPathsSchema = z
  .array(taskReferencedPathSchema)
  .max(100)
  .superRefine((paths, context) => {
    const uniquePaths = new Set<string>();
    for (const [index, path] of paths.entries()) {
      if (uniquePaths.has(path)) {
        context.addIssue({
          code: "custom",
          message: `Referenced path ${path} may only appear once.`,
          path: [index],
        });
      }
      uniquePaths.add(path);
    }
  });

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

const tagAssignmentsSchema = z
  .array(tagInputSchema)
  .max(50)
  .superRefine((assignedTags, context) => {
    const names = new Set<string>();
    for (const [index, tag] of assignedTags.entries()) {
      if (names.has(tag.name)) {
        context.addIssue({
          code: "custom",
          message: `Tag ${tag.name} may only be assigned once.`,
          path: [index, "name"],
        });
      }
      names.add(tag.name);
    }
  });

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
  referencedPaths: taskReferencedPathsSchema.default([]),
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

export const taskAttemptSummarySchema = z.object({
  id: z.string(),
  taskId: z.string(),
  agentRunId: z.string().nullable(),
  status: z.enum(["active", "completed", "failed", "abandoned"]),
  summary: z.string(),
  verification: z.array(z.string()),
  createdAt: z.string(),
  completedAt: z.string().nullable(),
});
export type TaskAttemptSummary = z.infer<typeof taskAttemptSummarySchema>;

export const taskContextPackageSchema = z.object({
  projectId: z.string(),
  task: taskSchema,
  acceptanceCriteria: z.string(),
  agentContext: z.string(),
  checklist: z.array(checklistItemSchema),
  relations: z.object({
    upstream: z.array(taskRelationSchema),
    downstream: z.array(taskRelationSchema),
  }),
  paths: z.object({
    repositoryRoot: z.string(),
    referencedPaths: z.array(z.string()),
  }),
  priorAttempts: z.array(taskAttemptSummarySchema),
  projectInstructions: z.array(
    z.object({
      path: z.string(),
      text: z.string(),
    }),
  ),
});
export type TaskContextPackage = z.infer<typeof taskContextPackageSchema>;

export const taskCandidateFieldSchema = z.enum([
  "descriptionText",
  "expectedOutcome",
  "acceptanceCriteria",
  "agentContext",
  "checklist",
  "relations",
  "referencedPaths",
  "timestamps",
]);
export type TaskCandidateField = z.infer<typeof taskCandidateFieldSchema>;

export const taskCandidateSchema = z.object({
  id: z.string(),
  projectId: z.string(),
  sequence: z.number().int().positive(),
  parentTaskId: z.string().nullable(),
  title: z.string(),
  lifecycle: taskLifecycleSchema,
  priority: taskPrioritySchema,
  position: z.number().int().nonnegative(),
  dueAt: taskDateSchema.nullable(),
  size: taskSizeSchema.nullable(),
  tags: z.array(tagSchema),
  requiredCapabilities: z.array(capabilityNameSchema),
  eligibility: taskEligibilitySchema,
  version: z.number().int().positive(),
  descriptionText: z.string().optional(),
  expectedOutcome: z.string().optional(),
  acceptanceCriteria: z.string().optional(),
  agentContext: z.string().optional(),
  checklist: z.array(checklistItemSchema).optional(),
  upstreamRelations: z.array(taskRelationSchema).optional(),
  downstreamRelations: z.array(taskRelationSchema).optional(),
  referencedPaths: taskReferencedPathsSchema.optional(),
  createdAt: z.string().optional(),
  updatedAt: z.string().optional(),
});
export type TaskCandidate = z.infer<typeof taskCandidateSchema>;

export const taskDiscoveryPageSchema = z.object({
  candidates: z.array(taskCandidateSchema),
  nextCursor: z.string().nullable(),
});
export type TaskDiscoveryPage = z.infer<typeof taskDiscoveryPageSchema>;

const taskFieldsSchema = z.object({
  title: z.string().trim().min(1).max(300),
  description: richTextDocumentSchema,
  expectedOutcome: z.string().trim().max(10_000),
  acceptanceCriteria: z.string().trim().max(20_000),
  agentContext: z.string().trim().max(20_000),
  checklist: z.array(checklistItemSchema).max(200),
  referencedPaths: taskReferencedPathsSchema.optional().default([]),
});

const optionalTaskPlanningFieldsSchema = z.object({
  priority: taskPrioritySchema.optional(),
  position: z.number().int().nonnegative().optional(),
  notBefore: taskDateSchema.nullable().optional(),
  dueAt: taskDateSchema.nullable().optional(),
  size: taskSizeSchema.nullable().optional(),
  tags: tagAssignmentsSchema.optional(),
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
  tags: tagAssignmentsSchema,
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
});
export type ListTasksInput = z.infer<typeof listTasksInputSchema>;

export const listTaskTagsInputSchema = z.object({
  projectId: z.string().trim().min(1),
});
export type ListTaskTagsInput = z.infer<typeof listTaskTagsInputSchema>;

export const taskDiscoveryCursorSchema = z
  .string()
  .trim()
  .max(200)
  .regex(
    /^v3:(0|[1-9]\d*):[a-f0-9]{64}:(urgent|high|normal|low):(0|[1-9]\d*):(~|\d{4}-\d{2}-\d{2}):([1-9]\d*)$/,
    "The work-discovery cursor is invalid.",
  )
  .refine(isValidTaskDiscoveryCursor, "The work-discovery cursor is invalid.");

export const findWorkInputSchema = z.object({
  projectId: z.string().trim().min(1),
  limit: z.number().int().positive().max(100).optional().default(25),
  cursor: taskDiscoveryCursorSchema.nullable().optional().default(null),
  fields: z.array(taskCandidateFieldSchema).max(20).optional().default([]),
});
export type FindWorkInput = z.infer<typeof findWorkInputSchema>;

export const taskContextInputSchema = z.object({
  projectId: z.string().trim().min(1),
  taskId: z.string().trim().min(1),
});
export type TaskContextInput = z.infer<typeof taskContextInputSchema>;

export const compiledCreateTaskInputSchema = z.compile(createTaskInputSchema);
export const compiledPrepareTaskInputSchema = z.compile(prepareTaskInputSchema);
export const compiledArchiveTaskInputSchema = z.compile(archiveTaskInputSchema);
export const compiledCompleteTaskInputSchema = z.compile(completeTaskInputSchema);
export const compiledReopenTaskInputSchema = z.compile(reopenTaskInputSchema);
export const compiledUpdateTaskPlanningInputSchema = z.compile(updateTaskPlanningInputSchema);
export const compiledCreateTaskRelationInputSchema = z.compile(createTaskRelationInputSchema);
export const compiledListTasksInputSchema = z.compile(listTasksInputSchema);
export const compiledListTaskTagsInputSchema = z.compile(listTaskTagsInputSchema);
export const compiledFindWorkInputSchema = z.compile(findWorkInputSchema);
export const compiledTaskContextInputSchema = z.compile(taskContextInputSchema);

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

export type TaskEvaluationContext = {
  readonly agentCapabilities: readonly string[];
  readonly today: string;
};

export type TaskOrderingKey = Pick<Task, "priority" | "position" | "dueAt" | "sequence">;

export type BlockingEdge = {
  readonly sourceTaskId: string;
  readonly targetTaskId: string;
};

export function normalizeCapabilities(capabilities: readonly string[] = []) {
  return [
    ...new Set(
      capabilities
        .map((capability) => capability.trim().toLocaleLowerCase("en-US"))
        .filter(Boolean),
    ),
  ].toSorted((left, right) => left.localeCompare(right));
}

export function taskOrderingExplanation(task: TaskOrderingKey) {
  return [
    `${task.priority} lane`,
    `position ${task.position}`,
    task.dueAt ? `due ${task.dueAt}` : "no due date",
    `stable tie-breaker #${task.sequence}`,
  ].join(", ");
}

export function evaluateTaskEligibility(
  task: Task,
  context: TaskEvaluationContext,
  blockingTaskIds: readonly string[],
): TaskEligibility {
  const agentCapabilities = new Set(normalizeCapabilities(context.agentCapabilities));
  const missingCapabilities = task.requiredCapabilities.filter(
    (capability) => !agentCapabilities.has(capability.toLocaleLowerCase("en-US")),
  );
  const orderingExplanation = taskOrderingExplanation(task);

  if (task.archivedAt) {
    return {
      claimable: false,
      status: "archived",
      reasons: ["Task is archived."],
      orderingExplanation,
      missingCapabilities,
      blockingTaskIds: [...blockingTaskIds],
    };
  }
  if (task.lifecycle === "done") {
    return {
      claimable: false,
      status: "complete",
      reasons: ["Task is complete."],
      orderingExplanation,
      missingCapabilities,
      blockingTaskIds: [...blockingTaskIds],
    };
  }
  if (task.lifecycle !== "ready") {
    return {
      claimable: false,
      status: "not_ready",
      reasons: ["Task is not ready."],
      orderingExplanation,
      missingCapabilities,
      blockingTaskIds: [...blockingTaskIds],
    };
  }
  if (task.notBefore && task.notBefore > context.today) {
    return {
      claimable: false,
      status: "scheduled",
      reasons: [`Task starts on ${task.notBefore}.`],
      orderingExplanation,
      missingCapabilities,
      blockingTaskIds: [...blockingTaskIds],
    };
  }
  if (blockingTaskIds.length > 0) {
    return {
      claimable: false,
      status: "blocked",
      reasons: [`Blocked by: ${blockingTaskIds.join(", ")}.`],
      orderingExplanation,
      missingCapabilities,
      blockingTaskIds: [...blockingTaskIds],
    };
  }
  if (missingCapabilities.length > 0) {
    return {
      claimable: false,
      status: "capability_mismatch",
      reasons: [`Missing capabilities: ${missingCapabilities.join(", ")}.`],
      orderingExplanation,
      missingCapabilities,
      blockingTaskIds: [...blockingTaskIds],
    };
  }
  return {
    claimable: true,
    status: "claimable",
    reasons: ["Ready, unscheduled, and capability-compatible."],
    orderingExplanation,
    missingCapabilities,
    blockingTaskIds: [...blockingTaskIds],
  };
}

export function compareTaskOrder(left: TaskOrderingKey, right: TaskOrderingKey) {
  const priority = taskPriorityRank[left.priority] - taskPriorityRank[right.priority];
  if (priority !== 0) return priority;
  const position = left.position - right.position;
  if (position !== 0) return position;
  if (left.dueAt !== right.dueAt) {
    if (!left.dueAt) return 1;
    if (!right.dueAt) return -1;
    return left.dueAt.localeCompare(right.dueAt);
  }
  return left.sequence - right.sequence;
}

function taskDiscoveryCursorParts(cursor: string) {
  const [, revision, evaluationKey, priority, position, dueAt, sequence] = cursor.split(":");
  return { revision, evaluationKey, priority, position, dueAt, sequence };
}

function isValidTaskDiscoveryCursor(cursor: string) {
  const { revision, evaluationKey, priority, position, dueAt, sequence } =
    taskDiscoveryCursorParts(cursor);
  return (
    Number.isSafeInteger(Number(revision)) &&
    Number(revision) >= 0 &&
    /^[a-f0-9]{64}$/.test(evaluationKey ?? "") &&
    taskPrioritySchema.safeParse(priority).success &&
    Number.isSafeInteger(Number(position)) &&
    Number(position) >= 0 &&
    (dueAt === "~" || taskDateSchema.safeParse(dueAt).success) &&
    Number.isSafeInteger(Number(sequence)) &&
    Number(sequence) > 0
  );
}

export function encodeTaskDiscoveryCursor(
  task: TaskOrderingKey,
  revision: number,
  evaluationKey: string,
) {
  return taskDiscoveryCursorSchema.parse(
    `v3:${revision}:${evaluationKey}:${task.priority}:${task.position}:${task.dueAt ?? "~"}:${task.sequence}`,
  );
}

export function decodeTaskDiscoveryCursor(
  cursor: string,
): TaskOrderingKey & { revision: number; evaluationKey: string } {
  const parsedCursor = taskDiscoveryCursorSchema.parse(cursor);
  const { revision, evaluationKey, priority, position, dueAt, sequence } =
    taskDiscoveryCursorParts(parsedCursor);
  return {
    revision: Number(revision),
    evaluationKey: evaluationKey!,
    priority: taskPrioritySchema.parse(priority),
    position: Number(position),
    dueAt: dueAt === "~" ? null : taskDateSchema.parse(dueAt),
    sequence: Number(sequence),
  };
}

export function findBlockingPath(
  edges: readonly BlockingEdge[],
  startTaskId: string,
  goalTaskId: string,
) {
  const outgoing = new Map<string, string[]>();
  for (const edge of edges) {
    outgoing.set(edge.sourceTaskId, [
      ...(outgoing.get(edge.sourceTaskId) ?? []),
      edge.targetTaskId,
    ]);
  }
  const queue: Array<readonly string[]> = [[startTaskId]];
  const visited = new Set<string>();
  for (const path of queue) {
    const current = path.at(-1);
    if (!current || visited.has(current)) continue;
    if (current === goalTaskId) return path;
    visited.add(current);
    for (const next of outgoing.get(current) ?? []) queue.push([...path, next]);
  }
  return null;
}

export function isIncompleteBlockingDependency(task: {
  readonly lifecycle: TaskLifecycle;
  readonly archivedAt: string | null;
}) {
  return !task.archivedAt && task.lifecycle !== "done" && task.lifecycle !== "cancelled";
}

export function taskParentViolation(
  parent: Pick<Task, "projectId" | "parentTaskId">,
  projectId: string,
) {
  if (parent.projectId !== projectId) return "different_project" as const;
  if (parent.parentTaskId) return "nested" as const;
  return null;
}
