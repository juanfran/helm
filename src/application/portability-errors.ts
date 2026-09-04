import { Data } from "effect";

export type PortabilityConflict = {
  readonly code:
    | "active_execution_conflict"
    | "duplicate_identity"
    | "immutable_mismatch"
    | "invalid_path"
    | "missing_dependency"
    | "profile_key_conflict"
    | "repository_conflict"
    | "sequence_conflict"
    | "version_conflict";
  readonly entityType: string;
  readonly sourceId?: string;
  readonly rowNumber?: number;
  readonly message: string;
};

export class InvalidPortabilityInputError extends Data.TaggedError("InvalidPortabilityInputError")<{
  readonly message: string;
  readonly issues?: readonly string[];
}> {}

export class UnsupportedPortabilityVersionError extends Data.TaggedError(
  "UnsupportedPortabilityVersionError",
)<{
  readonly receivedVersion: unknown;
  readonly message: string;
}> {}

export class PortabilityNotFoundError extends Data.TaggedError("PortabilityNotFoundError")<{
  readonly entityType: "project" | "saved_view";
  readonly entityId: string;
  readonly message: string;
}> {}

export class PortabilityConflictError extends Data.TaggedError("PortabilityConflictError")<{
  readonly conflicts: readonly PortabilityConflict[];
  readonly message: string;
}> {}

export class PortabilityPreviewStaleError extends Data.TaggedError("PortabilityPreviewStaleError")<{
  readonly message: string;
}> {}

export class PortabilityAuthorizationError extends Data.TaggedError(
  "PortabilityAuthorizationError",
)<{
  readonly message: string;
}> {}

export class PortabilityIdempotencyConflictError extends Data.TaggedError(
  "PortabilityIdempotencyConflictError",
)<{
  readonly key: string;
  readonly message: string;
}> {}

export class PortabilityPersistenceError extends Data.TaggedError("PortabilityPersistenceError")<{
  readonly correlationId: string;
  readonly message: string;
}> {}

export type PortabilityError =
  | InvalidPortabilityInputError
  | UnsupportedPortabilityVersionError
  | PortabilityNotFoundError
  | PortabilityConflictError
  | PortabilityPreviewStaleError
  | PortabilityAuthorizationError
  | PortabilityIdempotencyConflictError
  | PortabilityPersistenceError;

export type PortabilityErrorDto = {
  readonly type: PortabilityError["_tag"];
  readonly message: string;
  readonly issues?: readonly string[];
  readonly receivedVersion?: string | number | boolean | null;
  readonly entityType?: "project" | "saved_view";
  readonly entityId?: string;
  readonly conflicts?: readonly PortabilityConflict[];
  readonly key?: string;
  readonly correlationId?: string;
};

function serializableVersion(value: unknown): string | number | boolean | null {
  if (
    value === null ||
    typeof value === "string" ||
    typeof value === "number" ||
    typeof value === "boolean"
  ) {
    return value;
  }
  try {
    return JSON.stringify(value) ?? "unsupported";
  } catch {
    return "unserializable";
  }
}

export function toPortabilityErrorDto(error: PortabilityError): PortabilityErrorDto {
  switch (error["_tag"]) {
    case "InvalidPortabilityInputError":
      return {
        type: error["_tag"],
        message: error.message,
        issues: error.issues,
      };
    case "UnsupportedPortabilityVersionError":
      return {
        type: error["_tag"],
        message: error.message,
        receivedVersion: serializableVersion(error.receivedVersion),
      };
    case "PortabilityNotFoundError":
      return {
        type: error["_tag"],
        message: error.message,
        entityType: error.entityType,
        entityId: error.entityId,
      };
    case "PortabilityConflictError":
      return {
        type: error["_tag"],
        message: error.message,
        conflicts: error.conflicts,
      };
    case "PortabilityPreviewStaleError":
    case "PortabilityAuthorizationError":
      return { type: error["_tag"], message: error.message };
    case "PortabilityIdempotencyConflictError":
      return { type: error["_tag"], message: error.message, key: error.key };
    case "PortabilityPersistenceError":
      return {
        type: error["_tag"],
        message: error.message,
        correlationId: error.correlationId,
      };
  }
  const unhandled: never = error;
  throw new Error(`Unsupported portability error: ${String(unhandled)}`);
}
