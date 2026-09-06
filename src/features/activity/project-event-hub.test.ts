// @vitest-environment jsdom
import { describe, expect, it, vi } from "vitest";
import { createProjectEventHub } from "./project-event-hub";
import { subscribeToProjectEvents } from "./project-event-subscription";

class Source extends EventTarget {
  close = vi.fn();
  emit(cursor: number, projectId = "project-1") {
    this.dispatchEvent(
      new MessageEvent("helm", {
        data: JSON.stringify({
          id: `event-${cursor}`,
          cursor,
          projectId,
          kind: "task.created",
          importance: "routine",
          actor: { type: "human", id: "local-human" },
          entity: { type: "task", id: "task-1" },
          payload: {},
          changes: {
            projectIds: [projectId],
            taskIds: ["task-1"],
            activityEntryIds: [],
            agentRunIds: [],
            scopes: ["tasks"],
          },
          occurredAt: "2026-09-06T10:00:00Z",
        }),
      }),
    );
  }
}
function fixture() {
  const sources: Source[] = [];
  const create = vi.fn(() => {
    const source = new Source();
    sources.push(source);
    return source;
  });
  return { hub: createProjectEventHub(create), create, sources };
}

describe("shared project event transport", () => {
  it("shares one physical stream across application, project, and search subscribers", async () => {
    const { hub, create, sources } = fixture();
    const all = vi.fn();
    const project = vi.fn();
    const search = vi.fn();
    const stopAll = hub.subscribe("/api/events?after=4", all);
    const stopProject = hub.subscribe("/api/events?projectId=project-1&after=4", project);
    const stopSearch = hub.subscribe("/api/events?projectId=project-2&after=4", search);
    expect(create).toHaveBeenCalledExactlyOnceWith("/api/events?after=4");
    const source = sources[0]!;
    source.dispatchEvent(new Event("open"));
    source.emit(5);
    source.emit(6, "project-2");
    expect(all.mock.calls.map(([message]) => message.type)).toEqual(["open", "helm", "helm"]);
    expect(project).toHaveBeenCalledTimes(2);
    expect(search).toHaveBeenCalledTimes(2);
    stopAll();
    stopProject();
    expect(source.close).not.toHaveBeenCalled();
    source.emit(7, "project-2");
    expect(search).toHaveBeenCalledTimes(3);
    stopSearch();
    expect(source.close).toHaveBeenCalledOnce();
  });

  it("replays an older joining cursor without duplicating events for caught-up subscribers", () => {
    const { hub, create, sources } = fixture();
    const current = vi.fn();
    const late = vi.fn();
    const stopCurrent = hub.subscribe("/api/events?after=4", current);
    sources[0]!.emit(5);
    sources[0]!.emit(6);
    const stopLate = hub.subscribe("/api/events?after=3", late);
    expect(sources[0]!.close).toHaveBeenCalledOnce();
    expect(create).toHaveBeenLastCalledWith("/api/events?after=3");
    sources[0]!.emit(7); // disconnected generation must not deliver
    sources[1]!.emit(4);
    sources[1]!.emit(5);
    sources[1]!.emit(6);
    sources[1]!.emit(7);
    expect(current).toHaveBeenCalledTimes(3);
    expect(late).toHaveBeenCalledTimes(4);
    stopCurrent();
    stopLate();
  });

  it("reports an already-open connection to a new subscriber and suppresses messages after close", async () => {
    const { hub, create, sources } = fixture();
    const stop = hub.subscribe("/api/events?after=4", vi.fn());
    sources[0]!.dispatchEvent(new Event("open"));
    const listener = vi.fn();
    const stopNew = hub.subscribe("/api/events?after=4", listener);
    await Promise.resolve();
    expect(listener).toHaveBeenCalledExactlyOnceWith({ type: "open" });
    stopNew();
    sources[0]!.emit(5);
    expect(listener).toHaveBeenCalledOnce();
    stop();
    const stopAgain = hub.subscribe("/api/events?after=10", vi.fn());
    expect(create).toHaveBeenLastCalledWith("/api/events?after=10");
    stopAgain();
  });

  it("preserves independent committed cursors when a consumer fails projection", async () => {
    const { hub, create, sources } = fixture();
    const createEventSource = (url: string) => {
      const target = new EventTarget();
      const stop = hub.subscribe(url, (message) =>
        target.dispatchEvent(
          message.type === "helm"
            ? new MessageEvent("helm", { data: message.data })
            : new Event(message.type),
        ),
      );
      return {
        addEventListener: target.addEventListener.bind(target),
        removeEventListener: target.removeEventListener.bind(target),
        close: stop,
      };
    };
    const steady = vi.fn();
    const flaky = vi
      .fn()
      .mockRejectedValueOnce(new Error("Projection unavailable"))
      .mockResolvedValue(undefined);
    const committed = vi.fn();
    const stopSteady = subscribeToProjectEvents({
      projectId: null,
      afterCursor: 4,
      onEvent: steady,
      createEventSource,
    });
    const stopFlaky = subscribeToProjectEvents({
      projectId: "project-1",
      afterCursor: 4,
      onEvent: flaky,
      onCursor: committed,
      createEventSource,
    });
    sources[0]!.emit(5);
    sources[0]!.emit(6);
    await vi.waitFor(() => expect(create).toHaveBeenCalledTimes(2));
    expect(create).toHaveBeenLastCalledWith("/api/events?after=4");
    expect(committed).not.toHaveBeenCalled();
    sources[1]!.emit(5);
    sources[1]!.emit(6);
    await vi.waitFor(() => expect(committed).toHaveBeenLastCalledWith(6));
    expect(flaky).toHaveBeenCalledTimes(3);
    expect(steady).toHaveBeenCalledTimes(2);
    stopSteady();
    stopFlaky();
  });
});
