import { z } from "zod";

import {
  canonicalizeTaskFilter,
  stableCanonicalJson,
  taskFilterV1Schema,
  type TaskFilterV1,
} from "./task-filters";
import { jsonValueSchema, type JsonValue } from "./rich-text";
import {
  MAX_CUSTOM_FIELD_DEFINITIONS,
  customFieldValueSchema,
  taskCustomFieldAssignmentSchema,
  validateCustomFieldValue,
  type CustomFieldDefinition,
  type CustomFieldValue,
  type TaskCustomFieldAssignment,
} from "./customization";
import {
  actorSchema,
  capabilityNameSchema,
  createTaskInputSchema,
  duplicateExclusiveTagGroups,
  missingReadyPreparation,
  normalizeCapabilities,
  taskParentViolation,
  taskDateSchema,
  taskPrioritySchema,
  type Actor,
  type Task,
  type TaskLifecycle,
  type TaskPriority,
  type TaskTag,
  type TagInput,
} from "./tasks";

export const MAX_BULK_CREATE_ITEMS = 100;
export const MAX_BULK_UPDATE_TARGETS = 200;
export const BULK_TASK_PREVIEW_TOKEN_PREFIX = "btp1";

const opaqueIdSchema = z.string().trim().min(1).max(200);
const reasonSchema = z.string().trim().min(1).max(1_000);
const uniqueIdListSchema = z
  .array(opaqueIdSchema)
  .min(1)
  .max(MAX_BULK_UPDATE_TARGETS)
  .superRefine((values, context) => {
    const seen = new Set<string>();
    for (const [index, value] of values.entries()) {
      if (seen.has(value)) {
        context.addIssue({
          code: "custom",
          message: `Identifier ${value} may only appear once.`,
          path: [index],
        });
      }
      seen.add(value);
    }
  });

export const bulkTaskCustomFieldValueSchema = z.strictObject({
  fieldId: opaqueIdSchema,
  value: customFieldValueSchema,
});
export type BulkTaskCustomFieldValue = z.infer<typeof bulkTaskCustomFieldValueSchema>;

function uniqueCustomFieldValues(
  values: readonly { readonly fieldId: string }[],
  context: z.core.$RefinementCtx,
) {
  const seen = new Set<string>();
  for (const [index, entry] of values.entries()) {
    if (seen.has(entry.fieldId)) {
      context.addIssue({
        code: "custom",
        message: `Custom field ${entry.fieldId} may only appear once.`,
        path: [index, "fieldId"],
        input: entry.fieldId,
      });
    }
    seen.add(entry.fieldId);
  }
}

const bulkTaskCustomFieldValuesSchema = z
  .array(bulkTaskCustomFieldValueSchema)
  .max(MAX_CUSTOM_FIELD_DEFINITIONS)
  .superRefine(uniqueCustomFieldValues);

export const bulkTaskCustomFieldChangesSchema = z
  .strictObject({
    set: bulkTaskCustomFieldValuesSchema.optional().default([]),
    clear: z
      .array(opaqueIdSchema)
      .max(MAX_CUSTOM_FIELD_DEFINITIONS)
      .superRefine((values, context) =>
        uniqueCustomFieldValues(
          values.map((fieldId) => ({ fieldId })),
          context,
        ),
      )
      .optional()
      .default([]),
  })
  .superRefine((changes, context) => {
    const overlap = overlappingValues(
      changes.set.map(({ fieldId }) => fieldId),
      changes.clear,
    );
    if (overlap.length > 0) {
      context.addIssue({
        code: "custom",
        message: `Custom fields cannot be set and cleared together: ${overlap.join(", ")}.`,
      });
    }
  });
export type BulkTaskCustomFieldChanges = z.infer<typeof bulkTaskCustomFieldChangesSchema>;

const createTaskFieldsSchema = createTaskInputSchema
  .omit({
    projectId: true,
    expectedVersion: true,
    idempotencyKey: true,
  })
  .extend({
    customFields: bulkTaskCustomFieldValuesSchema.optional().default([]),
  });

export const bulkTaskCreateItemSchema = z.strictObject({
  clientId: opaqueIdSchema,
  task: createTaskFieldsSchema,
});
export type BulkTaskCreateItem = z.infer<typeof bulkTaskCreateItemSchema>;

