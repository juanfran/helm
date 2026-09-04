// @vitest-environment jsdom

import { QueryClient } from "@tanstack/react-query";
import { afterEach, describe, expect, it, vi } from "vitest";

import { readTasks } from "../../server/task-functions";
import { getTaskCollection } from "./task-collection";

vi.mock("../../server/task-functions", () => ({
  readTasks: vi.fn(),
}));

afterEach(() => {
  vi.useRealTimers();
  vi.resetAllMocks();
});

describe("task collection freshness", () => {
  it("does not poll because durable project events drive targeted writes", async () => {
    vi.useFakeTimers();
    const queryClient = new QueryClient({
      defaultOptions: { queries: { retry: false } },
    });
    vi.mocked(readTasks).mockResolvedValue([]);

    const collection = getTaskCollection(queryClient, "project-1");
    await collection.preload();

    expect(readTasks).toHaveBeenCalledTimes(1);

    await vi.advanceTimersByTimeAsync(60_000);
    expect(readTasks).toHaveBeenCalledTimes(1);

    queryClient.clear();
  });
});
