import type { QueryClient } from "@tanstack/react-query";
import type { ProjectEvent } from "../../domain/activity";
import { readProjectEvents } from "../../server/activity-functions";
import { getProjectSyncCoordinator } from "../activity/project-sync-coordinator";

/** Lightweight shell state: search does not import the workspace's collections or schemas. */
function createSyncState(queryClient: QueryClient, projectId: string) {
  let cursor: number | undefined;
  let pending: Promise<number> | undefined;
  return {
    coordinator: getProjectSyncCoordinator(queryClient, projectId),
    projectReady: undefined as ((event: ProjectEvent) => Promise<void>) | undefined,
    captureCursor() {
      if (cursor !== undefined) return Promise.resolve(cursor);
      pending ??= readProjectEvents({
        data: { projectId, direction: "backward", afterCursor: 0, beforeCursor: null, limit: 1 },
      })
        .then((page) => {
          cursor = page.latestCursor;
          return cursor;
        })
        .catch((error: unknown) => {
          pending = undefined;
          throw error;
        });
      return pending;
    },
    advanceCursor(next: number) {
      cursor = Math.max(cursor ?? 0, next);
    },
  };
}
const scopes = new WeakMap<QueryClient, Map<string, ReturnType<typeof createSyncState>>>();
export function getWorkspaceSyncState(queryClient: QueryClient, projectId: string) {
  let projects = scopes.get(queryClient);
  if (!projects) {
    projects = new Map();
    scopes.set(queryClient, projects);
  }
  let state = projects.get(projectId);
  if (!state) {
    state = createSyncState(queryClient, projectId);
    projects.set(projectId, state);
  }
  return state;
}
