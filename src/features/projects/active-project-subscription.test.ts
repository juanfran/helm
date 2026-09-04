// @vitest-environment jsdom

import { describe, expect, it, vi } from "vitest";

import type { ProjectEvent } from "../../domain/activity";
import type { EventSourceLike } from "../activity/project-event-subscription";
import {
  isActiveProjectChangeEvent,
  subscribeToActiveProjectChanges,
} from "./active-project-subscription";

function event(kind: string, scopes: ProjectEvent["changes"]["scopes"]): ProjectEvent {
  return {
    id: "event-12",
    cursor: 12,
    projectId: "project-2",
    kind,
    importance: "routine",
    actor: { type: "human", id: "local-human" },
    entity: { type: "project", id: "project-2" },
    payload: {},
    changes: {
      projectIds: ["project-2"],
      taskIds: [],
      activityEntryIds: [],
      agentRunIds: [],
      scopes,
    },
    occurredAt: "2026-09-04T12:00:00.000Z",
  };
}

class FakeEventSource extends EventTarget implements EventSourceLike {
  close() {}

  emit(value: ProjectEvent) {
    this.dispatchEvent(new MessageEvent("helm", { data: JSON.stringify(value) }));
  }
}

async function drainProjection(turns = 20): Promise<void> {
  if (turns === 0) return;
  await Promise.resolve();
  return drainProjection(turns - 1);
}

describe("active project subscription", () => {
  it("classifies only project changes that also update preferences", () => {
    expect(isActiveProjectChangeEvent(event("project.created", ["preferences", "projects"]))).toBe(
      true,
    );
    expect(isActiveProjectChangeEvent(event("project.selected", ["preferences"]))).toBe(true);
    expect(isActiveProjectChangeEvent(event("project.review_mode.changed", ["projects"]))).toBe(
      false,
    );
    expect(isActiveProjectChangeEvent(event("preference.theme.changed", ["preferences"]))).toBe(
      false,
    );
  });

  it("observes a selection from another project's durable event stream", async () => {
    const source = new FakeEventSource();
    const onChange = vi.fn();
    const createEventSource = vi.fn(() => source);
    const stop = subscribeToActiveProjectChanges({
      afterCursor: 11,
      onChange,
      createEventSource,
    });

    source.emit(event("task.created", ["tasks"]));
    source.emit({
      ...event("project.selected", ["preferences", "projects"]),
      id: "event-13",
      cursor: 13,
    });
    source.emit({
      ...event("project.created", ["preferences", "projects"]),
      id: "event-14",
      cursor: 14,
    });
    await drainProjection();

    expect(createEventSource).toHaveBeenCalledWith("/api/events?after=11");
    expect(onChange).toHaveBeenCalledTimes(2);
    stop();
  });
});
