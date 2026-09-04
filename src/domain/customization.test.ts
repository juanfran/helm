import { describe, expect, it } from "vitest";

import {
  MAX_CUSTOM_FIELD_TEXT_LENGTH,
  addCustomFieldDefinitionInputSchema,
  compiledAddCustomFieldDefinitionInputSchema,
  compiledCustomFieldDefinitionSchema,
  compiledCustomFieldValueSchema,
  compiledListProjectCustomizationInputSchema,
  compiledProjectCustomizationSnapshotSchema,
  compiledReorderCustomFieldDefinitionsInputSchema,
  compiledRetireCustomFieldDefinitionInputSchema,
  compiledSetTagReviewModeOverrideInputSchema,
  compiledSetTaskReviewModeOverrideInputSchema,
  compiledTaskCustomFieldAssignmentSchema,
  customFieldDefinitionDraftSchema,
  customFieldDefinitionSchema,
  customFieldTypeSchema,
  customFieldValueSchema,
  listProjectCustomizationInputSchema,
  projectCustomizationSnapshotSchema,
  reorderCustomFieldDefinitionsInputSchema,
  resolveReviewPolicy,
  retireCustomFieldDefinitionInputSchema,
  setTagReviewModeOverrideInputSchema,
  setTaskReviewModeOverrideInputSchema,
  taskCustomFieldAssignmentSchema,
  validateCustomFieldDefault,
  validateCustomFieldValue,
} from "./customization";

const timestamp = "2026-09-04T12:00:00.000Z";

function textDefinition(overrides: Record<string, unknown> = {}) {
  return customFieldDefinitionSchema.parse({
    id: "field-summary",
    projectId: "project-1",
    key: "summary",
    type: "text",
    validation: { minLength: 2, maxLength: 40 },
    defaultValue: { type: "text", value: "Ready" },
    display: { label: "Summary", description: "A short task summary." },
    position: 0,
    retiredAt: null,
    createdAt: timestamp,
    updatedAt: timestamp,
    ...overrides,
  });
}

function numberDefinition(overrides: Record<string, unknown> = {}) {
  return customFieldDefinitionSchema.parse({
    id: "field-score",
    projectId: "project-1",
    key: "score",
    type: "number",
    validation: { min: 1, max: 10, integer: true },
    defaultValue: { type: "number", value: 5 },
    display: { label: "Score", description: "Planning score." },
    position: 1,
    retiredAt: null,
    createdAt: timestamp,
    updatedAt: timestamp,
    ...overrides,
  });
}

function validationCodes(issues: ReturnType<typeof validateCustomFieldValue>) {
  return issues.map(({ code }) => code);
}

