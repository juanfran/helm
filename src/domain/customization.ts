import { z } from "zod";

import { projectReviewModeSchema, type ProjectReviewMode } from "./projects";

export const MAX_CUSTOM_FIELD_DEFINITIONS = 50;
export const MAX_CUSTOM_FIELD_TEXT_LENGTH = 20_000;
export const MAX_CUSTOM_FIELD_SELECT_OPTIONS = 100;

const opaqueIdSchema = z.string().trim().min(1).max(200);
const idempotencyKeySchema = z.string().trim().min(1).max(200);
const reasonSchema = z.string().trim().min(1).max(1_000);
const timestampSchema = z.iso.datetime({ offset: true });
const dateSchema = z.iso.date({ error: "Use a valid ISO date in YYYY-MM-DD format." });

export const customFieldKeySchema = z
  .string()
  .trim()
  .min(1)
  .max(80)
  .regex(
    /^[a-z][a-z0-9_]*$/,
    "Use a lowercase machine key beginning with a letter and containing only letters, numbers, or underscores.",
  );

export const customFieldTypeSchema = z.enum(["text", "number", "boolean", "date", "single_select"]);
export type CustomFieldType = z.infer<typeof customFieldTypeSchema>;

export const customFieldTextValueSchema = z.strictObject({
  type: z.literal("text"),
  value: z.string().max(MAX_CUSTOM_FIELD_TEXT_LENGTH),
});
export const customFieldNumberValueSchema = z.strictObject({
  type: z.literal("number"),
  value: z.number().finite(),
});
export const customFieldBooleanValueSchema = z.strictObject({
  type: z.literal("boolean"),
  value: z.boolean(),
});
export const customFieldDateValueSchema = z.strictObject({
  type: z.literal("date"),
  value: dateSchema,
});
export const customFieldSingleSelectValueSchema = z.strictObject({
  type: z.literal("single_select"),
  value: z
    .string()
    .trim()
    .min(1)
    .max(80)
    .regex(/^[a-z][a-z0-9_-]*$/, "Use a stable lowercase option identifier."),
});

export const customFieldValueSchema = z.discriminatedUnion("type", [
  customFieldTextValueSchema,
  customFieldNumberValueSchema,
  customFieldBooleanValueSchema,
  customFieldDateValueSchema,
  customFieldSingleSelectValueSchema,
]);
export type CustomFieldValue = z.infer<typeof customFieldValueSchema>;

export const customFieldDisplaySchema = z.strictObject({
  label: z.string().trim().min(1).max(120),
  description: z.string().trim().max(1_000).default(""),
});
export type CustomFieldDisplay = z.infer<typeof customFieldDisplaySchema>;

export const customFieldTextValidationSchema = z
  .strictObject({
    minLength: z.number().int().nonnegative().max(MAX_CUSTOM_FIELD_TEXT_LENGTH).default(0),
    maxLength: z
      .number()
      .int()
      .nonnegative()
      .max(MAX_CUSTOM_FIELD_TEXT_LENGTH)
      .default(MAX_CUSTOM_FIELD_TEXT_LENGTH),
  })
  .superRefine((validation, context) => {
    if (validation.minLength > validation.maxLength) {
      context.addIssue({
        code: "custom",
        message: "The minimum text length must not exceed the maximum text length.",
        path: ["maxLength"],
        input: validation.maxLength,
      });
    }
  });
export type CustomFieldTextValidation = z.infer<typeof customFieldTextValidationSchema>;

export const customFieldNumberValidationSchema = z
  .strictObject({
    min: z.number().finite().nullable().default(null),
    max: z.number().finite().nullable().default(null),
    integer: z.boolean().default(false),
  })
  .superRefine((validation, context) => {
    if (validation.min !== null && validation.max !== null && validation.min > validation.max) {
      context.addIssue({
        code: "custom",
        message: "The minimum number must not exceed the maximum number.",
        path: ["max"],
        input: validation.max,
      });
    }
  });
