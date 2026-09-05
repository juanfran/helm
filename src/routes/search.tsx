import { createFileRoute, redirect } from "@tanstack/react-router";

import { RoutePendingState } from "../components/route-state";
import { SearchPage } from "../features/tasks/task-search-page";
import { getTaskSearchCollection } from "../features/tasks/task-search-collection";
import { taskSearchInputFromParams } from "../features/tasks/task-search-params";
import { SearchRouteError } from "../features/tasks/task-search-route-error";
import { parseTaskSearchRouteParams } from "../features/tasks/task-search-route-params";
import { taskTagsQueryOptions } from "../features/tasks/task-tags-query";
import { readProjectEvents } from "../server/activity-functions";
import { readAppState, readProjects } from "../server/project-functions";
import { readSavedViews } from "../server/task-query-functions";

export const Route = createFileRoute("/search")({
  ssr: false,
  codeSplitGroupings: [["loader"], ["component"], ["errorComponent"]],
  validateSearch: parseTaskSearchRouteParams,
  loaderDeps: ({ search: { presentation: _presentation, ...query } }) => query,
  loader: async ({ context, deps }) => {
    const [state, projects] = await Promise.all([readAppState(), readProjects()]);
    if (deps.project) {
      const project = projects.find((item) => item.id === deps.project);
      if (!project) throw new Error("This project could not be found.");
      state.activeProject = project;
    }
    if (!state.activeProject) throw redirect({ to: "/" });
    const projectId = state.activeProject.id;
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
    await Promise.all([
      collection.isReady()
        ? collection.utils.refetch({ throwOnError: true })
        : collection.preload(),
      context.queryClient.ensureQueryData({
        queryKey: ["saved-views", projectId] as const,
        queryFn: () => readSavedViews({ data: { projectId, includeArchived: false } }),
      }),
      context.queryClient.ensureQueryData(taskTagsQueryOptions(projectId)),
    ]);
    return {
      state,
      projects: [...projects],
      input,
      eventCursor: eventPage.latestCursor,
    };
  },
  pendingComponent: RoutePendingState,
  errorComponent: SearchRouteError,
  component: SearchPage,
});
