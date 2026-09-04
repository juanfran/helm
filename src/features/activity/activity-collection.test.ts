// @vitest-environment jsdom

import { QueryClient } from "@tanstack/react-query";
import { afterEach, describe, expect, it, vi } from "vitest";

import {
  readActivityEntries,
  readManualBlockers,
  readProjectEvents,
} from "../../server/activity-functions";
import {
  getActivityEntryCollection,
  getManualBlockerCollection,
  getProjectEventCollection,
} from "./activity-collection";

vi.mock("../../server/activity-functions", () => ({
  readActivityEntries: vi.fn(),
  readManualBlockers: vi.fn(),
  readProjectEvents: vi.fn(),
}));

afterEach(() => {
  vi.resetAllMocks();
});

describe("activity collection project scope", () => {
  it("builds distinct activity, blocker, and event collections for every project", async () => {
    vi.mocked(readActivityEntries).mockResolvedValue([]);
    vi.mocked(readManualBlockers).mockResolvedValue([]);
    vi.mocked(readProjectEvents).mockResolvedValue({
      events: [],
      direction: "backward",
      nextCursor: 0,
      previousCursor: null,
      hasMore: false,
      latestCursor: 0,
    });
    const queryClient = new QueryClient({ defaultOptions: { queries: { retry: false } } });

    const activityA = getActivityEntryCollection(queryClient, "project-a");
    const blockersA = getManualBlockerCollection(queryClient, "project-a");
    const eventsA = getProjectEventCollection(queryClient, "project-a");

    expect(getActivityEntryCollection(queryClient, "project-a")).toBe(activityA);
    expect(getActivityEntryCollection(queryClient, "project-b")).not.toBe(activityA);
    expect(getManualBlockerCollection(queryClient, "project-b")).not.toBe(blockersA);
    expect(getProjectEventCollection(queryClient, "project-b")).not.toBe(eventsA);

    await Promise.all([activityA.preload(), blockersA.preload(), eventsA.preload()]);

    expect(readActivityEntries).toHaveBeenCalledWith({
      data: { projectId: "project-a", limit: 200 },
    });
    expect(readManualBlockers).toHaveBeenCalledWith({
      data: { projectId: "project-a", includeResolved: true, limit: 200 },
    });
    expect(readProjectEvents).toHaveBeenCalledWith({
      data: {
        projectId: "project-a",
        direction: "backward",
        beforeCursor: null,
        afterCursor: 0,
        limit: 200,
      },
    });

    queryClient.clear();
  });
});
