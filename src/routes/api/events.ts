import { createFileRoute } from "@tanstack/react-router";
import { Effect } from "effect";

import { readActivityEvents } from "../../application/activity";
import type { ProjectEvent } from "../../domain/activity";
import {
  createProjectEventsRequestHandler,
  type ProjectEventReader,
} from "../../realtime/project-event-stream.server";
import { activityServices } from "../../server/project-runtime.server";

const eventReader: ProjectEventReader<ProjectEvent> = {
  readEvents: (input, options) =>
    Effect.runPromise(readActivityEvents(input, activityServices), { signal: options.signal }),
};

const handleProjectEventsRequest = createProjectEventsRequestHandler(eventReader);

export const Route = createFileRoute("/api/events")({
  server: {
    handlers: {
      GET: ({ request }) => handleProjectEventsRequest(request),
    },
  },
});
