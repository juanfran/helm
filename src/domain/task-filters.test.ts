import { describe, expect, it } from "vitest";

import { customFieldDefinitionSchema } from "./customization";
import { emptyRichTextDocument, taskSchema, type Task } from "./tasks";
import {
  canonicalTaskFilterJson,
  canonicalizeTaskFilter,
  canonicalizeTaskSearchFields,
  canonicalizeTaskSearchOrder,
  compiledSearchTasksInputSchema,
  compiledTaskFilterV1Schema,
  completeTaskSearchFields,
  defaultTaskSearchOrder,
  matchesStructuredTaskFilter,
  searchTasksInputSchema,
  taskSearchCandidateSchema,
  taskSearchFieldSchema,
  taskFilterCustomFieldClauseSchema,
  taskFilterV1Schema,
  type TaskFilterV1,
} from "./task-filters";

function task(overrides: Partial<Task> = {}): Task {
  return taskSchema.parse({
    id: "task-1",
    projectId: "project-1",
    sequence: 2,
    parentTaskId: null,
    childTaskIds: [],
    title: "Search the work queue",
    lifecycle: "ready",
    priority: "high",
    position: 3,
    notBefore: "2026-09-01",
    dueAt: "2026-09-30",
    size: "m",
    tags: [
      {
        id: "tag-search",
        name: "search",
        description: "Search work",
        color: "#2563eb",
        exclusiveGroup: null,
      },
    ],
    requiredCapabilities: ["sqlite", "typescript"],
    referencedPaths: [],
    claim: null,
    upstreamRelations: [
      {
        id: "relation-1",
        projectId: "project-1",
        sourceTaskId: "task-blocker",
        sourceSequence: 1,
        sourceTitle: "Prepare the schema",
        targetTaskId: "task-1",
        targetSequence: 2,
        targetTitle: "Search the work queue",
        type: "blocks",
        createdAt: "2026-09-01T09:00:00.000Z",
      },
    ],
    downstreamRelations: [],
    manualBlockers: [],
    eligibility: {
      claimable: true,
      status: "claimable",
      reasons: ["Ready."],
      orderingExplanation: "high lane",
      missingCapabilities: [],
      blockingTaskIds: [],
      manualBlockerIds: [],
    },
    description: emptyRichTextDocument,
    descriptionText: "Find tasks and history.",
    expectedOutcome: "Search is shared.",
    acceptanceCriteria: "Filters compose.",
    agentContext: "Use FTS5.",
    checklist: [{ id: "verify", text: "Run tests", checked: false }],
    reviewAttemptId: null,
    cancelledFromLifecycle: null,
    version: 1,
    archivedAt: null,
    createdAt: "2026-09-01T10:00:00.000Z",
    updatedAt: "2026-09-02T10:00:00.000Z",
    ...overrides,
  });
}

function customFieldDefinition(overrides: Record<string, unknown>) {
  return customFieldDefinitionSchema.parse({
    id: "field-text",
    projectId: "project-1",
    key: "text_field",
    type: "text",
    validation: { minLength: 0, maxLength: 1_000 },
    defaultValue: null,
    display: { label: "Text field", description: "" },
    position: 0,
    retiredAt: null,
    createdAt: "2026-09-01T09:00:00.000Z",
    updatedAt: "2026-09-01T09:00:00.000Z",
    ...overrides,
  });
}

function completeFilter(): TaskFilterV1 {
  return {
    schemaVersion: 1,
    projectId: "project-1",
    search: { text: "search queue", mode: "all" },
    archiveState: "exclude",
    lifecycles: ["ready"],
    eligibility: ["claimable"],
    priorities: ["high"],
    tags: { operator: "all_of", values: ["tag-search"] },
    capabilities: { operator: "all_of", values: ["typescript", "sqlite"] },
    actor: {
      operator: "any_of",
      actors: [{ type: "agent_profile", id: "profile-1" }],
      sources: ["attempt"],
    },
    dates: [
      {
        field: "due_at",
        operator: "between",
        from: "2026-09-01",
        to: "2026-09-30",
      },
      {
        field: "updated_at",
        operator: "on_or_after",
        value: "2026-09-02T00:00:00.000Z",
      },
      { field: "not_before", operator: "present" },
    ],
    relations: [
      {
        direction: "upstream",
        operator: "exists",
        types: ["blocks"],
        taskIds: ["task-blocker"],
      },
    ],
  };
}

