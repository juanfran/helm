import { Effect } from "effect";

import type { ActivityActor } from "../domain/activity";
import {
  canonicalizeTaskSearchFields,
  compiledSearchTasksInputSchema,
  type SearchTasksInput,
  type TaskFilterV1,
  type TaskSearchOrder,
  type TaskSearchPage,
} from "../domain/task-filters";
import {
  compiledArchiveSavedViewInputSchema,
  compiledCreateSavedViewInputSchema,
  compiledGetSavedViewInputSchema,
  compiledListSavedViewsInputSchema,
  compiledRestoreSavedViewInputSchema,
  compiledUpdateSavedViewInputSchema,
  type ArchiveSavedViewInput,
  type CreateSavedViewInput,
  type GetSavedViewInput,
  type ListSavedViewsInput,
  type RestoreSavedViewInput,
  type SavedView,
  type UpdateSavedViewInput,
} from "../domain/saved-views";
import { InvalidTaskQueryError, type TaskQueryError } from "./task-query-errors";
import { systemTaskClock } from "./tasks";

export type TaskQueryEvaluationContext = {
  readonly today: string;
  readonly now: string;
  readonly agentCapabilities: readonly string[];
};

export type TaskSelectionItem = {
  readonly id: string;
  readonly version: number;
};

export interface TaskQueryStore {
  search(
    input: SearchTasksInput,
    context: TaskQueryEvaluationContext,
  ): Effect.Effect<TaskSearchPage, TaskQueryError>;
  resolveSelection(
    filter: TaskFilterV1,
    order: readonly TaskSearchOrder[] | undefined,
    context: TaskQueryEvaluationContext,
  ): Effect.Effect<readonly TaskSelectionItem[], TaskQueryError>;
  listSavedViews(input: ListSavedViewsInput): Effect.Effect<readonly SavedView[], TaskQueryError>;
  getSavedView(input: GetSavedViewInput): Effect.Effect<SavedView, TaskQueryError>;
  createSavedView(
    input: CreateSavedViewInput,
    actor: ActivityActor,
    now: string,
  ): Effect.Effect<SavedView, TaskQueryError>;
  updateSavedView(
    input: UpdateSavedViewInput,
    actor: ActivityActor,
    now: string,
  ): Effect.Effect<SavedView, TaskQueryError>;
  archiveSavedView(
    input: ArchiveSavedViewInput,
    actor: ActivityActor,
    now: string,
  ): Effect.Effect<SavedView, TaskQueryError>;
  restoreSavedView(
    input: RestoreSavedViewInput,
    actor: ActivityActor,
    now: string,
  ): Effect.Effect<SavedView, TaskQueryError>;
}

export type TaskQueryClock = {
  today(): string;
  now(): string;
};

export type TaskQueryServices = {
  readonly store: TaskQueryStore;
  readonly clock: TaskQueryClock;
};

export const systemTaskQueryClock: TaskQueryClock = {
  today: () => systemTaskClock.today(),
  now: () => new Date().toISOString(),
};

function validationIssues(error: unknown) {
  if (!error || typeof error !== "object" || !("issues" in error)) return undefined;
  const issues = Reflect.get(error, "issues");
  if (!Array.isArray(issues)) return undefined;
  return issues.map((issue) => {
    if (!issue || typeof issue !== "object") return String(issue);
    const issuePath = Reflect.get(issue, "path");
    const issueMessage = Reflect.get(issue, "message");
    const path = Array.isArray(issuePath) ? issuePath.map(String).join(".") : "";
    const message = typeof issueMessage === "string" ? issueMessage : "Invalid value.";
    return path ? `${path}: ${message}` : message;
  });
}

function parseInput<A>(parse: () => A): Effect.Effect<A, InvalidTaskQueryError> {
  return Effect.try({
    try: parse,
    catch: (error) =>
      new InvalidTaskQueryError({
        message: "The task query input is invalid.",
        issues: validationIssues(error),
      }),
  });
}

function evaluationContext(
  services: TaskQueryServices,
  agentCapabilities: readonly string[],
): TaskQueryEvaluationContext {
  return {
    today: services.clock.today(),
    now: services.clock.now(),
    agentCapabilities,
  };
}

export function searchTasks(
  input: unknown,
  agentCapabilities: readonly string[],
  services: TaskQueryServices,
) {
  return Effect.flatMap(
    parseInput(() => compiledSearchTasksInputSchema.parse(input)),
    (parsed) =>
      services.store.search(
        { ...parsed, fields: canonicalizeTaskSearchFields(parsed.fields) },
        evaluationContext(services, agentCapabilities),
      ),
  );
}

/** Shared selection seam used by search today and bulk commands in issue #10. */
export function resolveTaskSelection(
  filter: unknown,
  order: readonly TaskSearchOrder[] | undefined,
  agentCapabilities: readonly string[],
  services: TaskQueryServices,
) {
  return Effect.flatMap(
    parseInput(() =>
      compiledSearchTasksInputSchema.parse({ filter, order, limit: 1, cursor: null }),
    ),
    (parsed) =>
      services.store.resolveSelection(
        parsed.filter,
        parsed.order,
        evaluationContext(services, agentCapabilities),
      ),
  );
}

export function listSavedViews(input: unknown, services: TaskQueryServices) {
  return Effect.flatMap(
    parseInput(() => compiledListSavedViewsInputSchema.parse(input)),
    (parsed) => services.store.listSavedViews(parsed),
  );
}

export function getSavedView(input: unknown, services: TaskQueryServices) {
  return Effect.flatMap(
    parseInput(() => compiledGetSavedViewInputSchema.parse(input)),
    (parsed) => services.store.getSavedView(parsed),
  );
}

export function createSavedView(input: unknown, actor: ActivityActor, services: TaskQueryServices) {
  return Effect.flatMap(
    parseInput(() => compiledCreateSavedViewInputSchema.parse(input)),
    (parsed) => services.store.createSavedView(parsed, actor, services.clock.now()),
  );
}

export function updateSavedView(input: unknown, actor: ActivityActor, services: TaskQueryServices) {
  return Effect.flatMap(
    parseInput(() => compiledUpdateSavedViewInputSchema.parse(input)),
    (parsed) => services.store.updateSavedView(parsed, actor, services.clock.now()),
  );
}

export function archiveSavedView(
  input: unknown,
  actor: ActivityActor,
  services: TaskQueryServices,
) {
  return Effect.flatMap(
    parseInput(() => compiledArchiveSavedViewInputSchema.parse(input)),
    (parsed) => services.store.archiveSavedView(parsed, actor, services.clock.now()),
  );
}

export function restoreSavedView(
  input: unknown,
  actor: ActivityActor,
  services: TaskQueryServices,
) {
  return Effect.flatMap(
    parseInput(() => compiledRestoreSavedViewInputSchema.parse(input)),
    (parsed) => services.store.restoreSavedView(parsed, actor, services.clock.now()),
  );
}
