import { Effect } from "effect";

import type { ActivityActor } from "../domain/activity";
import {
  compiledAddCustomFieldDefinitionInputSchema,
  compiledListProjectCustomizationInputSchema,
  compiledReorderCustomFieldDefinitionsInputSchema,
  compiledRetireCustomFieldDefinitionInputSchema,
  compiledSetTagReviewModeOverrideInputSchema,
  customFieldDefinitionSchema,
  MAX_CUSTOM_FIELD_DEFINITIONS,
  type AddCustomFieldDefinitionInput,
  type CustomFieldDefinition,
  type ListProjectCustomizationInput,
  type ProjectCustomizationSnapshot,
  type ReorderCustomFieldDefinitionsInput,
  type RetireCustomFieldDefinitionInput,
  type SetTagReviewModeOverrideInput,
} from "../domain/customization";
import {
  CustomFieldDefinitionKeyConflictError,
  CustomFieldDefinitionNotFoundError,
  CustomFieldDefinitionOrderError,
  CustomFieldDefinitionStateError,
  CustomizationAuthorizationError,
  CustomizationTagNotFoundError,
  InvalidCustomizationInputError,
  type CustomizationCommandError,
} from "./customization-errors";

export const LOCAL_CUSTOMIZATION_HUMAN = {
  type: "human",
  id: "local-human",
} as const satisfies ActivityActor;
export type LocalCustomizationHuman = typeof LOCAL_CUSTOMIZATION_HUMAN;

export type CustomizationCommand =
  | { readonly type: "add_field_definition"; readonly input: AddCustomFieldDefinitionInput }
  | { readonly type: "retire_field_definition"; readonly input: RetireCustomFieldDefinitionInput }
  | {
      readonly type: "reorder_field_definitions";
      readonly input: ReorderCustomFieldDefinitionsInput;
    }
  | {
      readonly type: "set_tag_review_mode_override";
      readonly input: SetTagReviewModeOverrideInput;
    };

export type CustomizationAggregateState = {
  readonly projectId: string;
  readonly definitions: readonly CustomFieldDefinition[];
  readonly tags: readonly {
    id: string;
    name: string;
    reviewModeOverride: "required" | "direct" | null;
  }[];
};

type CustomizationEventPlan = {
  readonly kind: string;
  readonly entityType: "custom_field_definition" | "project" | "tag";
  readonly entityId: string;
  readonly payload: Readonly<Record<string, unknown>>;
};

export type CustomizationMutationPlan =
  | {
      readonly type: "add_field_definition";
      readonly definition: CustomFieldDefinition;
      readonly event: CustomizationEventPlan;
    }
  | {
      readonly type: "retire_field_definition";
      readonly fieldId: string;
      readonly event: CustomizationEventPlan;
    }
  | {
      readonly type: "reorder_field_definitions";
      readonly positions: readonly { readonly fieldId: string; readonly position: number }[];
      readonly event: CustomizationEventPlan;
    }
  | {
      readonly type: "set_tag_review_mode_override";
      readonly tagId: string;
      readonly reviewModeOverride: "required" | "direct" | null;
      readonly event: CustomizationEventPlan;
    };

export function customizationCommandName(command: CustomizationCommand) {
  switch (command.type) {
    case "add_field_definition":
      return "customization.field.add";
    case "retire_field_definition":
      return "customization.field.retire";
    case "reorder_field_definitions":
      return "customization.fields.reorder";
    case "set_tag_review_mode_override":
      return "customization.tag_review_mode.set";
  }
  const unhandled: never = command;
  throw new Error(`Unsupported customization command: ${String(unhandled)}`);
}

function duplicateValues(values: readonly string[]) {
  const seen = new Set<string>();
  const repeated = new Set<string>();
  for (const value of values) {
    if (seen.has(value)) repeated.add(value);
    seen.add(value);
  }
  return [...repeated].toSorted();
}

