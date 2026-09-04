import { z } from "zod";

import {
  customFieldDateValueSchema,
  customFieldNumberValueSchema,
  customFieldTextValueSchema,
  customFieldValueSchema,
  type CustomFieldType,
} from "./customization";
import {
  capabilityNameSchema,
  taskCandidateFieldSchema,
  taskCandidateSchema,
  taskDateSchema,
  taskLifecycleSchema,
  taskPrioritySchema,
  taskRelationTypeSchema,
  type Task,
  type TaskCandidateField,
  type TaskRelation,
} from "./tasks";

const opaqueIdSchema = z.string().trim().min(1).max(200);
const timestampSchema = z.iso.datetime({ offset: true });

export const taskFilterSearchModeSchema = z.enum(["all", "any", "phrase"]);
export const taskFilterArchiveStateSchema = z.enum(["exclude", "include", "only"]);
export const taskFilterEligibilityStatusSchema = z.enum([
  "not_ready",
  "scheduled",
  "blocked",
  "capability_mismatch",
  "claimable",
  "claimed",
  "complete",
  "archived",
]);

const taskFilterSetOperatorSchema = z.enum(["any_of", "all_of", "none_of"]);

export const taskFilterActorReferenceSchema = z.discriminatedUnion("type", [
  z.strictObject({ type: z.literal("human"), id: opaqueIdSchema }),
  z.strictObject({ type: z.literal("system"), id: opaqueIdSchema }),
  z.strictObject({ type: z.literal("agent_profile"), id: opaqueIdSchema }),
  z.strictObject({ type: z.literal("agent_run"), id: opaqueIdSchema }),
]);
export type TaskFilterActorReference = z.infer<typeof taskFilterActorReferenceSchema>;

export const taskFilterActorSourceSchema = z.enum(["activity", "attempt", "event"]);
export type TaskFilterActorSource = z.infer<typeof taskFilterActorSourceSchema>;

const taskFilterDateFieldSchema = z.enum(["not_before", "due_at", "created_at", "updated_at"]);
export type TaskFilterDateField = z.infer<typeof taskFilterDateFieldSchema>;

function isCalendarDateField(field: TaskFilterDateField) {
  return field === "not_before" || field === "due_at";
}

function addInvalidDateIssue(
  context: z.core.$RefinementCtx,
  field: TaskFilterDateField,
  value: string,
  path: PropertyKey[],
) {
  const valid = isCalendarDateField(field)
    ? taskDateSchema.safeParse(value).success
    : timestampSchema.safeParse(value).success;
  if (!valid) {
    context.addIssue({
      code: "custom",
      message: isCalendarDateField(field)
        ? "Use an ISO date in YYYY-MM-DD format."
        : "Use an ISO timestamp with a timezone.",
      path,
      input: value,
    });
  }
}

const dateBetweenClauseSchema = z
  .strictObject({
    field: taskFilterDateFieldSchema,
    operator: z.literal("between"),
    from: z.string().min(1).max(100),
    to: z.string().min(1).max(100),
  })
  .superRefine((clause, context) => {
    addInvalidDateIssue(context, clause.field, clause.from, ["from"]);
    addInvalidDateIssue(context, clause.field, clause.to, ["to"]);
    const from = isCalendarDateField(clause.field) ? clause.from : Date.parse(clause.from);
    const to = isCalendarDateField(clause.field) ? clause.to : Date.parse(clause.to);
    if (from > to) {
      context.addIssue({
        code: "custom",
        message: "The beginning of a date range must not be after its end.",
        path: ["to"],
        input: clause.to,
      });
    }
  });

function boundedDateComparisonClause(operator: "on_or_after" | "on_or_before") {
  return z
    .strictObject({
      field: taskFilterDateFieldSchema,
      operator: z.literal(operator),
      value: z.string().min(1).max(100),
    })
    .superRefine((clause, context) => {
      addInvalidDateIssue(context, clause.field, clause.value, ["value"]);
    });
}

export const taskFilterDateClauseSchema = z.discriminatedUnion("operator", [
  dateBetweenClauseSchema,
  boundedDateComparisonClause("on_or_after"),
  boundedDateComparisonClause("on_or_before"),
  z.strictObject({
    field: taskFilterDateFieldSchema,
    operator: z.literal("present"),
  }),
  z.strictObject({
    field: taskFilterDateFieldSchema,
    operator: z.literal("missing"),
  }),
]);
export type TaskFilterDateClause = z.infer<typeof taskFilterDateClauseSchema>;

