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
  projectBulkTaskUpdate,
  validateBulkTaskCreateItem,
  validateBulkTaskCreateParent,
  validateBulkTaskCreateTagDefinitions,
} from "./bulk-tasks";
import { taskSchema, type Task, type TaskTag } from "./tasks";

const frontendTag: TaskTag = {
  id: "tag-frontend",
  name: "frontend",
  description: "Browser work",
  color: "#2563eb",
  exclusiveGroup: "area",
};

const backendTag: TaskTag = {
  id: "tag-backend",
  name: "backend",
  description: "Server work",
  color: "#16a34a",
  exclusiveGroup: "area",
};

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
