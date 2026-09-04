import { describe, expect, it } from "vitest";

import { emptyRichTextDocument } from "./rich-text";
import {
  bulkTaskCreateItemSchema,
  bulkTaskExecutionResultSchema,
  bulkTaskIntentSchema,
  bulkTaskPreviewSchema,
  bulkTaskPreviewTokenSchema,
  canonicalizeBulkTaskIntent,
  compiledBulkTaskExecutionResultSchema,
  compiledBulkTaskIntentSchema,
  compiledBulkTaskPreviewSchema,
  compiledExecuteBulkTasksInputSchema,
  executeBulkTasksInputSchema,
  projectBulkTaskCreateCustomFields,
  projectBulkTaskUpdate,
  validateBulkTaskCreateItem,
  validateBulkTaskCreateParent,
  validateBulkTaskCreateTagDefinitions,
} from "./bulk-tasks";
import { customFieldDefinitionSchema, type CustomFieldDefinition } from "./customization";
import { taskSchema, type Task, type TaskTag } from "./tasks";

const frontendTag: TaskTag = {
  id: "tag-frontend",
  name: "frontend",
  description: "Browser work",
  color: "#2563eb",
  exclusiveGroup: "area",
  reviewModeOverride: null,
};

const backendTag: TaskTag = {
  id: "tag-backend",
  name: "backend",
  description: "Server work",
  color: "#16a34a",
  exclusiveGroup: "area",
  reviewModeOverride: null,
};

function numberField(
  overrides: Partial<{
    id: string;
    key: string;
    retiredAt: string | null;
  }> = {},
): CustomFieldDefinition {
  return customFieldDefinitionSchema.parse({
    id: "field-estimate",
    projectId: "project-1",
    key: "estimate",
    type: "number",
    validation: { min: 0, max: 10, integer: true },
    defaultValue: { type: "number", value: 3 },
    display: { label: "Estimate", description: "Whole points" },
    position: 0,
    retiredAt: null,
    createdAt: "2026-09-04T12:00:00.000Z",
    updatedAt: "2026-09-04T12:00:00.000Z",
    ...overrides,
  });
}

function task(overrides: Partial<Task> = {}) {
  return taskSchema.parse({
    id: "task-1",
    projectId: "project-1",
    sequence: 1,
    parentTaskId: null,
    title: "Ship the bulk command",
    lifecycle: "backlog",
    priority: "normal",
    position: 0,
    notBefore: null,
    dueAt: null,
    size: null,
    tags: [],
    requiredCapabilities: [],
    referencedPaths: [],
    claim: null,
    description: emptyRichTextDocument,
    descriptionText: "",
    expectedOutcome: "Bulk updates are atomic.",
    acceptanceCriteria: "A preview is required.",
    agentContext: "",
    checklist: [{ id: "verify", text: "Verify the transaction", checked: false }],
    reviewAttemptId: null,
    cancelledFromLifecycle: null,
    version: 1,
    archivedAt: null,
    createdAt: "2026-09-04T12:00:00.000Z",
    updatedAt: "2026-09-04T12:00:00.000Z",
    ...overrides,
  });
}

function updateIntent() {
  return {
    schemaVersion: 1 as const,
    kind: "update" as const,
    projectId: "project-1",
    reason: "Align the selected planning fields",
    selection: { type: "ids" as const, taskIds: ["task-b", "task-a"] },
    patch: {
      priority: "high" as const,
      tags: { add: ["tag-z", "tag-a"], remove: [] },
      capabilities: { add: ["TypeScript", "rust", "typescript"], remove: [] },
    },
  };
}