export const taskFilterRelationClauseSchema = z.strictObject({
  direction: z.enum(["upstream", "downstream", "either"]),
  operator: z.enum(["exists", "not_exists"]),
  types: z.array(taskRelationTypeSchema).min(1).max(4).optional(),
  taskIds: z.array(opaqueIdSchema).min(1).max(200).optional(),
});
export type TaskFilterRelationClause = z.infer<typeof taskFilterRelationClauseSchema>;

const customFieldClauseBase = { fieldId: opaqueIdSchema };

const taskFilterCustomFieldPresenceClauseSchema = z.strictObject({
  ...customFieldClauseBase,
  operator: z.enum(["present", "missing"]),
});

const taskFilterCustomFieldEqualityClauseSchema = z.strictObject({
  ...customFieldClauseBase,
  operator: z.enum(["equals", "not_equals"]),
  value: customFieldValueSchema,
});

const taskFilterCustomFieldTextClauseSchema = z.strictObject({
  ...customFieldClauseBase,
  operator: z.enum(["contains", "not_contains", "starts_with", "ends_with"]),
  value: customFieldTextValueSchema,
});

const taskFilterCustomFieldNumberClauseSchema = z.strictObject({
  ...customFieldClauseBase,
  operator: z.enum(["greater_than", "greater_than_or_equal", "less_than", "less_than_or_equal"]),
  value: customFieldNumberValueSchema,
});

const taskFilterCustomFieldNumberBetweenClauseSchema = z
  .strictObject({
    ...customFieldClauseBase,
    operator: z.literal("between"),
    from: customFieldNumberValueSchema,
    to: customFieldNumberValueSchema,
  })
  .superRefine((clause, context) => {
    if (clause.from.value > clause.to.value) {
      context.addIssue({
        code: "custom",
        message: "The beginning of a number range must not exceed its end.",
        path: ["to"],
        input: clause.to,
      });
    }
  });

const taskFilterCustomFieldDateClauseSchema = z.strictObject({
  ...customFieldClauseBase,
  operator: z.enum(["before", "on_or_before", "after", "on_or_after"]),
  value: customFieldDateValueSchema,
});

const taskFilterCustomFieldDateBetweenClauseSchema = z
  .strictObject({
    ...customFieldClauseBase,
    operator: z.literal("between"),
    from: customFieldDateValueSchema,
    to: customFieldDateValueSchema,
  })
  .superRefine((clause, context) => {
    if (clause.from.value > clause.to.value) {
      context.addIssue({
        code: "custom",
        message: "The beginning of a date range must not be after its end.",
        path: ["to"],
        input: clause.to,
      });
    }
  });

/**
 * Custom-field operands reuse the tagged value contract used by task mutations and projections.
 * Presence works across all field types; every other operator carries its expected field type.
 */
export const taskFilterCustomFieldClauseSchema = z.union([
  taskFilterCustomFieldPresenceClauseSchema,
  taskFilterCustomFieldEqualityClauseSchema,
  taskFilterCustomFieldTextClauseSchema,
  taskFilterCustomFieldNumberClauseSchema,
  taskFilterCustomFieldNumberBetweenClauseSchema,
  taskFilterCustomFieldDateClauseSchema,
  taskFilterCustomFieldDateBetweenClauseSchema,
]);
export type TaskFilterCustomFieldClause = z.infer<typeof taskFilterCustomFieldClauseSchema>;

export function taskFilterCustomFieldOperandType(
  clause: TaskFilterCustomFieldClause,
): CustomFieldType | null {
  if ("value" in clause) return clause.value.type;
  if ("from" in clause) return clause.from.type;
  return null;
}

const taskFilterTagsSchema = z.strictObject({
  operator: taskFilterSetOperatorSchema,
  values: z.array(opaqueIdSchema).min(1).max(100),
});

const taskFilterCapabilitiesSchema = z.strictObject({
  operator: taskFilterSetOperatorSchema,
  values: z.array(capabilityNameSchema).min(1).max(100),
});

const taskFilterActorSchema = z.strictObject({
  operator: z.enum(["any_of", "none_of"]),
  actors: z.array(taskFilterActorReferenceSchema).min(1).max(100),
  sources: z.array(taskFilterActorSourceSchema).min(1).max(3),
});