export const bulkTaskSelectionSchema = z.discriminatedUnion("type", [
  z.strictObject({
    type: z.literal("ids"),
    taskIds: uniqueIdListSchema,
  }),
  z.strictObject({
    type: z.literal("filter"),
    filter: taskFilterV1Schema,
  }),
]);
export type BulkTaskSelection = z.infer<typeof bulkTaskSelectionSchema>;

const optionalIdChangesSchema = z.strictObject({
  add: z.array(opaqueIdSchema).max(100).optional().default([]),
  remove: z.array(opaqueIdSchema).max(100).optional().default([]),
});

const optionalCapabilityChangesSchema = z.strictObject({
  add: z.array(capabilityNameSchema).max(50).optional().default([]),
  remove: z.array(capabilityNameSchema).max(50).optional().default([]),
});

function overlappingValues(left: readonly string[], right: readonly string[]) {
  const rightValues = new Set(right);
  return [...new Set(left.filter((value) => rightValues.has(value)))].toSorted();
}

export const bulkTaskUpdatePatchSchema = z
  .strictObject({
    lifecycle: z.enum(["backlog", "ready"]).optional(),
    priority: taskPrioritySchema.optional(),
    notBefore: taskDateSchema.nullable().optional(),
    dueAt: taskDateSchema.nullable().optional(),
    tags: optionalIdChangesSchema.optional(),
    capabilities: optionalCapabilityChangesSchema.optional(),
    customFields: bulkTaskCustomFieldChangesSchema.optional(),
  })
  .superRefine((patch, context) => {
    const hasScalarChange = ["lifecycle", "priority", "notBefore", "dueAt"].some((field) =>
      Object.prototype.hasOwnProperty.call(patch, field),
    );
    const hasSetChange =
      Boolean(patch.tags && (patch.tags.add.length > 0 || patch.tags.remove.length > 0)) ||
      Boolean(
        patch.capabilities &&
        (patch.capabilities.add.length > 0 || patch.capabilities.remove.length > 0),
      ) ||
      Boolean(
        patch.customFields &&
        (patch.customFields.set.length > 0 || patch.customFields.clear.length > 0),
      );
    if (!hasScalarChange && !hasSetChange) {
      context.addIssue({
        code: "custom",
        message: "A bulk update must change at least one supported field.",
      });
    }

    const tagOverlap = patch.tags ? overlappingValues(patch.tags.add, patch.tags.remove) : [];
    if (tagOverlap.length > 0) {
      context.addIssue({
        code: "custom",
        message: `Tags cannot be added and removed together: ${tagOverlap.join(", ")}.`,
        path: ["tags"],
      });
    }

    const capabilityOverlap = patch.capabilities
      ? overlappingValues(
          normalizeCapabilities(patch.capabilities.add),
          normalizeCapabilities(patch.capabilities.remove),
        )
      : [];
    if (capabilityOverlap.length > 0) {
      context.addIssue({
        code: "custom",
        message: `Capabilities cannot be added and removed together: ${capabilityOverlap.join(", ")}.`,
        path: ["capabilities"],
      });
    }
  });
export type BulkTaskUpdatePatch = z.infer<typeof bulkTaskUpdatePatchSchema>;

const bulkCreateIntentSchema = z
  .strictObject({
    schemaVersion: z.literal(1),
    kind: z.literal("create"),
    projectId: opaqueIdSchema,
    reason: reasonSchema,
    items: z.array(bulkTaskCreateItemSchema).min(1).max(MAX_BULK_CREATE_ITEMS),
  })
  .superRefine((intent, context) => {
    const seen = new Set<string>();
    for (const [index, item] of intent.items.entries()) {
      if (seen.has(item.clientId)) {
        context.addIssue({
          code: "custom",
          message: `Client identifier ${item.clientId} may only appear once.`,
          path: ["items", index, "clientId"],
        });
      }
      seen.add(item.clientId);
    }
  });