export type CustomFieldNumberValidation = z.infer<typeof customFieldNumberValidationSchema>;

export const customFieldBooleanValidationSchema = z.strictObject({});
export type CustomFieldBooleanValidation = z.infer<typeof customFieldBooleanValidationSchema>;

export const customFieldDateValidationSchema = z
  .strictObject({
    min: dateSchema.nullable().default(null),
    max: dateSchema.nullable().default(null),
  })
  .superRefine((validation, context) => {
    if (validation.min !== null && validation.max !== null && validation.min > validation.max) {
      context.addIssue({
        code: "custom",
        message: "The earliest date must not be after the latest date.",
        path: ["max"],
        input: validation.max,
      });
    }
  });
export type CustomFieldDateValidation = z.infer<typeof customFieldDateValidationSchema>;

export const customFieldSelectOptionSchema = z.strictObject({
  id: z
    .string()
    .trim()
    .min(1)
    .max(80)
    .regex(/^[a-z][a-z0-9_-]*$/, "Use a stable lowercase option identifier."),
  label: z.string().trim().min(1).max(120),
});
export type CustomFieldSelectOption = z.infer<typeof customFieldSelectOptionSchema>;

export const customFieldSingleSelectValidationSchema = z
  .strictObject({
    options: z.array(customFieldSelectOptionSchema).min(1).max(MAX_CUSTOM_FIELD_SELECT_OPTIONS),
  })
  .superRefine((validation, context) => {
    const identifiers = new Set<string>();
    const labels = new Set<string>();
    for (const [index, option] of validation.options.entries()) {
      if (identifiers.has(option.id)) {
        context.addIssue({
          code: "custom",
          message: `Option identifier ${option.id} may only appear once.`,
          path: ["options", index, "id"],
          input: option.id,
        });
      }
      identifiers.add(option.id);

      const normalizedLabel = option.label.normalize("NFKC").toLocaleLowerCase("en-US");
      if (labels.has(normalizedLabel)) {
        context.addIssue({
          code: "custom",
          message: `Option label ${option.label} may only appear once.`,
          path: ["options", index, "label"],
          input: option.label,
        });
      }
      labels.add(normalizedLabel);
    }
  });
export type CustomFieldSingleSelectValidation = z.infer<
  typeof customFieldSingleSelectValidationSchema
>;

const definitionCommonFields = {
  key: customFieldKeySchema,
  display: customFieldDisplaySchema,
};

const textDefinitionFields = {
  ...definitionCommonFields,
  type: z.literal("text"),
  validation: customFieldTextValidationSchema.default({
    minLength: 0,
    maxLength: MAX_CUSTOM_FIELD_TEXT_LENGTH,
  }),
  defaultValue: customFieldTextValueSchema.nullable().default(null),
};

const numberDefinitionFields = {
  ...definitionCommonFields,
  type: z.literal("number"),
  validation: customFieldNumberValidationSchema.default({ min: null, max: null, integer: false }),
  defaultValue: customFieldNumberValueSchema.nullable().default(null),
};

const booleanDefinitionFields = {
  ...definitionCommonFields,
  type: z.literal("boolean"),
  validation: customFieldBooleanValidationSchema.default({}),
  defaultValue: customFieldBooleanValueSchema.nullable().default(null),
};

const dateDefinitionFields = {
  ...definitionCommonFields,
  type: z.literal("date"),
  validation: customFieldDateValidationSchema.default({ min: null, max: null }),
  defaultValue: customFieldDateValueSchema.nullable().default(null),
};

const singleSelectDefinitionFields = {
  ...definitionCommonFields,
  type: z.literal("single_select"),
  validation: customFieldSingleSelectValidationSchema,
  defaultValue: customFieldSingleSelectValueSchema.nullable().default(null),
};

const rawCustomFieldDefinitionDraftSchema = z.discriminatedUnion("type", [
  z.strictObject(textDefinitionFields),
  z.strictObject(numberDefinitionFields),
  z.strictObject(booleanDefinitionFields),
  z.strictObject(dateDefinitionFields),
  z.strictObject(singleSelectDefinitionFields),
]);