export const taskFilterV1Schema = z.strictObject({
  schemaVersion: z.literal(1),
  projectId: opaqueIdSchema,
  search: z
    .strictObject({
      text: z.string().trim().min(1).max(500),
      mode: taskFilterSearchModeSchema.default("all"),
    })
    .optional(),
  archiveState: taskFilterArchiveStateSchema.default("exclude"),
  lifecycles: z.array(taskLifecycleSchema).min(1).max(6).optional(),
  eligibility: z.array(taskFilterEligibilityStatusSchema).min(1).max(8).optional(),
  priorities: z.array(taskPrioritySchema).min(1).max(4).optional(),
  tags: taskFilterTagsSchema.optional(),
  capabilities: taskFilterCapabilitiesSchema.optional(),
  actor: taskFilterActorSchema.optional(),
  dates: z.array(taskFilterDateClauseSchema).min(1).max(24).optional(),
  relations: z.array(taskFilterRelationClauseSchema).min(1).max(24).optional(),
  customFields: z.array(taskFilterCustomFieldClauseSchema).min(1).max(24).optional(),
});
export type TaskFilterV1 = z.infer<typeof taskFilterV1Schema>;

export const taskSearchOrderFieldSchema = z.enum([
  "relevance",
  "priority",
  "position",
  "due_at",
  "not_before",
  "created_at",
  "updated_at",
  "sequence",
  "title",
  "id",
]);
export const taskSearchOrderDirectionSchema = z.enum(["asc", "desc"]);
export const taskSearchOrderSchema = z.strictObject({
  field: taskSearchOrderFieldSchema,
  direction: taskSearchOrderDirectionSchema,
});
export type TaskSearchOrder = z.infer<typeof taskSearchOrderSchema>;

export const taskSearchOrderListSchema = z.array(taskSearchOrderSchema).min(1).max(10);

/**
 * Optional task-candidate groups available to bounded search callers.
 *
 * - `descriptionText`, `expectedOutcome`, `acceptanceCriteria`, `agentContext`, and `checklist`
 *   each add their same-named property.
 * - `relations` adds `upstreamRelations` and `downstreamRelations`.
 * - `customFields`, `reviewPolicy`, and `referencedPaths` each add their same-named property.
 * - `timestamps` adds `archivedAt`, `createdAt`, and `updatedAt`.
 *
 * Core candidate identity, planning, assignment, and eligibility fields are always present.
 */
export const taskSearchFieldSchema = taskCandidateFieldSchema;
export type TaskSearchField = TaskCandidateField;

export const completeTaskSearchFields: TaskSearchField[] = [
  ...taskSearchFieldSchema.options,
].toSorted((left, right) => left.localeCompare(right));
export const taskSearchFieldListSchema = z
  .array(taskSearchFieldSchema)
  .max(taskSearchFieldSchema.options.length)
  .default([])
  .describe(
    "Optional candidate groups: descriptionText, expectedOutcome, acceptanceCriteria, agentContext, checklist, relations (upstreamRelations and downstreamRelations), customFields, reviewPolicy, referencedPaths, and timestamps (archivedAt, createdAt, and updatedAt).",
  );

export const searchTasksInputSchema = z
  .strictObject({
    filter: taskFilterV1Schema,
    order: taskSearchOrderListSchema.optional(),
    fields: taskSearchFieldListSchema,
    limit: z.number().int().positive().max(100).default(50),
    cursor: z.string().trim().min(1).max(4_000).nullable().default(null),
  })
  .superRefine((input, context) => {
    if (!input.filter.search && input.order?.some(({ field }) => field === "relevance")) {
      context.addIssue({
        code: "custom",
        message: "Relevance ordering requires a text search.",
        path: ["order"],
        input: input.order,
      });
    }
  });
export type SearchTasksInput = z.infer<typeof searchTasksInputSchema>;

export const taskSearchMatchedSourceSchema = z.enum([
  "title",
  "task_content",
  "acceptance_criteria",
  "comments",
  "reports",
]);
export type TaskSearchMatchedSource = z.infer<typeof taskSearchMatchedSourceSchema>;

/** A compact search row; optional properties are present only when their field group is selected. */
export const taskSearchCandidateSchema = taskCandidateSchema.extend({
  notBefore: taskDateSchema.nullable(),
  archivedAt: timestampSchema.nullable().optional(),
});
export type TaskSearchCandidate = z.infer<typeof taskSearchCandidateSchema>;

