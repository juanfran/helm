import type { QueryClient } from "@tanstack/react-query";
import type { ProjectEvent } from "../../domain/activity";
import { readActivityEntries, readManualBlockers } from "../../server/activity-functions";
import { readTaskAttempts, readTasks } from "../../server/task-functions";
import {
  getActivityEntryCollection,
  getManualBlockerCollection,
  getProjectEventCollection,
} from "../activity/activity-collection";
import { getImportantProjectEventCollection } from "../activity/important-project-event-collection";
import { applyProjectionDelta, projectEvent } from "../activity/project-event-projector";
import { getWorkspaceSyncState } from "./workspace-sync-state";
import { getTaskAttemptCollection } from "../tasks/task-attempt-collection";
import { getTaskCollection } from "../tasks/task-collection";
import { createWorkspaceResource } from "./workspace-resource";

function createWorkspaceData(queryClient: QueryClient, projectId: string) {
  const sync = getWorkspaceSyncState(queryClient, projectId);
  const coordinator = sync.coordinator;
  const captureCursor = () => sync.captureCursor();
  const collections = {
    tasks: getTaskCollection(queryClient, projectId),
    attempts: getTaskAttemptCollection(queryClient, projectId),
    activity: getActivityEntryCollection(queryClient, projectId),
    blockers: getManualBlockerCollection(queryClient, projectId),
    events: getProjectEventCollection(queryClient, projectId),
    important: getImportantProjectEventCollection(queryClient, projectId),
  };
  function resource(collection: (typeof collections)[keyof typeof collections]) {
    return createWorkspaceResource(
      async () => {
        await captureCursor();
        if (collection.isReady() || collection.utils.lastError)
          await collection.utils.refetch({ throwOnError: true });
        else await collection.preload();
      },
      coordinator,
      () => collection.isReady(),
    );
  }
  const resources = {
    tasks: resource(collections.tasks),
    attempts: resource(collections.attempts),
    activity: resource(collections.activity),
    blockers: resource(collections.blockers),
    events: resource(collections.events),
    important: resource(collections.important),
  };
  async function readTaskDelta(taskIds: readonly string[]) {
    const rows = await readTasks({
      data: { projectId, taskIds: [...taskIds], includeArchived: true },
    });
    const byId = new Map(rows.map((task) => [task.id, task]));
    return {
      upserts: rows.filter((task) => task.archivedAt === null),
      deleteIds: taskIds.filter((id) => !byId.get(id) || byId.get(id)?.archivedAt !== null),
    };
  }
  async function readAttemptDelta(taskIds: readonly string[]) {
    return {
      upserts: await readTaskAttempts({ data: { projectId, taskIds: [...taskIds] } }),
      deleteIds: [],
    };
  }
  // Call inside the project coordinator, shared with human command reconciliation.
  async function projectReady(event: ProjectEvent) {
    for (const item of Object.values(resources)) item.markChanged();
    await projectEvent(event, {
      taskCollection: resources.tasks.ready ? collections.tasks : undefined,
      attemptCollection: resources.attempts.ready ? collections.attempts : undefined,
      activityCollection: resources.activity.ready ? collections.activity : undefined,
      blockerCollection: resources.blockers.ready ? collections.blockers : undefined,
      eventCollection: resources.events.ready ? collections.events : undefined,
      importantEventCollection: resources.important.ready ? collections.important : undefined,
      readTaskDelta,
      readAttemptDelta,
      readActivityDelta: async (entryIds) => {
        const rows = await readActivityEntries({
          data: { projectId, entryIds: [...entryIds], limit: entryIds.length },
        });
        if (rows.length !== new Set(entryIds).size)
          throw new Error("An activity event referenced an entry that could not be projected.");
        return { upserts: rows, deleteIds: [] };
      },
      readBlockerDelta: async (taskIds) => ({
        upserts: (
          await Promise.all(
            taskIds.map((taskId) =>
              readManualBlockers({
                data: { projectId, taskId, includeResolved: true, limit: 200 },
              }),
            ),
          )
        ).flat(),
        deleteIds: [],
      }),
    });
    if (event.changes.scopes.includes("views"))
      await queryClient.invalidateQueries({ queryKey: ["saved-views", projectId] });
    if (event.changes.taskIds.length)
      await queryClient.invalidateQueries({ queryKey: ["task-tags", projectId] });
    if (event.importance !== "routine")
      await queryClient.invalidateQueries({ queryKey: ["important-project-events", projectId] });
  }
  sync.projectReady = projectReady;
  return {
    collections,
    resources,
    captureCursor,
    coordinator,
    projectReady,
    readTaskDelta,
    readAttemptDelta,
    async refreshTimeSensitiveTasks(now = Date.now()) {
      // Start dates pass without an event. Recheck only affected rows on navigation.
      await coordinator.run(async () => {
        const taskIds = collections.tasks.toArray
          .filter(
            (task) =>
              (task.eligibility?.status === "scheduled" &&
                task.notBefore &&
                Date.parse(task.notBefore) <= now) ||
              (task.claim && Date.parse(task.claim.expiresAt) <= now),
          )
          .map((task) => task.id);
        if (taskIds.length) applyProjectionDelta(collections.tasks, await readTaskDelta(taskIds));
      });
    },
    advanceCursor(next: number) {
      sync.advanceCursor(next);
    },
  };
}

export type WorkspaceData = ReturnType<typeof createWorkspaceData>;
const scopes = new WeakMap<QueryClient, Map<string, WorkspaceData>>();
export function getWorkspaceData(queryClient: QueryClient, projectId: string) {
  let projects = scopes.get(queryClient);
  if (!projects) {
    projects = new Map();
    scopes.set(queryClient, projects);
  }
  let data = projects.get(projectId);
  if (!data) {
    data = createWorkspaceData(queryClient, projectId);
    projects.set(projectId, data);
  }
  return data;
}
