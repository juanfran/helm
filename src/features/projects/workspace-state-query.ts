import { queryOptions } from "@tanstack/react-query";
import { readAppState, readProjects } from "../../server/project-functions";
import { readSavedViews } from "../../server/task-query-functions";

export function workspaceStateQueryOptions() {
  return queryOptions({
    queryKey: ["workspace-state"] as const,
    staleTime: Infinity,
    queryFn: async () => {
      const [state, projects] = await Promise.all([readAppState(), readProjects()]);
      return { state, projects };
    },
  });
}

export function savedViewsQueryOptions(projectId: string) {
  return queryOptions({
    queryKey: ["saved-views", projectId] as const,
    staleTime: Infinity,
    queryFn: () => readSavedViews({ data: { projectId, includeArchived: false } }),
  });
}
