import { Effect, Either } from "effect";

import {
  executeProjectImport,
  previewProjectImport,
  type PortabilityServices,
} from "../application/portability";
import { toPortabilityErrorDto, type PortabilityErrorDto } from "../application/portability-errors";
import type { ProjectImportExecutionResult, ProjectImportPreview } from "../domain/portability";
import type { Actor } from "../domain/tasks";

export type ProjectImportPreviewResponse =
  | { readonly ok: true; readonly preview: ProjectImportPreview }
  | { readonly ok: false; readonly error: PortabilityErrorDto };

export type ProjectImportExecutionResponse =
  | { readonly ok: true; readonly result: ProjectImportExecutionResult }
  | { readonly ok: false; readonly error: PortabilityErrorDto };

export async function executePreviewProjectImport(
  data: unknown,
  actor: Actor,
  services: PortabilityServices,
): Promise<ProjectImportPreviewResponse> {
  const result = await Effect.runPromise(
    Effect.either(previewProjectImport(data, actor, services)),
  );
  return Either.isRight(result)
    ? { ok: true, preview: result.right }
    : { ok: false, error: toPortabilityErrorDto(result.left) };
}

export async function executePortableProjectImport(
  data: unknown,
  actor: Actor,
  services: PortabilityServices,
): Promise<ProjectImportExecutionResponse> {
  const result = await Effect.runPromise(
    Effect.either(executeProjectImport(data, actor, services)),
  );
  return Either.isRight(result)
    ? { ok: true, result: result.right }
    : { ok: false, error: toPortabilityErrorDto(result.left) };
}
