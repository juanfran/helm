import { Effect, Either } from "effect";

import { createProject, setTheme, type ProjectServices } from "../application/projects";
import { toProjectErrorDto, type ProjectErrorDto } from "../application/project-errors";
import type { AppState, Project } from "../domain/projects";

export type ProjectCommandResponse =
  | { ok: true; project: Project }
  | { ok: false; error: ProjectErrorDto };

export type ThemeCommandResponse =
  | { ok: true; state: AppState }
  | { ok: false; error: ProjectErrorDto };

export async function executeCreateProject(
  data: unknown,
  services: ProjectServices,
): Promise<ProjectCommandResponse> {
  const result = await Effect.runPromise(Effect.either(createProject(data, services)));
  return Either.isRight(result)
    ? { ok: true, project: result.right }
    : { ok: false, error: toProjectErrorDto(result.left) };
}

export async function executeChangeTheme(
  data: unknown,
  services: ProjectServices,
): Promise<ThemeCommandResponse> {
  const result = await Effect.runPromise(Effect.either(setTheme(data, services)));
  return Either.isRight(result)
    ? { ok: true, state: result.right }
    : { ok: false, error: toProjectErrorDto(result.left) };
}
