import { createCollection } from "@tanstack/react-db";
import { queryCollectionOptions } from "@tanstack/query-db-collection";
import type { QueryClient } from "@tanstack/react-query";

import {
  activityEntrySchema,
  manualBlockerSchema,
  projectEventSchema,
} from "../../domain/activity";
import {
  readActivityEntries,
  readManualBlockers,
  readProjectEvents,
} from "../../server/activity-functions";

function buildActivityEntryCollection(queryClient: QueryClient, projectId: string) {
  return createCollection(
    queryCollectionOptions({
      queryKey: ["activity-entries", projectId],
      queryFn: async () => [...(await readActivityEntries({ data: { projectId, limit: 200 } }))],
      queryClient,
      schema: activityEntrySchema,
      getKey: (entry) => entry.id,
      staleTime: Infinity,
    }),
  );
}

export type ActivityEntryCollection = ReturnType<typeof buildActivityEntryCollection>;
const collections = new WeakMap<QueryClient, Map<string, ActivityEntryCollection>>();

export function getActivityEntryCollection(queryClient: QueryClient, projectId: string) {
  let scoped = collections.get(queryClient);
  if (!scoped) {
    scoped = new Map();
    collections.set(queryClient, scoped);
  }
  let collection = scoped.get(projectId);
  if (!collection) {
    collection = buildActivityEntryCollection(queryClient, projectId);
    scoped.set(projectId, collection);
  }
  return collection;
}

function buildManualBlockerCollection(queryClient: QueryClient, projectId: string) {
  return createCollection(
    queryCollectionOptions({
      queryKey: ["manual-blockers", projectId],
      queryFn: async () => [
        ...(await readManualBlockers({
          data: { projectId, includeResolved: true, limit: 200 },
        })),
      ],
      queryClient,
      schema: manualBlockerSchema,
      getKey: (blocker) => blocker.id,
      staleTime: Infinity,
    }),
  );
}

export type ManualBlockerCollection = ReturnType<typeof buildManualBlockerCollection>;
const blockerCollections = new WeakMap<QueryClient, Map<string, ManualBlockerCollection>>();

export function getManualBlockerCollection(queryClient: QueryClient, projectId: string) {
  let scoped = blockerCollections.get(queryClient);
  if (!scoped) {
    scoped = new Map();
    blockerCollections.set(queryClient, scoped);
  }
  let collection = scoped.get(projectId);
  if (!collection) {
    collection = buildManualBlockerCollection(queryClient, projectId);
    scoped.set(projectId, collection);
  }
  return collection;
}

function buildProjectEventCollection(queryClient: QueryClient, projectId: string) {
  return createCollection(
    queryCollectionOptions({
      queryKey: ["project-events", projectId],
      queryFn: async () => [
        ...(
          await readProjectEvents({
            data: {
              projectId,
              direction: "backward",
              beforeCursor: null,
              afterCursor: 0,
              limit: 200,
            },
          })
        ).events,
      ],
      queryClient,
      schema: projectEventSchema,
      getKey: (event) => event.id,
      staleTime: Infinity,
    }),
  );
}

export type ProjectEventCollection = ReturnType<typeof buildProjectEventCollection>;
const eventCollections = new WeakMap<QueryClient, Map<string, ProjectEventCollection>>();

export function getProjectEventCollection(queryClient: QueryClient, projectId: string) {
  let scoped = eventCollections.get(queryClient);
  if (!scoped) {
    scoped = new Map();
    eventCollections.set(queryClient, scoped);
  }
  let collection = scoped.get(projectId);
  if (!collection) {
    collection = buildProjectEventCollection(queryClient, projectId);
    scoped.set(projectId, collection);
  }
  return collection;
}

function buildImportantProjectEventCollection(queryClient: QueryClient, projectId: string) {
  return createCollection(
    queryCollectionOptions({
      queryKey: ["important-project-events", projectId],
      queryFn: async () => [
        ...(
          await readProjectEvents({
            data: {
              projectId,
              importance: ["attention", "critical"],
              direction: "backward",
              beforeCursor: null,
              afterCursor: 0,
              limit: 200,
            },
          })
        ).events,
      ],
      queryClient,
      schema: projectEventSchema,
      getKey: (event) => event.id,
      staleTime: Infinity,
    }),
  );
}

export type ImportantProjectEventCollection = ReturnType<
  typeof buildImportantProjectEventCollection
>;
const importantEventCollections = new WeakMap<
  QueryClient,
  Map<string, ImportantProjectEventCollection>
>();

export function getImportantProjectEventCollection(queryClient: QueryClient, projectId: string) {
  let scoped = importantEventCollections.get(queryClient);
  if (!scoped) {
    scoped = new Map();
    importantEventCollections.set(queryClient, scoped);
  }
  let collection = scoped.get(projectId);
  if (!collection) {
    collection = buildImportantProjectEventCollection(queryClient, projectId);
    scoped.set(projectId, collection);
  }
  return collection;
}