describe("custom-field definitions", () => {
  it("models each supported type with one discriminated typed-value shape", () => {
    const drafts = [
      {
        key: "summary",
        type: "text" as const,
        display: { label: "Summary" },
        validation: { minLength: 1, maxLength: 80 },
        defaultValue: { type: "text" as const, value: "Untriaged" },
      },
      {
        key: "score",
        type: "number" as const,
        display: { label: "Score" },
        validation: { min: 0, max: 10, integer: true },
        defaultValue: { type: "number" as const, value: 3 },
      },
      {
        key: "customer_visible",
        type: "boolean" as const,
        display: { label: "Customer visible" },
        validation: {},
        defaultValue: { type: "boolean" as const, value: false },
      },
      {
        key: "release_date",
        type: "date" as const,
        display: { label: "Release date" },
        validation: { min: "2026-01-01", max: "2026-12-31" },
        defaultValue: { type: "date" as const, value: "2026-09-30" },
      },
      {
        key: "risk",
        type: "single_select" as const,
        display: { label: "Risk" },
        validation: {
          options: [
            { id: "low", label: "Low" },
            { id: "high", label: "High" },
          ],
        },
        defaultValue: { type: "single_select" as const, value: "low" },
      },
    ];

    expect(drafts.map((draft) => customFieldDefinitionDraftSchema.parse(draft).type)).toEqual([
      "text",
      "number",
      "boolean",
      "date",
      "single_select",
    ]);
    expect(
      drafts.map((draft) => customFieldDefinitionDraftSchema.parse(draft).display.description),
    ).toEqual(["", "", "", "", ""]);
    expect(drafts.map((draft) => customFieldValueSchema.parse(draft.defaultValue))).toEqual(
      drafts.map(({ defaultValue }) => defaultValue),
    );
  });

  it("supplies explicit defaults for validation and the optional field default", () => {
    expect(
      customFieldDefinitionDraftSchema.parse({
        key: "notes",
        type: "text",
        display: { label: "Notes" },
      }),
    ).toEqual({
      key: "notes",
      type: "text",
      display: { label: "Notes", description: "" },
      validation: { minLength: 0, maxLength: MAX_CUSTOM_FIELD_TEXT_LENGTH },
      defaultValue: null,
    });
  });

  it("rejects invalid type-specific configuration and cross-type defaults", () => {
    expect(() =>
      customFieldDefinitionDraftSchema.parse({
        key: "notes",
        type: "text",
        display: { label: "Notes" },
        validation: { minLength: 10, maxLength: 2 },
      }),
    ).toThrow(/minimum text length/i);
    expect(() =>
      customFieldDefinitionDraftSchema.parse({
        key: "score",
        type: "number",
        display: { label: "Score" },
        validation: { min: 10, max: 1, integer: false },
      }),
    ).toThrow(/minimum number/i);
    expect(() =>
      customFieldDefinitionDraftSchema.parse({
        key: "release_date",
        type: "date",
        display: { label: "Release date" },
        validation: { min: "2026-10-01", max: "2026-09-01" },
      }),
    ).toThrow(/earliest date/i);
    expect(() =>
      customFieldDefinitionDraftSchema.parse({
        key: "risk",
        type: "single_select",
        display: { label: "Risk" },
        validation: {
          options: [
            { id: "high", label: "High" },
            { id: "high", label: "HIGH" },
          ],
        },
      }),
    ).toThrow(/may only appear once/i);
    expect(() =>
      customFieldDefinitionDraftSchema.parse({
        key: "notes",
        type: "text",
        display: { label: "Notes" },
        defaultValue: { type: "number", value: 1 },
      }),
    ).toThrow();
  });

  it("rejects defaults that are structurally typed but violate the field constraints", () => {
    const invalidDefault = {
      key: "score",
      type: "number" as const,
      display: { label: "Score", description: "" },
      validation: { min: 1, max: 10, integer: true },
      defaultValue: { type: "number" as const, value: 0.5 },
    };

    expect(validationCodes(validateCustomFieldDefault(invalidDefault))).toEqual([
      "number_not_integer",
      "number_below_minimum",
    ]);
    expect(() => customFieldDefinitionDraftSchema.parse(invalidDefault)).toThrow(
      /whole number|at least 1/i,
    );
  });

  it("keeps normal and compiled definition and value parsing in parity", () => {
    const definition = textDefinition();
    const value = { type: "text" as const, value: "Detailed enough" };

    expect(compiledCustomFieldDefinitionSchema.parse(definition)).toEqual(
      customFieldDefinitionSchema.parse(definition),
    );
    expect(compiledCustomFieldValueSchema.parse(value)).toEqual(
      customFieldValueSchema.parse(value),
    );
    expect(() =>
      compiledCustomFieldDefinitionSchema.parse({
        ...definition,
        defaultValue: { type: "text", value: "x" },
      }),
    ).toThrow(/at least 2 characters/i);
  });
});