function addDefaultIssues(
  definition: z.infer<typeof rawCustomFieldDefinitionDraftSchema>,
  context: z.core.$RefinementCtx,
) {
  for (const issue of validateCustomFieldDefault(definition)) {
    context.addIssue({
      code: "custom",
      message: issue.message,
      path: ["defaultValue"],
      input: definition.defaultValue,
    });
  }
}

export const customFieldDefinitionDraftSchema =
  rawCustomFieldDefinitionDraftSchema.superRefine(addDefaultIssues);
export type CustomFieldDefinitionDraft = z.infer<typeof customFieldDefinitionDraftSchema>;

const persistedDefinitionFields = {
  id: opaqueIdSchema,
  projectId: opaqueIdSchema,
  position: z.number().int().nonnegative(),
  retiredAt: timestampSchema.nullable(),
  createdAt: timestampSchema,
  updatedAt: timestampSchema,
};

const rawCustomFieldDefinitionSchema = z.discriminatedUnion("type", [
  z.strictObject({ ...persistedDefinitionFields, ...textDefinitionFields }),
  z.strictObject({ ...persistedDefinitionFields, ...numberDefinitionFields }),
  z.strictObject({ ...persistedDefinitionFields, ...booleanDefinitionFields }),
  z.strictObject({ ...persistedDefinitionFields, ...dateDefinitionFields }),
  z.strictObject({ ...persistedDefinitionFields, ...singleSelectDefinitionFields }),
]);

export const customFieldDefinitionSchema =
  rawCustomFieldDefinitionSchema.superRefine(addDefaultIssues);
export type CustomFieldDefinition = z.infer<typeof customFieldDefinitionSchema>;

export const customFieldValidationCodeSchema = z.enum([
  "invalid_value",
  "type_mismatch",
  "text_too_short",
  "text_too_long",
  "number_below_minimum",
  "number_above_maximum",
  "number_not_integer",
  "date_before_minimum",
  "date_after_maximum",
  "select_option_unknown",
]);
export type CustomFieldValidationCode = z.infer<typeof customFieldValidationCodeSchema>;

export const customFieldValidationIssueSchema = z.strictObject({
  code: customFieldValidationCodeSchema,
  message: z.string().trim().min(1),
});
export type CustomFieldValidationIssue = z.infer<typeof customFieldValidationIssueSchema>;

type CustomFieldConfiguration = z.infer<typeof rawCustomFieldDefinitionDraftSchema>;

function validationIssue(
  code: CustomFieldValidationCode,
  message: string,
): CustomFieldValidationIssue {
  return customFieldValidationIssueSchema.parse({ code, message });
}