export const taskSearchItemSchema = z.strictObject({
  task: taskSearchCandidateSchema,
  relevance: z.number().finite().nullable(),
  matchedSources: z.array(taskSearchMatchedSourceSchema).max(5),
});
export type TaskSearchItem = z.infer<typeof taskSearchItemSchema>;

export const taskSearchPageSchema = z.strictObject({
  items: z.array(taskSearchItemSchema).max(100),
  nextCursor: z.string().max(4_000).nullable(),
  hasMore: z.boolean(),
  total: z.number().int().nonnegative(),
  revision: z.number().int().nonnegative(),
});
export type TaskSearchPage = z.infer<typeof taskSearchPageSchema>;

export const compiledTaskFilterV1Schema = z.compile(taskFilterV1Schema);
export const compiledSearchTasksInputSchema = z.compile(searchTasksInputSchema);
export const compiledTaskSearchPageSchema = z.compile(taskSearchPageSchema);

function sortedUnique<T extends string>(values: readonly T[]): T[] {
  return [...new Set(values)].toSorted((left, right) => left.localeCompare(right));
}

export function canonicalizeTaskSearchFields(
  input: readonly TaskSearchField[] | undefined,
): TaskSearchField[] {
  return sortedUnique(taskSearchFieldListSchema.parse(input));
}

function uniqueByCanonicalJson<T>(values: readonly T[]) {
  const keyed = new Map(values.map((value) => [stableCanonicalJson(value), value]));
  return [...keyed.entries()]
    .toSorted(([left], [right]) => left.localeCompare(right))
    .map(([, value]) => value);
}

function canonicalizeDateClause(clause: TaskFilterDateClause): TaskFilterDateClause {
  if (
    isCalendarDateField(clause.field) ||
    clause.operator === "present" ||
    clause.operator === "missing"
  ) {
    return clause;
  }
  if (clause.operator === "between") {
    return {
      ...clause,
      from: new Date(clause.from).toISOString(),
      to: new Date(clause.to).toISOString(),
    };
  }
  return { ...clause, value: new Date(clause.value).toISOString() };
}

function canonicalizeRelationClause(relation: TaskFilterRelationClause): TaskFilterRelationClause {
  return {
    ...relation,
    ...(relation.types ? { types: sortedUnique(relation.types) } : {}),
    ...(relation.taskIds ? { taskIds: sortedUnique(relation.taskIds) } : {}),
  };
}

function normalizeCustomFieldText(value: string) {
  return value.normalize("NFKC").toLocaleLowerCase("en-US");
}

function canonicalizeCustomFieldClause(
  clause: TaskFilterCustomFieldClause,
): TaskFilterCustomFieldClause {
  if (
    clause.operator !== "contains" &&
    clause.operator !== "not_contains" &&
    clause.operator !== "starts_with" &&
    clause.operator !== "ends_with"
  ) {
    return clause;
  }
  return {
    ...clause,
    value: {
      type: "text",
      value: normalizeCustomFieldText(clause.value.value),
    },
  };
}

export function canonicalizeTaskFilter(input: unknown): TaskFilterV1 {
  const filter = taskFilterV1Schema.parse(input);
  const canonical = {
    ...filter,
    ...(filter.lifecycles ? { lifecycles: sortedUnique(filter.lifecycles) } : {}),
    ...(filter.eligibility ? { eligibility: sortedUnique(filter.eligibility) } : {}),
    ...(filter.priorities ? { priorities: sortedUnique(filter.priorities) } : {}),
    ...(filter.tags ? { tags: { ...filter.tags, values: sortedUnique(filter.tags.values) } } : {}),
    ...(filter.capabilities
      ? {
          capabilities: {
            ...filter.capabilities,
            values: sortedUnique(
              filter.capabilities.values.map((capability) => capability.toLocaleLowerCase("en-US")),
            ),
          },
        }
      : {}),
    ...(filter.actor
      ? {
          actor: {
            ...filter.actor,
            actors: uniqueByCanonicalJson(filter.actor.actors),
            sources: sortedUnique(filter.actor.sources),
          },
        }
      : {}),
    ...(filter.dates
      ? {
          dates: uniqueByCanonicalJson(filter.dates.map(canonicalizeDateClause)),
        }
      : {}),
    ...(filter.relations
      ? {
          relations: uniqueByCanonicalJson(filter.relations.map(canonicalizeRelationClause)),
        }
      : {}),
    ...(filter.customFields
      ? {
          customFields: uniqueByCanonicalJson(
            filter.customFields.map(canonicalizeCustomFieldClause),
          ),
        }
      : {}),
  };
  return taskFilterV1Schema.parse(canonical);
}