const bulkUpdateIntentSchema = z
  .strictObject({
    schemaVersion: z.literal(1),
    kind: z.literal("update"),
    projectId: opaqueIdSchema,
    reason: reasonSchema,
    selection: bulkTaskSelectionSchema,
    patch: bulkTaskUpdatePatchSchema,
  })
  .superRefine((intent, context) => {
    if (
      intent.selection.type === "filter" &&
      intent.selection.filter.projectId !== intent.projectId
    ) {
      context.addIssue({
        code: "custom",
        message: "The bulk intent and task filter must address the same project.",
        path: ["selection", "filter", "projectId"],
      });
    }
  });

export const bulkTaskIntentSchema = z.union([bulkCreateIntentSchema, bulkUpdateIntentSchema]);
export type BulkTaskIntent = z.infer<typeof bulkTaskIntentSchema>;

export const bulkTaskPreviewTokenSchema = z
  .string()
  .regex(
    /^btp1:[a-f0-9]{64}:[a-f0-9]{64}$/,
    "Use the deterministic bulk-preview token returned by Helm.",
  );
export type BulkTaskPreviewToken = z.infer<typeof bulkTaskPreviewTokenSchema>;

export const executeBulkTasksInputSchema = z.strictObject({
  intent: bulkTaskIntentSchema,
  previewToken: bulkTaskPreviewTokenSchema,
  idempotencyKey: z.string().trim().min(1).max(200),
});
export type ExecuteBulkTasksInput = z.infer<typeof executeBulkTasksInputSchema>;

export const bulkTaskValidationCodeSchema = z.enum([
  "selection_limit",
  "task_not_found",
  "wrong_project",
  "task_archived",
  "task_not_editable",
  "task_not_prepared",
  "tag_not_found",
  "exclusive_tag_conflict",
  "tag_definition_conflict",
  "custom_field_not_found",
  "custom_field_retired",
  "custom_field_invalid_value",
  "invalid_parent",
  "invalid_path",
  "no_changes",
]);
export type BulkTaskValidationCode = z.infer<typeof bulkTaskValidationCodeSchema>;

export const bulkTaskValidationFailureSchema = z.strictObject({
  code: bulkTaskValidationCodeSchema,
  message: z.string().trim().min(1),
  targetKey: opaqueIdSchema.optional(),
  taskId: opaqueIdSchema.optional(),
  field: z.string().trim().min(1).max(100).optional(),
});
export type BulkTaskValidationFailure = z.infer<typeof bulkTaskValidationFailureSchema>;

export const bulkTaskProjectedChangeSchema = z.strictObject({
  field: z.enum([
    "task",
    "lifecycle",
    "priority",
    "notBefore",
    "dueAt",
    "tags",
    "requiredCapabilities",
    "customFields",
  ]),
  before: jsonValueSchema,
  after: jsonValueSchema,
});
export type BulkTaskProjectedChange = z.infer<typeof bulkTaskProjectedChangeSchema>;

export const bulkTaskPreviewTargetSchema = z.strictObject({
  targetKey: opaqueIdSchema,
  clientId: opaqueIdSchema.nullable(),
  taskId: opaqueIdSchema.nullable(),
  sequence: z.number().int().positive().nullable(),
  title: z.string(),
  expectedVersion: z.number().int().nonnegative().nullable(),
  projectedVersion: z.number().int().positive().nullable(),
  changed: z.boolean(),
  changes: z.array(bulkTaskProjectedChangeSchema),
  failures: z.array(bulkTaskValidationFailureSchema),
});
export type BulkTaskPreviewTarget = z.infer<typeof bulkTaskPreviewTargetSchema>;

export const bulkTaskPreviewSchema = z.strictObject({
  schemaVersion: z.literal(1),
  mode: z.literal("atomic"),
  kind: z.enum(["create", "update"]),
  projectId: opaqueIdSchema,
  matchedCount: z.number().int().nonnegative(),
  affectedCount: z.number().int().nonnegative(),
  executable: z.boolean(),
  targets: z.array(bulkTaskPreviewTargetSchema).max(MAX_BULK_UPDATE_TARGETS),
  failures: z.array(bulkTaskValidationFailureSchema),
  previewToken: bulkTaskPreviewTokenSchema,
});
export type BulkTaskPreview = z.infer<typeof bulkTaskPreviewSchema>;

