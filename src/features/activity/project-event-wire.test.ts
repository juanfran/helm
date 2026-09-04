import { describe, expect, it } from "vitest";

import { projectEventSchema, type ProjectEvent } from "../../domain/activity";
import { parseProjectEventWire } from "./project-event-wire";

function event(): ProjectEvent {
  return {
    id: "event-7",
    cursor: 7,
    projectId: "project-1",
    kind: "task.changed",
    importance: "attention",
    actor: { type: "agent", id: "run-1" },
    entity: { type: "task", id: "task-1" },
    payload: { nested: [null, true, 2, "value", { safe: "yes" }] },
    changes: {
      projectIds: ["project-1"],
      taskIds: ["task-1"],
      activityEntryIds: [],
      agentRunIds: ["run-1"],
      savedViewIds: ["view-1"],
      scopes: ["tasks", "agents"],
    },
    occurredAt: "2026-09-04T12:00:00.000Z",
  };
}

describe("project event wire parser", () => {
  it("constructs the same stripped event shape as the canonical domain schema", () => {
    const candidate = {
      ...event(),
      ignored: "outside the wire contract",
      actor: { ...event().actor, ignored: true },
      changes: { ...event().changes, ignored: true },
    };

    expect(parseProjectEventWire(candidate)).toEqual(projectEventSchema.parse(candidate));
  });

  it("matches the canonical schema for malformed boundary values", () => {
    const valid = event();
    const candidates: unknown[] = [
      null,
      { ...valid, cursor: 0 },
      { ...valid, cursor: 1.5 },
      { ...valid, projectId: 1 },
      { ...valid, importance: "urgent" },
      { ...valid, actor: { type: "agent", id: "" } },
      { ...valid, entity: { type: "task" } },
      { ...valid, payload: { invalid: undefined } },
      { ...valid, changes: { ...valid.changes, scopes: ["unknown"] } },
      { ...valid, changes: { ...valid.changes, savedViewIds: "view-1" } },
      { ...valid, occurredAt: 123 },
    ];

    for (const candidate of candidates) {
      expect(parseProjectEventWire(candidate) !== undefined).toBe(
        projectEventSchema.safeParse(candidate).success,
      );
    }
  });
});
