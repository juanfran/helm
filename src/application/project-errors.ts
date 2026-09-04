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
  readonly changeSummary: string;
  readonly message: string;
}> {}

export class ProjectNotFoundError extends Data.TaggedError("ProjectNotFoundError")<{
  readonly projectId: string;
  readonly message: string;
}> {}

export class ActiveProjectVersionConflictError extends Data.TaggedError(
  "ActiveProjectVersionConflictError",
)<{
  readonly projectId: string;
  readonly expectedVersion: number;
  readonly currentVersion: number;
  readonly changeSummary: string;
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
  | ProjectNotFoundError
  | ActiveProjectVersionConflictError
  | ProjectAuthorizationError
  | ProjectPersistenceError;

export type ProjectErrorDto = {
  type:
    | "InvalidProjectInputError"
    | "InvalidRepositoryRootError"
    | "DuplicateRepositoryRootError"
    | "IdempotencyConflictError"
    | "ProjectVersionConflictError"
    | "ProjectNotFoundError"
    | "ActiveProjectVersionConflictError"
    | "ProjectAuthorizationError"
    | "ProjectPersistenceError";
  message: string;
  projectId?: string;
  expectedVersion?: number;
  currentVersion?: number;
  changeSummary?: string;
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
    case "ProjectNotFoundError":
      return {
        type: error["_tag"],
        message: error.message,
        projectId: error.projectId,
      };
    case "ActiveProjectVersionConflictError":
    case "ProjectVersionConflictError":
      return {
        type: error["_tag"],
        message: error.message,
        projectId: error.projectId,
        expectedVersion: error.expectedVersion,
        currentVersion: error.currentVersion,
        changeSummary: error.changeSummary,
      };
    default:
      return { type: error["_tag"], message: error.message };
  }
}
