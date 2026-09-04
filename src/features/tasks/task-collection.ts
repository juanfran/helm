import { createCollection } from "@tanstack/react-db";
import { queryCollectionOptions } from "@tanstack/query-db-collection";
import type { QueryClient } from "@tanstack/react-query";

import { taskSchema } from "../../domain/tasks";
import { readTasks } from "../../server/task-functions";

function buildTaskCollection(queryClient: QueryClient, projectId: string) {
  return createCollection(
    queryCollectionOptions({
      queryKey: ["tasks", projectId],
      queryFn: async () => [...(await readTasks({ data: { projectId, includeArchived: false } }))],
      queryClient,
      schema: taskSchema,
      getKey: (task) => task.id,
      staleTime: Infinity,
    }),
  );
}

type TaskCollection = ReturnType<typeof buildTaskCollection>;
const collections = new WeakMap<QueryClient, Map<string, TaskCollection>>();

export function getTaskCollection(queryClient: QueryClient, projectId: string) {
  let scoped = collections.get(queryClient);
  if (!scoped) {
    scoped = new Map();
    collections.set(queryClient, scoped);
  }
  let collection = scoped.get(projectId);
  if (!collection) {
    collection = buildTaskCollection(queryClient, projectId);
    scoped.set(projectId, collection);
  }
  return collection;
}
