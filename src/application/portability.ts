import { Effect } from "effect";

import {
  compiledExecuteProjectImportInputSchema,
  compiledExportProjectInputSchema,
  compiledExportProjectMarkdownInputSchema,
  compiledPreviewProjectImportInputSchema,
  type ExecuteProjectImportInput,
  type ExportProjectInput,
  type ExportProjectMarkdownInput,
  type HelmProjectExport,
  type PreviewProjectImportInput,
  type ProjectImportExecutionResult,
  type ProjectImportPreview,
} from "../domain/portability";
import type { Actor } from "../domain/tasks";
import type { RepositoryInspector } from "./projects";
import {
  InvalidPortabilityInputError,
  PortabilityAuthorizationError,
  type PortabilityError,
} from "./portability-errors";

export type PortabilityClock = { now(): string };

export const systemPortabilityClock: PortabilityClock = {
  now: () => new Date().toISOString(),
};

export type PortabilityExportContext = {
  readonly now: string;
};

export type ProjectMarkdownExport = {
  readonly projectName: string;
  readonly viewName: string | null;
  readonly markdown: string;
};

export type DatabaseBackupBody = Uint8Array | ReadableStream<Uint8Array>;

export interface PortabilityStore {
  createBackup(signal?: AbortSignal): Effect.Effect<DatabaseBackupBody, PortabilityError>;
  exportProject(
    input: ExportProjectInput,
    context: PortabilityExportContext,
  ): Effect.Effect<HelmProjectExport, PortabilityError>;
  exportProjectMarkdown(
    input: ExportProjectMarkdownInput,
    context: PortabilityExportContext,
  ): Effect.Effect<ProjectMarkdownExport, PortabilityError>;
  previewImport(
    input: PreviewProjectImportInput,
    actor: Actor,
    context: PortabilityExportContext,
  ): Effect.Effect<ProjectImportPreview, PortabilityError>;
  executeImport(
    input: ExecuteProjectImportInput,
    actor: Actor,
    context: PortabilityExportContext,
  ): Effect.Effect<ProjectImportExecutionResult, PortabilityError>;
}

export type PortabilityServices = {
  readonly store: PortabilityStore;
  readonly clock: PortabilityClock;
  readonly repositoryInspector: RepositoryInspector;
};

function validationIssues(error: unknown) {
  if (!error || typeof error !== "object" || !("issues" in error)) return undefined;
  const issues = Reflect.get(error, "issues");
  if (!Array.isArray(issues)) return undefined;
  return issues.map((issue) => {
    if (!issue || typeof issue !== "object") return String(issue);
    const path = Reflect.get(issue, "path");
    const message = Reflect.get(issue, "message");
    const renderedPath = Array.isArray(path) ? path.map(String).join(".") : "";
    const renderedMessage = typeof message === "string" ? message : "Invalid value.";
    return renderedPath ? `${renderedPath}: ${renderedMessage}` : renderedMessage;
  });
}

function parseInput<A>(parse: () => A): Effect.Effect<A, InvalidPortabilityInputError> {
  return Effect.try({
    try: parse,
    catch: (error) =>
      new InvalidPortabilityInputError({
        message: "The portability request is invalid.",
        issues: validationIssues(error),
      }),
  });
}

function humanOnly(actor: Actor) {
  return actor.type === "human"
    ? Effect.succeed(actor)
    : Effect.fail(
        new PortabilityAuthorizationError({
          message: "Only the local human can import project data.",
        }),
      );
}

function inspectNewProjectRepository<
  A extends PreviewProjectImportInput | ExecuteProjectImportInput,
>(input: A, services: PortabilityServices): Effect.Effect<A, InvalidPortabilityInputError> {
  if (input.targetProjectId !== null) return Effect.succeed(input);
  if (input.repositoryRoot === undefined) {
    return Effect.fail(
      new InvalidPortabilityInputError({
        message: "A repository root is required for a new project import.",
      }),
    );
  }
  return Effect.map(
    Effect.mapError(
      services.repositoryInspector.inspect(input.repositoryRoot),
      (error) =>
        new InvalidPortabilityInputError({
          message: "The import repository root is invalid.",
          issues: [error.message],
        }),
    ),
    (repository) => ({ ...input, repositoryRoot: repository.canonicalRoot }),
  );
}

export function createDatabaseBackup(services: PortabilityServices, signal?: AbortSignal) {
  return services.store.createBackup(signal);
}

export function exportProject(input: unknown, services: PortabilityServices) {
  return Effect.flatMap(
    parseInput(() => compiledExportProjectInputSchema.parse(input)),
    (parsed) => services.store.exportProject(parsed, { now: services.clock.now() }),
  );
}

export function exportProjectMarkdown(input: unknown, services: PortabilityServices) {
  return Effect.flatMap(
    parseInput(() => compiledExportProjectMarkdownInputSchema.parse(input)),
    (parsed) => services.store.exportProjectMarkdown(parsed, { now: services.clock.now() }),
  );
}

export function previewProjectImport(input: unknown, actor: Actor, services: PortabilityServices) {
  return Effect.flatMap(humanOnly(actor), () =>
    Effect.flatMap(
      parseInput(() => compiledPreviewProjectImportInputSchema.parse(input)),
      (parsed) =>
        Effect.flatMap(inspectNewProjectRepository(parsed, services), (canonical) =>
          services.store.previewImport(canonical, actor, { now: services.clock.now() }),
        ),
    ),
  );
}

export function executeProjectImport(input: unknown, actor: Actor, services: PortabilityServices) {
  return Effect.flatMap(humanOnly(actor), () =>
    Effect.flatMap(
      parseInput(() => compiledExecuteProjectImportInputSchema.parse(input)),
      (parsed) =>
        Effect.flatMap(inspectNewProjectRepository(parsed, services), (canonical) =>
          services.store.executeImport(canonical, actor, { now: services.clock.now() }),
        ),
    ),
  );
}
