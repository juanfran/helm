import { createHash, randomUUID } from "node:crypto";
import { mkdirSync } from "node:fs";
import { dirname, resolve } from "node:path";

import Database from "better-sqlite3";
import { asc, eq, max } from "drizzle-orm";
import { drizzle } from "drizzle-orm/better-sqlite3";
import { migrate } from "drizzle-orm/better-sqlite3/migrator";
import { Effect } from "effect";

import {
  DuplicateRepositoryRootError,
  IdempotencyConflictError,
  ProjectPersistenceError,
  type ProjectCommandError,
} from "../application/project-errors";
import type { ProjectStore, RepositoryDetails } from "../application/projects";
import type { AppState, CreateProjectInput, Project, SetThemeInput } from "../domain/projects";
import { appStateSchema, projectSchema } from "../domain/projects";
import { events, idempotencyRecords, preferences, projects, schema } from "../db/schema";

const PREFERENCES_ID = 1;
const LOCAL_HUMAN_ID = "local-human";

type DrizzleDatabase = ReturnType<typeof drizzle<typeof schema>>;

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

function readAppState(db: DrizzleDatabase): AppState {
  const [row] = db
    .select({ preference: preferences, project: projects })
    .from(preferences)
    .leftJoin(projects, eq(preferences.activeProjectId, projects.id))
    .where(eq(preferences.id, PREFERENCES_ID))
    .limit(1)
    .all();

  return {
    activeProject: row?.project ?? null,
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
          db.transaction((tx) => {
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
              version: 1,
              createdAt: now,
              updatedAt: now,
            };

            tx.insert(projects).values(project).run();
            tx.update(preferences)
              .set({ activeProjectId: project.id, updatedAt: now })
              .where(eq(preferences.id, PREFERENCES_ID))
              .run();
            tx.insert(events)
              .values({
                projectId: project.id,
                kind: "project.created",
                actorType: "human",
                actorId: LOCAL_HUMAN_ID,
                entityType: "project",
                entityId: project.id,
                payloadJson: JSON.stringify({
                  name: project.name,
                  repositoryRoot: project.repositoryRoot,
                  selected: true,
                }),
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
          }),
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
              theme: stateRow?.preference.theme ?? "system",
            };
            tx.insert(events)
              .values({
                projectId: state.activeProject?.id ?? null,
                kind: "preference.theme.changed",
                actorType: "human",
                actorId: LOCAL_HUMAN_ID,
                entityType: "preferences",
                entityId: String(PREFERENCES_ID),
                payloadJson: JSON.stringify({ theme: input.theme }),
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
  };

  return store;
}
