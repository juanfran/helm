import { createCollection } from "@tanstack/react-db";
import { queryCollectionOptions } from "@tanstack/query-db-collection";
import type { QueryClient } from "@tanstack/react-query";

import type { ProjectEvent } from "../../domain/activity";
import { readImportantProjectEvents } from "../../server/important-project-event-functions";
import { importantProjectEventQueryKey } from "./important-project-event-query";
import { parseProjectEventWire } from "./project-event-wire";

export function parseImportantProjectEvents(events: readonly unknown[]) {
  return events.map((event) => {
    const parsed = parseProjectEventWire(event);
    if (!parsed) throw new TypeError("Helm received an invalid important project event.");
    return parsed;
  });
}

function buildImportantProjectEventCollection(queryClient: QueryClient, projectId: string) {
  return createCollection(
    queryCollectionOptions({
      queryKey: importantProjectEventQueryKey(projectId),
      queryFn: async () => {
        const page = await readImportantProjectEvents({ data: { projectId } });
        return parseImportantProjectEvents(page.events);
      },
      queryClient,
      getKey: (event) => event.id,
      staleTime: Infinity,
    }),
  );
}

export type ImportantProjectEventCollection = ReturnType<
  typeof buildImportantProjectEventCollection
>;

export function upsertImportantProjectEvent(
  event: ProjectEvent,
  collection: ImportantProjectEventCollection,
) {
  if (event.importance === "routine") return false;
  collection.utils.writeUpsert(event);
  return true;
}

const collections = new WeakMap<QueryClient, Map<string, ImportantProjectEventCollection>>();

export function getImportantProjectEventCollection(queryClient: QueryClient, projectId: string) {
  let scoped = collections.get(queryClient);
  if (!scoped) {
    scoped = new Map();
    collections.set(queryClient, scoped);
  }
  let collection = scoped.get(projectId);
  if (!collection) {
    collection = buildImportantProjectEventCollection(queryClient, projectId);
    scoped.set(projectId, collection);
  }
  return collection;
}
