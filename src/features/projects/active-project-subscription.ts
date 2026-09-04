import type { ProjectEvent } from "../../domain/activity";
import { readProjectEvents } from "../../server/activity-functions";
import {
  subscribeToProjectEvents,
  type EventSourceLike,
} from "../activity/project-event-subscription";

export function isActiveProjectChangeEvent(event: ProjectEvent) {
  return (
    event.changes.scopes.includes("preferences") &&
    (event.kind === "project.created" || event.kind === "project.selected")
  );
}

export async function readApplicationEventCursor() {
  const page = await readProjectEvents({
    data: {
      projectId: null,
      direction: "backward",
      afterCursor: 0,
      beforeCursor: null,
      limit: 1,
    },
  });
  return page.latestCursor;
}

export function subscribeToActiveProjectChanges({
  afterCursor,
  onChange,
  createEventSource,
}: {
  afterCursor: number;
  onChange: (event: ProjectEvent) => void | Promise<void>;
  createEventSource?: (url: string) => EventSourceLike;
}) {
  return subscribeToProjectEvents({
    projectId: null,
    afterCursor,
    createEventSource,
    onEvent: (event) => (isActiveProjectChangeEvent(event) ? onChange(event) : undefined),
  });
}
