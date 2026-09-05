import type { SavedViewPresentation } from "../../domain/saved-views";
import type { TaskFilterV1 } from "../../domain/task-filters";
import type { TaskLifecycle, TaskPriority } from "../../domain/tasks";

type TaskSearchMode = NonNullable<TaskFilterV1["search"]>["mode"];
type TaskEligibility = NonNullable<TaskFilterV1["eligibility"]>[number];

const taskSearchModes = {
  all: true,
  any: true,
  phrase: true,
} as const satisfies Record<TaskSearchMode, true>;
const taskLifecycles = {
  backlog: true,
  ready: true,
  in_progress: true,
  review: true,
  done: true,
  cancelled: true,
} as const satisfies Record<TaskLifecycle, true>;
const taskEligibilityStates = {
  not_ready: true,
  scheduled: true,
  blocked: true,
  capability_mismatch: true,
  claimable: true,
  claimed: true,
  complete: true,
  archived: true,
} as const satisfies Record<TaskEligibility, true>;
const taskPriorities = {
  urgent: true,
  high: true,
  normal: true,
  low: true,
} as const satisfies Record<TaskPriority, true>;
const taskPresentations = {
  list: true,
  board: true,
} as const satisfies Record<SavedViewPresentation, true>;
const capabilityNamePattern = /^[a-z0-9][a-z0-9._:-]*$/i;

export type TaskSearchParams = {
  readonly project?: string;
  readonly q: string;
  readonly mode: TaskSearchMode;
  readonly lifecycle: TaskLifecycle | null;
  readonly eligibility: TaskEligibility | null;
  readonly priority: TaskPriority | null;
  readonly tag: string | null;
  readonly capability: string | null;
  readonly presentation: SavedViewPresentation;
  readonly cursor: string | null;
};

export type TaskSearchQueryParams = Omit<TaskSearchParams, "presentation">;
export type SavedViewSearchParams = { readonly cursor: string | null; readonly project?: string };

function isEnumValue<TValue extends string>(
  value: unknown,
  values: Readonly<Record<TValue, true>>,
): value is TValue {
  return typeof value === "string" && Object.hasOwn(values, value);
}

function enumValue<TValue extends string>(
  value: unknown,
  values: Readonly<Record<TValue, true>>,
  fallback: TValue,
) {
  return isEnumValue(value, values) ? value : fallback;
}

function nullableEnumValue<TValue extends string>(
  value: unknown,
  values: Readonly<Record<TValue, true>>,
) {
  if (value === "" || value === undefined || value === null) return null;
  return isEnumValue(value, values) ? value : null;
}

function boundedString(value: unknown, maximumLength: number, fallback: string) {
  return typeof value === "string" && value.length <= maximumLength ? value : fallback;
}

function trimmedNullableString(value: unknown, maximumLength: number, pattern?: RegExp) {
  if (value === undefined || value === null) return null;
  if (typeof value !== "string") return null;
  const trimmed = value.trim();
  return trimmed && trimmed.length <= maximumLength && (!pattern || pattern.test(trimmed))
    ? trimmed
    : null;
}

export function parseTaskSearchRouteParams(
  search: Readonly<Record<string, unknown>>,
): TaskSearchParams {
  return {
    ...(trimmedNullableString(search.project, 200)
      ? { project: trimmedNullableString(search.project, 200) ?? undefined }
      : {}),
    q: boundedString(search.q, 500, ""),
    mode: enumValue(search.mode, taskSearchModes, "all"),
    lifecycle: nullableEnumValue(search.lifecycle, taskLifecycles),
    eligibility: nullableEnumValue(search.eligibility, taskEligibilityStates),
    priority: nullableEnumValue(search.priority, taskPriorities),
    tag: trimmedNullableString(search.tag, 200),
    capability: trimmedNullableString(search.capability, 80, capabilityNamePattern),
    presentation: enumValue(search.presentation, taskPresentations, "list"),
    cursor: trimmedNullableString(search.cursor, 4_000),
  };
}

export function parseSavedViewSearchRouteParams(
  search: Readonly<Record<string, unknown>>,
): SavedViewSearchParams {
  return {
    cursor: trimmedNullableString(search.cursor, 4_000),
    ...(trimmedNullableString(search.project, 200)
      ? { project: trimmedNullableString(search.project, 200) ?? undefined }
      : {}),
  };
}

export const emptyTaskSearchParams = parseTaskSearchRouteParams({});