export const bulkTaskExecutionItemSchema = z.strictObject({
  targetKey: opaqueIdSchema,
  clientId: opaqueIdSchema.nullable(),
  taskId: opaqueIdSchema,
  version: z.number().int().positive(),
  changed: z.boolean(),
});

export const bulkTaskExecutionResultSchema = z.strictObject({
  schemaVersion: z.literal(1),
  mode: z.literal("atomic"),
  kind: z.enum(["create", "update"]),
  operationId: opaqueIdSchema,
  projectId: opaqueIdSchema,
  matchedCount: z.number().int().nonnegative(),
  affectedCount: z.number().int().nonnegative(),
  parentEventCursor: z.number().int().positive(),
  items: z.array(bulkTaskExecutionItemSchema).max(MAX_BULK_UPDATE_TARGETS),
});
export type BulkTaskExecutionResult = z.infer<typeof bulkTaskExecutionResultSchema>;

const hashSchema = z.string().regex(/^[a-f0-9]{64}$/);
export const bulkTaskPreviewStateSchema = z.strictObject({
  schemaVersion: z.literal(1),
  projectId: opaqueIdSchema,
  actor: actorSchema,
  evaluation: z.strictObject({
    today: taskDateSchema,
    agentCapabilities: z.array(capabilityNameSchema),
  }),
  targets: z.array(
    z.strictObject({
      targetKey: opaqueIdSchema,
      taskId: opaqueIdSchema.nullable(),
      version: z.number().int().nonnegative(),
    }),
  ),
  tagDefinitionsHash: hashSchema,
  customFieldDefinitionsHash: hashSchema,
  sequenceBase: z.number().int().nonnegative().nullable(),
});
export type BulkTaskPreviewState = z.infer<typeof bulkTaskPreviewStateSchema>;

export const compiledBulkTaskIntentSchema = z.compile(bulkTaskIntentSchema);
export const compiledExecuteBulkTasksInputSchema = z.compile(executeBulkTasksInputSchema);
export const compiledBulkTaskPreviewSchema = z.compile(bulkTaskPreviewSchema);
export const compiledBulkTaskExecutionResultSchema = z.compile(bulkTaskExecutionResultSchema);

function sortedUnique(values: readonly string[]) {
  return [...new Set(values)].toSorted((left, right) => left.localeCompare(right));
}

function canonicalCreateTask(task: BulkTaskCreateItem["task"]) {
  return {
    ...task,
    tags: task.tags
      ? [...task.tags].toSorted((left, right) => left.name.localeCompare(right.name))
      : undefined,
    requiredCapabilities: task.requiredCapabilities
      ? normalizeCapabilities(task.requiredCapabilities)
      : undefined,
    referencedPaths: task.referencedPaths ? sortedUnique(task.referencedPaths) : undefined,
    customFields: [...task.customFields].toSorted((left, right) =>
      left.fieldId.localeCompare(right.fieldId),
    ),
  };
}

export function canonicalizeBulkTaskIntent(input: unknown): BulkTaskIntent {
  const intent = bulkTaskIntentSchema.parse(input);
  if (intent.kind === "create") {
    return bulkTaskIntentSchema.parse({
      ...intent,
      items: intent.items.map((item) => ({
        ...item,
        task: canonicalCreateTask(item.task),
      })),
    });
  }
  const selection =
    intent.selection.type === "ids"
      ? {
          type: "ids" as const,
          taskIds: sortedUnique(intent.selection.taskIds),
        }
      : {
          type: "filter" as const,
          filter: canonicalizeTaskFilter(intent.selection.filter),
        };
  return bulkTaskIntentSchema.parse({
    ...intent,
    selection,
    patch: {
      ...intent.patch,
      ...(intent.patch.tags
        ? {
            tags: {
              add: sortedUnique(intent.patch.tags.add),
              remove: sortedUnique(intent.patch.tags.remove),
            },
          }
        : {}),
      ...(intent.patch.capabilities
        ? {
            capabilities: {
              add: normalizeCapabilities(intent.patch.capabilities.add),
              remove: normalizeCapabilities(intent.patch.capabilities.remove),
            },
          }
        : {}),
      ...(intent.patch.customFields
        ? {
            customFields: {
              set: [...intent.patch.customFields.set].toSorted((left, right) =>
                left.fieldId.localeCompare(right.fieldId),
              ),
              clear: sortedUnique(intent.patch.customFields.clear),
            },
          }
        : {}),
    },
  });
}

