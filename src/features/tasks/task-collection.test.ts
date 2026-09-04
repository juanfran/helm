// @vitest-environment jsdom

import { QueryClient } from "@tanstack/react-query";
import { afterEach, describe, expect, it, vi } from "vitest";

import { emptyRichTextDocument, taskSchema } from "../../domain/tasks";
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
    expect(getTaskCollection(queryClient, "project-1")).toBe(collection);
    expect(getTaskCollection(queryClient, "project-2")).not.toBe(collection);
    await collection.preload();

    expect(readTasks).toHaveBeenCalledTimes(1);
    expect(readTasks).toHaveBeenCalledWith({
      data: { projectId: "project-1", includeArchived: false },
    });

    await vi.advanceTimersByTimeAsync(60_000);
    expect(readTasks).toHaveBeenCalledTimes(1);

    queryClient.clear();
  });

  it("cannot expose one project's task rows through another project's collection", async () => {
    const queryClient = new QueryClient({ defaultOptions: { queries: { retry: false } } });
    vi.mocked(readTasks).mockImplementation(({ data }) =>
      Promise.resolve([
        taskSchema.parse({
          id: `task-${data.projectId}`,
          projectId: data.projectId,
          sequence: 1,
          parentTaskId: null,
          title: `Task for ${data.projectId}`,
          lifecycle: "backlog",
          description: emptyRichTextDocument,
          descriptionText: "",
          expectedOutcome: "",
          acceptanceCriteria: "",
          agentContext: "",
          checklist: [],
          version: 1,
          archivedAt: null,
          createdAt: "2026-09-04T12:00:00.000Z",
          updatedAt: "2026-09-04T12:00:00.000Z",
        }),
      ]),
    );

    const first = getTaskCollection(queryClient, "project-a");
    const second = getTaskCollection(queryClient, "project-b");
    await Promise.all([first.preload(), second.preload()]);

    expect(first.toArray.map((task) => task.id)).toEqual(["task-project-a"]);
    expect(second.toArray.map((task) => task.id)).toEqual(["task-project-b"]);
    expect(second.get("task-project-a")).toBeUndefined();
    queryClient.clear();
  });
});