/** Validates one structurally parsed typed value against a project's immutable field definition. */
export function validateCustomFieldValue(
  definition: CustomFieldConfiguration,
  valueInput: unknown,
): readonly CustomFieldValidationIssue[] {
  const parsed = customFieldValueSchema.safeParse(valueInput);
  if (!parsed.success) {
    return [validationIssue("invalid_value", "Use a supported typed custom-field value.")];
  }
  const value = parsed.data;
  if (value.type !== definition.type) {
    return [
      validationIssue(
        "type_mismatch",
        `Field ${definition.key} requires a ${definition.type} value, not ${value.type}.`,
      ),
    ];
  }

  switch (definition.type) {
    case "text": {
      if (value.type !== "text") return [];
      const issues: CustomFieldValidationIssue[] = [];
      if (value.value.length < definition.validation.minLength) {
        issues.push(
          validationIssue(
            "text_too_short",
            `Field ${definition.key} must contain at least ${definition.validation.minLength} characters.`,
          ),
        );
      }
      if (value.value.length > definition.validation.maxLength) {
        issues.push(
          validationIssue(
            "text_too_long",
            `Field ${definition.key} must contain at most ${definition.validation.maxLength} characters.`,
          ),
        );
      }
      return issues;
    }
    case "number": {
      if (value.type !== "number") return [];
      const issues: CustomFieldValidationIssue[] = [];
      if (definition.validation.integer && !Number.isInteger(value.value)) {
        issues.push(
          validationIssue("number_not_integer", `Field ${definition.key} requires a whole number.`),
        );
      }
      if (definition.validation.min !== null && value.value < definition.validation.min) {
        issues.push(
          validationIssue(
            "number_below_minimum",
            `Field ${definition.key} must be at least ${definition.validation.min}.`,
          ),
        );
      }
      if (definition.validation.max !== null && value.value > definition.validation.max) {
        issues.push(
          validationIssue(
            "number_above_maximum",
            `Field ${definition.key} must be at most ${definition.validation.max}.`,
          ),
        );
      }
      return issues;
    }
    case "boolean":
      return [];
    case "date": {
      if (value.type !== "date") return [];
      const issues: CustomFieldValidationIssue[] = [];
      if (definition.validation.min !== null && value.value < definition.validation.min) {
        issues.push(
          validationIssue(
            "date_before_minimum",
            `Field ${definition.key} must be on or after ${definition.validation.min}.`,
          ),
        );
      }
      if (definition.validation.max !== null && value.value > definition.validation.max) {
        issues.push(
          validationIssue(
            "date_after_maximum",
            `Field ${definition.key} must be on or before ${definition.validation.max}.`,
          ),
        );
      }
      return issues;
    }
    case "single_select": {
      if (value.type !== "single_select") return [];
      return definition.validation.options.some((option) => option.id === value.value)
        ? []
        : [
            validationIssue(
              "select_option_unknown",
              `Field ${definition.key} does not define option ${value.value}.`,
            ),
          ];
    }
  }

  return [];
}

/** Applies the same value rules to a definition's optional default. */
export function validateCustomFieldDefault(
  definition: CustomFieldConfiguration,
): readonly CustomFieldValidationIssue[] {
  return definition.defaultValue === null
    ? []
    : validateCustomFieldValue(definition, definition.defaultValue);
}

export const taskCustomFieldAssignmentSourceSchema = z.enum(["explicit", "default", "unset"]);

export const taskCustomFieldAssignmentSchema = z
  .strictObject({
    definition: customFieldDefinitionSchema,
    value: customFieldValueSchema.nullable(),
    source: taskCustomFieldAssignmentSourceSchema,
  })
  .superRefine((assignment, context) => {
    if (assignment.source === "unset" && assignment.value !== null) {
      context.addIssue({
        code: "custom",
        message: "An unset custom field cannot contain a value.",
        path: ["value"],
        input: assignment.value,
      });
      return;
    }
    if (assignment.source !== "unset" && assignment.value === null) {
      context.addIssue({
        code: "custom",
        message: `A ${assignment.source} custom field must contain a value.`,
        path: ["value"],
        input: assignment.value,
      });
      return;
    }
    if (assignment.value !== null) {
      for (const issue of validateCustomFieldValue(assignment.definition, assignment.value)) {
        context.addIssue({
          code: "custom",
          message: issue.message,
          path: ["value"],
          input: assignment.value,
        });
      }
    }
    if (
      assignment.source === "default" &&
      JSON.stringify(assignment.value) !== JSON.stringify(assignment.definition.defaultValue)
    ) {
      context.addIssue({
        code: "custom",
        message: "A default assignment must expose the definition's default value.",
        path: ["value"],
        input: assignment.value,
      });
    }
  });
export type TaskCustomFieldAssignment = z.infer<typeof taskCustomFieldAssignmentSchema>;

export const tagReviewRuleSchema = z.strictObject({
  tagId: opaqueIdSchema,
  tagName: z.string().trim().min(1).max(80),
  reviewMode: projectReviewModeSchema,
});
export type TagReviewRule = z.infer<typeof tagReviewRuleSchema>;

export const reviewPolicyTagSchema = z.strictObject({
  id: opaqueIdSchema,
  name: z.string().trim().min(1).max(80),
  reviewModeOverride: projectReviewModeSchema.nullable().default(null),
});
export type ReviewPolicyTag = z.infer<typeof reviewPolicyTagSchema>;

