import { createHash, randomUUID } from "node:crypto";
import { mkdirSync } from "node:fs";
import { dirname, resolve } from "node:path";

import Database from "better-sqlite3";
import { and, asc, eq, max } from "drizzle-orm";
import { drizzle } from "drizzle-orm/better-sqlite3";
import { migrate } from "drizzle-orm/better-sqlite3/migrator";
import { Effect } from "effect";

import {
  ActiveProjectVersionConflictError,
  DuplicateRepositoryRootError,
  IdempotencyConflictError,
  ProjectAuthorizationError,
  ProjectNotFoundError,
  ProjectPersistenceError,
  ProjectVersionConflictError,
  type ProjectCommandError,
} from "../application/project-errors";
import type { ProjectStore, RepositoryDetails } from "../application/projects";
import type { ActivityActor } from "../domain/activity";
import type {
  AppState,
  CreateProjectInput,
  Project,
  SelectActiveProjectInput,
  SetProjectReviewModeInput,
  SetThemeInput,
} from "../domain/projects";
import { appStateSchema, projectSchema } from "../domain/projects";
import { events, idempotencyRecords, preferences, projects, schema } from "../db/schema";
import { importanceForEventKind, normalizeEventChangeHints } from "../domain/activity";

const PREFERENCES_ID = 1;
const LOCAL_HUMAN_ID = "local-human";

type DrizzleDatabase = ReturnType<typeof drizzle<typeof schema>>;
type DrizzleTransaction = Parameters<Parameters<DrizzleDatabase["transaction"]>[0]>[0];
type DatabaseSession = DrizzleDatabase | DrizzleTransaction;

export type SqliteProjectStore = ProjectStore & {
  readonly database: Database.Database;
  close(): void;
};

function inputHash(command: string, input: unknown) {
  return createHash("sha256")
    .update(`${command}:${JSON.stringify(input)}`)
    .digest("hex");
}

function persistenceError(error: unknown) {
  return new ProjectPersistenceError({
    message: error instanceof Error ? error.message : "The project database operation failed.",
  });
}

function readAppState(db: DatabaseSession): AppState {
  const [row] = db
    .select({ preference: preferences, project: projects })
    .from(preferences)
    .leftJoin(projects, eq(preferences.activeProjectId, projects.id))
    .where(eq(preferences.id, PREFERENCES_ID))
    .limit(1)
    .all();

  return {
    activeProject: row?.project ?? null,
    activeProjectVersion: row?.preference.activeProjectVersion ?? 0,
    theme: row?.preference.theme ?? "system",
  };
}

function databasePathFrom(value: string) {
  if (value === ":memory:") return value;
  return resolve(value.replace(/^file:/, ""));
}