export function defaultTaskSearchOrder(filter: Pick<TaskFilterV1, "search">): TaskSearchOrder[] {
  return [
    ...(filter.search ? ([{ field: "relevance", direction: "asc" }] as const) : []),
    { field: "priority", direction: "asc" },
    { field: "position", direction: "asc" },
    { field: "due_at", direction: "asc" },
    { field: "sequence", direction: "asc" },
    { field: "id", direction: "asc" },
  ];
}

export function canonicalizeTaskSearchOrder(
  input: readonly TaskSearchOrder[] | undefined,
  filter: Pick<TaskFilterV1, "search">,
): TaskSearchOrder[] {
  const parsed = input ? taskSearchOrderListSchema.parse(input) : defaultTaskSearchOrder(filter);
  if (!filter.search && parsed.some(({ field }) => field === "relevance")) {
    throw new Error("Relevance ordering requires a text search.");
  }
  const seen = new Set<string>();
  const order = parsed.filter(({ field }) => {
    if (seen.has(field)) return false;
    seen.add(field);
    return true;
  });
  for (const field of ["sequence", "id"] as const) {
    if (!seen.has(field)) order.push({ field, direction: "asc" });
  }
  return order;
}

function canonicalJsonValue(value: unknown): unknown {
  if (Array.isArray(value)) return value.map(canonicalJsonValue);
  if (value && typeof value === "object") {
    return Object.fromEntries(
      Object.entries(value)
        .filter(([, child]) => child !== undefined)
        .toSorted(([left], [right]) => left.localeCompare(right))
        .map(([key, child]) => [key, canonicalJsonValue(child)]),
    );
  }
  return value;
}

export function stableCanonicalJson(value: unknown): string {
  const serialized = JSON.stringify(canonicalJsonValue(value));
  if (serialized === undefined)
    throw new TypeError("Only JSON-serializable values can be canonicalized.");
  return serialized;
}

export function canonicalTaskFilterJson(input: unknown) {
  return stableCanonicalJson(canonicalizeTaskFilter(input));
}

export type StructuredTaskFilterFacts = {
  readonly actors: readonly {
    readonly source: TaskFilterActorSource;
    readonly actor: TaskFilterActorReference;
  }[];
};

function matchesSetOperator(
  available: ReadonlySet<string>,
  operator: z.infer<typeof taskFilterSetOperatorSchema>,
  wanted: readonly string[],
) {
  if (operator === "any_of") return wanted.some((value) => available.has(value));
  if (operator === "all_of") return wanted.every((value) => available.has(value));
  return wanted.every((value) => !available.has(value));
}

function actorKey(actor: TaskFilterActorReference) {
  return `${actor.type}:${actor.id}`;
}

function taskDateValue(task: Task, field: TaskFilterDateField) {
  if (field === "not_before") return task.notBefore;
  if (field === "due_at") return task.dueAt;
  if (field === "created_at") return task.createdAt;
  return task.updatedAt;
}

function matchesDateClause(task: Task, clause: TaskFilterDateClause) {
  const value = taskDateValue(task, clause.field);
  if (clause.operator === "missing") return value === null;
  if (clause.operator === "present") return value !== null;
  if (value === null) return false;
  if (clause.operator === "between") return value >= clause.from && value <= clause.to;
  if (clause.operator === "on_or_after") return value >= clause.value;
  return value <= clause.value;
}

function relationOtherTaskId(relation: TaskRelation, direction: "upstream" | "downstream") {
  return direction === "upstream" ? relation.sourceTaskId : relation.targetTaskId;
}

function relationCandidates(
  task: Task,
  direction: TaskFilterRelationClause["direction"],
): Array<{ relation: TaskRelation; direction: "upstream" | "downstream" }> {
  return [
    ...(direction === "downstream"
      ? []
      : task.upstreamRelations.map((relation) => ({
          relation,
          direction: "upstream" as const,
        }))),
    ...(direction === "upstream"
      ? []
      : task.downstreamRelations.map((relation) => ({
          relation,
          direction: "downstream" as const,
        }))),
  ];
}

