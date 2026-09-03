import { mkdir, mkdtemp, rm, writeFile } from "node:fs/promises";
import { join } from "node:path";
import { tmpdir } from "node:os";

import { Effect, Either } from "effect";
import { afterEach, describe, expect, it } from "vitest";

import { createProject, getAppState, setTheme } from "./projects";
import { compiledCreateProjectInputSchema, createProjectInputSchema } from "../domain/projects";
import { localRepositoryInspector } from "../infrastructure/repository-inspector.server";
import {
  createSqliteProjectStore,
  type SqliteProjectStore,
} from "../infrastructure/sqlite-project-store.server";

const temporaryPaths: string[] = [];

async function temporaryDirectory() {
  const path = await mkdtemp(join(tmpdir(), "helm-project-test-"));
  temporaryPaths.push(path);
  return path;
}

async function repository(name = "example") {
  const parent = await temporaryDirectory();
  const root = join(parent, name);
  await mkdir(join(root, ".git"), { recursive: true });
  return root;
}

function services(store: SqliteProjectStore) {
  return { store, inspector: localRepositoryInspector };
}

afterEach(async () => {
  await Promise.all(
    temporaryPaths.splice(0).map((path) => rm(path, { recursive: true, force: true })),
  );
});

describe("project application commands", () => {
  it("creates, selects, attributes, and idempotently returns one project atomically", async () => {
    const store = createSqliteProjectStore(":memory:");
    const root = await repository();
    const command = { repositoryRoot: root, idempotencyKey: "create-example" };

    const first = await Effect.runPromise(createProject(command, services(store)));
    const retry = await Effect.runPromise(createProject(command, services(store)));
    const state = await Effect.runPromise(getAppState(services(store)));
    const projectCount = store.database
      .prepare<[], { count: number }>("select count(*) as count from projects")
      .get();
    const event = store.database
      .prepare<[], { kind: string; actorType: string; actorId: string }>(
        "select kind, actor_type as actorType, actor_id as actorId from events",
      )
      .get();

    expect(retry).toEqual(first);
    expect(projectCount?.count).toBe(1);
    expect(state.activeProject).toEqual(first);
    expect(event).toEqual({
      kind: "project.created",
      actorType: "human",
      actorId: "local-human",
    });
    store.close();
  });

  it("returns typed missing, non-directory, and duplicate errors without partial records", async () => {
    const store = createSqliteProjectStore(":memory:");
    const parent = await temporaryDirectory();
    const file = join(parent, "file.txt");
    await writeFile(file, "not a directory");
    const plainDirectory = join(parent, "plain-directory");
    await mkdir(plainDirectory);
    const root = await repository("duplicate");

    const missing = await Effect.runPromise(
      Effect.either(
        createProject(
          { repositoryRoot: join(parent, "missing"), idempotencyKey: "missing" },
          services(store),
        ),
      ),
    );
    const notDirectory = await Effect.runPromise(
      Effect.either(
        createProject({ repositoryRoot: file, idempotencyKey: "file" }, services(store)),
      ),
    );
    const notRepository = await Effect.runPromise(
      Effect.either(
        createProject(
          { repositoryRoot: plainDirectory, idempotencyKey: "plain-directory" },
          services(store),
        ),
      ),
    );
    await Effect.runPromise(
      createProject({ repositoryRoot: root, idempotencyKey: "first" }, services(store)),
    );
    const duplicate = await Effect.runPromise(
      Effect.either(
        createProject({ repositoryRoot: root, idempotencyKey: "duplicate" }, services(store)),
      ),
    );

    if (Either.isRight(missing) || missing.left["_tag"] !== "InvalidRepositoryRootError") {
      throw new Error("Expected a missing repository root error");
    }
    if (
      Either.isRight(notDirectory) ||
      notDirectory.left["_tag"] !== "InvalidRepositoryRootError"
    ) {
      throw new Error("Expected a non-directory repository root error");
    }
    if (
      Either.isRight(notRepository) ||
      notRepository.left["_tag"] !== "InvalidRepositoryRootError"
    ) {
      throw new Error("Expected a non-repository root error");
    }
    expect(missing.left.reason).toBe("missing");
    expect(notDirectory.left.reason).toBe("not-directory");
    expect(notRepository.left.reason).toBe("not-repository-root");
    expect(Either.isLeft(duplicate) && duplicate.left["_tag"]).toBe("DuplicateRepositoryRootError");
    expect(
      store.database.prepare<[], { count: number }>("select count(*) as count from projects").get()
        ?.count,
    ).toBe(1);
    store.close();
  });

  it("rolls the project and selection back when its audit event cannot be written", async () => {
    const store = createSqliteProjectStore(":memory:");
    const root = await repository("rollback");
    store.database.exec(`
      create trigger reject_project_event
      before insert on events when NEW.kind = 'project.created'
      begin select raise(abort, 'event rejected'); end;
    `);

    const result = await Effect.runPromise(
      Effect.either(
        createProject({ repositoryRoot: root, idempotencyKey: "rollback" }, services(store)),
      ),
    );
    const state = await Effect.runPromise(getAppState(services(store)));

    expect(Either.isLeft(result) && result.left["_tag"]).toBe("ProjectPersistenceError");
    expect(state.activeProject).toBeNull();
    expect(
      store.database.prepare<[], { count: number }>("select count(*) as count from projects").get()
        ?.count,
    ).toBe(0);
    store.close();
  });

  it("restores the active project and theme after opening a new database process", async () => {
    const parent = await temporaryDirectory();
    const databasePath = join(parent, "helm.db");
    const root = await repository("persistent");
    const firstStore = createSqliteProjectStore(databasePath);
    const project = await Effect.runPromise(
      createProject(
        { repositoryRoot: root, idempotencyKey: "persistent-project" },
        services(firstStore),
      ),
    );
    await Effect.runPromise(
      setTheme({ theme: "dark", idempotencyKey: "persistent-theme" }, services(firstStore)),
    );
    firstStore.close();

    const reopenedStore = createSqliteProjectStore(databasePath);
    const restored = await Effect.runPromise(getAppState(services(reopenedStore)));

    expect(restored).toEqual({ activeProject: project, theme: "dark" });
    reopenedStore.close();
  });

  it("accepts and rejects representative input through normal and compiled schemas", () => {
    const valid = { repositoryRoot: "/tmp/example", idempotencyKey: "request-1" };
    expect(createProjectInputSchema.parse(valid)).toEqual(valid);
    expect(compiledCreateProjectInputSchema.parse(valid)).toEqual(valid);
    expect(() => createProjectInputSchema.parse({ ...valid, repositoryRoot: "" })).toThrow();
    expect(() =>
      compiledCreateProjectInputSchema.parse({ ...valid, repositoryRoot: "" }),
    ).toThrow();
  });
});
