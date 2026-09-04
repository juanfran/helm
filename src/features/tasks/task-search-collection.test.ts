// @vitest-environment jsdom

import { QueryClient } from "@tanstack/react-query";
import { afterEach, describe, expect, it, vi } from "vitest";

import {
  completeTaskSearchFields,
  searchTasksInputSchema,
  taskSearchItemSchema,
  type SearchTasksInput,
} from "../../domain/task-filters";
import { readTaskSearchPage } from "../../server/task-query-functions";
import {
  canonicalizeTaskSearchInput,
  getTaskSearchCollection,
  taskSearchQueryKey,
} from "./task-search-collection";

vi.mock("../../server/task-query-functions", () => ({
  readTaskSearchPage: vi.fn(),
}));

const searchItem = taskSearchItemSchema.parse({
  task: {
    id: "task-1",
    projectId: "project-1",
    sequence: 1,
    parentTaskId: null,
    title: "Build exact search",
    lifecycle: "ready",
    priority: "normal",
    position: 0,
    notBefore: null,
    dueAt: null,
    size: null,
    tags: [],
    requiredCapabilities: [],
    claim: null,
    eligibility: {
      claimable: true,
      status: "claimable",
      reasons: [],
      orderingExplanation: "Normal priority, manual position 0, sequence 1.",
      missingCapabilities: [],
      blockingTaskIds: [],
    },
    descriptionText: "",
    expectedOutcome: "Search remains deterministic.",
    acceptanceCriteria: "Equivalent inputs share one collection.",
    agentContext: "",
    checklist: [{ id: "check-1", text: "Verify the query key", checked: false }],
    version: 1,
    createdAt: "2026-09-04T10:00:00.000Z",
    updatedAt: "2026-09-04T10:00:00.000Z",
  },
  relevance: null,
  matchedSources: [],
});

function searchInput(overrides: Partial<SearchTasksInput> = {}) {
  return searchTasksInputSchema.parse({
    filter: {
      schemaVersion: 1,
      projectId: "project-1",
      archiveState: "exclude",
      lifecycles: ["ready", "backlog"],
      capabilities: {
        operator: "all_of",
        values: ["TypeScript", "sqlite", "typescript"],
      },
    },
    limit: 25,
    cursor: null,
    ...overrides,
  });
}

afterEach(() => {
  vi.resetAllMocks();
});

describe("task search collection", () => {
  it("canonicalizes equivalent filters and orders into one stable exact key", () => {
    const left = searchInput({
      order: [
        { field: "priority", direction: "asc" },
        { field: "priority", direction: "desc" },
      ],
    });
    const right = searchTasksInputSchema.parse({
      filter: {
        schemaVersion: 1,
        projectId: "project-1",
        archiveState: "exclude",
        lifecycles: ["backlog", "ready"],
        capabilities: {
          operator: "all_of",
          values: ["sqlite", "typescript"],
        },
      },
      order: [
        { field: "priority", direction: "asc" },
        { field: "sequence", direction: "asc" },
        { field: "id", direction: "asc" },
      ],
      limit: 25,
      cursor: null,
    });

    expect(canonicalizeTaskSearchInput(left)).toEqual(canonicalizeTaskSearchInput(right));
    expect(taskSearchQueryKey(left)).toEqual(taskSearchQueryKey(right));

    const queryClient = new QueryClient({ defaultOptions: { queries: { retry: false } } });
    expect(getTaskSearchCollection(queryClient, left)).toBe(
      getTaskSearchCollection(queryClient, right),
    );
    queryClient.clear();
  });

  it("scopes collections by QueryClient and the exact cursor", () => {
    const firstClient = new QueryClient();
    const secondClient = new QueryClient();
    const firstPage = searchInput();
    const nextPage = searchInput({ cursor: "next-page" });

    const firstCollection = getTaskSearchCollection(firstClient, firstPage);
    expect(getTaskSearchCollection(firstClient, firstPage)).toBe(firstCollection);
    expect(getTaskSearchCollection(firstClient, nextPage)).not.toBe(firstCollection);
    expect(getTaskSearchCollection(secondClient, firstPage)).not.toBe(firstCollection);

    firstClient.clear();
    secondClient.clear();
  });

  it("keeps compact and complete projections isolated while canonicalizing field order", () => {
    const queryClient = new QueryClient();
    const compact = searchInput({ fields: [] });
    const complete = searchInput({ fields: [...completeTaskSearchFields] });
    const reordered = searchInput({ fields: completeTaskSearchFields.toReversed() });

    expect(taskSearchQueryKey(compact)).not.toEqual(taskSearchQueryKey(complete));
    expect(getTaskSearchCollection(queryClient, compact)).not.toBe(
      getTaskSearchCollection(queryClient, complete),
    );
    expect(taskSearchQueryKey(reordered)).toEqual(taskSearchQueryKey(complete));
    expect(getTaskSearchCollection(queryClient, reordered)).toBe(
      getTaskSearchCollection(queryClient, complete),
    );

    queryClient.clear();
  });

  it("keeps otherwise identical searches isolated by project", async () => {
    vi.mocked(readTaskSearchPage).mockResolvedValue({
      items: [],
      nextCursor: null,
      hasMore: false,
      total: 0,
      revision: 0,
    });
    const queryClient = new QueryClient({ defaultOptions: { queries: { retry: false } } });
    const firstProject = searchInput();
    const secondProject = searchInput({
      filter: { ...firstProject.filter, projectId: "project-2" },
    });

    const firstCollection = getTaskSearchCollection(queryClient, firstProject);
    const secondCollection = getTaskSearchCollection(queryClient, secondProject);

    expect(secondCollection).not.toBe(firstCollection);
    expect(taskSearchQueryKey(secondProject)).not.toEqual(taskSearchQueryKey(firstProject));
    await Promise.all([firstCollection.preload(), secondCollection.preload()]);
    expect(
      vi.mocked(readTaskSearchPage).mock.calls.map(([request]) => request.data.filter.projectId),
    ).toEqual(expect.arrayContaining(["project-1", "project-2"]));
    queryClient.clear();
  });

  it("loads the canonical input and exposes page items by task id", async () => {
    const page = {
      items: [searchItem],
      nextCursor: null,
      hasMore: false,
      total: 1,
      revision: 4,
    };
    vi.mocked(readTaskSearchPage).mockResolvedValue(page);
    const queryClient = new QueryClient({ defaultOptions: { queries: { retry: false } } });
    const input = searchInput();
    const collection = getTaskSearchCollection(queryClient, input);

    await collection.preload();

    expect(readTaskSearchPage).toHaveBeenCalledWith({
      data: canonicalizeTaskSearchInput(input),
    });
    expect(queryClient.getQueryData(taskSearchQueryKey(input))).toEqual(page);
    expect(collection.get(searchItem.task.id)).toMatchObject({ ...searchItem, rank: 0 });
    expect(collection.toArray).toHaveLength(1);
    queryClient.clear();
  });
});
