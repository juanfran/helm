// @vitest-environment jsdom

import { describe, expect, it, vi } from "vitest";

import type { ProjectEvent } from "../../domain/activity";
import {
  projectEventStreamUrl,
  subscribeToProjectEvents,
  type EventSourceLike,
} from "./project-event-subscription";

function event(cursor: number, projectId = "project-1"): ProjectEvent {
  return {
    id: `event-${cursor}`,
    cursor,
    projectId,
    kind: "task.entry.comment.created",
    importance: "routine",
    actor: { type: "human", id: "local-human" },
    entity: { type: "activity_entry", id: `entry-${cursor}` },
    payload: {},
    changes: {
      projectIds: [projectId],
      taskIds: ["task-1"],
      activityEntryIds: [`entry-${cursor}`],
      agentRunIds: [],
      scopes: ["activity", "tasks"],
    },
    occurredAt: `2026-09-04T10:00:0${cursor}.000Z`,
  };
}

class FakeEventSource extends EventTarget implements EventSourceLike {
  readonly close = vi.fn();

  emitProjectEvent(value: unknown) {
    this.dispatchEvent(new MessageEvent("helm", { data: JSON.stringify(value) }));
  }
}

async function drainProjection(turns = 10): Promise<void> {
  if (turns === 0) return;
  await Promise.resolve();
  return drainProjection(turns - 1);
}

describe("project event subscription", () => {
  it("starts after the loader cursor and projects ordered events once", async () => {
    const source = new FakeEventSource();
    const onEvent = vi.fn(async (_event: ProjectEvent) => undefined);
    const onCursor = vi.fn();
    const createEventSource = vi.fn(() => source);

    const stop = subscribeToProjectEvents({
      projectId: "project-1",
      afterCursor: 4,
      onEvent,
      onCursor,
      createEventSource,
    });
    source.emitProjectEvent(event(5));
    source.emitProjectEvent(event(5));
    source.emitProjectEvent(event(6));
    await drainProjection();

    expect(createEventSource).toHaveBeenCalledWith("/api/events?projectId=project-1&after=4");
    expect(onEvent.mock.calls.map((call) => call[0]?.cursor)).toEqual([5, 6]);
    expect(onCursor).toHaveBeenLastCalledWith(6);

    stop();
    expect(source.close).toHaveBeenCalledOnce();
  });

  it("rejects malformed or cross-project events without advancing", async () => {
    const source = new FakeEventSource();
    const onEvent = vi.fn();
    const onCursor = vi.fn();
    const onError = vi.fn();
    const stop = subscribeToProjectEvents({
      projectId: "project-1",
      afterCursor: 0,
      onEvent,
      onCursor,
      onError,
      createEventSource: () => source,
    });

    source.emitProjectEvent({ cursor: 1 });
    source.emitProjectEvent(event(2, "project-2"));
    await drainProjection();

    expect(onEvent).not.toHaveBeenCalled();
    expect(onCursor).not.toHaveBeenCalled();
    expect(onError).toHaveBeenCalledTimes(2);
    stop();
  });

  it("reconnects from the committed cursor when projection fails with later events queued", async () => {
    const firstSource = new FakeEventSource();
    const recoverySource = new FakeEventSource();
    let connectionCount = 0;
    let shouldFail = true;
    const onEvent = vi.fn(async (value: ProjectEvent) => {
      if (value.cursor === 5 && shouldFail) {
        shouldFail = false;
        throw new Error("projection failed");
      }
    });
    const onCursor = vi.fn();
    const onError = vi.fn();
    const createEventSource = vi.fn(() => {
      connectionCount += 1;
      return connectionCount === 1 ? firstSource : recoverySource;
    });

    const stop = subscribeToProjectEvents({
      projectId: "project-1",
      afterCursor: 4,
      onEvent,
      onCursor,
      onError,
      createEventSource,
    });
    firstSource.emitProjectEvent(event(5));
    firstSource.emitProjectEvent(event(6));
    await drainProjection();

    expect(onEvent.mock.calls.map((call) => call[0]?.cursor)).toEqual([5]);
    expect(onCursor).not.toHaveBeenCalled();
    expect(onError).toHaveBeenCalledOnce();
    expect(firstSource.close).toHaveBeenCalledOnce();
    expect(createEventSource).toHaveBeenCalledTimes(2);
    expect(createEventSource).toHaveBeenNthCalledWith(2, "/api/events?projectId=project-1&after=4");

    firstSource.emitProjectEvent(event(7));
    recoverySource.emitProjectEvent(event(5));
    recoverySource.emitProjectEvent(event(6));
    await drainProjection();

    expect(onEvent.mock.calls.map((call) => call[0]?.cursor)).toEqual([5, 5, 6]);
    expect(onCursor.mock.calls.map((call) => call[0])).toEqual([5, 6]);
    expect(createEventSource).toHaveBeenCalledTimes(2);

    stop();
    expect(recoverySource.close).toHaveBeenCalledOnce();
  });

  it("stops projecting after cleanup", async () => {
    const source = new FakeEventSource();
    const onEvent = vi.fn();
    const stop = subscribeToProjectEvents({
      projectId: "project-1",
      afterCursor: 0,
      onEvent,
      createEventSource: () => source,
    });

    stop();
    source.emitProjectEvent(event(1));
    await drainProjection();

    expect(onEvent).not.toHaveBeenCalled();
  });
});

describe("project event stream URL", () => {
  it("encodes project identifiers and the durable cursor", () => {
    expect(projectEventStreamUrl("project / one", 42)).toBe(
      "/api/events?projectId=project+%2F+one&after=42",
    );
  });
});