function matchesRelationClause(task: Task, clause: TaskFilterRelationClause) {
  const typeSet = clause.types ? new Set(clause.types) : null;
  const taskIdSet = clause.taskIds ? new Set(clause.taskIds) : null;
  const exists = relationCandidates(task, clause.direction).some(({ relation, direction }) => {
    if (typeSet && !typeSet.has(relation.type)) return false;
    return !taskIdSet || taskIdSet.has(relationOtherTaskId(relation, direction));
  });
  return clause.operator === "exists" ? exists : !exists;
}

function matchesCustomFieldClause(task: Task, clause: TaskFilterCustomFieldClause) {
  const assignment = task.customFields.find(({ definition }) => definition.id === clause.fieldId);
  const current = assignment?.value ?? null;
  if (clause.operator === "missing") return assignment !== undefined && current === null;
  if (clause.operator === "present") return current !== null;
  if (current === null) return false;

  if (clause.operator === "equals" || clause.operator === "not_equals") {
    if (current.type !== clause.value.type) return false;
    const equal = stableCanonicalJson(current) === stableCanonicalJson(clause.value);
    return clause.operator === "equals" ? equal : !equal;
  }
  if (current.type !== taskFilterCustomFieldOperandType(clause)) return false;

  switch (clause.operator) {
    case "contains":
      return (
        current.type === "text" &&
        normalizeCustomFieldText(current.value).includes(clause.value.value)
      );
    case "not_contains":
      return (
        current.type === "text" &&
        !normalizeCustomFieldText(current.value).includes(clause.value.value)
      );
    case "starts_with":
      return (
        current.type === "text" &&
        normalizeCustomFieldText(current.value).startsWith(clause.value.value)
      );
    case "ends_with":
      return (
        current.type === "text" &&
        normalizeCustomFieldText(current.value).endsWith(clause.value.value)
      );
    case "greater_than":
      return current.type === "number" && current.value > clause.value.value;
    case "greater_than_or_equal":
      return current.type === "number" && current.value >= clause.value.value;
    case "less_than":
      return current.type === "number" && current.value < clause.value.value;
    case "less_than_or_equal":
      return current.type === "number" && current.value <= clause.value.value;
    case "before":
      return current.type === "date" && current.value < clause.value.value;
    case "on_or_before":
      return current.type === "date" && current.value <= clause.value.value;
    case "after":
      return current.type === "date" && current.value > clause.value.value;
    case "on_or_after":
      return current.type === "date" && current.value >= clause.value.value;
    case "between":
      return (
        current.type === clause.from.type &&
        current.value >= clause.from.value &&
        current.value <= clause.to.value
      );
  }

  return false;
}

export function matchesStructuredTaskFilter(
  task: Task,
  input: TaskFilterV1,
  facts: StructuredTaskFilterFacts,
) {
  const filter = canonicalizeTaskFilter(input);
  if (task.projectId !== filter.projectId) return false;
  if (filter.archiveState === "exclude" && task.archivedAt !== null) return false;
  if (filter.archiveState === "only" && task.archivedAt === null) return false;
  if (filter.lifecycles && !filter.lifecycles.includes(task.lifecycle)) return false;
  if (
    filter.eligibility &&
    (!task.eligibility || !filter.eligibility.includes(task.eligibility.status))
  ) {
    return false;
  }
  if (filter.priorities && !filter.priorities.includes(task.priority)) return false;
  if (
    filter.tags &&
    !matchesSetOperator(
      new Set(task.tags.map(({ id }) => id)),
      filter.tags.operator,
      filter.tags.values,
    )
  ) {
    return false;
  }
  if (
    filter.capabilities &&
    !matchesSetOperator(
      new Set(task.requiredCapabilities.map((value) => value.toLocaleLowerCase("en-US"))),
      filter.capabilities.operator,
      filter.capabilities.values,
    )
  ) {
    return false;
  }
  if (filter.actor) {
    const sources = new Set(filter.actor.sources);
    const actors = new Set(filter.actor.actors.map(actorKey));
    const matches = facts.actors.some(
      (fact) => sources.has(fact.source) && actors.has(actorKey(fact.actor)),
    );
    if (filter.actor.operator === "any_of" ? !matches : matches) return false;
  }
  if (filter.dates?.some((clause) => !matchesDateClause(task, clause))) return false;
  if (filter.relations?.some((clause) => !matchesRelationClause(task, clause))) return false;
  if (filter.customFields?.some((clause) => !matchesCustomFieldClause(task, clause))) return false;
  return true;
}
