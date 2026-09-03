import { Data } from "effect";

export type RepositoryRootReason = "missing" | "not-directory" | "not-repository-root";

export class InvalidProjectInputError extends Data.TaggedError("InvalidProjectInputError")<{
  readonly message: string;
}> {}

export class InvalidRepositoryRootError extends Data.TaggedError("InvalidRepositoryRootError")<{
  readonly path: string;
  readonly reason: RepositoryRootReason;
  readonly message: string;
}> {}

export class DuplicateRepositoryRootError extends Data.TaggedError("DuplicateRepositoryRootError")<{
  readonly path: string;
  readonly message: string;
}> {}

export class IdempotencyConflictError extends Data.TaggedError("IdempotencyConflictError")<{
  readonly key: string;
  readonly message: string;
}> {}

export class ProjectPersistenceError extends Data.TaggedError("ProjectPersistenceError")<{
  readonly message: string;
}> {}

export type ProjectCommandError =
  | InvalidProjectInputError
  | InvalidRepositoryRootError
  | DuplicateRepositoryRootError
  | IdempotencyConflictError
  | ProjectPersistenceError;

export type ProjectErrorDto = {
  type:
    | "InvalidProjectInputError"
    | "InvalidRepositoryRootError"
    | "DuplicateRepositoryRootError"
    | "IdempotencyConflictError"
    | "ProjectPersistenceError";
  message: string;
  path?: string;
  reason?: RepositoryRootReason;
};

export function toProjectErrorDto(error: ProjectCommandError): ProjectErrorDto {
  switch (error["_tag"]) {
    case "InvalidRepositoryRootError":
      return {
        type: error["_tag"],
        message: error.message,
        path: error.path,
        reason: error.reason,
      };
    case "DuplicateRepositoryRootError":
      return { type: error["_tag"], message: error.message, path: error.path };
    default:
      return { type: error["_tag"], message: error.message };
  }
}
