import type { QueryClient } from "@tanstack/react-query";

import {
  getActivityEntryCollection,
  getManualBlockerCollection,
  getProjectEventCollection,
} from "../activity/activity-collection";
import { getImportantProjectEventCollection } from "../activity/important-project-event-collection";
import {
  getProjectSyncCoordinator,
  waitForAllProjectSync,
} from "../activity/project-sync-coordinator";
import { getTaskAttemptCollection } from "../tasks/task-attempt-collection";
import { getTaskCollection } from "../tasks/task-collection";
import { taskTagsQueryOptions } from "../tasks/task-tags-query";
import { projectCustomizationQueryOptions } from "./project-customization-query";
import { readProjectEvents } from "../../server/activity-functions";
import { readAppState, readProjects } from "../../server/project-functions";
import { readSavedViews } from "../../server/task-query-functions";

export async function loadWorkspacePage(queryClient: QueryClient) {
  const [state, projects] = await Promise.all([readAppState(), readProjects()]);
  let eventCursor = 0;
  let savedViews: readonly { readonly id: string; readonly name: string }[] = [];
  if (state.activeProject) {
    const projectId = state.activeProject.id;
    const [eventPage, projectSavedViews] = await Promise.all([
      readProjectEvents({
        data: {
          projectId,
          direction: "backward",
          afterCursor: 0,
          beforeCursor: null,
          limit: 1,
        },
      }),
      readSavedViews({ data: { projectId, includeArchived: false } }),
    ]);
    savedViews = projectSavedViews.map(({ id, name }) => ({ id, name }));
    eventCursor = eventPage.latestCursor;
    const syncCoordinator = getProjectSyncCoordinator(queryClient, projectId);
    const taskCollection = getTaskCollection(queryClient, projectId);
    const attemptCollection = getTaskAttemptCollection(queryClient, projectId);
    const activityCollection = getActivityEntryCollection(queryClient, projectId);
    const blockerCollection = getManualBlockerCollection(queryClient, projectId);
    const eventCollection = getProjectEventCollection(queryClient, projectId);
    const importantEventCollection = getImportantProjectEventCollection(queryClient, projectId);
    await syncCoordinator.run(() =>
      waitForAllProjectSync([
        taskCollection.isReady()
          ? taskCollection.utils.refetch({ throwOnError: true })
          : taskCollection.preload(),
        attemptCollection.isReady()
          ? attemptCollection.utils.refetch({ throwOnError: true })
          : attemptCollection.preload(),
        activityCollection.isReady()
          ? activityCollection.utils.refetch({ throwOnError: true })
          : activityCollection.preload(),
        blockerCollection.isReady()
          ? blockerCollection.utils.refetch({ throwOnError: true })
          : blockerCollection.preload(),
        eventCollection.isReady()
          ? eventCollection.utils.refetch({ throwOnError: true })
          : eventCollection.preload(),
        importantEventCollection.isReady()
          ? importantEventCollection.utils.refetch({ throwOnError: true })
          : importantEventCollection.preload(),
        queryClient.ensureQueryData(taskTagsQueryOptions(projectId)),
        queryClient.fetchQuery(projectCustomizationQueryOptions(projectId)),
      ]),
    );
  }
  return { ...state, projects: [...projects], eventCursor, savedViews };
}
