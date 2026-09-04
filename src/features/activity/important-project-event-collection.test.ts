// @vitest-environment jsdom

import { QueryClient } from "@tanstack/react-query";
import { afterEach, describe, expect, it, vi } from "vitest";

import { readImportantProjectEvents } from "../../server/important-project-event-functions";
import {
  getImportantProjectEventCollection,
  parseImportantProjectEvents,
  upsertImportantProjectEvent,
} from "./important-project-event-collection";

vi.mock("../../server/important-project-event-functions", () => ({
  readImportantProjectEvents: vi.fn(),
}));

afterEach(() => vi.resetAllMocks());

describe("important project event collection", () => {
  it("is stable per QueryClient and project and loads the bounded important-event query", async () => {
    vi.mocked(readImportantProjectEvents).mockResolvedValue({
      events: [],
      direction: "backward",
      nextCursor: 0,
      previousCursor: null,
      hasMore: false,
      latestCursor: 0,
    });
    const queryClient = new QueryClient({ defaultOptions: { queries: { retry: false } } });
    const collection = getImportantProjectEventCollection(queryClient, "project-1");

    expect(getImportantProjectEventCollection(queryClient, "project-1")).toBe(collection);
    expect(getImportantProjectEventCollection(queryClient, "project-2")).not.toBe(collection);
    await collection.preload();

    expect(readImportantProjectEvents).toHaveBeenCalledWith({ data: { projectId: "project-1" } });
    expect(collection.toArray).toEqual([]);
    queryClient.clear();
  });

  it("rejects an invalid wire projection instead of poisoning the collection", async () => {
    expect(() => parseImportantProjectEvents([{ id: "event-invalid" }])).toThrow(
      "Helm received an invalid important project event.",
    );
  });

  it("upserts only important live events without the full workspace projector", async () => {
    vi.mocked(readImportantProjectEvents).mockResolvedValue({
      events: [],
      direction: "backward",
      nextCursor: 0,
      previousCursor: null,
      hasMore: false,
      latestCursor: 0,
    });
    const queryClient = new QueryClient({ defaultOptions: { queries: { retry: false } } });
    const collection = getImportantProjectEventCollection(queryClient, "project-upsert");
    await collection.preload();
    const [important] = parseImportantProjectEvents([
      {
        id: "event-1",
        cursor: 1,
        projectId: "project-upsert",
        kind: "task.review.requested",
        importance: "attention",
        actor: { type: "human", id: "human-1" },
        entity: { type: "task", id: "task-1" },
        payload: {},
        changes: {
          projectIds: ["project-upsert"],
          taskIds: ["task-1"],
          activityEntryIds: [],
          agentRunIds: [],
          scopes: ["tasks", "activity"],
        },
        occurredAt: "2026-09-04T10:00:00.000Z",
      },
    ]);
    if (!important) throw new Error("The event fixture must be valid.");

    expect(upsertImportantProjectEvent(important, collection)).toBe(true);
    expect(collection.toArray.map(({ id }) => id)).toEqual(["event-1"]);
    expect(
      upsertImportantProjectEvent(
        { ...important, id: "event-routine", importance: "routine" },
        collection,
      ),
    ).toBe(false);
    expect(collection.toArray.map(({ id }) => id)).toEqual(["event-1"]);
    queryClient.clear();
  });
});
