import { Effect, Either } from "effect";

import {
  addCustomFieldDefinition,
  clearTagReviewModeOverride,
  reorderCustomFieldDefinitions,
  retireCustomFieldDefinition,
  setTagReviewModeOverride,
  type CustomizationServices,
} from "../application/customizations";
import {
  toCustomizationErrorDto,
  type CustomizationCommandError,
  type CustomizationErrorDto,
} from "../application/customization-errors";
import type { ActivityActor } from "../domain/activity";
import type { ProjectCustomizationSnapshot } from "../domain/customization";

export type CustomizationCommandResponse =
  | { readonly ok: true; readonly customization: ProjectCustomizationSnapshot }
  | { readonly ok: false; readonly error: CustomizationErrorDto };

async function execute(
  effect: Effect.Effect<ProjectCustomizationSnapshot, CustomizationCommandError>,
): Promise<CustomizationCommandResponse> {
  const result = await Effect.runPromise(Effect.either(effect));
  return Either.isRight(result)
    ? { ok: true, customization: result.right }
    : { ok: false, error: toCustomizationErrorDto(result.left) };
}

export function executeAddCustomFieldDefinition(
  input: unknown,
  actor: ActivityActor,
  services: CustomizationServices,
) {
  return execute(addCustomFieldDefinition(input, actor, services));
}

export function executeRetireCustomFieldDefinition(
  input: unknown,
  actor: ActivityActor,
  services: CustomizationServices,
) {
  return execute(retireCustomFieldDefinition(input, actor, services));
}

export function executeReorderCustomFieldDefinitions(
  input: unknown,
  actor: ActivityActor,
  services: CustomizationServices,
) {
  return execute(reorderCustomFieldDefinitions(input, actor, services));
}

export function executeChangeTagReviewModeOverride(
  input: unknown,
  actor: ActivityActor,
  services: CustomizationServices,
) {
  const reviewMode =
    input && typeof input === "object" && "reviewModeOverride" in input
      ? Reflect.get(input, "reviewModeOverride")
      : undefined;
  return execute(
    reviewMode === null
      ? clearTagReviewModeOverride(input, actor, services)
      : setTagReviewModeOverride(input, actor, services),
  );
}