export function canonicalBulkTaskIntentJson(input: unknown) {
  return stableCanonicalJson(canonicalizeBulkTaskIntent(input));
}

function failure(
  code: BulkTaskValidationCode,
  message: string,
  options: Partial<Pick<BulkTaskValidationFailure, "targetKey" | "taskId" | "field">> = {},
): BulkTaskValidationFailure {
  return bulkTaskValidationFailureSchema.parse({ code, message, ...options });
}

export function validateBulkTaskCreateItem(item: BulkTaskCreateItem) {
  const failures: BulkTaskValidationFailure[] = [];
  if (item.task.lifecycle === "ready") {
    const missingFields = missingReadyPreparation(item.task);
    if (missingFields.length > 0) {
      failures.push(
        failure("task_not_prepared", `Ready tasks require: ${missingFields.join(", ")}.`, {
          targetKey: item.clientId,
          field: "lifecycle",
        }),
      );
    }
  }
  const [exclusiveConflict] = duplicateExclusiveTagGroups(item.task.tags ?? []);
  if (exclusiveConflict) {
    failures.push(
      failure(
        "exclusive_tag_conflict",
        `Tags in the ${exclusiveConflict.group} group are mutually exclusive: ${exclusiveConflict.tagNames.join(", ")}.`,
        { targetKey: item.clientId, field: "tags" },
      ),
    );
  }
  return failures;
}

function sameBulkTagDefinition(
  left: Pick<TagInput, "description" | "color" | "exclusiveGroup">,
  right: TagInput,
) {
  return (
    left.description === right.description &&
    left.color.toLocaleLowerCase("en-US") === right.color.toLocaleLowerCase("en-US") &&
    (left.exclusiveGroup ?? null) === (right.exclusiveGroup ?? null)
  );
}

export function validateBulkTaskCreateTagDefinitions(
  items: readonly BulkTaskCreateItem[],
  existingDefinitions: readonly TaskTag[],
) {
  const existing = new Map(existingDefinitions.map((tag) => [tag.name, tag]));
  const proposed = new Map<string, TagInput>();
  const failures: BulkTaskValidationFailure[] = [];
  for (const item of items) {
    for (const tag of item.task.tags ?? []) {
      const definition = existing.get(tag.name) ?? proposed.get(tag.name);
      if (definition && !sameBulkTagDefinition(definition, tag)) {
        failures.push(
          failure(
            "tag_definition_conflict",
            `Tag ${tag.name} already has different project metadata.`,
            { targetKey: item.clientId, field: "tags" },
          ),
        );
      } else if (!definition) {
        proposed.set(tag.name, tag);
      }
    }
  }
  return failures;
}

export function validateBulkTaskCreateParent(
  item: BulkTaskCreateItem,
  projectId: string,
  parent: Pick<Task, "projectId" | "parentTaskId" | "lifecycle"> | undefined,
) {
  const parentTaskId = item.task.parentTaskId;
  if (!parentTaskId) return null;
  const options = { targetKey: item.clientId, field: "parentTaskId" } as const;
  if (!parent) {
    return failure("invalid_parent", `Parent task ${parentTaskId} does not exist.`, options);
  }
  const violation = taskParentViolation(parent, projectId);
  if (violation === "different_project") {
    return failure(
      "invalid_parent",
      "Child tasks must belong to the same project as their parent.",
      options,
    );
  }
  if (violation === "nested") {
    return failure("invalid_parent", "Tasks may only be nested one level deep.", options);
  }
  if (parent.lifecycle === "in_progress" || parent.lifecycle === "review") {
    return failure(
      "invalid_parent",
      "A child cannot be added while its parent has active work.",
      options,
    );
  }
  return null;
}

function compareCustomFieldDefinitions(left: CustomFieldDefinition, right: CustomFieldDefinition) {
  return left.position - right.position || left.id.localeCompare(right.id);
}

