// @vitest-environment jsdom

import { QueryClient } from "@tanstack/react-query";
import { afterEach, describe, expect, it, vi } from "vitest";

import { readTaskAttempts } from "../../server/task-functions";
import { getTaskAttemptCollection } from "./task-attempt-collection";

vi.mock("../../server/task-functions", () => ({
  readTaskAttempts: vi.fn(),
}));

afterEach(() => {
  vi.useRealTimers();
  vi.resetAllMocks();
});

describe("task attempt collection freshness", () => {
  it("is stable per project and does not poll between durable project events", async () => {
    vi.useFakeTimers();
    const queryClient = new QueryClient({
      defaultOptions: { queries: { retry: false } },
    });
    vi.mocked(readTaskAttempts).mockResolvedValue([]);

    const collection = getTaskAttemptCollection(queryClient, "project-1");
    expect(getTaskAttemptCollection(queryClient, "project-1")).toBe(collection);
    expect(getTaskAttemptCollection(queryClient, "project-2")).not.toBe(collection);

    await collection.preload();
    expect(readTaskAttempts).toHaveBeenCalledTimes(1);
    expect(readTaskAttempts).toHaveBeenCalledWith({ data: { projectId: "project-1" } });

    await vi.advanceTimersByTimeAsync(60_000);
    expect(readTaskAttempts).toHaveBeenCalledTimes(1);

    queryClient.clear();
  });
});
