import { queryOptions } from "@tanstack/react-query";

import { readTaskTags } from "../../server/task-tag-functions";

export function taskTagsQueryOptions(projectId: string) {
  return queryOptions({
    queryKey: ["task-tags", projectId] as const,
    staleTime: Infinity,
    queryFn: () => readTaskTags({ data: { projectId } }),
  });
}
