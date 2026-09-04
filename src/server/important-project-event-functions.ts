import { createServerFn } from "@tanstack/react-start";
import { Effect } from "effect";

import { readActivityEvents } from "../application/activity";
import { activityServices } from "./project-runtime.server";

export type ReadImportantProjectEventsInput = {
  readonly projectId: string;
};

function isRecord(value: unknown): value is Record<string, unknown> {
  return value !== null && typeof value === "object" && !Array.isArray(value);
}

/** Keep this client validator small; the application query performs canonical schema validation. */
export function parseReadImportantProjectEventsInput(
  input: unknown,
): ReadImportantProjectEventsInput {
  if (!isRecord(input) || typeof input.projectId !== "string") {
    throw new TypeError("An important-event query requires a project id.");
  }
  const projectId = input.projectId.trim();
  if (!projectId) throw new TypeError("An important-event query requires a project id.");
  return { projectId };
}

export const readImportantProjectEvents = createServerFn({ method: "GET" })
  .validator(parseReadImportantProjectEventsInput)
  .handler(({ data }) =>
    Effect.runPromise(
      readActivityEvents(
        {
          projectId: data.projectId,
          importance: ["attention", "critical"],
          direction: "backward",
          beforeCursor: null,
          afterCursor: 0,
          limit: 200,
        },
        activityServices,
      ),
    ),
  );