export const reviewModeOverrideSchema = projectReviewModeSchema.nullable();
export type ReviewModeOverride = z.infer<typeof reviewModeOverrideSchema>;

export const reviewPolicySourceSchema = z.discriminatedUnion("level", [
  z.strictObject({ level: z.literal("project"), projectId: opaqueIdSchema }),
  z.strictObject({ level: z.literal("task"), taskId: opaqueIdSchema }),
  z.strictObject({
    level: z.literal("tag"),
    tagIds: z.array(opaqueIdSchema).min(1).max(100),
    tagNames: z.array(z.string().trim().min(1).max(80)).min(1).max(100),
  }),
]);
export type ReviewPolicySource = z.infer<typeof reviewPolicySourceSchema>;

export const reviewPolicyResolutionSchema = z.strictObject({
  mode: projectReviewModeSchema,
  destination: z.enum(["review", "done"]),
  source: reviewPolicySourceSchema,
  applicableTagRules: z.array(tagReviewRuleSchema).max(100),
  tagConflict: z.boolean(),
  explanation: z.string().trim().min(1),
});
export type ReviewPolicyResolution = z.infer<typeof reviewPolicyResolutionSchema>;

export const reviewPolicyResolverInputSchema = z.strictObject({
  projectId: opaqueIdSchema,
  projectMode: projectReviewModeSchema,
  taskId: opaqueIdSchema,
  taskOverride: reviewModeOverrideSchema.default(null),
  tags: z.array(reviewPolicyTagSchema).max(100).default([]),
});
export type ReviewPolicyResolverInput = z.input<typeof reviewPolicyResolverInputSchema>;

function compareText(left: string, right: string) {
  return left < right ? -1 : left > right ? 1 : 0;
}

function compareReviewTags(left: ReviewPolicyTag, right: ReviewPolicyTag) {
  const leftName = left.name.normalize("NFKC").toLocaleLowerCase("en-US");
  const rightName = right.name.normalize("NFKC").toLocaleLowerCase("en-US");
  return (
    compareText(leftName, rightName) ||
    compareText(left.name, right.name) ||
    compareText(left.id, right.id)
  );
}

function policyAction(mode: ProjectReviewMode) {
  return mode === "required" ? "requires human review" : "routes completion directly to done";
}

function tagRuleList(rules: readonly TagReviewRule[]) {
  return rules.map((rule) => `“${rule.tagName}” ${policyAction(rule.reviewMode)}`).join("; ");
}