/** Plans domain-visible projection and audit changes against one aggregate snapshot. */
export function planCustomizationCommand(
  command: CustomizationCommand,
  state: CustomizationAggregateState,
  now: string,
  newDefinitionId: string,
): CustomizationMutationPlan {
  switch (command.type) {
    case "add_field_definition": {
      const input = command.input;
      if (state.definitions.some((definition) => definition.key === input.definition.key)) {
        throw new CustomFieldDefinitionKeyConflictError({
          projectId: input.projectId,
          fieldKey: input.definition.key,
          message: `Custom field key ${input.definition.key} is already defined in this project.`,
        });
      }
      if (state.definitions.length >= MAX_CUSTOM_FIELD_DEFINITIONS) {
        throw new InvalidCustomizationInputError({
          message: `A project can define at most ${MAX_CUSTOM_FIELD_DEFINITIONS} custom fields.`,
        });
      }
      const definition = customFieldDefinitionSchema.parse({
        ...input.definition,
        id: newDefinitionId,
        projectId: input.projectId,
        position: Math.max(-1, ...state.definitions.map(({ position }) => position)) + 1,
        retiredAt: null,
        createdAt: now,
        updatedAt: now,
      });
      return {
        type: command.type,
        definition,
        event: {
          kind: "customization.field.added",
          entityType: "custom_field_definition",
          entityId: definition.id,
          payload: {
            fieldId: definition.id,
            fieldKey: definition.key,
            fieldType: definition.type,
            definition,
          },
        },
      };
    }
    case "retire_field_definition": {
      const input = command.input;
      const definition = state.definitions.find(({ id }) => id === input.fieldId);
      if (!definition) {
        throw new CustomFieldDefinitionNotFoundError({
          projectId: input.projectId,
          fieldId: input.fieldId,
          message: "That custom-field definition does not exist in this project.",
        });
      }
      if (definition.retiredAt !== null) {
        throw new CustomFieldDefinitionStateError({
          fieldId: definition.id,
          state: "retired",
          message: `Custom field ${definition.key} is already retired.`,
        });
      }
      return {
        type: command.type,
        fieldId: definition.id,
        event: {
          kind: "customization.field.retired",
          entityType: "custom_field_definition",
          entityId: definition.id,
          payload: {
            fieldId: definition.id,
            fieldKey: definition.key,
            reason: input.reason,
          },
        },
      };
    }
    case "reorder_field_definitions": {
      const input = command.input;
      const activeIds = new Set(
        state.definitions.filter(({ retiredAt }) => retiredAt === null).map(({ id }) => id),
      );
      const requestedIds = new Set(input.orderedFieldIds);
      const missingFieldIds = [...activeIds].filter((id) => !requestedIds.has(id)).toSorted();
      const unexpectedFieldIds = [...requestedIds].filter((id) => !activeIds.has(id)).toSorted();
      const duplicateFieldIds = duplicateValues(input.orderedFieldIds);
      if (missingFieldIds.length || unexpectedFieldIds.length || duplicateFieldIds.length) {
        throw new CustomFieldDefinitionOrderError({
          projectId: input.projectId,
          missingFieldIds,
          unexpectedFieldIds,
          duplicateFieldIds,
          message: "The field order must contain every active definition exactly once.",
        });
      }
      const retiredPositions = new Set(
        state.definitions
          .filter(({ retiredAt }) => retiredAt !== null)
          .map(({ position }) => position),
      );
      let nextPosition = 0;
      const positions = input.orderedFieldIds.map((fieldId) => {
        while (retiredPositions.has(nextPosition)) nextPosition += 1;
        const planned = { fieldId, position: nextPosition };
        nextPosition += 1;
        return planned;
      });
      return {
        type: command.type,
        positions,
        event: {
          kind: "customization.fields.reordered",
          entityType: "project",
          entityId: input.projectId,
          payload: { orderedFieldIds: [...input.orderedFieldIds] },
        },
      };
    }
    case "set_tag_review_mode_override": {
      const input = command.input;
      const tag = state.tags.find(({ id }) => id === input.tagId);
      if (!tag) {
        throw new CustomizationTagNotFoundError({
          projectId: input.projectId,
          tagId: input.tagId,
          message: "That tag does not exist in this project.",
        });
      }
      return {
        type: command.type,
        tagId: tag.id,
        reviewModeOverride: input.reviewModeOverride,
        event: {
          kind:
            input.reviewModeOverride === null
              ? "customization.tag_review_mode.cleared"
              : "customization.tag_review_mode.changed",
          entityType: "tag",
          entityId: tag.id,
          payload: {
            tagId: tag.id,
            tagName: tag.name,
            previousReviewModeOverride: tag.reviewModeOverride,
            reviewModeOverride: input.reviewModeOverride,
            reason: input.reason,
          },
        },
      };
    }
  }
  const unhandled: never = command;
  throw new Error(`Unsupported customization command: ${String(unhandled)}`);
}

export interface CustomizationStore {
  list(
    input: ListProjectCustomizationInput,
  ): Effect.Effect<ProjectCustomizationSnapshot, CustomizationCommandError>;
  execute(
    command: CustomizationCommand,
    actor: LocalCustomizationHuman,
    now: string,
  ): Effect.Effect<ProjectCustomizationSnapshot, CustomizationCommandError>;
}

export type CustomizationClock = { now(): string };

export type CustomizationServices = {
  readonly store: CustomizationStore;
  readonly clock: CustomizationClock;
};

