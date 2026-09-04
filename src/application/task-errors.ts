import { Data } from "effect";

export class InvalidTaskInputError extends Data.TaggedError("InvalidTaskInputError")<{
  readonly message: string;
}> {}

export class TaskNotFoundError extends Data.TaggedError("TaskNotFoundError")<{
  readonly taskId: string;
  readonly message: string;
}> {}

export class TaskPreparationError extends Data.TaggedError("TaskPreparationError")<{
  readonly missingFields: readonly string[];
  readonly message: string;
}> {}

export class TaskVersionConflictError extends Data.TaggedError("TaskVersionConflictError")<{
  readonly taskId: string;
  readonly expectedVersion: number;
  readonly currentVersion: number;
  readonly changeSummary: string;
  readonly message: string;
}> {}

export class TaskAlreadyArchivedError extends Data.TaggedError("TaskAlreadyArchivedError")<{
  readonly taskId: string;
  readonly message: string;
}> {}

export class TaskLifecycleError extends Data.TaggedError("TaskLifecycleError")<{
  readonly taskId: string;
  readonly lifecycle: string;
  readonly message: string;
}> {}

export class TaskNestingError extends Data.TaggedError("TaskNestingError")<{
  readonly taskId: string;
  readonly parentTaskId?: string;
  readonly message: string;
}> {}

export class TaskRelationError extends Data.TaggedError("TaskRelationError")<{
  readonly sourceTaskId: string;
  readonly targetTaskId: string;
  readonly relationPath: readonly string[];
  readonly message: string;
}> {}

export class TaskIdempotencyConflictError extends Data.TaggedError("TaskIdempotencyConflictError")<{
  readonly key: string;
  readonly message: string;
}> {}

export class TaskTagConstraintError extends Data.TaggedError("TaskTagConstraintError")<{
  readonly group: string;
  readonly tagNames: readonly string[];
  readonly message: string;
}> {}

export class TaskTagDefinitionConflictError extends Data.TaggedError(
  "TaskTagDefinitionConflictError",
)<{
  readonly tagName: string;
  readonly message: string;
}> {}

export class TaskPathError extends Data.TaggedError("TaskPathError")<{
  readonly path: string;
  readonly message: string;
}> {}

export class TaskDiscoveryCursorStaleError extends Data.TaggedError(
  "TaskDiscoveryCursorStaleError",
)<{
  readonly cursorRevision: number;
  readonly currentRevision: number;
  readonly staleBecause: "queue_changed" | "evaluation_context_changed";
  readonly message: string;
}> {}

export class TaskClaimUnavailableError extends Data.TaggedError("TaskClaimUnavailableError")<{
  readonly taskId?: string;
  readonly eligibilityStatus?: string;
  readonly reasons: readonly string[];
  readonly message: string;
}> {}

export class TaskLeaseError extends Data.TaggedError("TaskLeaseError")<{
  readonly taskId?: string;
  readonly leaseId?: string;
  readonly reason:
    | "not_found"
    | "required"
    | "expired"
    | "inactive"
    | "owner_mismatch"
    | "inactive_run";
  readonly message: string;
}> {}

export class TaskPersistenceError extends Data.TaggedError("TaskPersistenceError")<{
  readonly message: string;
}> {}

export type TaskCommandError =
  | InvalidTaskInputError
  | TaskNotFoundError
  | TaskPreparationError
  | TaskVersionConflictError
  | TaskAlreadyArchivedError
  | TaskLifecycleError
  | TaskNestingError
  | TaskRelationError
  | TaskIdempotencyConflictError
  | TaskTagConstraintError
  | TaskTagDefinitionConflictError
  | TaskPathError
  | TaskDiscoveryCursorStaleError
  | TaskClaimUnavailableError
  | TaskLeaseError
  | TaskPersistenceError;

export type TaskErrorDto = {
  type: TaskCommandError["_tag"];
  message: string;
  taskId?: string;
  missingFields?: readonly string[];
  expectedVersion?: number;
  currentVersion?: number;
  changeSummary?: string;
  group?: string;
  tagNames?: readonly string[];
  tagName?: string;
  key?: string;
  path?: string;
  cursorRevision?: number;
  currentRevision?: number;
  staleBecause?: "queue_changed" | "evaluation_context_changed";
  lifecycle?: string;
  parentTaskId?: string;
  sourceTaskId?: string;
  targetTaskId?: string;
  relationPath?: readonly string[];
  eligibilityStatus?: string;
  reasons?: readonly string[];
  leaseId?: string;
  leaseReason?: TaskLeaseError["reason"];
};

export function toTaskErrorDto(error: TaskCommandError): TaskErrorDto {
  switch (error["_tag"]) {
    case "TaskNotFoundError":
    case "TaskAlreadyArchivedError":
      return { type: error["_tag"], message: error.message, taskId: error.taskId };
    case "TaskLifecycleError":
      return {
        type: error["_tag"],
        message: error.message,
        taskId: error.taskId,
        lifecycle: error.lifecycle,
      };
    case "TaskNestingError":
      return {
        type: error["_tag"],
        message: error.message,
        taskId: error.taskId,
        parentTaskId: error.parentTaskId,
      };
    case "TaskRelationError":
      return {
        type: error["_tag"],
        message: error.message,
        sourceTaskId: error.sourceTaskId,
        targetTaskId: error.targetTaskId,
        relationPath: error.relationPath,
      };
    case "TaskPreparationError":
      return { type: error["_tag"], message: error.message, missingFields: error.missingFields };
    case "TaskVersionConflictError":
      return {
        type: error["_tag"],
        message: error.message,
        taskId: error.taskId,
        expectedVersion: error.expectedVersion,
        currentVersion: error.currentVersion,
        changeSummary: error.changeSummary,
      };
    case "TaskTagConstraintError":
      return {
        type: error["_tag"],
        message: error.message,
        group: error.group,
        tagNames: error.tagNames,
      };
    case "TaskTagDefinitionConflictError":
      return {
        type: error["_tag"],
        message: error.message,
        tagName: error.tagName,
      };
    case "TaskPathError":
      return { type: error["_tag"], message: error.message, path: error.path };
    case "TaskIdempotencyConflictError":
      return { type: error["_tag"], message: error.message, key: error.key };
    case "TaskDiscoveryCursorStaleError":
      return {
        type: error["_tag"],
        message: error.message,
        cursorRevision: error.cursorRevision,
        currentRevision: error.currentRevision,
        staleBecause: error.staleBecause,
      };
    case "TaskClaimUnavailableError":
      return {
        type: error["_tag"],
        message: error.message,
        taskId: error.taskId,
        eligibilityStatus: error.eligibilityStatus,
        reasons: error.reasons,
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