/** Resolves the policy applied at completion without mutating lifecycle state. */
export function resolveReviewPolicy(input: ReviewPolicyResolverInput): ReviewPolicyResolution {
  const parsed = reviewPolicyResolverInputSchema.parse(input);
  const configuredTags = parsed.tags
    .filter(
      (tag): tag is ReviewPolicyTag & { reviewModeOverride: ProjectReviewMode } =>
        tag.reviewModeOverride !== null,
    )
    .toSorted(compareReviewTags);
  const applicableTagRules = configuredTags.map((tag) =>
    tagReviewRuleSchema.parse({
      tagId: tag.id,
      tagName: tag.name,
      reviewMode: tag.reviewModeOverride,
    }),
  );
  const tagConflict = new Set(applicableTagRules.map((rule) => rule.reviewMode)).size > 1;

  if (parsed.taskOverride !== null) {
    const lowerPriority =
      applicableTagRules.length === 0
        ? "No tag override applies."
        : `${applicableTagRules.length} lower-priority tag override${applicableTagRules.length === 1 ? "" : "s"}${tagConflict ? " conflict but do not affect this decision" : " do not affect this decision"}.`;
    return reviewPolicyResolutionSchema.parse({
      mode: parsed.taskOverride,
      destination: parsed.taskOverride === "required" ? "review" : "done",
      source: { level: "task", taskId: parsed.taskId },
      applicableTagRules,
      tagConflict,
      explanation: `Task override ${policyAction(parsed.taskOverride)} and takes precedence over tag and project policies. ${lowerPriority}`,
    });
  }

  if (applicableTagRules.length > 0) {
    const mode: ProjectReviewMode = tagConflict ? "required" : applicableTagRules[0]!.reviewMode;
    const selectedRules = applicableTagRules.filter((rule) => rule.reviewMode === mode);
    return reviewPolicyResolutionSchema.parse({
      mode,
      destination: mode === "required" ? "review" : "done",
      source: {
        level: "tag",
        tagIds: selectedRules.map((rule) => rule.tagId),
        tagNames: selectedRules.map((rule) => rule.tagName),
      },
      applicableTagRules,
      tagConflict,
      explanation: tagConflict
        ? `Tag overrides conflict: ${tagRuleList(applicableTagRules)}. Human review is selected conservatively over the project policy.`
        : `Tag override${applicableTagRules.length === 1 ? "" : "s"} ${policyAction(mode)} and take precedence over the project policy: ${tagRuleList(applicableTagRules)}.`,
    });
  }

  return reviewPolicyResolutionSchema.parse({
    mode: parsed.projectMode,
    destination: parsed.projectMode === "required" ? "review" : "done",
    source: { level: "project", projectId: parsed.projectId },
    applicableTagRules,
    tagConflict: false,
    explanation: `Project policy ${policyAction(parsed.projectMode)} because no task or tag override applies.`,
  });
}

export const projectCustomizationSnapshotSchema = z
  .strictObject({
    schemaVersion: z.literal(1),
    projectId: opaqueIdSchema,
    projectVersion: z.number().int().positive(),
    definitions: z.array(customFieldDefinitionSchema).max(MAX_CUSTOM_FIELD_DEFINITIONS),
    tagReviewRules: z.array(tagReviewRuleSchema).max(100).default([]),
  })
  .superRefine((snapshot, context) => {
    const identifiers = new Set<string>();
    const keys = new Set<string>();
    const positions = new Set<number>();
    for (const [index, definition] of snapshot.definitions.entries()) {
      if (definition.projectId !== snapshot.projectId) {
        context.addIssue({
          code: "custom",
          message: "Every custom-field definition must belong to the snapshot project.",
          path: ["definitions", index, "projectId"],
          input: definition.projectId,
        });
      }
      if (identifiers.has(definition.id)) {
        context.addIssue({
          code: "custom",
          message: `Definition id ${definition.id} may only appear once.`,
          path: ["definitions", index, "id"],
          input: definition.id,
        });
      }
      identifiers.add(definition.id);
      if (keys.has(definition.key)) {
        context.addIssue({
          code: "custom",
          message: `Definition key ${definition.key} may only appear once.`,
          path: ["definitions", index, "key"],
          input: definition.key,
        });
      }
      keys.add(definition.key);
      if (positions.has(definition.position)) {
        context.addIssue({
          code: "custom",
          message: `Definition position ${definition.position} may only appear once.`,
          path: ["definitions", index, "position"],
          input: definition.position,
        });
      }
      positions.add(definition.position);
    }

    const tagIdentifiers = new Set<string>();
    for (const [index, rule] of snapshot.tagReviewRules.entries()) {
      if (tagIdentifiers.has(rule.tagId)) {
        context.addIssue({
          code: "custom",
          message: `Tag review rule ${rule.tagId} may only appear once.`,
          path: ["tagReviewRules", index, "tagId"],
          input: rule.tagId,
        });
      }
      tagIdentifiers.add(rule.tagId);
    }
  });
export type ProjectCustomizationSnapshot = z.infer<typeof projectCustomizationSnapshotSchema>;

const expectedProjectVersionSchema = z.number().int().positive();

export const addCustomFieldDefinitionInputSchema = z.strictObject({
  projectId: opaqueIdSchema,
  definition: customFieldDefinitionDraftSchema,
  expectedProjectVersion: expectedProjectVersionSchema,
  idempotencyKey: idempotencyKeySchema,
});
export type AddCustomFieldDefinitionInput = z.infer<typeof addCustomFieldDefinitionInputSchema>;

