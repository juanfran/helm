import {
  canonicalizeTaskFilter,
  canonicalizeTaskSearchOrder,
  searchTasksInputSchema,
  type SearchTasksInput,
  type TaskFilterV1,
  type TaskSearchField,
} from "../../domain/task-filters";
import type { TaskSearchQueryParams } from "./task-search-route-params";

export {
  emptyTaskSearchParams,
  parseSavedViewSearchRouteParams,
  parseTaskSearchRouteParams,
} from "./task-search-route-params";
export type {
  SavedViewSearchParams,
  TaskSearchParams,
  TaskSearchQueryParams,
} from "./task-search-route-params";

/** Optional candidate data rendered by both human search-result routes. */
export const taskSearchResultFields = ["timestamps"] as const satisfies readonly TaskSearchField[];

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
  return searchTasksInputSchema.parse({
    filter,
    order: canonicalizeTaskSearchOrder(undefined, filter),
    fields: [...taskSearchResultFields],
    limit: 100,
    cursor: search.cursor,
  });
}
