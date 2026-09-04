import { Data } from "effect";

export class InvalidTaskQueryError extends Data.TaggedError("InvalidTaskQueryError")<{
  readonly message: string;
  readonly issues?: readonly string[];
}> {}

export class TaskQueryCursorError extends Data.TaggedError("TaskQueryCursorError")<{
  readonly reason: "malformed" | "stale" | "query_mismatch" | "evaluation_context_changed";
  readonly message: string;
  readonly cursorRevision?: number;
  readonly currentRevision?: number;
}> {}

export class SavedViewNotFoundError extends Data.TaggedError("SavedViewNotFoundError")<{
  readonly savedViewId: string;
  readonly message: string;
}> {}

export class SavedViewVersionConflictError extends Data.TaggedError(
  "SavedViewVersionConflictError",
)<{
  readonly savedViewId: string;
  readonly expectedVersion: number;
  readonly currentVersion: number;
  readonly message: string;
}> {}

export class SavedViewNameConflictError extends Data.TaggedError("SavedViewNameConflictError")<{
  readonly projectId: string;
  readonly name: string;
  readonly message: string;
}> {}

export class SavedViewIdempotencyConflictError extends Data.TaggedError(
  "SavedViewIdempotencyConflictError",
)<{
  readonly key: string;
  readonly message: string;
}> {}

export class TaskQueryPersistenceError extends Data.TaggedError("TaskQueryPersistenceError")<{
  readonly message: string;
}> {}

export type TaskQueryError =
  | InvalidTaskQueryError
  | TaskQueryCursorError
  | SavedViewNotFoundError
  | SavedViewVersionConflictError
  | SavedViewNameConflictError
  | SavedViewIdempotencyConflictError
  | TaskQueryPersistenceError;

export type TaskQueryErrorDto = {
  readonly type: TaskQueryError["_tag"];
  readonly message: string;
  readonly issues?: readonly string[];
  readonly reason?: TaskQueryCursorError["reason"];
  readonly cursorRevision?: number;
  readonly currentRevision?: number;
  readonly savedViewId?: string;
  readonly expectedVersion?: number;
  readonly currentVersion?: number;
  readonly projectId?: string;
  readonly name?: string;
  readonly key?: string;
};

export function toTaskQueryErrorDto(error: TaskQueryError): TaskQueryErrorDto {
  switch (error["_tag"]) {
    case "InvalidTaskQueryError":
      return { type: error["_tag"], message: error.message, issues: error.issues };
    case "TaskQueryCursorError":
      return {
        type: error["_tag"],
        message: error.message,
        reason: error.reason,
        cursorRevision: error.cursorRevision,
        currentRevision: error.currentRevision,
      };
    case "SavedViewNotFoundError":
      return {
        type: error["_tag"],
        message: error.message,
        savedViewId: error.savedViewId,
      };
    case "SavedViewVersionConflictError":
      return {
        type: error["_tag"],
        message: error.message,
        savedViewId: error.savedViewId,
        expectedVersion: error.expectedVersion,
        currentVersion: error.currentVersion,
      };
    case "SavedViewNameConflictError":
      return {
        type: error["_tag"],
        message: error.message,
        projectId: error.projectId,
        name: error.name,
      };
    case "SavedViewIdempotencyConflictError":
      return { type: error["_tag"], message: error.message, key: error.key };
    default:
      return { type: error["_tag"], message: error.message };
  }
}
