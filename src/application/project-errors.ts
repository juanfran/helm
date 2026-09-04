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

export class ProjectVersionConflictError extends Data.TaggedError("ProjectVersionConflictError")<{
  readonly projectId: string;
  readonly expectedVersion: number;
  readonly currentVersion: number;
  readonly message: string;
}> {}

export class ProjectAuthorizationError extends Data.TaggedError("ProjectAuthorizationError")<{
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
  | ProjectVersionConflictError
  | ProjectAuthorizationError
  | ProjectPersistenceError;

export type ProjectErrorDto = {
  type:
    | "InvalidProjectInputError"
    | "InvalidRepositoryRootError"
    | "DuplicateRepositoryRootError"
    | "IdempotencyConflictError"
    | "ProjectVersionConflictError"
    | "ProjectAuthorizationError"
    | "ProjectPersistenceError";
  message: string;
  projectId?: string;
  expectedVersion?: number;
  currentVersion?: number;
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
    case "ProjectVersionConflictError":
      return {
        type: error["_tag"],
        message: error.message,
        projectId: error.projectId,
        expectedVersion: error.expectedVersion,
        currentVersion: error.currentVersion,
      };
    default:
      return { type: error["_tag"], message: error.message };
  }
}