export const retireCustomFieldDefinitionInputSchema = z.strictObject({
  projectId: opaqueIdSchema,
  fieldId: opaqueIdSchema,
  expectedProjectVersion: expectedProjectVersionSchema,
  reason: reasonSchema,
  idempotencyKey: idempotencyKeySchema,
});
export type RetireCustomFieldDefinitionInput = z.infer<
  typeof retireCustomFieldDefinitionInputSchema
>;

const orderedFieldIdsSchema = z
  .array(opaqueIdSchema)
  .min(1)
  .max(MAX_CUSTOM_FIELD_DEFINITIONS)
  .superRefine((identifiers, context) => {
    const seen = new Set<string>();
    for (const [index, identifier] of identifiers.entries()) {
      if (seen.has(identifier)) {
        context.addIssue({
          code: "custom",
          message: `Field identifier ${identifier} may only appear once.`,
          path: [index],
          input: identifier,
        });
      }
      seen.add(identifier);
    }
  });

export const reorderCustomFieldDefinitionsInputSchema = z.strictObject({
  projectId: opaqueIdSchema,
  orderedFieldIds: orderedFieldIdsSchema,
  expectedProjectVersion: expectedProjectVersionSchema,
  idempotencyKey: idempotencyKeySchema,
});
export type ReorderCustomFieldDefinitionsInput = z.infer<
  typeof reorderCustomFieldDefinitionsInputSchema
>;

export const setTagReviewModeOverrideInputSchema = z.strictObject({
  projectId: opaqueIdSchema,
  tagId: opaqueIdSchema,
  reviewModeOverride: reviewModeOverrideSchema,
  expectedProjectVersion: expectedProjectVersionSchema,
  reason: reasonSchema,
  idempotencyKey: idempotencyKeySchema,
});
export type SetTagReviewModeOverrideInput = z.infer<typeof setTagReviewModeOverrideInputSchema>;

export const setTaskReviewModeOverrideInputSchema = z.strictObject({
  projectId: opaqueIdSchema,
  taskId: opaqueIdSchema,
  reviewModeOverride: reviewModeOverrideSchema,
  expectedTaskVersion: z.number().int().positive(),
  reason: reasonSchema,
  idempotencyKey: idempotencyKeySchema,
});
export type SetTaskReviewModeOverrideInput = z.infer<typeof setTaskReviewModeOverrideInputSchema>;

export const listProjectCustomizationInputSchema = z.strictObject({
  projectId: opaqueIdSchema,
  includeRetired: z.boolean().default(true),
});
export type ListProjectCustomizationInput = z.infer<typeof listProjectCustomizationInputSchema>;

export const compiledCustomFieldValueSchema = z.compile(customFieldValueSchema);
export const compiledCustomFieldDefinitionSchema = z.compile(customFieldDefinitionSchema);
export const compiledTaskCustomFieldAssignmentSchema = z.compile(taskCustomFieldAssignmentSchema);
export const compiledProjectCustomizationSnapshotSchema = z.compile(
  projectCustomizationSnapshotSchema,
);
export const compiledAddCustomFieldDefinitionInputSchema = z.compile(
  addCustomFieldDefinitionInputSchema,
);
export const compiledRetireCustomFieldDefinitionInputSchema = z.compile(
  retireCustomFieldDefinitionInputSchema,
);
export const compiledReorderCustomFieldDefinitionsInputSchema = z.compile(
  reorderCustomFieldDefinitionsInputSchema,
);
export const compiledSetTagReviewModeOverrideInputSchema = z.compile(
  setTagReviewModeOverrideInputSchema,
);
export const compiledSetTaskReviewModeOverrideInputSchema = z.compile(
  setTaskReviewModeOverrideInputSchema,
);
export const compiledListProjectCustomizationInputSchema = z.compile(
  listProjectCustomizationInputSchema,
);
