import { describe, expect, it } from "vitest";

import { emptyRichTextDocument, taskSchema, type Task } from "./tasks";
import {
  canonicalTaskFilterJson,
  canonicalizeTaskFilter,
  canonicalizeTaskSearchOrder,
  compiledSearchTasksInputSchema,
  compiledTaskFilterV1Schema,
  defaultTaskSearchOrder,
  matchesStructuredTaskFilter,
  searchTasksInputSchema,
  taskFilterV1Schema,
  type TaskFilterV1,
} from "./task-filters";

function task(): Task {
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
      { field: "due_at", operator: "between", from: "2026-09-01", to: "2026-09-30" },
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
      searchTasksInputSchema.parse({ filter: { schemaVersion: 1, projectId: "project-1" } }),
    ).toMatchObject({
      filter: { archiveState: "exclude" },
      limit: 50,
      cursor: null,
    });
  });

  it("canonicalizes semantically unordered values and clauses", () => {
    const left = completeFilter();
    const right: TaskFilterV1 = {
      ...left,
      capabilities: { operator: "all_of", values: ["SQLITE", "typescript", "sqlite"] },
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
        { ...filter, relations: [{ direction: "upstream", operator: "not_exists" }] },
        facts,
      ),
    ).toBe(false);
  });

  it("rejects unknown keys, empty sets, invalid ranges, and relevance without search", () => {
    expect(() =>
      taskFilterV1Schema.parse({ schemaVersion: 1, projectId: "project-1", unknown: true }),
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
        dates: [{ field: "due_at", operator: "between", from: "2026-10-01", to: "2026-09-01" }],
      }),
    ).toThrow();
    expect(() =>
      compiledSearchTasksInputSchema.parse({
        filter: { schemaVersion: 1, projectId: "project-1" },
        order: [{ field: "relevance", direction: "asc" }],
      }),
    ).toThrow();
  });

  it("provides deterministic defaults and appends stable custom-order tie breakers", () => {
    const withoutSearch = canonicalizeTaskFilter({ schemaVersion: 1, projectId: "project-1" });
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