function explicitCustomFieldValues(assignments: readonly TaskCustomFieldAssignment[]) {
  return new Map<string, CustomFieldValue>(
    assignments.flatMap((assignment) =>
      assignment.source === "explicit" && assignment.value !== null
        ? [[assignment.definition.id, assignment.value] as const]
        : [],
    ),
  );
}

function effectiveCustomFieldAssignments(
  definitionsInput: readonly CustomFieldDefinition[],
  explicitValues: ReadonlyMap<string, CustomFieldValue>,
) {
  return [...definitionsInput]
    .toSorted(compareCustomFieldDefinitions)
    .filter((definition) => definition.retiredAt === null || explicitValues.has(definition.id))
    .map((definition) => {
      const explicit = explicitValues.get(definition.id);
      const value = explicit ?? definition.defaultValue;
      return taskCustomFieldAssignmentSchema.parse({
        definition,
        value,
        source: explicit ? "explicit" : value === null ? "unset" : "default",
      });
    });
}

function customFieldValueFailures(
  values: readonly BulkTaskCustomFieldValue[],
  clear: readonly string[],
  definitions: readonly CustomFieldDefinition[],
  options: Pick<BulkTaskValidationFailure, "targetKey"> &
    Partial<Pick<BulkTaskValidationFailure, "taskId">>,
) {
  const failures: BulkTaskValidationFailure[] = [];
  const definitionsById = new Map(definitions.map((definition) => [definition.id, definition]));
  for (const entry of [
    ...values.map(({ fieldId, value }) => ({ fieldId, value })),
    ...clear.map((fieldId) => ({ fieldId, value: null })),
  ]) {
    const definition = definitionsById.get(entry.fieldId);
    if (!definition) {
      failures.push(
        failure(
          "custom_field_not_found",
          `Custom field ${entry.fieldId} does not belong to this project.`,
          { ...options, field: "customFields" },
        ),
      );
      continue;
    }
    if (definition.retiredAt !== null) {
      failures.push(
        failure(
          "custom_field_retired",
          `Custom field ${definition.key} is retired and cannot be changed.`,
          { ...options, field: "customFields" },
        ),
      );
      continue;
    }
    if (entry.value === null) continue;
    const issues = validateCustomFieldValue(definition, entry.value);
    if (issues.length > 0) {
      failures.push(
        failure("custom_field_invalid_value", issues.map(({ message }) => message).join(" "), {
          ...options,
          field: "customFields",
        }),
      );
    }
  }
  return failures;
}

export type BulkTaskCreateCustomFieldProjection = {
  readonly projected: readonly TaskCustomFieldAssignment[];
  readonly failures: readonly BulkTaskValidationFailure[];
};

export function projectBulkTaskCreateCustomFields(
  item: BulkTaskCreateItem,
  definitions: readonly CustomFieldDefinition[],
): BulkTaskCreateCustomFieldProjection {
  const failures = customFieldValueFailures(item.task.customFields, [], definitions, {
    targetKey: item.clientId,
  });
  const definitionsById = new Map(definitions.map((definition) => [definition.id, definition]));
  const validValues = new Map(
    item.task.customFields
      .filter(({ fieldId, value }) => {
        const definition = definitionsById.get(fieldId);
        return (
          definition !== undefined &&
          definition.retiredAt === null &&
          validateCustomFieldValue(definition, value).length === 0
        );
      })
      .map(({ fieldId, value }) => [fieldId, value] as const),
  );
  return {
    projected: effectiveCustomFieldAssignments(definitions, validValues),
    failures,
  };
}

export function bulkTaskCustomFieldsJson(
  assignments: readonly TaskCustomFieldAssignment[],
): JsonValue {
  return Object.fromEntries(
    assignments.map(({ definition, value, source }) => [definition.id, { value, source }]),
  );
}

export type BulkTaskProjectedFields = {
  readonly lifecycle: TaskLifecycle;
  readonly priority: TaskPriority;
  readonly notBefore: string | null;
  readonly dueAt: string | null;
  readonly tags: readonly TaskTag[];
  readonly requiredCapabilities: readonly string[];
  readonly customFields: readonly TaskCustomFieldAssignment[];
};

