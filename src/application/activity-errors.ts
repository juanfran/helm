import { Data } from "effect";

import type { TaskLeaseError, TaskNotFoundError, TaskVersionConflictError } from "./task-errors";

export class InvalidActivityInputError extends Data.TaggedError("InvalidActivityInputError")<{
  readonly message: string;
}> {}

export class ActivityEntryNotFoundError extends Data.TaggedError("ActivityEntryNotFoundError")<{
  readonly entryId: string;
  readonly message: string;
}> {}

export class ActivityEntryWithdrawnError extends Data.TaggedError("ActivityEntryWithdrawnError")<{
  readonly entryId: string;
  readonly message: string;
}> {}

export class ActivityAttributionError extends Data.TaggedError("ActivityAttributionError")<{
  readonly message: string;
}> {}

export class ActivityIdempotencyConflictError extends Data.TaggedError(
  "ActivityIdempotencyConflictError",
)<{
  readonly key: string;
  readonly message: string;
}> {}

export class ManualBlockerNotFoundError extends Data.TaggedError("ManualBlockerNotFoundError")<{
  readonly blockerId: string;
  readonly message: string;
}> {}

export class ManualBlockerStateError extends Data.TaggedError("ManualBlockerStateError")<{
  readonly blockerId: string;
  readonly status: string;
  readonly message: string;
}> {}

export class ActivityPersistenceError extends Data.TaggedError("ActivityPersistenceError")<{
  readonly message: string;
}> {}

export type ActivityCommandError =
  | InvalidActivityInputError
  | ActivityEntryNotFoundError
  | ActivityEntryWithdrawnError
  | ActivityAttributionError
  | ActivityIdempotencyConflictError
  | ManualBlockerNotFoundError
  | ManualBlockerStateError
  | TaskNotFoundError
  | TaskVersionConflictError
  | TaskLeaseError
  | ActivityPersistenceError;

export type ActivityErrorDto = {
  type: ActivityCommandError["_tag"];
  message: string;
  entryId?: string;
  blockerId?: string;
  taskId?: string;
  leaseId?: string;
  expectedVersion?: number;
  currentVersion?: number;
  changeSummary?: string;
  status?: string;
  key?: string;
  leaseReason?: TaskLeaseError["reason"];
};

export function toActivityErrorDto(error: ActivityCommandError): ActivityErrorDto {
  switch (error["_tag"]) {
    case "ActivityEntryNotFoundError":
    case "ActivityEntryWithdrawnError":
      return { type: error["_tag"], message: error.message, entryId: error.entryId };
    case "ActivityIdempotencyConflictError":
      return { type: error["_tag"], message: error.message, key: error.key };
    case "ManualBlockerNotFoundError":
      return { type: error["_tag"], message: error.message, blockerId: error.blockerId };
    case "ManualBlockerStateError":
      return {
        type: error["_tag"],
        message: error.message,
        blockerId: error.blockerId,
        status: error.status,
      };
    case "TaskNotFoundError":
      return { type: error["_tag"], message: error.message, taskId: error.taskId };
    case "TaskVersionConflictError":
      return {
        type: error["_tag"],
        message: error.message,
        taskId: error.taskId,
        expectedVersion: error.expectedVersion,
        currentVersion: error.currentVersion,
        changeSummary: error.changeSummary,
      };
    case "TaskLeaseError":
      return {
        type: error["_tag"],
        message: error.message,
        taskId: error.taskId,
        leaseId: error.leaseId,
        leaseReason: error.reason,
      };
    default:
      return { type: error["_tag"], message: error.message };
  }
}
