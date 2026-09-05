import { canonicalizeTaskSearchOrder, type SearchTasksInput } from "../../domain/task-filters";
import type { SavedViewVisibleField } from "../../domain/saved-views";
import { createHumanSavedView } from "../../server/task-query-functions";

const visibleFields: SavedViewVisibleField[] = [
  "title",
  "lifecycle",
  "eligibility",
  "priority",
  "tags",
  "capabilities",
  "due_at",
];

/** Interaction-only adapter: browsing search does not load saved-view creation code. */
export function saveSearchView(
  projectId: string,
  name: string,
  input: SearchTasksInput,
  presentation: "list" | "board",
) {
  return createHumanSavedView({
    data: {
      projectId,
      name: name.trim(),
      definition: {
        schemaVersion: 1,
        filter: input.filter,
        order: canonicalizeTaskSearchOrder(input.order, input.filter),
        grouping: presentation === "board" ? { type: "lifecycle" } : { type: "none" },
        visibleFields,
        presentation,
      },
      idempotencyKey: crypto.randomUUID(),
    },
  });
}
