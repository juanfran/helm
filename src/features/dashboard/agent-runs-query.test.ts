import { QueryClient } from "@tanstack/react-query";
import { afterEach, describe, expect, it, vi } from "vitest";

import { readAgentRuns } from "../../server/agent-functions";
import { activeAgentRunsQueryOptions, refreshActiveAgentRuns } from "./agent-runs-query";

vi.mock("../../server/agent-functions", () => ({ readAgentRuns: vi.fn() }));

afterEach(() => vi.resetAllMocks());

describe("active agent-run query", () => {
  it("forces a loader refresh even while subscription-managed cache data is fresh", async () => {
    const queryClient = new QueryClient({ defaultOptions: { queries: { retry: false } } });
    const first = {
      id: "run-1",
      profileId: "profile-1",
      profileKey: "build",
      displayName: "Build Agent",
      capabilities: ["typescript"],
      status: "active" as const,
      clientName: "test",
      clientVersion: "1",
      createdAt: "2026-09-04T10:00:00.000Z",
      lastSeenAt: "2026-09-04T10:00:00.000Z",
      endedAt: null,
    };
    const second = { ...first, id: "run-2", lastSeenAt: "2026-09-04T10:01:00.000Z" };
    vi.mocked(readAgentRuns).mockResolvedValueOnce([first]).mockResolvedValueOnce([second]);

    await queryClient.ensureQueryData(activeAgentRunsQueryOptions());
    await queryClient.ensureQueryData(activeAgentRunsQueryOptions());
    expect(readAgentRuns).toHaveBeenCalledTimes(1);
    expect(activeAgentRunsQueryOptions().gcTime).toBe(Infinity);

    await expect(refreshActiveAgentRuns(queryClient)).resolves.toEqual([second]);
    expect(readAgentRuns).toHaveBeenCalledTimes(2);
    queryClient.clear();
  });
});
