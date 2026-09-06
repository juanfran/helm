import { createFileRoute, stripSearchParams } from "@tanstack/react-router";

import { RoutePendingState } from "../components/route-state";
import { SearchPage } from "../features/tasks/task-search-page";
import { getTaskSearchCollection } from "../features/tasks/task-search-collection";
import { taskSearchInputFromParams } from "../features/tasks/task-search-params";
import { SearchRouteError } from "../features/tasks/task-search-route-error";
import {
  emptyTaskSearchParams,
  parseTaskSearchRouteParams,
} from "../features/tasks/task-search-route-params";
import { taskTagsQueryOptions } from "../features/tasks/task-tags-query";
import { readProjectEvents } from "../server/activity-functions";
import {
  workspaceStateQueryOptions,
  savedViewsQueryOptions,
} from "../features/projects/workspace-state-query";

export const Route = createFileRoute("/$projectId/search")({
  ssr: false,
  codeSplitGroupings: [["loader"], ["component"], ["errorComponent"]],
  validateSearch: parseTaskSearchRouteParams,
  search: { middlewares: [stripSearchParams(emptyTaskSearchParams)] },
  loaderDeps: ({ search: { presentation: _presentation, ...query } }) => query,
  loader: async ({ context, deps, params, parentMatchPromise }) => {
    await parentMatchPromise;
    const snapshot = await context.queryClient.ensureQueryData(workspaceStateQueryOptions());
    const state = { ...snapshot.state };
    const projects = snapshot.projects;
    const project = projects.find((item) => item.id === params.projectId);
    if (!project) throw new Error("This project could not be found.");
    state.activeProject = project;
    const projectId = project.id;
    const eventPage = await readProjectEvents({
      data: {
        projectId,
        direction: "backward",
        afterCursor: 0,
        beforeCursor: null,
        limit: 1,
      },
    });
    const input = taskSearchInputFromParams(projectId, deps);
    const collection = getTaskSearchCollection(context.queryClient, input);
    void context.queryClient.prefetchQuery(savedViewsQueryOptions(projectId));
    void context.queryClient.prefetchQuery(taskTagsQueryOptions(projectId));
    await (collection.isReady()
      ? collection.utils.refetch({ throwOnError: true })
      : collection.preload());
    return {
      state,
      project,
      projects: [...projects],
      input,
      eventCursor: eventPage.latestCursor,
    };
  },
  pendingComponent: RoutePendingState,
  errorComponent: SearchRouteError,
  component: SearchPage,
});
