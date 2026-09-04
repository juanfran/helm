import { queryOptions, type QueryClient } from "@tanstack/react-query";

import { readAgentRuns } from "../../server/agent-functions";

export const activeAgentRunsQueryKey = ["agent-runs", "active"] as const;

export function activeAgentRunsQueryOptions() {
  return queryOptions({
    queryKey: activeAgentRunsQueryKey,
    queryFn: () => readAgentRuns({ data: { status: "active", limit: 200 } }),
    gcTime: Infinity,
    staleTime: Infinity,
  });
}

/**
 * Refresh after the application cursor has been captured. A forced loader read plus replay from that
 * earlier cursor closes the gap between cached presence and a replacement event subscription.
 */
export function refreshActiveAgentRuns(queryClient: QueryClient) {
  return queryClient.fetchQuery({ ...activeAgentRunsQueryOptions(), staleTime: 0 });
}
