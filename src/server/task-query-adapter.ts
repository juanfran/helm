import { Effect, Either } from "effect";

import {
  archiveSavedView,
  createSavedView,
  restoreSavedView,
  updateSavedView,
  type TaskQueryServices,
} from "../application/task-queries";
import { toTaskQueryErrorDto, type TaskQueryErrorDto } from "../application/task-query-errors";
import type { ActivityActor } from "../domain/activity";
import type { SavedView } from "../domain/saved-views";

export type SavedViewCommandResponse =
  | { readonly ok: true; readonly view: SavedView }
  | { readonly ok: false; readonly error: TaskQueryErrorDto };

async function execute(
  operation: Effect.Effect<SavedView, Parameters<typeof toTaskQueryErrorDto>[0]>,
): Promise<SavedViewCommandResponse> {
  const result = await Effect.runPromise(Effect.either(operation));
  return Either.isRight(result)
    ? { ok: true, view: result.right }
    : { ok: false, error: toTaskQueryErrorDto(result.left) };
}

export function executeCreateSavedView(
  input: unknown,
  actor: ActivityActor,
  services: TaskQueryServices,
) {
  return execute(createSavedView(input, actor, services));
}

export function executeUpdateSavedView(
  input: unknown,
  actor: ActivityActor,
  services: TaskQueryServices,
) {
  return execute(updateSavedView(input, actor, services));
}

export function executeArchiveSavedView(
  input: unknown,
  actor: ActivityActor,
  services: TaskQueryServices,
) {
  return execute(archiveSavedView(input, actor, services));
}

export function executeRestoreSavedView(
  input: unknown,
  actor: ActivityActor,
  services: TaskQueryServices,
) {
  return execute(restoreSavedView(input, actor, services));
}
