import { queryOptions, type QueryClient } from "@tanstack/react-query";

import { readProjectCustomization } from "../../server/customization-functions";

export function projectCustomizationQueryOptions(projectId: string) {
  return queryOptions({
    queryKey: ["project-customization", projectId] as const,
    queryFn: () => readProjectCustomization({ data: { projectId, includeRetired: true } }),
  });
}

export async function refreshProjectCustomization(queryClient: QueryClient, projectId: string) {
  await queryClient.invalidateQueries({ queryKey: ["project-customization", projectId] });
  return queryClient.fetchQuery(projectCustomizationQueryOptions(projectId));
}