export type BulkTaskUpdateProjection = {
  readonly projected: BulkTaskProjectedFields;
  readonly changes: readonly BulkTaskProjectedChange[];
  readonly failures: readonly BulkTaskValidationFailure[];
};

function tagJson(tags: readonly TaskTag[]): JsonValue {
  return tags.map(({ id, name }) => ({ id, name }));
}

function change(field: BulkTaskProjectedChange["field"], before: JsonValue, after: JsonValue) {
  return bulkTaskProjectedChangeSchema.parse({ field, before, after });
}

function sameJson(left: JsonValue, right: JsonValue) {
  return stableCanonicalJson(left) === stableCanonicalJson(right);
}

function editableLifecycle(lifecycle: TaskLifecycle) {
  return lifecycle === "backlog" || lifecycle === "ready";
}

export function projectBulkTaskUpdate(
  task: Task,
  patchInput: BulkTaskUpdatePatch,
  tagDefinitions: readonly TaskTag[],
  customFieldDefinitions: readonly CustomFieldDefinition[] = [],
): BulkTaskUpdateProjection {
  const patch = bulkTaskUpdatePatchSchema.parse(patchInput);
  const failures: BulkTaskValidationFailure[] = [];
  const targetOptions = { targetKey: task.id, taskId: task.id } as const;

  if (task.archivedAt) {
    failures.push(
      failure("task_archived", "Archived tasks cannot be changed in bulk.", targetOptions),
    );
  } else if (!editableLifecycle(task.lifecycle)) {
    failures.push(
      failure(
        "task_not_editable",
        "Only backlog or ready tasks can receive bulk planning changes.",
        { ...targetOptions, field: "lifecycle" },
      ),
    );
  }

  const tagsById = new Map(tagDefinitions.map((tag) => [tag.id, tag]));
  const requestedTagIds = [...(patch.tags?.add ?? []), ...(patch.tags?.remove ?? [])];
  for (const tagId of requestedTagIds) {
    if (!tagsById.has(tagId)) {
      failures.push(
        failure("tag_not_found", `Tag ${tagId} does not belong to this project.`, {
          ...targetOptions,
          field: "tags",
        }),
      );
    }
  }

  const removedTagIds = new Set(patch.tags?.remove ?? []);
  const finalTagsById = new Map(
    task.tags.filter((tag) => !removedTagIds.has(tag.id)).map((tag) => [tag.id, tag]),
  );
  for (const tagId of patch.tags?.add ?? []) {
    const tag = tagsById.get(tagId);
    if (tag) finalTagsById.set(tag.id, tag);
  }
  const finalTags = [...finalTagsById.values()].toSorted(
    (left, right) => left.name.localeCompare(right.name) || left.id.localeCompare(right.id),
  );
  const [exclusiveConflict] = duplicateExclusiveTagGroups(finalTags);
  if (exclusiveConflict) {
    failures.push(
      failure(
        "exclusive_tag_conflict",
        `Remove the existing ${exclusiveConflict.group} tag before adding another: ${exclusiveConflict.tagNames.join(", ")}.`,
        { ...targetOptions, field: "tags" },
      ),
    );
  }

  const removedCapabilities = new Set(normalizeCapabilities(patch.capabilities?.remove ?? []));
  const finalCapabilities = normalizeCapabilities([
    ...task.requiredCapabilities.filter(
      (capability) => !removedCapabilities.has(capability.toLocaleLowerCase("en-US")),
    ),
    ...(patch.capabilities?.add ?? []),
  ]);
  const customDefinitionsById = new Map(
    task.customFields.map(({ definition }) => [definition.id, definition]),
  );
  for (const definition of customFieldDefinitions) {
    customDefinitionsById.set(definition.id, definition);
  }
  const effectiveCustomDefinitions = [...customDefinitionsById.values()];
  const customFieldFailures = customFieldValueFailures(
    patch.customFields?.set ?? [],
    patch.customFields?.clear ?? [],
    effectiveCustomDefinitions,
    targetOptions,
  );
  failures.push(...customFieldFailures);
  const validCustomFieldIds = new Set(
    effectiveCustomDefinitions.filter(({ retiredAt }) => retiredAt === null).map(({ id }) => id),
  );
  const initialExplicitCustomFields = explicitCustomFieldValues(task.customFields);
  const beforeCustomFieldAssignments = effectiveCustomFieldAssignments(
    effectiveCustomDefinitions,
    initialExplicitCustomFields,
  );
  const finalExplicitCustomFields = new Map(initialExplicitCustomFields);
  for (const fieldId of patch.customFields?.clear ?? []) {
    if (validCustomFieldIds.has(fieldId)) finalExplicitCustomFields.delete(fieldId);
  }
  for (const { fieldId, value } of patch.customFields?.set ?? []) {
    const definition = customDefinitionsById.get(fieldId);
    if (
      definition?.retiredAt === null &&
      validateCustomFieldValue(definition, value).length === 0
    ) {
      finalExplicitCustomFields.set(fieldId, value);
    }
  }
  const finalCustomFields = effectiveCustomFieldAssignments(
    effectiveCustomDefinitions,
    finalExplicitCustomFields,
  );
  const projected: BulkTaskProjectedFields = {
    lifecycle: patch.lifecycle ?? task.lifecycle,
    priority: patch.priority ?? task.priority,
    notBefore: Object.prototype.hasOwnProperty.call(patch, "notBefore")
      ? (patch.notBefore ?? null)
      : task.notBefore,
    dueAt: Object.prototype.hasOwnProperty.call(patch, "dueAt")
      ? (patch.dueAt ?? null)
      : task.dueAt,
    tags: finalTags,
    requiredCapabilities: finalCapabilities,
    customFields: finalCustomFields,
  };

  if (patch.lifecycle === "ready" && task.lifecycle !== "ready") {
    const missingFields = missingReadyPreparation(task);
    if (missingFields.length > 0) {
      failures.push(
        failure("task_not_prepared", `Ready tasks require: ${missingFields.join(", ")}.`, {
          ...targetOptions,
          field: "lifecycle",
        }),
      );
    }
  }

  const changes: BulkTaskProjectedChange[] = [];
  const scalarValues = [
    ["lifecycle", task.lifecycle, projected.lifecycle],
    ["priority", task.priority, projected.priority],
    ["notBefore", task.notBefore, projected.notBefore],
    ["dueAt", task.dueAt, projected.dueAt],
  ] as const;
  for (const [field, before, after] of scalarValues) {
    if (before !== after) changes.push(change(field, before, after));
  }
  const beforeTags = tagJson(
    [...task.tags].toSorted(
      (left, right) => left.name.localeCompare(right.name) || left.id.localeCompare(right.id),
    ),
  );
  const afterTags = tagJson(finalTags);
  if (!sameJson(beforeTags, afterTags)) changes.push(change("tags", beforeTags, afterTags));
  const beforeCapabilities = normalizeCapabilities(task.requiredCapabilities);
  if (!sameJson(beforeCapabilities, finalCapabilities)) {
    changes.push(change("requiredCapabilities", beforeCapabilities, finalCapabilities));
  }
  const beforeCustomFields = bulkTaskCustomFieldsJson(beforeCustomFieldAssignments);
  const afterCustomFields = bulkTaskCustomFieldsJson(finalCustomFields);
  if (!sameJson(beforeCustomFields, afterCustomFields)) {
    changes.push(change("customFields", beforeCustomFields, afterCustomFields));
  }

  return { projected, changes, failures };
}

export function canonicalizeBulkTaskPreviewState(input: BulkTaskPreviewState) {
  return bulkTaskPreviewStateSchema.parse({
    ...input,
    evaluation: {
      ...input.evaluation,
      agentCapabilities: normalizeCapabilities(input.evaluation.agentCapabilities),
    },
    targets: [...input.targets].toSorted(
      (left, right) =>
        left.targetKey.localeCompare(right.targetKey) ||
        (left.taskId ?? "").localeCompare(right.taskId ?? ""),
    ),
  });
}

export function canonicalBulkTaskPreviewStateJson(input: BulkTaskPreviewState) {
  return stableCanonicalJson(canonicalizeBulkTaskPreviewState(input));
}

export type BulkTaskActor = Actor;
export type BulkCreateTaskFields = BulkTaskCreateItem["task"];
export type BulkTaskFilter = TaskFilterV1;
