import { createServerFn } from "@tanstack/react-start";
import { Effect } from "effect";

import { listTaskTags } from "../application/tasks";
import { taskServices } from "./project-runtime.server";

export type ReadTaskTagsInput = {
  readonly projectId: string;
};

function isRecord(value: unknown): value is Record<string, unknown> {
  return value !== null && typeof value === "object" && !Array.isArray(value);
}

/** Keep the client validator small; the application query performs canonical schema validation. */
export function parseReadTaskTagsInput(input: unknown): ReadTaskTagsInput {
  if (!isRecord(input) || typeof input.projectId !== "string") {
    throw new TypeError("A task-tag query requires a project id.");
  }
  const projectId = input.projectId.trim();
  if (!projectId) throw new TypeError("A task-tag query requires a project id.");
  return { projectId };
}

export const readTaskTags = createServerFn({ method: "GET" })
  .validator(parseReadTaskTagsInput)
  .handler(({ data }) => Effect.runPromise(listTaskTags(data, taskServices)));
