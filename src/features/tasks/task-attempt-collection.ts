import { createCollection } from "@tanstack/react-db";
import { queryCollectionOptions } from "@tanstack/query-db-collection";
import type { QueryClient } from "@tanstack/react-query";

import { taskAttemptSummarySchema } from "../../domain/tasks";
import { readTaskAttempts } from "../../server/task-functions";

function buildTaskAttemptCollection(queryClient: QueryClient, projectId: string) {
  return createCollection(
    queryCollectionOptions({
      queryKey: ["task-attempts", projectId],
      queryFn: async () => [...(await readTaskAttempts({ data: { projectId } }))],
      queryClient,
      schema: taskAttemptSummarySchema,
      getKey: (attempt) => attempt.id,
      staleTime: Infinity,
    }),
  );
}

export type TaskAttemptCollection = ReturnType<typeof buildTaskAttemptCollection>;
const collections = new WeakMap<QueryClient, Map<string, TaskAttemptCollection>>();

export function getTaskAttemptCollection(queryClient: QueryClient, projectId: string) {
  let scoped = collections.get(queryClient);
  if (!scoped) {
    scoped = new Map();
    collections.set(queryClient, scoped);
  }
  let collection = scoped.get(projectId);
  if (!collection) {
    collection = buildTaskAttemptCollection(queryClient, projectId);
    scoped.set(projectId, collection);
  }
  return collection;
}
