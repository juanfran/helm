// @vitest-environment jsdom

import { QueryClient } from "@tanstack/react-query";
import { afterEach, describe, expect, it, vi } from "vitest";

import { readTasks } from "../../server/task-functions";
import { getTaskCollection, TASK_COLLECTION_REFETCH_INTERVAL_MS } from "./task-collection";

vi.mock("../../server/task-functions", () => ({
  readTasks: vi.fn(),
}));

afterEach(() => {
  vi.useRealTimers();
  vi.resetAllMocks();
});

describe("task collection freshness", () => {
  it("refetches an open collection every five seconds", async () => {
    vi.useFakeTimers();
    const queryClient = new QueryClient({
      defaultOptions: { queries: { retry: false } },
    });
    vi.mocked(readTasks).mockResolvedValue([]);

    const collection = getTaskCollection(queryClient, "project-1");
    await collection.preload();

    expect(readTasks).toHaveBeenCalledTimes(1);

    await vi.advanceTimersByTimeAsync(TASK_COLLECTION_REFETCH_INTERVAL_MS - 1);
    expect(readTasks).toHaveBeenCalledTimes(1);

    await vi.advanceTimersByTimeAsync(1);
    expect(readTasks).toHaveBeenCalledTimes(2);

    queryClient.clear();
  });
});
