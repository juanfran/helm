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

export class TaskIdempotencyConflictError extends Data.TaggedError("TaskIdempotencyConflictError")<{
  readonly key: string;
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
  | TaskIdempotencyConflictError
  | TaskPersistenceError;

export type TaskErrorDto = {
  type: TaskCommandError["_tag"];
  message: string;
  taskId?: string;
  missingFields?: readonly string[];
  expectedVersion?: number;
  currentVersion?: number;
  changeSummary?: string;
};

export function toTaskErrorDto(error: TaskCommandError): TaskErrorDto {
  switch (error["_tag"]) {
    case "TaskNotFoundError":
    case "TaskAlreadyArchivedError":
      return { type: error["_tag"], message: error.message, taskId: error.taskId };
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
    default:
      return { type: error["_tag"], message: error.message };
  }
}
