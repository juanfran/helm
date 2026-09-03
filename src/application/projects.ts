import { Effect } from "effect";

import {
  compiledCreateProjectInputSchema,
  compiledSetThemeInputSchema,
  type AppState,
  type CreateProjectInput,
  type Project,
  type SetThemeInput,
} from "../domain/projects";
import {
  InvalidProjectInputError,
  type ProjectCommandError,
  type ProjectPersistenceError,
} from "./project-errors";

export type RepositoryDetails = { canonicalRoot: string; name: string };

export interface RepositoryInspector {
  inspect(path: string): Effect.Effect<RepositoryDetails, ProjectCommandError>;
}

export interface ProjectStore {
  getAppState(): Effect.Effect<AppState, ProjectPersistenceError>;
  listProjects(): Effect.Effect<readonly Project[], ProjectPersistenceError>;
  createAndSelect(
    input: CreateProjectInput,
    repository: RepositoryDetails,
  ): Effect.Effect<Project, ProjectCommandError>;
  setTheme(input: SetThemeInput): Effect.Effect<AppState, ProjectCommandError>;
}

export type ProjectServices = {
  inspector: RepositoryInspector;
  store: ProjectStore;
};

function parseInput<A>(parse: () => A): Effect.Effect<A, InvalidProjectInputError> {
  return Effect.try({
    try: parse,
    catch: () => new InvalidProjectInputError({ message: "The command input is invalid." }),
  });
}

export function createProject(
  input: unknown,
  services: ProjectServices,
): Effect.Effect<Project, ProjectCommandError> {
  return Effect.flatMap(
    parseInput(() => compiledCreateProjectInputSchema.parse(input)),
    (parsed) =>
      Effect.flatMap(services.inspector.inspect(parsed.repositoryRoot), (repository) =>
        services.store.createAndSelect(parsed, repository),
      ),
  );
}

export function setTheme(
  input: unknown,
  services: ProjectServices,
): Effect.Effect<AppState, ProjectCommandError> {
  return Effect.flatMap(
    parseInput(() => compiledSetThemeInputSchema.parse(input)),
    (parsed) => services.store.setTheme(parsed),
  );
}

export function getAppState(services: ProjectServices) {
  return services.store.getAppState();
}

export function listProjects(services: ProjectServices) {
  return services.store.listProjects();
}