describe("custom-field value validation", () => {
  it("reports structural and discriminant mismatches before field-specific rules", () => {
    const definition = textDefinition();

    expect(
      validationCodes(validateCustomFieldValue(definition, { type: "text", value: 42 })),
    ).toEqual(["invalid_value"]);
    expect(
      validationCodes(validateCustomFieldValue(definition, { type: "boolean", value: true })),
    ).toEqual(["type_mismatch"]);
  });

  it("applies text and number bounds without losing multiple useful issues", () => {
    expect(
      validationCodes(validateCustomFieldValue(textDefinition(), { type: "text", value: "x" })),
    ).toEqual(["text_too_short"]);
    expect(
      validationCodes(
        validateCustomFieldValue(textDefinition(), {
          type: "text",
          value: "x".repeat(41),
        }),
      ),
    ).toEqual(["text_too_long"]);
    expect(
      validationCodes(validateCustomFieldValue(numberDefinition(), { type: "number", value: 0.5 })),
    ).toEqual(["number_not_integer", "number_below_minimum"]);
    expect(
      validationCodes(validateCustomFieldValue(numberDefinition(), { type: "number", value: 11 })),
    ).toEqual(["number_above_maximum"]);
  });

  it("applies date and select membership rules and accepts valid boolean values", () => {
    const dateDefinition = customFieldDefinitionDraftSchema.parse({
      key: "release_date",
      type: "date",
      display: { label: "Release date" },
      validation: { min: "2026-09-01", max: "2026-09-30" },
    });
    const selectDefinition = customFieldDefinitionDraftSchema.parse({
      key: "risk",
      type: "single_select",
      display: { label: "Risk" },
      validation: { options: [{ id: "high", label: "High" }] },
    });
    const booleanDefinition = customFieldDefinitionDraftSchema.parse({
      key: "visible",
      type: "boolean",
      display: { label: "Visible" },
    });

    expect(
      validationCodes(
        validateCustomFieldValue(dateDefinition, { type: "date", value: "2026-08-31" }),
      ),
    ).toEqual(["date_before_minimum"]);
    expect(
      validationCodes(
        validateCustomFieldValue(dateDefinition, { type: "date", value: "2026-10-01" }),
      ),
    ).toEqual(["date_after_maximum"]);
    expect(
      validationCodes(
        validateCustomFieldValue(selectDefinition, { type: "single_select", value: "low" }),
      ),
    ).toEqual(["select_option_unknown"]);
    expect(validateCustomFieldValue(booleanDefinition, { type: "boolean", value: false })).toEqual(
      [],
    );
  });
});