describe("bulk task contract", () => {
  it("parses through normal and compiled schemas and canonicalizes set-shaped input", () => {
    const input = updateIntent();

    expect(compiledBulkTaskIntentSchema.parse(input)).toEqual(bulkTaskIntentSchema.parse(input));
    expect(canonicalizeBulkTaskIntent(input)).toMatchObject({
      selection: { taskIds: ["task-a", "task-b"] },
      patch: {
        tags: { add: ["tag-a", "tag-z"], remove: [] },
        capabilities: { add: ["rust", "typescript"], remove: [] },
      },
    });
  });

  it("keeps compiled execution, preview, and result schemas in parity", () => {
    const previewToken = `btp1:${"a".repeat(64)}:${"0".repeat(64)}`;
    const executeInput = {
      intent: updateIntent(),
      previewToken,
      idempotencyKey: "bulk-execution-1",
    };
    const preview = {
      schemaVersion: 1 as const,
      mode: "atomic" as const,
      kind: "update" as const,
      projectId: "project-1",
      matchedCount: 1,
      affectedCount: 1,
      executable: true,
      targets: [
        {
          targetKey: "task-1",
          clientId: null,
          taskId: "task-1",
          sequence: 1,
          title: "Ship the bulk command",
          expectedVersion: 1,
          projectedVersion: 2,
          changed: true,
          changes: [{ field: "priority" as const, before: "normal", after: "high" }],
          failures: [],
        },
      ],
      failures: [],
      previewToken,
    };
    const result = {
      schemaVersion: 1 as const,
      mode: "atomic" as const,
      kind: "update" as const,
      operationId: "bulk-operation-1",
      projectId: "project-1",
      matchedCount: 1,
      affectedCount: 1,
      parentEventCursor: 42,
      items: [
        {
          targetKey: "task-1",
          clientId: null,
          taskId: "task-1",
          version: 2,
          changed: true,
        },
      ],
    };

    expect(compiledExecuteBulkTasksInputSchema.parse(executeInput)).toEqual(
      executeBulkTasksInputSchema.parse(executeInput),
    );
    expect(compiledBulkTaskPreviewSchema.parse(preview)).toEqual(
      bulkTaskPreviewSchema.parse(preview),
    );
    expect(compiledBulkTaskExecutionResultSchema.parse(result)).toEqual(
      bulkTaskExecutionResultSchema.parse(result),
    );
  });

  it("rejects project-mismatched filters, empty updates, and overlapping set changes", () => {
    const base = updateIntent();
    expect(() =>
      bulkTaskIntentSchema.parse({
        ...base,
        selection: {
          type: "filter",
          filter: { schemaVersion: 1, projectId: "project-2" },
        },
      }),
    ).toThrow(/same project/);
    expect(() => bulkTaskIntentSchema.parse({ ...base, patch: {} })).toThrow(
      /at least one supported field/,
    );
    expect(() =>
      bulkTaskIntentSchema.parse({
        ...base,
        patch: { tags: { add: ["tag-a"], remove: ["tag-a"] } },
      }),
    ).toThrow(/cannot be added and removed/);
    expect(() =>
      bulkTaskIntentSchema.parse({
        ...base,
        patch: { reviewModeOverride: "direct" },
      }),
    ).toThrow();
    expect(() =>
      bulkTaskIntentSchema.parse({
        ...base,
        patch: {
          customFields: {
            set: [
              {
                fieldId: "field-estimate",
                value: { type: "number", value: 5 },
              },
            ],
            clear: ["field-estimate"],
          },
        },
      }),
    ).toThrow(/cannot be set and cleared/);
  });

  it("canonicalizes and projects typed custom-field set and clear changes", () => {
    const definition = numberField();
    const current = task({
      customFields: [{ definition, value: definition.defaultValue, source: "default" }],
    });
    const intent = canonicalizeBulkTaskIntent({
      ...updateIntent(),
      patch: {
        customFields: {
          set: [
            {
              fieldId: definition.id,
              value: { type: "number", value: 5 },
            },
          ],
          clear: [],
        },
      },
    });
    if (intent.kind !== "update") throw new Error("Expected an update intent.");

    const setProjection = projectBulkTaskUpdate(current, intent.patch, [], [definition]);
    expect(setProjection.failures).toEqual([]);
    expect(setProjection.projected.customFields).toMatchObject([
      {
        definition: { id: definition.id },
        value: { type: "number", value: 5 },
        source: "explicit",
      },
    ]);
    expect(setProjection.changes).toEqual([
      {
        field: "customFields",
        before: {
          [definition.id]: {
            value: { type: "number", value: 3 },
            source: "default",
          },
        },
        after: {
          [definition.id]: {
            value: { type: "number", value: 5 },
            source: "explicit",
          },
        },
      },
    ]);

    const explicit = task({
      customFields: [...setProjection.projected.customFields],
    });
    const clearProjection = projectBulkTaskUpdate(
      explicit,
      { customFields: { set: [], clear: [definition.id] } },
      [],
      [definition],
    );
    expect(clearProjection.projected.customFields).toMatchObject([
      {
        value: { type: "number", value: 3 },
        source: "default",
      },
    ]);
    expect(clearProjection.changes.map(({ field }) => field)).toEqual(["customFields"]);
  });

  it("validates missing, retired, mismatched, and rule-invalid custom fields", () => {
    const definition = numberField();
    const retired = numberField({
      id: "field-retired",
      key: "retired_estimate",
      retiredAt: "2026-09-04T13:00:00.000Z",
    });
    const projection = projectBulkTaskUpdate(
      task(),
      {
        customFields: {
          set: [
            {
              fieldId: "field-missing",
              value: { type: "number", value: 1 },
            },
            {
              fieldId: retired.id,
              value: { type: "number", value: 1 },
            },
            {
              fieldId: definition.id,
              value: { type: "number", value: 2.5 },
            },
          ],
          clear: [],
        },
      },
      [],
      [definition, retired],
    );
    expect(projection.failures.map(({ code }) => code)).toEqual([
      "custom_field_not_found",
      "custom_field_retired",
      "custom_field_invalid_value",
    ]);
    expect(projection.failures[2]?.message).toMatch(/whole number/);

    const mismatch = projectBulkTaskUpdate(
      task(),
      {
        customFields: {
          set: [
            {
              fieldId: definition.id,
              value: { type: "text", value: "five" },
            },
          ],
          clear: [],
        },
      },
      [],
      [definition],
    );
    expect(mismatch.failures).toMatchObject([
      {
        code: "custom_field_invalid_value",
        message: expect.stringMatching(/number value/),
      },
    ]);
  });

  it("projects defaults for bulk creates while persisting only valid explicit values", () => {
    const definition = numberField();
    const valid = bulkTaskCreateItemSchema.parse({
      clientId: "draft-custom",
      task: {
        parentTaskId: null,
        lifecycle: "backlog",
        title: "Custom field task",
        description: emptyRichTextDocument,
        expectedOutcome: "",
        acceptanceCriteria: "",
        agentContext: "",
        checklist: [],
        referencedPaths: [],
        customFields: [
          {
            fieldId: definition.id,
            value: { type: "number", value: 7 },
          },
        ],
      },
    });
    expect(projectBulkTaskCreateCustomFields(valid, [definition])).toMatchObject({
      failures: [],
      projected: [
        {
          value: { type: "number", value: 7 },
          source: "explicit",
        },
      ],
    });

    const invalid = bulkTaskCreateItemSchema.parse({
      ...valid,
      task: {
        ...valid.task,
        customFields: [
          {
            fieldId: definition.id,
            value: { type: "number", value: 11 },
          },
        ],
      },
    });
    expect(projectBulkTaskCreateCustomFields(invalid, [definition]).failures).toMatchObject([
      { code: "custom_field_invalid_value", targetKey: invalid.clientId },
    ]);
  });

  it("requires explicit removal before adding another exclusive-group tag", () => {
    const current = task({ tags: [frontendTag] });
    const rejected = projectBulkTaskUpdate(
      current,
      { tags: { add: [backendTag.id], remove: [] } },
      [frontendTag, backendTag],
    );
    const accepted = projectBulkTaskUpdate(
      current,
      { tags: { add: [backendTag.id], remove: [frontendTag.id] } },
      [frontendTag, backendTag],
    );

    expect(rejected.failures).toMatchObject([
      { code: "exclusive_tag_conflict", taskId: current.id, field: "tags" },
    ]);
    expect(accepted.failures).toEqual([]);
    expect(accepted.projected.tags).toEqual([backendTag]);
    expect(accepted.changes.map(({ field }) => field)).toEqual(["tags"]);
  });

  it("keeps no-op targets matched without inventing a projected change", () => {
    const current = task({ lifecycle: "ready", priority: "high" });
    const projection = projectBulkTaskUpdate(current, { priority: "high" }, []);

    expect(projection.failures).toEqual([]);
    expect(projection.changes).toEqual([]);
    expect(projection.projected.priority).toBe("high");
  });

  it("validates ready transitions and ready bulk creates against preparation rules", () => {
    const incomplete = task({
      expectedOutcome: "",
      acceptanceCriteria: "",
      checklist: [],
    });
    expect(projectBulkTaskUpdate(incomplete, { lifecycle: "ready" }, []).failures).toMatchObject([
      { code: "task_not_prepared", field: "lifecycle" },
    ]);
    expect(
      validateBulkTaskCreateItem({
        clientId: "draft-1",
        task: {
          parentTaskId: null,
          lifecycle: "ready",
          title: "Incomplete ready work",
          description: emptyRichTextDocument,
          expectedOutcome: "",
          acceptanceCriteria: "",
          agentContext: "",
          checklist: [],
          referencedPaths: [],
          customFields: [],
        },
      }),
    ).toMatchObject([{ code: "task_not_prepared", targetKey: "draft-1" }]);
  });

  it("validates bulk-create tag definitions in the domain", () => {
    const conflicting = bulkTaskCreateItemSchema.parse({
      clientId: "draft-conflict",
      task: {
        parentTaskId: null,
        lifecycle: "backlog",
        title: "Use an incompatible tag definition",
        description: emptyRichTextDocument,
        expectedOutcome: "",
        acceptanceCriteria: "",
        agentContext: "",
        checklist: [],
        referencedPaths: [],
        tags: [
          {
            name: frontendTag.name,
            description: "A conflicting description",
            color: frontendTag.color.toUpperCase(),
            exclusiveGroup: frontendTag.exclusiveGroup,
          },
        ],
      },
    });

    expect(validateBulkTaskCreateTagDefinitions([conflicting], [frontendTag])).toMatchObject([
      {
        code: "tag_definition_conflict",
        targetKey: conflicting.clientId,
        field: "tags",
      },
    ]);
  });

  it("validates bulk-create parent policy in the domain", () => {
    const child = bulkTaskCreateItemSchema.parse({
      clientId: "draft-child",
      task: {
        parentTaskId: "parent-1",
        lifecycle: "backlog",
        title: "Create a child",
        description: emptyRichTextDocument,
        expectedOutcome: "",
        acceptanceCriteria: "",
        agentContext: "",
        checklist: [],
        referencedPaths: [],
      },
    });

    expect(validateBulkTaskCreateParent(child, "project-1", undefined)).toMatchObject({
      code: "invalid_parent",
      targetKey: child.clientId,
    });
    expect(
      validateBulkTaskCreateParent(child, "project-1", {
        projectId: "project-2",
        parentTaskId: null,
        lifecycle: "backlog",
      }),
    ).toMatchObject({ code: "invalid_parent", field: "parentTaskId" });
    expect(
      validateBulkTaskCreateParent(child, "project-1", {
        projectId: "project-1",
        parentTaskId: "grandparent-1",
        lifecycle: "backlog",
      }),
    ).toMatchObject({
      code: "invalid_parent",
      message: expect.stringMatching(/one level/),
    });
    expect(
      validateBulkTaskCreateParent(child, "project-1", {
        projectId: "project-1",
        parentTaskId: null,
        lifecycle: "in_progress",
      }),
    ).toMatchObject({
      code: "invalid_parent",
      message: expect.stringMatching(/active work/),
    });
    expect(
      validateBulkTaskCreateParent(child, "project-1", {
        projectId: "project-1",
        parentTaskId: null,
        lifecycle: "ready",
      }),
    ).toBeNull();
  });

  it("uses a versioned two-hash preview token", () => {
    expect(bulkTaskPreviewTokenSchema.parse(`btp1:${"a".repeat(64)}:${"0".repeat(64)}`)).toBe(
      `btp1:${"a".repeat(64)}:${"0".repeat(64)}`,
    );
    expect(() => bulkTaskPreviewTokenSchema.parse("btp1:not-a-preview")).toThrow();
  });
});