export function createSqliteProjectStore(
  databaseUrl = process.env.DATABASE_URL ?? "./data/helm.db",
): SqliteProjectStore {
  const databasePath = databasePathFrom(databaseUrl);
  if (databasePath !== ":memory:") mkdirSync(dirname(databasePath), { recursive: true });

  const database = new Database(databasePath);
  database.pragma("foreign_keys = ON");
  database.pragma("journal_mode = WAL");
  database.pragma("busy_timeout = 5000");

  const db = drizzle(database, { schema });
  migrate(db, { migrationsFolder: resolve("drizzle") });
  db.insert(preferences)
    .values({
      id: PREFERENCES_ID,
      activeProjectId: null,
      activeProjectVersion: 0,
      theme: "system",
      updatedAt: new Date().toISOString(),
    })
    .onConflictDoNothing()
    .run();

  const store: SqliteProjectStore = {
    database,
    close() {
      database.close();
    },
    getAppState() {
      return Effect.try({ try: () => readAppState(db), catch: persistenceError });
    },
    listProjects() {
      return Effect.try({
        try: () => db.select().from(projects).orderBy(asc(projects.sequence)).all(),
        catch: persistenceError,
      });
    },
    createAndSelect(input: CreateProjectInput, repository: RepositoryDetails) {
      return Effect.try({
        try: () =>
          db.transaction(
            (tx) => {
              const hash = inputHash("project.create", {
                repositoryRoot: repository.canonicalRoot,
              });
              const [existingRequest] = tx
                .select()
                .from(idempotencyRecords)
                .where(eq(idempotencyRecords.key, input.idempotencyKey))
                .limit(1)
                .all();

              if (existingRequest) {
                if (
                  existingRequest.command !== "project.create" ||
                  existingRequest.inputHash !== hash
                ) {
                  throw new IdempotencyConflictError({
                    key: input.idempotencyKey,
                    message: "That idempotency key was already used for a different command.",
                  });
                }
                return projectSchema.parse(JSON.parse(existingRequest.resultJson));
              }

              const [duplicate] = tx
                .select({ id: projects.id })
                .from(projects)
                .where(eq(projects.repositoryRoot, repository.canonicalRoot))
                .limit(1)
                .all();
              if (duplicate) {
                throw new DuplicateRepositoryRootError({
                  path: repository.canonicalRoot,
                  message: "That repository is already registered in Helm.",
                });
              }

              const [sequenceResult] = tx
                .select({ value: max(projects.sequence) })
                .from(projects)
                .all();
              const now = new Date().toISOString();
              const project: Project = {
                id: randomUUID(),
                sequence: (sequenceResult?.value ?? 0) + 1,
                name: repository.name,
                repositoryRoot: repository.canonicalRoot,
                reviewMode: "required",
                version: 1,
                createdAt: now,
                updatedAt: now,
              };

              const preference = tx
                .select()
                .from(preferences)
                .where(eq(preferences.id, PREFERENCES_ID))
                .limit(1)
                .get();
              if (!preference) throw new Error("Helm preferences are unavailable.");
              const activeProjectVersion = preference.activeProjectVersion + 1;

              tx.insert(projects).values(project).run();
              tx.update(preferences)
                .set({ activeProjectId: project.id, activeProjectVersion, updatedAt: now })
                .where(eq(preferences.id, PREFERENCES_ID))
                .run();
              tx.insert(events)
                .values({
                  projectId: project.id,
                  kind: "project.created",
                  importance: importanceForEventKind("project.created"),
                  actorType: "human",
                  actorId: LOCAL_HUMAN_ID,
                  entityType: "project",
                  entityId: project.id,
                  payloadJson: JSON.stringify({
                    name: project.name,
                    repositoryRoot: project.repositoryRoot,
                    selected: true,
                    activeProjectVersion,
                  }),
                  changesJson: JSON.stringify(
                    normalizeEventChangeHints({
                      projectIds: [project.id],
                      scopes: ["projects", "preferences"],
                    }),
                  ),
                  occurredAt: now,
                })
                .run();
              tx.insert(idempotencyRecords)
                .values({
                  key: input.idempotencyKey,
                  command: "project.create",
                  inputHash: hash,
                  resultJson: JSON.stringify(project),
                  createdAt: now,
                })
                .run();
              return project;
            },
            { behavior: "immediate" },
          ),
        catch: (error): ProjectCommandError => {
          if (
            error instanceof DuplicateRepositoryRootError ||
            error instanceof IdempotencyConflictError
          ) {
            return error;
          }
          if (error instanceof Error && error.message.includes("projects.repository_root")) {
            return new DuplicateRepositoryRootError({
              path: repository.canonicalRoot,
              message: "That repository is already registered in Helm.",
            });
          }
          return persistenceError(error);
        },
      });
    },
    selectActiveProject(input: SelectActiveProjectInput, actor: ActivityActor) {
      return Effect.try({
        try: () =>
          db.transaction(
            (tx) => {
              if (actor.type !== "human") {
                throw new ProjectAuthorizationError({
                  message: "Only the local human can select the active project.",
                });
              }
              const command = "project.select";
              const hash = inputHash(command, {
                projectId: input.projectId,
                expectedVersion: input.expectedVersion,
              });
              const existingRequest = tx
                .select()
                .from(idempotencyRecords)
                .where(eq(idempotencyRecords.key, input.idempotencyKey))
                .limit(1)
                .get();
              if (existingRequest) {
                if (existingRequest.command !== command || existingRequest.inputHash !== hash) {
                  throw new IdempotencyConflictError({
                    key: input.idempotencyKey,
                    message: "That idempotency key was already used for a different command.",
                  });
                }
                return appStateSchema.parse(JSON.parse(existingRequest.resultJson));
              }

              const targetProject = tx
                .select()
                .from(projects)
                .where(eq(projects.id, input.projectId))
                .limit(1)
                .get();
              if (!targetProject) {
                throw new ProjectNotFoundError({
                  projectId: input.projectId,
                  message: "That project does not exist.",
                });
              }
              const preference = tx
                .select()
                .from(preferences)
                .where(eq(preferences.id, PREFERENCES_ID))
                .limit(1)
                .get();
              if (!preference) throw new Error("Helm preferences are unavailable.");
              if (preference.activeProjectVersion !== input.expectedVersion) {
                throw new ActiveProjectVersionConflictError({
                  projectId: input.projectId,
                  expectedVersion: input.expectedVersion,
                  currentVersion: preference.activeProjectVersion,
                  changeSummary: `The active project selection is now version ${preference.activeProjectVersion}, with project ${preference.activeProjectId ?? "none"} selected.`,
                  message: `Active project version conflict: expected ${input.expectedVersion}, current ${preference.activeProjectVersion}.`,
                });
              }

              const now = new Date().toISOString();
              const activeProjectVersion = preference.activeProjectVersion + 1;
              const update = tx
                .update(preferences)
                .set({
                  activeProjectId: targetProject.id,
                  activeProjectVersion,
                  updatedAt: now,
                })
                .where(
                  and(
                    eq(preferences.id, PREFERENCES_ID),
                    eq(preferences.activeProjectVersion, preference.activeProjectVersion),
                  ),
                )
                .run();
              if (update.changes !== 1) {
                const currentVersion =
                  tx
                    .select({ version: preferences.activeProjectVersion })
                    .from(preferences)
                    .where(eq(preferences.id, PREFERENCES_ID))
                    .limit(1)
                    .get()?.version ?? preference.activeProjectVersion;
                throw new ActiveProjectVersionConflictError({
                  projectId: input.projectId,
                  expectedVersion: input.expectedVersion,
                  currentVersion,
                  changeSummary: `The active project selection is now version ${currentVersion}.`,
                  message: `Active project version conflict: expected ${input.expectedVersion}, current ${currentVersion}.`,
                });
              }

              const state = readAppState(tx);
              tx.insert(events)
                .values({
                  projectId: targetProject.id,
                  kind: "project.selected",
                  importance: importanceForEventKind("project.selected"),
                  actorType: actor.type,
                  actorId: actor.id,
                  entityType: "preferences",
                  entityId: String(PREFERENCES_ID),
                  payloadJson: JSON.stringify({
                    previousProjectId: preference.activeProjectId,
                    projectId: targetProject.id,
                    previousVersion: preference.activeProjectVersion,
                    version: activeProjectVersion,
                  }),
                  changesJson: JSON.stringify(
                    normalizeEventChangeHints({
                      projectIds: [
                        ...(preference.activeProjectId ? [preference.activeProjectId] : []),
                        targetProject.id,
                      ],
                      scopes: ["projects", "preferences"],
                    }),
                  ),
                  occurredAt: now,
                })
                .run();
              tx.insert(idempotencyRecords)
                .values({
                  key: input.idempotencyKey,
                  command,
                  inputHash: hash,
                  resultJson: JSON.stringify(state),
                  createdAt: now,
                })
                .run();
              return state;
            },
            { behavior: "immediate" },
          ),
        catch: (error): ProjectCommandError => {
          if (
            error instanceof ActiveProjectVersionConflictError ||
            error instanceof IdempotencyConflictError ||
            error instanceof ProjectAuthorizationError ||
            error instanceof ProjectNotFoundError
          ) {
            return error;
          }
          return persistenceError(error);
        },
      });
    },
    setTheme(input: SetThemeInput) {
      return Effect.try({
        try: () =>
          db.transaction((tx) => {
            const hash = inputHash("preference.theme.set", { theme: input.theme });
            const [existingRequest] = tx
              .select()
              .from(idempotencyRecords)
              .where(eq(idempotencyRecords.key, input.idempotencyKey))
              .limit(1)
              .all();
            if (existingRequest) {
              if (
                existingRequest.command !== "preference.theme.set" ||
                existingRequest.inputHash !== hash
              ) {
                throw new IdempotencyConflictError({
                  key: input.idempotencyKey,
                  message: "That idempotency key was already used for a different command.",
                });
              }
              return appStateSchema.parse(JSON.parse(existingRequest.resultJson));
            }

            const now = new Date().toISOString();
            tx.update(preferences)
              .set({ theme: input.theme, updatedAt: now })
              .where(eq(preferences.id, PREFERENCES_ID))
              .run();

            const [stateRow] = tx
              .select({ preference: preferences, project: projects })
              .from(preferences)
              .leftJoin(projects, eq(preferences.activeProjectId, projects.id))
              .where(eq(preferences.id, PREFERENCES_ID))
              .limit(1)
              .all();
            const state: AppState = {
              activeProject: stateRow?.project ?? null,
              activeProjectVersion: stateRow?.preference.activeProjectVersion ?? 0,
              theme: stateRow?.preference.theme ?? "system",
            };
            tx.insert(events)
              .values({
                projectId: state.activeProject?.id ?? null,
                kind: "preference.theme.changed",
                importance: importanceForEventKind("preference.theme.changed"),
                actorType: "human",
                actorId: LOCAL_HUMAN_ID,
                entityType: "preferences",
                entityId: String(PREFERENCES_ID),
                payloadJson: JSON.stringify({ theme: input.theme }),
                changesJson: JSON.stringify(
                  normalizeEventChangeHints({
                    projectIds: state.activeProject ? [state.activeProject.id] : [],
                    scopes: ["preferences"],
                  }),
                ),
                occurredAt: now,
              })
              .run();
            tx.insert(idempotencyRecords)
              .values({
                key: input.idempotencyKey,
                command: "preference.theme.set",
                inputHash: hash,
                resultJson: JSON.stringify(state),
                createdAt: now,
              })
              .run();
            return state;
          }),
        catch: (error): ProjectCommandError =>
          error instanceof IdempotencyConflictError ? error : persistenceError(error),
      });
    },
    setReviewMode(input: SetProjectReviewModeInput, actor: ActivityActor) {
      return Effect.try({
        try: () =>
          db.transaction(
            (tx) => {
              if (actor.type !== "human") {
                throw new ProjectAuthorizationError({
                  message: "Only the local human can change the project review mode.",
                });
              }
              const command = "project.review_mode.set";
              const hash = inputHash(command, {
                projectId: input.projectId,
                reviewMode: input.reviewMode,
                expectedVersion: input.expectedVersion,
              });
              const existingRequest = tx
                .select()
                .from(idempotencyRecords)
                .where(eq(idempotencyRecords.key, input.idempotencyKey))
                .limit(1)
                .get();
              if (existingRequest) {
                if (existingRequest.command !== command || existingRequest.inputHash !== hash) {
                  throw new IdempotencyConflictError({
                    key: input.idempotencyKey,
                    message: "That idempotency key was already used for a different command.",
                  });
                }
                return projectSchema.parse(JSON.parse(existingRequest.resultJson));
              }

              const project = tx
                .select()
                .from(projects)
                .where(eq(projects.id, input.projectId))
                .limit(1)
                .get();
              if (!project) {
                throw new ProjectVersionConflictError({
                  projectId: input.projectId,
                  expectedVersion: input.expectedVersion,
                  currentVersion: 0,
                  changeSummary: "The project no longer exists.",
                  message: "That project does not exist.",
                });
              }
              if (project.version !== input.expectedVersion) {
                throw new ProjectVersionConflictError({
                  projectId: project.id,
                  expectedVersion: input.expectedVersion,
                  currentVersion: project.version,
                  changeSummary: `Project #${project.sequence} is now version ${project.version} with review mode ${project.reviewMode}.`,
                  message: `Project version conflict: expected ${input.expectedVersion}, current ${project.version}.`,
                });
              }

              const now = new Date().toISOString();
              const update = tx
                .update(projects)
                .set({
                  reviewMode: input.reviewMode,
                  version: project.version + 1,
                  updatedAt: now,
                })
                .where(and(eq(projects.id, project.id), eq(projects.version, project.version)))
                .run();
              if (update.changes !== 1) {
                const currentVersion =
                  tx
                    .select({ version: projects.version })
                    .from(projects)
                    .where(eq(projects.id, project.id))
                    .limit(1)
                    .get()?.version ?? project.version;
                throw new ProjectVersionConflictError({
                  projectId: project.id,
                  expectedVersion: input.expectedVersion,
                  currentVersion,
                  changeSummary: `The project is now version ${currentVersion}.`,
                  message: `Project version conflict: expected ${input.expectedVersion}, current ${currentVersion}.`,
                });
              }
              const updated = projectSchema.parse(
                tx.select().from(projects).where(eq(projects.id, project.id)).limit(1).get(),
              );
              tx.insert(events)
                .values({
                  projectId: updated.id,
                  kind: "project.review_mode.changed",
                  importance: importanceForEventKind("project.review_mode.changed"),
                  actorType: actor.type,
                  actorId: actor.id,
                  entityType: "project",
                  entityId: updated.id,
                  payloadJson: JSON.stringify({
                    previousReviewMode: project.reviewMode,
                    reviewMode: updated.reviewMode,
                    previousVersion: project.version,
                    version: updated.version,
                  }),
                  changesJson: JSON.stringify(
                    normalizeEventChangeHints({
                      projectIds: [updated.id],
                      scopes: ["projects"],
                    }),
                  ),
                  occurredAt: now,
                })
                .run();
              tx.insert(idempotencyRecords)
                .values({
                  key: input.idempotencyKey,
                  command,
                  inputHash: hash,
                  resultJson: JSON.stringify(updated),
                  createdAt: now,
                })
                .run();
              return updated;
            },
            { behavior: "immediate" },
          ),
        catch: (error): ProjectCommandError => {
          if (
            error instanceof IdempotencyConflictError ||
            error instanceof ProjectVersionConflictError ||
            error instanceof ProjectAuthorizationError
          ) {
            return error;
          }
          return persistenceError(error);
        },
      });
    },
  };

  return store;
}