describe("customization projections", () => {
  it("exposes explicit, default, and unset task assignments", () => {
    const definition = textDefinition();
    const assignments = [
      {
        definition,
        value: { type: "text" as const, value: "Explicit" },
        source: "explicit" as const,
      },
      { definition, value: definition.defaultValue, source: "default" as const },
      { definition, value: null, source: "unset" as const },
    ];

    for (const assignment of assignments) {
      expect(compiledTaskCustomFieldAssignmentSchema.parse(assignment)).toEqual(
        taskCustomFieldAssignmentSchema.parse(assignment),
      );
    }
    expect(() =>
      taskCustomFieldAssignmentSchema.parse({
        definition,
        value: null,
        source: "explicit",
      }),
    ).toThrow(/must contain a value/i);
    expect(() =>
      taskCustomFieldAssignmentSchema.parse({
        definition,
        value: { type: "text", value: "Not the default" },
        source: "default",
      }),
    ).toThrow(/definition's default value/i);
  });

  it("keeps retired definitions and their historical typed assignments readable", () => {
    const retired = textDefinition({ retiredAt: "2026-09-05T12:00:00.000Z" });
    const assignment = {
      definition: retired,
      value: { type: "text" as const, value: "Historical value" },
      source: "explicit" as const,
    };

    expect(taskCustomFieldAssignmentSchema.parse(assignment)).toEqual(assignment);
  });

  it("validates project snapshots, definition identity, ordering, and tag-rule identity", () => {
    const snapshot = {
      schemaVersion: 1 as const,
      projectId: "project-1",
      projectVersion: 3,
      definitions: [textDefinition(), numberDefinition()],
      tagReviewRules: [
        { tagId: "tag-quality", tagName: "quality", reviewMode: "required" as const },
      ],
    };

    expect(compiledProjectCustomizationSnapshotSchema.parse(snapshot)).toEqual(
      projectCustomizationSnapshotSchema.parse(snapshot),
    );
    expect(() =>
      projectCustomizationSnapshotSchema.parse({
        ...snapshot,
        definitions: [textDefinition(), numberDefinition({ projectId: "project-2" })],
      }),
    ).toThrow(/snapshot project/i);
    expect(() =>
      projectCustomizationSnapshotSchema.parse({
        ...snapshot,
        definitions: [textDefinition(), numberDefinition({ id: "field-summary" })],
      }),
    ).toThrow(/definition id/i);
    expect(() =>
      projectCustomizationSnapshotSchema.parse({
        ...snapshot,
        definitions: [textDefinition(), numberDefinition({ key: "summary" })],
      }),
    ).toThrow(/definition key/i);
    expect(() =>
      projectCustomizationSnapshotSchema.parse({
        ...snapshot,
        definitions: [textDefinition(), numberDefinition({ position: 0 })],
      }),
    ).toThrow(/definition position/i);
    expect(() =>
      projectCustomizationSnapshotSchema.parse({
        ...snapshot,
        tagReviewRules: [snapshot.tagReviewRules[0], snapshot.tagReviewRules[0]],
      }),
    ).toThrow(/tag review rule/i);
  });
});

describe("customization commands and query", () => {
  it("keeps add, retire, reorder, and review-override commands in compiled parity", () => {
    const add = {
      projectId: "project-1",
      definition: {
        key: "risk",
        type: "single_select" as const,
        display: { label: "Risk" },
        validation: { options: [{ id: "high", label: "High" }] },
      },
      expectedProjectVersion: 2,
      idempotencyKey: "add-risk",
    };
    const retire = {
      projectId: "project-1",
      fieldId: "field-risk",
      expectedProjectVersion: 3,
      reason: "This planning field is obsolete.",
      idempotencyKey: "retire-risk",
    };
    const reorder = {
      projectId: "project-1",
      orderedFieldIds: ["field-score", "field-summary"],
      expectedProjectVersion: 4,
      idempotencyKey: "reorder-fields",
    };
    const tagOverride = {
      projectId: "project-1",
      tagId: "tag-quality",
      reviewModeOverride: "required" as const,
      expectedProjectVersion: 5,
      reason: "Quality-tagged work needs review.",
      idempotencyKey: "set-quality-review",
    };
    const taskOverride = {
      projectId: "project-1",
      taskId: "task-1",
      reviewModeOverride: null,
      expectedTaskVersion: 6,
      reason: "Return this task to inherited policy.",
      idempotencyKey: "clear-task-review",
    };

    expect(compiledAddCustomFieldDefinitionInputSchema.parse(add)).toEqual(
      addCustomFieldDefinitionInputSchema.parse(add),
    );
    expect(compiledRetireCustomFieldDefinitionInputSchema.parse(retire)).toEqual(
      retireCustomFieldDefinitionInputSchema.parse(retire),
    );
    expect(compiledReorderCustomFieldDefinitionsInputSchema.parse(reorder)).toEqual(
      reorderCustomFieldDefinitionsInputSchema.parse(reorder),
    );
    expect(compiledSetTagReviewModeOverrideInputSchema.parse(tagOverride)).toEqual(
      setTagReviewModeOverrideInputSchema.parse(tagOverride),
    );
    expect(compiledSetTaskReviewModeOverrideInputSchema.parse(taskOverride)).toEqual(
      setTaskReviewModeOverrideInputSchema.parse(taskOverride),
    );
  });

  it("defaults the project customization query and compiles it once", () => {
    const input = { projectId: "project-1" };
    const expected = { projectId: "project-1", includeRetired: true };

    expect(listProjectCustomizationInputSchema.parse(input)).toEqual(expected);
    expect(compiledListProjectCustomizationInputSchema.parse(input)).toEqual(expected);
  });

  it("rejects duplicate ordering, unknown commands, lifecycle values, and empty reasons", () => {
    expect(() =>
      compiledReorderCustomFieldDefinitionsInputSchema.parse({
        projectId: "project-1",
        orderedFieldIds: ["field-a", "field-a"],
        expectedProjectVersion: 1,
        idempotencyKey: "duplicate-order",
      }),
    ).toThrow(/only appear once/i);
    expect(() =>
      addCustomFieldDefinitionInputSchema.parse({
        projectId: "project-1",
        definition: {
          key: "workflow",
          type: "lifecycle",
          display: { label: "Workflow" },
        },
        expectedProjectVersion: 1,
        idempotencyKey: "add-lifecycle",
      }),
    ).toThrow();
    expect(customFieldTypeSchema.safeParse("lifecycle").success).toBe(false);
    expect(() =>
      setTagReviewModeOverrideInputSchema.parse({
        projectId: "project-1",
        tagId: "tag-quality",
        reviewModeOverride: "done",
        expectedProjectVersion: 1,
        reason: "Bypass lifecycle",
        idempotencyKey: "bypass-lifecycle",
      }),
    ).toThrow();
    expect(() =>
      retireCustomFieldDefinitionInputSchema.parse({
        projectId: "project-1",
        fieldId: "field-risk",
        expectedProjectVersion: 1,
        reason: "   ",
        idempotencyKey: "empty-reason",
      }),
    ).toThrow();
    expect(() =>
      listProjectCustomizationInputSchema.parse({
        projectId: "project-1",
        destructiveDelete: true,
      }),
    ).toThrow();
  });
});

describe("review-policy resolution", () => {
  it("falls back to the project policy when no more specific override applies", () => {
    const resolution = resolveReviewPolicy({
      projectId: "project-1",
      projectMode: "required",
      taskId: "task-1",
      tags: [{ id: "tag-docs", name: "docs", reviewModeOverride: null }],
    });

    expect(resolution).toMatchObject({
      mode: "required",
      destination: "review",
      source: { level: "project", projectId: "project-1" },
      applicableTagRules: [],
      tagConflict: false,
    });
    expect(resolution.explanation).toMatch(/no task or tag override/i);
  });

  it("lets matching tag policy override the project and sorts evidence stably", () => {
    const resolution = resolveReviewPolicy({
      projectId: "project-1",
      projectMode: "required",
      taskId: "task-1",
      tags: [
        { id: "tag-z", name: "speed", reviewModeOverride: "direct" },
        { id: "tag-b", name: "delivery", reviewModeOverride: "direct" },
        { id: "tag-a", name: "delivery", reviewModeOverride: "direct" },
      ],
    });

    expect(resolution).toMatchObject({
      mode: "direct",
      destination: "done",
      source: {
        level: "tag",
        tagIds: ["tag-a", "tag-b", "tag-z"],
        tagNames: ["delivery", "delivery", "speed"],
      },
      tagConflict: false,
    });
    expect(resolution.applicableTagRules.map(({ tagId }) => tagId)).toEqual([
      "tag-a",
      "tag-b",
      "tag-z",
    ]);
    expect(resolution.explanation).toMatch(/precedence over the project policy/i);
  });

  it("resolves conflicting tag policies conservatively and explains the choice", () => {
    const resolution = resolveReviewPolicy({
      projectId: "project-1",
      projectMode: "direct",
      taskId: "task-1",
      tags: [
        { id: "tag-speed", name: "speed", reviewModeOverride: "direct" },
        { id: "tag-quality", name: "quality", reviewModeOverride: "required" },
      ],
    });

    expect(resolution).toMatchObject({
      mode: "required",
      destination: "review",
      source: {
        level: "tag",
        tagIds: ["tag-quality"],
        tagNames: ["quality"],
      },
      tagConflict: true,
    });
    expect(resolution.applicableTagRules.map(({ tagId }) => tagId)).toEqual([
      "tag-quality",
      "tag-speed",
    ]);
    expect(resolution.explanation).toMatch(/conflict.*conservatively/is);
  });

  it("lets the task override win over conflicting tags while preserving the explanation evidence", () => {
    const resolution = resolveReviewPolicy({
      projectId: "project-1",
      projectMode: "required",
      taskId: "task-1",
      taskOverride: "direct",
      tags: [
        { id: "tag-quality", name: "quality", reviewModeOverride: "required" },
        { id: "tag-speed", name: "speed", reviewModeOverride: "direct" },
      ],
    });

    expect(resolution).toMatchObject({
      mode: "direct",
      destination: "done",
      source: { level: "task", taskId: "task-1" },
      tagConflict: true,
    });
    expect(resolution.explanation).toMatch(/task override.*precedence.*conflict/is);
  });
});