describe("versioned task filters", () => {
  it("parses the bounded contract identically through normal and compiled schemas", () => {
    const filter = completeFilter();
    expect(compiledTaskFilterV1Schema.parse(filter)).toEqual(taskFilterV1Schema.parse(filter));

    const input = { filter, limit: 25 };
    expect(compiledSearchTasksInputSchema.parse(input)).toEqual(
      searchTasksInputSchema.parse(input),
    );
    expect(
      searchTasksInputSchema.parse({
        filter: { schemaVersion: 1, projectId: "project-1" },
      }),
    ).toMatchObject({
      filter: { archiveState: "exclude" },
      fields: [],
      limit: 50,
      cursor: null,
    });
  });

  it("bounds and canonicalizes optional search-candidate field groups", () => {
    const selectedInput = {
      filter: { schemaVersion: 1 as const, projectId: "project-1" },
      fields: ["timestamps", "acceptanceCriteria", "timestamps"] as const,
    };
    expect(compiledSearchTasksInputSchema.parse(selectedInput)).toEqual(
      searchTasksInputSchema.parse(selectedInput),
    );
    expect(canonicalizeTaskSearchFields(selectedInput.fields)).toEqual([
      "acceptanceCriteria",
      "timestamps",
    ]);
    expect(completeTaskSearchFields).toEqual(
      [...taskSearchFieldSchema.options].toSorted((left, right) => left.localeCompare(right)),
    );
    expect(
      searchTasksInputSchema.safeParse({
        filter: { schemaVersion: 1, projectId: "project-1" },
        fields: Array.from({ length: 11 }, () => "timestamps"),
      }).success,
    ).toBe(false);
  });

  it("uses a compact candidate schema with an always-present scheduling boundary", () => {
    const completeTask = task();
    const compactCandidate = {
      id: completeTask.id,
      projectId: completeTask.projectId,
      sequence: completeTask.sequence,
      parentTaskId: completeTask.parentTaskId,
      title: completeTask.title,
      lifecycle: completeTask.lifecycle,
      priority: completeTask.priority,
      position: completeTask.position,
      notBefore: completeTask.notBefore,
      dueAt: completeTask.dueAt,
      size: completeTask.size,
      tags: completeTask.tags,
      requiredCapabilities: completeTask.requiredCapabilities,
      claim: completeTask.claim,
      eligibility: completeTask.eligibility,
      version: completeTask.version,
    };

    expect(taskSearchCandidateSchema.parse(compactCandidate)).toEqual(compactCandidate);
    expect(
      taskSearchCandidateSchema.safeParse({
        ...compactCandidate,
        notBefore: undefined,
      }).success,
    ).toBe(false);
    expect(
      taskSearchCandidateSchema.parse({
        ...compactCandidate,
        archivedAt: completeTask.archivedAt,
        updatedAt: completeTask.updatedAt,
      }),
    ).toMatchObject({ archivedAt: null, updatedAt: completeTask.updatedAt });
  });

  it("canonicalizes semantically unordered values and clauses", () => {
    const left = completeFilter();
    const right: TaskFilterV1 = {
      ...left,
      capabilities: {
        operator: "all_of",
        values: ["SQLITE", "typescript", "sqlite"],
      },
      actor: {
        operator: "any_of",
        actors: [
          { type: "agent_profile", id: "profile-1" },
          { type: "agent_profile", id: "profile-1" },
        ],
        sources: ["attempt", "attempt"],
      },
      dates: [...left.dates!].toReversed(),
      relations: [
        {
          ...left.relations![0]!,
          types: ["blocks", "blocks"],
          taskIds: ["task-blocker", "task-blocker"],
        },
      ],
    };

    expect(canonicalTaskFilterJson(left)).toBe(canonicalTaskFilterJson(right));
    expect(canonicalizeTaskFilter(right).capabilities?.values).toEqual(["sqlite", "typescript"]);
  });

  it("parses typed custom-field presence, equality, text, number, and date clauses", () => {
    const customFields = [
      { fieldId: "field-text", operator: "present" as const },
      {
        fieldId: "field-boolean",
        operator: "equals" as const,
        value: { type: "boolean" as const, value: false },
      },
      {
        fieldId: "field-text",
        operator: "contains" as const,
        value: { type: "text" as const, value: "queue" },
      },
      {
        fieldId: "field-number",
        operator: "greater_than_or_equal" as const,
        value: { type: "number" as const, value: 3 },
      },
      {
        fieldId: "field-number",
        operator: "between" as const,
        from: { type: "number" as const, value: 1 },
        to: { type: "number" as const, value: 10 },
      },
      {
        fieldId: "field-date",
        operator: "on_or_before" as const,
        value: { type: "date" as const, value: "2026-09-30" },
      },
      {
        fieldId: "field-date",
        operator: "between" as const,
        from: { type: "date" as const, value: "2026-09-01" },
        to: { type: "date" as const, value: "2026-09-30" },
      },
    ];
    const filter = {
      schemaVersion: 1 as const,
      projectId: "project-1",
      customFields,
    };

    expect(compiledTaskFilterV1Schema.parse(filter)).toEqual(taskFilterV1Schema.parse(filter));
    expect(customFields.map((clause) => taskFilterCustomFieldClauseSchema.parse(clause))).toEqual(
      customFields,
    );
  });

  it("canonicalizes custom-field clauses, including case-insensitive text comparisons", () => {
    const left = {
      schemaVersion: 1 as const,
      projectId: "project-1",
      customFields: [
        {
          fieldId: "field-score",
          operator: "greater_than" as const,
          value: { type: "number" as const, value: 3 },
        },
        {
          fieldId: "field-summary",
          operator: "contains" as const,
          value: { type: "text" as const, value: "QUEUE" },
        },
      ],
    };
    const right = {
      ...left,
      customFields: [
        left.customFields[1]!,
        {
          ...left.customFields[1]!,
          value: { type: "text" as const, value: "queue" },
        },
        left.customFields[0]!,
      ],
    };

    expect(canonicalTaskFilterJson(left)).toBe(canonicalTaskFilterJson(right));
    expect(canonicalizeTaskFilter(right).customFields).toHaveLength(2);
    expect(
      canonicalizeTaskFilter(right).customFields?.find(({ operator }) => operator === "contains"),
    ).toMatchObject({ value: { type: "text", value: "queue" } });
  });

  it("matches every structured category while leaving text search to persistence", () => {
    const filter = completeFilter();
    const facts = {
      actors: [
        {
          source: "attempt" as const,
          actor: { type: "agent_profile" as const, id: "profile-1" },
        },
      ],
    };

    expect(matchesStructuredTaskFilter(task(), filter, facts)).toBe(true);
    expect(matchesStructuredTaskFilter(task(), { ...filter, priorities: ["urgent"] }, facts)).toBe(
      false,
    );
    expect(matchesStructuredTaskFilter(task(), filter, { actors: [] })).toBe(false);
    expect(
      matchesStructuredTaskFilter(
        task(),
        {
          ...filter,
          relations: [{ direction: "upstream", operator: "not_exists" }],
        },
        facts,
      ),
    ).toBe(false);
  });

  it("matches custom-field clauses against explicit and effective default values", () => {
    const text = customFieldDefinition({
      defaultValue: { type: "text", value: "Default queue" },
    });
    const score = customFieldDefinition({
      id: "field-score",
      key: "score",
      type: "number",
      validation: { min: null, max: null, integer: false },
      defaultValue: { type: "number", value: 5 },
      display: { label: "Score", description: "" },
      position: 1,
    });
    const visible = customFieldDefinition({
      id: "field-visible",
      key: "visible",
      type: "boolean",
      validation: {},
      defaultValue: { type: "boolean", value: false },
      display: { label: "Visible", description: "" },
      position: 2,
    });
    const release = customFieldDefinition({
      id: "field-release",
      key: "release",
      type: "date",
      validation: { min: null, max: null },
      defaultValue: null,
      display: { label: "Release", description: "" },
      position: 3,
    });
    const risk = customFieldDefinition({
      id: "field-risk",
      key: "risk",
      type: "single_select",
      validation: { options: [{ id: "high", label: "High" }] },
      defaultValue: { type: "single_select", value: "high" },
      display: { label: "Risk", description: "" },
      position: 4,
    });
    const unset = customFieldDefinition({
      id: "field-unset",
      key: "unset_field",
      position: 5,
    });
    const retired = customFieldDefinition({
      id: "field-retired",
      key: "retired_field",
      position: 6,
      retiredAt: "2026-09-02T00:00:00.000Z",
    });
    const customTask = task({
      customFields: [
        {
          definition: text,
          value: { type: "text", value: "Customer Queue" },
          source: "explicit",
        },
        { definition: score, value: score.defaultValue, source: "default" },
        { definition: visible, value: visible.defaultValue, source: "default" },
        {
          definition: release,
          value: { type: "date", value: "2026-09-15" },
          source: "explicit",
        },
        { definition: risk, value: risk.defaultValue, source: "default" },
        { definition: unset, value: null, source: "unset" },
        {
          definition: retired,
          value: { type: "text", value: "Historical evidence" },
          source: "explicit",
        },
      ],
    });
    const facts = { actors: [] };

    expect(
      matchesStructuredTaskFilter(
        customTask,
        taskFilterV1Schema.parse({
          schemaVersion: 1,
          projectId: "project-1",
          customFields: [
            {
              fieldId: text.id,
              operator: "contains",
              value: { type: "text", value: "CUSTOMER" },
            },
            {
              fieldId: score.id,
              operator: "between",
              from: { type: "number", value: 4 },
              to: { type: "number", value: 6 },
            },
            {
              fieldId: visible.id,
              operator: "equals",
              value: { type: "boolean", value: false },
            },
            {
              fieldId: release.id,
              operator: "after",
              value: { type: "date", value: "2026-09-01" },
            },
            {
              fieldId: risk.id,
              operator: "equals",
              value: { type: "single_select", value: "high" },
            },
            { fieldId: retired.id, operator: "present" },
          ],
        }),
        facts,
      ),
    ).toBe(true);
    expect(
      matchesStructuredTaskFilter(
        customTask,
        taskFilterV1Schema.parse({
          schemaVersion: 1,
          projectId: "project-1",
          customFields: [{ fieldId: unset.id, operator: "missing" }],
        }),
        facts,
      ),
    ).toBe(true);
    expect(
      matchesStructuredTaskFilter(
        customTask,
        taskFilterV1Schema.parse({
          schemaVersion: 1,
          projectId: "project-1",
          customFields: [
            {
              fieldId: retired.id,
              operator: "equals",
              value: { type: "text", value: "Historical evidence" },
            },
          ],
        }),
        facts,
      ),
    ).toBe(true);
  });

  it("does not treat missing or type-mismatched values as negative comparison matches", () => {
    const definition = customFieldDefinition({});
    const customTask = task({
      customFields: [{ definition, value: null, source: "unset" }],
    });
    const facts = { actors: [] };

    for (const clause of [
      {
        fieldId: definition.id,
        operator: "not_equals" as const,
        value: { type: "text" as const, value: "anything" },
      },
      {
        fieldId: definition.id,
        operator: "not_contains" as const,
        value: { type: "text" as const, value: "anything" },
      },
      {
        fieldId: definition.id,
        operator: "equals" as const,
        value: { type: "number" as const, value: 1 },
      },
    ]) {
      expect(
        matchesStructuredTaskFilter(
          customTask,
          taskFilterV1Schema.parse({
            schemaVersion: 1,
            projectId: "project-1",
            customFields: [clause],
          }),
          facts,
        ),
      ).toBe(false);
    }
  });

  it("rejects unknown keys, empty sets, invalid ranges, and relevance without search", () => {
    expect(() =>
      taskFilterV1Schema.parse({
        schemaVersion: 1,
        projectId: "project-1",
        unknown: true,
      }),
    ).toThrow();
    expect(() =>
      compiledTaskFilterV1Schema.parse({
        schemaVersion: 1,
        projectId: "project-1",
        priorities: [],
      }),
    ).toThrow();
    expect(() =>
      taskFilterV1Schema.parse({
        schemaVersion: 1,
        projectId: "project-1",
        dates: [
          {
            field: "due_at",
            operator: "between",
            from: "2026-10-01",
            to: "2026-09-01",
          },
        ],
      }),
    ).toThrow();
    expect(() =>
      compiledSearchTasksInputSchema.parse({
        filter: { schemaVersion: 1, projectId: "project-1" },
        order: [{ field: "relevance", direction: "asc" }],
      }),
    ).toThrow();
    expect(() =>
      compiledTaskFilterV1Schema.parse({
        schemaVersion: 1,
        projectId: "project-1",
        customFields: [
          {
            fieldId: "field-score",
            operator: "between",
            from: { type: "number", value: 10 },
            to: { type: "number", value: 1 },
          },
        ],
      }),
    ).toThrow(/number range/i);
    expect(() =>
      taskFilterV1Schema.parse({
        schemaVersion: 1,
        projectId: "project-1",
        customFields: [
          {
            fieldId: "field-visible",
            operator: "contains",
            value: { type: "boolean", value: true },
          },
        ],
      }),
    ).toThrow();
    expect(() =>
      taskFilterCustomFieldClauseSchema.parse({
        fieldId: "field-text",
        operator: "present",
        value: { type: "text", value: "unexpected" },
      }),
    ).toThrow();
  });

  it("provides deterministic defaults and appends stable custom-order tie breakers", () => {
    const withoutSearch = canonicalizeTaskFilter({
      schemaVersion: 1,
      projectId: "project-1",
    });
    expect(defaultTaskSearchOrder(withoutSearch).map(({ field }) => field)).toEqual([
      "priority",
      "position",
      "due_at",
      "sequence",
      "id",
    ]);
    expect(defaultTaskSearchOrder(completeFilter())[0]).toEqual({
      field: "relevance",
      direction: "asc",
    });
    expect(
      canonicalizeTaskSearchOrder(
        [
          { field: "title", direction: "desc" },
          { field: "title", direction: "desc" },
        ],
        withoutSearch,
      ),
    ).toEqual([
      { field: "title", direction: "desc" },
      { field: "sequence", direction: "asc" },
      { field: "id", direction: "asc" },
    ]);
  });
});