export const systemCustomizationClock: CustomizationClock = {
  now: () => new Date().toISOString(),
};

function validationIssues(error: unknown) {
  if (!error || typeof error !== "object" || !("issues" in error)) return undefined;
  const issues = Reflect.get(error, "issues");
  if (!Array.isArray(issues)) return undefined;
  return issues.map((issue) => {
    if (!issue || typeof issue !== "object") return String(issue);
    const issuePath = Reflect.get(issue, "path");
    const issueMessage = Reflect.get(issue, "message");
    const path = Array.isArray(issuePath) ? issuePath.map(String).join(".") : "";
    const message = typeof issueMessage === "string" ? issueMessage : "Invalid value.";
    return path ? `${path}: ${message}` : message;
  });
}

function parseInput<A>(parse: () => A): Effect.Effect<A, InvalidCustomizationInputError> {
  return Effect.try({
    try: parse,
    catch: (error) =>
      new InvalidCustomizationInputError({
        message: "The customization input is invalid.",
        issues: validationIssues(error),
      }),
  });
}

function requireLocalHuman(
  actor: ActivityActor,
): Effect.Effect<typeof LOCAL_CUSTOMIZATION_HUMAN, CustomizationAuthorizationError> {
  return actor.type === LOCAL_CUSTOMIZATION_HUMAN.type && actor.id === LOCAL_CUSTOMIZATION_HUMAN.id
    ? Effect.succeed(LOCAL_CUSTOMIZATION_HUMAN)
    : Effect.fail(
        new CustomizationAuthorizationError({
          message: "Only the local human can change project customization.",
        }),
      );
}

function executeAsLocalHuman(
  parsed: Effect.Effect<CustomizationCommand, InvalidCustomizationInputError>,
  actor: ActivityActor,
  services: CustomizationServices,
) {
  return Effect.flatMap(requireLocalHuman(actor), (human) =>
    Effect.flatMap(parsed, (command) =>
      services.store.execute(command, human, services.clock.now()),
    ),
  );
}

export function listProjectCustomization(input: unknown, services: CustomizationServices) {
  return Effect.flatMap(
    parseInput(() => compiledListProjectCustomizationInputSchema.parse(input)),
    (parsed) => services.store.list(parsed),
  );
}

export function addCustomFieldDefinition(
  input: unknown,
  actor: ActivityActor,
  services: CustomizationServices,
) {
  return executeAsLocalHuman(
    Effect.map(
      parseInput(() => compiledAddCustomFieldDefinitionInputSchema.parse(input)),
      (parsed): CustomizationCommand => ({ type: "add_field_definition", input: parsed }),
    ),
    actor,
    services,
  );
}

export function retireCustomFieldDefinition(
  input: unknown,
  actor: ActivityActor,
  services: CustomizationServices,
) {
  return executeAsLocalHuman(
    Effect.map(
      parseInput(() => compiledRetireCustomFieldDefinitionInputSchema.parse(input)),
      (parsed): CustomizationCommand => ({ type: "retire_field_definition", input: parsed }),
    ),
    actor,
    services,
  );
}

export function reorderCustomFieldDefinitions(
  input: unknown,
  actor: ActivityActor,
  services: CustomizationServices,
) {
  return executeAsLocalHuman(
    Effect.map(
      parseInput(() => compiledReorderCustomFieldDefinitionsInputSchema.parse(input)),
      (parsed): CustomizationCommand => ({ type: "reorder_field_definitions", input: parsed }),
    ),
    actor,
    services,
  );
}

function changeTagReviewModeOverride(
  input: unknown,
  actor: ActivityActor,
  services: CustomizationServices,
  operation: "set" | "clear",
) {
  const parsed = Effect.flatMap(
    parseInput(() => compiledSetTagReviewModeOverrideInputSchema.parse(input)),
    (command) => {
      const isClear = command.reviewModeOverride === null;
      if ((operation === "clear") === isClear) {
        return Effect.succeed({
          type: "set_tag_review_mode_override" as const,
          input: command,
        });
      }
      return Effect.fail(
        new InvalidCustomizationInputError({
          message:
            operation === "clear"
              ? "Clearing a tag review override requires a null review mode."
              : "Setting a tag review override requires an explicit review mode.",
        }),
      );
    },
  );
  return executeAsLocalHuman(parsed, actor, services);
}

export function setTagReviewModeOverride(
  input: unknown,
  actor: ActivityActor,
  services: CustomizationServices,
) {
  return changeTagReviewModeOverride(input, actor, services, "set");
}

export function clearTagReviewModeOverride(
  input: unknown,
  actor: ActivityActor,
  services: CustomizationServices,
) {
  return changeTagReviewModeOverride(input, actor, services, "clear");
}
