import { z } from "zod";

import {
  canonicalizeTaskFilter,
  canonicalizeTaskSearchOrder,
  type SearchTasksInput,
  type TaskFilterV1,
} from "../../domain/task-filters";
import { capabilityNameSchema, taskLifecycleSchema, taskPrioritySchema } from "../../domain/tasks";

function trimToNullable(value: unknown) {
  if (typeof value !== "string") return value === undefined ? null : value;
  const trimmed = value.trim();
  return trimmed ? trimmed : null;
}

const optionalTagId = z.preprocess(
  trimToNullable,
  z.string().min(1).max(200).nullable().catch(null),
);
const optionalCapability = z.preprocess(
  trimToNullable,
  capabilityNameSchema.nullable().catch(null),
);
export const taskSearchCursorParamSchema = z.preprocess(
  trimToNullable,
  z.string().max(4_000).nullable().catch(null),
);

export const taskSearchParamsSchema = z.object({
  q: z.string().max(500).catch(""),
  mode: z.enum(["all", "any", "phrase"]).catch("all"),
  lifecycle: z.preprocess(
    (value) => (value === "" || value === undefined ? null : value),
    taskLifecycleSchema.nullable().catch(null),
  ),
  eligibility: z.preprocess(
    (value) => (value === "" || value === undefined ? null : value),
    z
      .enum([
        "not_ready",
        "scheduled",
        "blocked",
        "capability_mismatch",
        "claimable",
        "claimed",
        "complete",
        "archived",
      ])
      .nullable()
      .catch(null),
  ),
  priority: z.preprocess(
    (value) => (value === "" || value === undefined ? null : value),
    taskPrioritySchema.nullable().catch(null),
  ),
  tag: optionalTagId,
  capability: optionalCapability,
  presentation: z.enum(["list", "board"]).catch("list"),
  cursor: taskSearchCursorParamSchema,
});
export type TaskSearchParams = z.infer<typeof taskSearchParamsSchema>;
export type TaskSearchQueryParams = Omit<TaskSearchParams, "presentation">;

export const emptyTaskSearchParams: TaskSearchParams = taskSearchParamsSchema.parse({});

export function taskFilterFromSearchParams(projectId: string, search: TaskSearchQueryParams) {
  const filter: TaskFilterV1 = {
    schemaVersion: 1,
    projectId,
    archiveState: search.eligibility === "archived" ? "only" : "exclude",
    ...(search.q.trim() ? { search: { text: search.q.trim(), mode: search.mode } } : {}),
    ...(search.lifecycle ? { lifecycles: [search.lifecycle] } : {}),
    ...(search.eligibility ? { eligibility: [search.eligibility] } : {}),
    ...(search.priority ? { priorities: [search.priority] } : {}),
    ...(search.tag ? { tags: { operator: "any_of", values: [search.tag] } } : {}),
    ...(search.capability
      ? { capabilities: { operator: "any_of", values: [search.capability] } }
      : {}),
  };
  return canonicalizeTaskFilter(filter);
}

export function taskSearchInputFromParams(
  projectId: string,
  search: TaskSearchQueryParams,
): SearchTasksInput {
  const filter = taskFilterFromSearchParams(projectId, search);
  return {
    filter,
    order: canonicalizeTaskSearchOrder(undefined, filter),
    limit: 100,
    cursor: search.cursor,
  };
}
