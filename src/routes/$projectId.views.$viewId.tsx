import { createFileRoute, stripSearchParams } from "@tanstack/react-router";

import { RoutePendingState } from "../components/route-state";
import { searchTasksInputSchema } from "../domain/task-filters";
import { SavedViewPage } from "../features/tasks/saved-view-page";
import { ViewRouteError } from "../features/tasks/saved-view-route-error";
import { getTaskSearchCollection } from "../features/tasks/task-search-collection";
import { taskSearchResultFields } from "../features/tasks/task-search-params";
import { parseSavedViewSearchRouteParams } from "../features/tasks/task-search-route-params";

import { readProjectEvents } from "../server/activity-functions";
import { workspaceStateQueryOptions } from "../features/projects/workspace-state-query";
import { readSavedView } from "../server/task-query-functions";

export const Route = createFileRoute("/$projectId/views/$viewId")({
  ssr: false,
  codeSplitGroupings: [["loader"], ["component"], ["errorComponent"]],
  validateSearch: parseSavedViewSearchRouteParams,
  search: { middlewares: [stripSearchParams({ cursor: null })] },
  loaderDeps: ({ search }) => search,
  loader: async ({ context, deps, params, parentMatchPromise }) => {
    await parentMatchPromise;
    const snapshot = await context.queryClient.ensureQueryData(workspaceStateQueryOptions());
    const state = { ...snapshot.state };
    const projects = snapshot.projects;
    const project = projects.find((item) => item.id === params.projectId);
    if (!project) throw new Error("This project could not be found.");
    state.activeProject = project;
    const projectId = project.id;
    const [eventPage, view] = await Promise.all([
      readProjectEvents({
        data: {
          projectId,
          direction: "backward",
          afterCursor: 0,
          beforeCursor: null,
          limit: 1,
        },
      }),
      readSavedView({ data: { projectId, savedViewId: params.viewId } }),
    ]);
    const input = searchTasksInputSchema.parse({
      filter: view.definition.filter,
      order: view.definition.order,
      fields: [...taskSearchResultFields],
      limit: 100,
      cursor: deps.cursor,
    });
    const collection = getTaskSearchCollection(context.queryClient, input);
    await (collection.isReady()
      ? collection.utils.refetch({ throwOnError: true })
      : collection.preload());
    return {
      state,
      projects: [...projects],
      view,
      input,
      eventCursor: eventPage.latestCursor,
    };
  },
  pendingComponent: RoutePendingState,
  errorComponent: ViewRouteError,
  component: SavedViewPage,
});
