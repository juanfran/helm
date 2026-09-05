import { createFileRoute, stripSearchParams } from "@tanstack/react-router";

import { RoutePendingState } from "../components/route-state";
import { searchTasksInputSchema } from "../domain/task-filters";
import { SavedViewPage } from "../features/tasks/saved-view-page";
import { ViewRouteError } from "../features/tasks/saved-view-route-error";
import { getTaskSearchCollection } from "../features/tasks/task-search-collection";
import { taskSearchResultFields } from "../features/tasks/task-search-params";
import { parseSavedViewSearchRouteParams } from "../features/tasks/task-search-route-params";
import { taskTagsQueryOptions } from "../features/tasks/task-tags-query";
import { readProjectEvents } from "../server/activity-functions";
import { readAppState, readProjects } from "../server/project-functions";
import { readSavedView } from "../server/task-query-functions";

export const Route = createFileRoute("/$projectId/views/$viewId")({
  ssr: false,
  codeSplitGroupings: [["loader"], ["component"], ["errorComponent"]],
  validateSearch: parseSavedViewSearchRouteParams,
  search: { middlewares: [stripSearchParams({ cursor: null })] },
  loaderDeps: ({ search }) => search,
  loader: async ({ context, deps, params }) => {
    const [state, projects] = await Promise.all([readAppState(), readProjects()]);
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
    const view = await readSavedView({ data: { projectId, savedViewId: params.viewId } });
    const input = searchTasksInputSchema.parse({
      filter: view.definition.filter,
      order: view.definition.order,
      fields: [...taskSearchResultFields],
      limit: 100,
      cursor: deps.cursor,
    });
    const collection = getTaskSearchCollection(context.queryClient, input);
    await Promise.all([
      collection.isReady()
        ? collection.utils.refetch({ throwOnError: true })
        : collection.preload(),
      context.queryClient.ensureQueryData(taskTagsQueryOptions(projectId)),
    ]);
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
