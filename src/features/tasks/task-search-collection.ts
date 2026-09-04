import { createCollection } from "@tanstack/react-db";
import { queryCollectionOptions } from "@tanstack/query-db-collection";
import { queryOptions, type QueryClient } from "@tanstack/react-query";

import {
  canonicalizeTaskFilter,
  canonicalizeTaskSearchOrder,
  searchTasksInputSchema,
  stableCanonicalJson,
  taskSearchItemSchema,
  type SearchTasksInput,
  type TaskFilterV1,
  type TaskSearchOrder,
} from "../../domain/task-filters";
import { readTaskSearchPage } from "../../server/task-query-functions";
import { z } from "zod";

const taskSearchCollectionRowSchema = taskSearchItemSchema.extend({
  rank: z.number().int().nonnegative(),
});

export type TaskSearchCollectionRow = z.infer<typeof taskSearchCollectionRowSchema>;

export type CanonicalTaskSearchInput = {
  filter: TaskFilterV1;
  order: TaskSearchOrder[];
  limit: number;
  cursor: string | null;
};

export function canonicalizeTaskSearchInput(input: SearchTasksInput): CanonicalTaskSearchInput {
  const parsed = searchTasksInputSchema.parse(input);
  const filter = canonicalizeTaskFilter(parsed.filter);
  return {
    filter,
    order: canonicalizeTaskSearchOrder(parsed.order, filter),
    limit: parsed.limit,
    cursor: parsed.cursor,
  };
}

export function taskSearchQueryKey(input: SearchTasksInput) {
  const canonical = canonicalizeTaskSearchInput(input);
  return ["task-search", canonical.filter.projectId, stableCanonicalJson(canonical)] as const;
}

export function taskSearchPageQueryOptions(input: SearchTasksInput) {
  const canonicalInput = canonicalizeTaskSearchInput(input);
  return queryOptions({
    queryKey: taskSearchQueryKey(canonicalInput),
    queryFn: () => readTaskSearchPage({ data: canonicalInput }),
    staleTime: Infinity,
  });
}

function buildTaskSearchCollection(
  queryClient: QueryClient,
  canonicalInput: CanonicalTaskSearchInput,
) {
  return createCollection(
    queryCollectionOptions({
      queryKey: taskSearchQueryKey(canonicalInput),
      queryFn: () => readTaskSearchPage({ data: canonicalInput }),
      select: (page) => page.items.map((item, rank) => ({ ...item, rank })),
      queryClient,
      schema: taskSearchCollectionRowSchema,
      getKey: (item) => item.task.id,
      staleTime: Infinity,
    }),
  );
}

export type TaskSearchCollection = ReturnType<typeof buildTaskSearchCollection>;

const collections = new WeakMap<QueryClient, Map<string, TaskSearchCollection>>();
const maximumScopedCollections = 50;

export function getTaskSearchCollection(queryClient: QueryClient, input: SearchTasksInput) {
  const canonicalInput = canonicalizeTaskSearchInput(input);
  const exactKey = stableCanonicalJson(canonicalInput);
  let scoped = collections.get(queryClient);
  if (!scoped) {
    scoped = new Map();
    collections.set(queryClient, scoped);
  }
  let collection = scoped.get(exactKey);
  if (collection) {
    // Refresh insertion order so eviction behaves like LRU and does not preferentially clean up
    // a collection the user just returned to.
    scoped.delete(exactKey);
    scoped.set(exactKey, collection);
  }
  if (!collection) {
    if (scoped.size >= maximumScopedCollections) {
      const oldestKey = scoped.keys().next().value;
      if (typeof oldestKey === "string") {
        const oldestCollection = scoped.get(oldestKey);
        scoped.delete(oldestKey);
        void oldestCollection?.cleanup().catch(() => undefined);
      }
    }
    collection = buildTaskSearchCollection(queryClient, canonicalInput);
    scoped.set(exactKey, collection);
  }
  return collection;
}
