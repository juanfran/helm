import { Data } from "effect";

export class InvalidCustomizationInputError extends Data.TaggedError(
  "InvalidCustomizationInputError",
)<{
  readonly message: string;
  readonly issues?: readonly string[];
}> {}

export class CustomizationAuthorizationError extends Data.TaggedError(
  "CustomizationAuthorizationError",
)<{
  readonly message: string;
}> {}

export class CustomizationProjectNotFoundError extends Data.TaggedError(
  "CustomizationProjectNotFoundError",
)<{
  readonly projectId: string;
  readonly message: string;
}> {}

export class CustomizationVersionConflictError extends Data.TaggedError(
  "CustomizationVersionConflictError",
)<{
  readonly projectId: string;
  readonly expectedVersion: number;
  readonly currentVersion: number;
  readonly changeSummary: string;
  readonly message: string;
}> {}

export class CustomFieldDefinitionNotFoundError extends Data.TaggedError(
  "CustomFieldDefinitionNotFoundError",
)<{
  readonly projectId: string;
  readonly fieldId: string;
  readonly message: string;
}> {}

export class CustomFieldDefinitionStateError extends Data.TaggedError(
  "CustomFieldDefinitionStateError",
)<{
  readonly fieldId: string;
  readonly state: "retired";
  readonly message: string;
}> {}

export class CustomFieldDefinitionKeyConflictError extends Data.TaggedError(
  "CustomFieldDefinitionKeyConflictError",
)<{
  readonly projectId: string;
  readonly fieldKey: string;
  readonly message: string;
}> {}

export class CustomFieldDefinitionOrderError extends Data.TaggedError(
  "CustomFieldDefinitionOrderError",
)<{
  readonly projectId: string;
  readonly missingFieldIds: readonly string[];
  readonly unexpectedFieldIds: readonly string[];
  readonly duplicateFieldIds: readonly string[];
  readonly message: string;
}> {}

export class CustomizationTagNotFoundError extends Data.TaggedError(
  "CustomizationTagNotFoundError",
)<{
  readonly projectId: string;
  readonly tagId: string;
  readonly message: string;
}> {}

export class CustomizationIdempotencyConflictError extends Data.TaggedError(
  "CustomizationIdempotencyConflictError",
)<{
  readonly key: string;
  readonly message: string;
}> {}

export class CustomizationPersistenceError extends Data.TaggedError(
  "CustomizationPersistenceError",
)<{
  readonly message: string;
  readonly correlationId: string;
}> {}

export type CustomizationCommandError =
  | InvalidCustomizationInputError
  | CustomizationAuthorizationError
  | CustomizationProjectNotFoundError
  | CustomizationVersionConflictError
  | CustomFieldDefinitionNotFoundError
  | CustomFieldDefinitionStateError
  | CustomFieldDefinitionKeyConflictError
  | CustomFieldDefinitionOrderError
  | CustomizationTagNotFoundError
  | CustomizationIdempotencyConflictError
  | CustomizationPersistenceError;

export type CustomizationErrorDto = {
  readonly type: CustomizationCommandError["_tag"];
  readonly message: string;
  readonly issues?: readonly string[];
  readonly projectId?: string;
  readonly fieldId?: string;
  readonly fieldKey?: string;
  readonly tagId?: string;
  readonly state?: CustomFieldDefinitionStateError["state"];
  readonly expectedVersion?: number;
  readonly currentVersion?: number;
  readonly changeSummary?: string;
  readonly missingFieldIds?: readonly string[];
  readonly unexpectedFieldIds?: readonly string[];
  readonly duplicateFieldIds?: readonly string[];
  readonly key?: string;
  readonly correlationId?: string;
};

export function toCustomizationErrorDto(error: CustomizationCommandError): CustomizationErrorDto {
  switch (error["_tag"]) {
    case "InvalidCustomizationInputError":
      return { type: error["_tag"], message: error.message, issues: error.issues };
    case "CustomizationAuthorizationError":
      return { type: error["_tag"], message: error.message };
    case "CustomizationProjectNotFoundError":
      return {
        type: error["_tag"],
        message: error.message,
        projectId: error.projectId,
      };
    case "CustomizationVersionConflictError":
      return {
        type: error["_tag"],
        message: error.message,
        projectId: error.projectId,
        expectedVersion: error.expectedVersion,
        currentVersion: error.currentVersion,
        changeSummary: error.changeSummary,
      };
    case "CustomFieldDefinitionNotFoundError":
      return {
        type: error["_tag"],
        message: error.message,
        projectId: error.projectId,
        fieldId: error.fieldId,
      };
    case "CustomFieldDefinitionStateError":
      return {
        type: error["_tag"],
        message: error.message,
        fieldId: error.fieldId,
        state: error.state,
      };
    case "CustomFieldDefinitionKeyConflictError":
      return {
        type: error["_tag"],
        message: error.message,
        projectId: error.projectId,
        fieldKey: error.fieldKey,
      };
    case "CustomFieldDefinitionOrderError":
      return {
        type: error["_tag"],
        message: error.message,
        projectId: error.projectId,
        missingFieldIds: error.missingFieldIds,
        unexpectedFieldIds: error.unexpectedFieldIds,
        duplicateFieldIds: error.duplicateFieldIds,
      };
    case "CustomizationTagNotFoundError":
      return {
        type: error["_tag"],
        message: error.message,
        projectId: error.projectId,
        tagId: error.tagId,
      };
    case "CustomizationIdempotencyConflictError":
      return { type: error["_tag"], message: error.message, key: error.key };
    case "CustomizationPersistenceError":
      return {
        type: error["_tag"],
        message: error.message,
        correlationId: error.correlationId,
      };
  }
  const unhandled: never = error;
  throw new Error(`Unsupported customization error: ${String(unhandled)}`);
}
