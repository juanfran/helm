import { Effect } from "effect";

import {
  canonicalizeBulkTaskIntent,
  compiledBulkTaskIntentSchema,
  compiledExecuteBulkTasksInputSchema,
  type BulkTaskExecutionResult,
  type BulkTaskIntent,
  type BulkTaskPreview,
  type ExecuteBulkTasksInput,
} from "../domain/bulk-tasks";
import { stableCanonicalJson } from "../domain/task-filters";
import { normalizeCapabilities, type Actor } from "../domain/tasks";
import {
  BulkTaskPreviewMismatchError,
  BulkTaskPreviewStaleError,
  BulkTaskPreviewValidationError,
  InvalidBulkTaskInputError,
  type BulkTaskCommandError,
} from "./bulk-task-errors";

export const BULK_TASK_EXECUTE_COMMAND = "task.bulk.execute";

export type BulkTaskEvaluationContext = {
  readonly today: string;
  readonly now: string;
  readonly agentCapabilities: readonly string[];
};

export interface BulkTaskStore {
  preview(
    intent: BulkTaskIntent,
    actor: Actor,
    context: BulkTaskEvaluationContext,
  ): Effect.Effect<BulkTaskPreview, BulkTaskCommandError>;
  execute(
    input: ExecuteBulkTasksInput,
    actor: Actor,
    context: BulkTaskEvaluationContext,
  ): Effect.Effect<BulkTaskExecutionResult, BulkTaskCommandError>;
}

export type BulkTaskClock = {
  today(): string;
  now(): string;
};

export type BulkTaskServices = {
  readonly store: BulkTaskStore;
  readonly clock: BulkTaskClock;
};

export const systemBulkTaskClock: BulkTaskClock = {
  today() {
    const date = new Date();
    const year = String(date.getFullYear()).padStart(4, "0");
    const month = String(date.getMonth() + 1).padStart(2, "0");
    const day = String(date.getDate()).padStart(2, "0");
    return `${year}-${month}-${day}`;
  },
  now: () => new Date().toISOString(),
};

export function canonicalBulkTaskIdempotencyJson(input: ExecuteBulkTasksInput, actor: Actor) {
  return stableCanonicalJson({
    command: BULK_TASK_EXECUTE_COMMAND,
    intent: canonicalizeBulkTaskIntent(input.intent),
    previewToken: input.previewToken,
    actor,
  });
}

export function assertBulkTaskExecutionMatchesPreview(
  input: ExecuteBulkTasksInput,
  currentPreview: BulkTaskPreview,
) {
  const [, providedIntentHash] = input.previewToken.split(":");
  const [, currentIntentHash] = currentPreview.previewToken.split(":");
  if (providedIntentHash !== currentIntentHash) {
    throw new BulkTaskPreviewMismatchError({
      reason: "intent_changed",
      message: "The bulk operation differs from the previewed intent.",
    });
  }
  if (input.previewToken !== currentPreview.previewToken) {
    throw new BulkTaskPreviewStaleError({
      reason: "state_changed",
      message: "The selected tasks or relevant project state changed after preview.",
    });
  }
  if (!currentPreview.executable) {
    throw new BulkTaskPreviewValidationError({
      message: "The bulk preview contains validation failures.",
      failures: [
        ...currentPreview.failures,
        ...currentPreview.targets.flatMap(({ failures }) => failures),
      ],
    });
  }
}

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

function parseInput<A>(parse: () => A): Effect.Effect<A, InvalidBulkTaskInputError> {
  return Effect.try({
    try: parse,
    catch: (error) =>
      new InvalidBulkTaskInputError({
        message: "The bulk task command input is invalid.",
        issues: validationIssues(error),
      }),
  });
}

function evaluationContext(
  services: BulkTaskServices,
  agentCapabilities: readonly string[],
): BulkTaskEvaluationContext {
  return {
    today: services.clock.today(),
    now: services.clock.now(),
    agentCapabilities: normalizeCapabilities(agentCapabilities),
  };
}

export function previewBulkTasks(
  input: unknown,
  actor: Actor,
  services: BulkTaskServices,
  agentCapabilities: readonly string[] = [],
) {
  return Effect.flatMap(
    parseInput(() => canonicalizeBulkTaskIntent(compiledBulkTaskIntentSchema.parse(input))),
    (intent) =>
      services.store.preview(intent, actor, evaluationContext(services, agentCapabilities)),
  );
}

export function executeBulkTasks(
  input: unknown,
  actor: Actor,
  services: BulkTaskServices,
  agentCapabilities: readonly string[] = [],
) {
  return Effect.flatMap(
    parseInput(() => {
      const parsed = compiledExecuteBulkTasksInputSchema.parse(input);
      return {
        ...parsed,
        intent: canonicalizeBulkTaskIntent(parsed.intent),
      } satisfies ExecuteBulkTasksInput;
    }),
    (command) =>
      services.store.execute(command, actor, evaluationContext(services, agentCapabilities)),
  );
}
