import { Data } from "effect";

import type { BulkTaskValidationFailure } from "../domain/bulk-tasks";

export class InvalidBulkTaskInputError extends Data.TaggedError("InvalidBulkTaskInputError")<{
  readonly message: string;
  readonly issues?: readonly string[];
}> {}

export class BulkTaskPreviewValidationError extends Data.TaggedError(
  "BulkTaskPreviewValidationError",
)<{
  readonly message: string;
  readonly failures: readonly BulkTaskValidationFailure[];
}> {}

export class BulkTaskPreviewMismatchError extends Data.TaggedError("BulkTaskPreviewMismatchError")<{
  readonly reason: "intent_changed" | "actor_changed";
  readonly message: string;
}> {}

export class BulkTaskPreviewStaleError extends Data.TaggedError("BulkTaskPreviewStaleError")<{
  readonly reason:
    | "target_set_changed"
    | "target_version_changed"
    | "evaluation_context_changed"
    | "tag_definition_changed"
    | "sequence_changed"
    | "state_changed";
  readonly taskIds?: readonly string[];
  readonly message: string;
}> {}

export class BulkTaskIdempotencyConflictError extends Data.TaggedError(
  "BulkTaskIdempotencyConflictError",
)<{
  readonly key: string;
  readonly message: string;
}> {}

export class BulkTaskPersistenceError extends Data.TaggedError("BulkTaskPersistenceError")<{
  readonly message: string;
  readonly correlationId: string;
}> {}

export type BulkTaskCommandError =
  | InvalidBulkTaskInputError
  | BulkTaskPreviewValidationError
  | BulkTaskPreviewMismatchError
  | BulkTaskPreviewStaleError
  | BulkTaskIdempotencyConflictError
  | BulkTaskPersistenceError;

export type BulkTaskErrorDto = {
  readonly type: BulkTaskCommandError["_tag"];
  readonly message: string;
  readonly issues?: readonly string[];
  readonly failures?: readonly BulkTaskValidationFailure[];
  readonly reason?: BulkTaskPreviewMismatchError["reason"] | BulkTaskPreviewStaleError["reason"];
  readonly taskIds?: readonly string[];
  readonly key?: string;
  readonly correlationId?: string;
};

export function toBulkTaskErrorDto(error: BulkTaskCommandError): BulkTaskErrorDto {
  switch (error["_tag"]) {
    case "InvalidBulkTaskInputError":
      return {
        type: error["_tag"],
        message: error.message,
        issues: error.issues,
      };
    case "BulkTaskPreviewValidationError":
      return {
        type: error["_tag"],
        message: error.message,
        failures: error.failures,
      };
    case "BulkTaskPreviewMismatchError":
      return {
        type: error["_tag"],
        message: error.message,
        reason: error.reason,
      };
    case "BulkTaskPreviewStaleError":
      return {
        type: error["_tag"],
        message: error.message,
        reason: error.reason,
        taskIds: error.taskIds,
      };
    case "BulkTaskIdempotencyConflictError":
      return {
        type: error["_tag"],
        message: error.message,
        key: error.key,
      };
    case "BulkTaskPersistenceError":
      return {
        type: error["_tag"],
        message: error.message,
        correlationId: error.correlationId,
      };
  }
  const unhandled: never = error;
  throw new Error(`Unsupported bulk task error: ${String(unhandled)}`);
}
