import { mkdir, mkdtemp, rm, writeFile } from "node:fs/promises";
import { join } from "node:path";
import { tmpdir } from "node:os";

import { Effect, Either } from "effect";
import { afterEach, describe, expect, it } from "vitest";

import {
  createProject,
  getAppState,
  listProjects,
  selectActiveProject,
  setProjectReviewMode,
  setTheme,
} from "./projects";
import {
  compiledCreateProjectInputSchema,
  compiledSelectActiveProjectInputSchema,
  compiledSetProjectReviewModeInputSchema,
  createProjectInputSchema,
  selectActiveProjectInputSchema,
  setProjectReviewModeInputSchema,
} from "../domain/projects";
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
    expect(state.activeProjectVersion).toBe(1);
    expect(event).toEqual({
      kind: "project.created",
      actorType: "human",
      actorId: "local-human",
    });
    store.close();
  });

  it("creates and selects another project after first run in stable sequence order", async () => {
    const store = createSqliteProjectStore(":memory:");
    const firstRoot = await repository("first");
    const secondRoot = await repository("second");

    const first = await Effect.runPromise(
      createProject({ repositoryRoot: firstRoot, idempotencyKey: "create-first" }, services(store)),
    );
    const second = await Effect.runPromise(
      createProject(
        { repositoryRoot: secondRoot, idempotencyKey: "create-second" },
        services(store),
      ),
    );
    const projects = await Effect.runPromise(listProjects(services(store)));
    const state = await Effect.runPromise(getAppState(services(store)));

    expect(projects).toEqual([first, second]);
    expect(projects.map((project) => project.sequence)).toEqual([1, 2]);
    expect(state).toEqual({ activeProject: second, activeProjectVersion: 2, theme: "system" });
    expect(
      store.database
        .prepare<[], number>("select count(*) from events where kind = 'project.created'")
        .pluck()
        .get(),
    ).toBe(2);
    store.close();
  });

  it("selects idempotently with human attribution and rejects stale or missing projects", async () => {
    const store = createSqliteProjectStore(":memory:");
    const firstRoot = await repository("selection-first");
    const secondRoot = await repository("selection-second");
    const first = await Effect.runPromise(
      createProject(
        { repositoryRoot: firstRoot, idempotencyKey: "selection-create-first" },
        services(store),
      ),
    );
    const second = await Effect.runPromise(
      createProject(
        { repositoryRoot: secondRoot, idempotencyKey: "selection-create-second" },
        services(store),
      ),
    );
    const command = {
      projectId: first.id,
      expectedVersion: 2,
      idempotencyKey: "select-first",
    };

    const selected = await Effect.runPromise(
      selectActiveProject(command, { type: "human", id: "local-human" }, services(store)),
    );
    const retry = await Effect.runPromise(
      selectActiveProject(command, { type: "human", id: "local-human" }, services(store)),
    );
    const stale = await Effect.runPromise(
      Effect.either(
        selectActiveProject(
          { projectId: second.id, expectedVersion: 2, idempotencyKey: "stale-selection" },
          { type: "human", id: "local-human" },
          services(store),
        ),
      ),
    );
    const missing = await Effect.runPromise(
      Effect.either(
        selectActiveProject(
          { projectId: "missing-project", expectedVersion: 3, idempotencyKey: "missing-selection" },
          { type: "human", id: "local-human" },
          services(store),
        ),
      ),
    );
    const unauthorized = await Effect.runPromise(
      Effect.either(
        selectActiveProject(
          { projectId: second.id, expectedVersion: 3, idempotencyKey: "agent-selection" },
          { type: "agent", id: "agent-run" },
          services(store),
        ),
      ),
    );
    const selectionEvents = store.database
      .prepare<
        [],
        {
          actorId: string;
          actorType: string;
          changesJson: string;
          projectId: string;
          payloadJson: string;
        }
      >(
        `select
          actor_id as actorId,
          actor_type as actorType,
          changes_json as changesJson,
          project_id as projectId,
          payload_json as payloadJson
        from events
        where kind = 'project.selected'`,
      )
      .all();

    expect(selected).toEqual({ activeProject: first, activeProjectVersion: 3, theme: "system" });
    expect(retry).toEqual(selected);
    expect(Either.isLeft(stale) && stale.left).toMatchObject({
      _tag: "ActiveProjectVersionConflictError",
      projectId: second.id,
      expectedVersion: 2,
      currentVersion: 3,
    });
    expect(Either.isLeft(missing) && missing.left).toMatchObject({
      _tag: "ProjectNotFoundError",
      projectId: "missing-project",
    });
    expect(Either.isLeft(unauthorized) && unauthorized.left).toMatchObject({
      _tag: "ProjectAuthorizationError",
    });
    expect(selectionEvents).toHaveLength(1);
    expect(selectionEvents[0]).toMatchObject({
      actorId: "local-human",
      actorType: "human",
      projectId: first.id,
    });
    expect(JSON.parse(selectionEvents[0]?.payloadJson ?? "null")).toEqual({
      previousProjectId: second.id,
      projectId: first.id,
      previousVersion: 2,
      version: 3,
    });
    expect(JSON.parse(selectionEvents[0]?.changesJson ?? "null")).toMatchObject({
      projectIds: [first.id, second.id].toSorted(),
      scopes: ["preferences", "projects"],
    });
    expect(await Effect.runPromise(getAppState(services(store)))).toEqual(selected);
    store.close();
  });

  it("rolls active selection and idempotency back when its audit event cannot be written", async () => {
    const store = createSqliteProjectStore(":memory:");
    const firstRoot = await repository("selection-rollback-first");
    const secondRoot = await repository("selection-rollback-second");
    const first = await Effect.runPromise(
      createProject(
        { repositoryRoot: firstRoot, idempotencyKey: "selection-rollback-create-first" },
        services(store),
      ),
    );
    const second = await Effect.runPromise(
      createProject(
        { repositoryRoot: secondRoot, idempotencyKey: "selection-rollback-create-second" },
        services(store),
      ),
    );
    store.database.exec(`
      create trigger reject_project_selection_event
      before insert on events when NEW.kind = 'project.selected'
      begin select raise(abort, 'selection event rejected'); end;
    `);

    const result = await Effect.runPromise(
      Effect.either(
        selectActiveProject(
          { projectId: first.id, expectedVersion: 2, idempotencyKey: "selection-rollback" },
          { type: "human", id: "local-human" },
          services(store),
        ),
      ),
    );
    const state = await Effect.runPromise(getAppState(services(store)));
    const idempotencyCount = store.database
      .prepare<[string], number>("select count(*) from idempotency_records where key = ?")
      .pluck()
      .get("selection-rollback");

    expect(Either.isLeft(result) && result.left).toMatchObject({ _tag: "ProjectPersistenceError" });
    expect(state).toEqual({ activeProject: second, activeProjectVersion: 2, theme: "system" });
    expect(idempotencyCount).toBe(0);
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
    expect(state.activeProjectVersion).toBe(0);
    expect(
      store.database.prepare<[], { count: number }>("select count(*) as count from projects").get()
        ?.count,
    ).toBe(0);
    store.close();
  });

  it("restores the active project and theme after opening a new database process", async () => {
    const parent = await temporaryDirectory();
    const databasePath = join(parent, "helm.db");
    const firstRoot = await repository("persistent-first");
    const secondRoot = await repository("persistent-second");
    const firstStore = createSqliteProjectStore(databasePath);
    const first = await Effect.runPromise(
      createProject(
        { repositoryRoot: firstRoot, idempotencyKey: "persistent-project-first" },
        services(firstStore),
      ),
    );
    await Effect.runPromise(
      createProject(
        { repositoryRoot: secondRoot, idempotencyKey: "persistent-project-second" },
        services(firstStore),
      ),
    );
    const selected = await Effect.runPromise(
      selectActiveProject(
        { projectId: first.id, expectedVersion: 2, idempotencyKey: "persistent-selection" },
        { type: "human", id: "local-human" },
        services(firstStore),
      ),
    );
    await Effect.runPromise(
      setTheme({ theme: "dark", idempotencyKey: "persistent-theme" }, services(firstStore)),
    );
    firstStore.close();

    const reopenedStore = createSqliteProjectStore(databasePath);
    const restored = await Effect.runPromise(getAppState(services(reopenedStore)));

    expect(restored).toEqual({ ...selected, theme: "dark" });
    reopenedStore.close();
  });

  it("changes review mode with versioning, attribution, and idempotency", async () => {
    const store = createSqliteProjectStore(":memory:");
    const root = await repository("review-mode");
    const project = await Effect.runPromise(
      createProject({ repositoryRoot: root, idempotencyKey: "review-project" }, services(store)),
    );
    const command = {
      projectId: project.id,
      reviewMode: "direct" as const,
      expectedVersion: project.version,
      idempotencyKey: "direct-review-mode",
    };

    const updated = await Effect.runPromise(
      setProjectReviewMode(command, { type: "human", id: "local-human" }, services(store)),
    );
    const retry = await Effect.runPromise(
      setProjectReviewMode(command, { type: "human", id: "local-human" }, services(store)),
    );
    const stale = await Effect.runPromise(
      Effect.either(
        setProjectReviewMode(
          { ...command, idempotencyKey: "stale-review-mode" },
          { type: "human", id: "local-human" },
          services(store),
        ),
      ),
    );
    const unauthorized = await Effect.runPromise(
      Effect.either(
        setProjectReviewMode(
          {
            ...command,
            expectedVersion: updated.version,
            idempotencyKey: "agent-review-mode",
          },
          { type: "agent", id: "run-1" },
          services(store),
        ),
      ),
    );
    const event = store.database
      .prepare<[], { actorType: string; actorId: string; payloadJson: string }>(
        "select actor_type as actorType, actor_id as actorId, payload_json as payloadJson from events where kind = 'project.review_mode.changed'",
      )
      .get();

    expect(project).toMatchObject({ reviewMode: "required", version: 1 });
    expect(updated).toMatchObject({ reviewMode: "direct", version: 2 });
    expect(retry).toEqual(updated);
    expect(Either.isLeft(stale) && stale.left).toMatchObject({
      _tag: "ProjectVersionConflictError",
      expectedVersion: 1,
      currentVersion: 2,
    });
    expect(Either.isLeft(unauthorized) && unauthorized.left).toMatchObject({
      _tag: "ProjectAuthorizationError",
    });
    expect(event).toMatchObject({ actorType: "human", actorId: "local-human" });
    expect(JSON.parse(event?.payloadJson ?? "null")).toEqual({
      previousReviewMode: "required",
      reviewMode: "direct",
      previousVersion: 1,
      version: 2,
    });
    store.close();
  });

  it("rolls review mode, audit, and idempotency back together", async () => {
    const store = createSqliteProjectStore(":memory:");
    const root = await repository("review-mode-rollback");
    const project = await Effect.runPromise(
      createProject(
        { repositoryRoot: root, idempotencyKey: "review-rollback-project" },
        services(store),
      ),
    );
    store.database.exec(`
      create trigger reject_review_mode_event
      before insert on events when NEW.kind = 'project.review_mode.changed'
      begin select raise(abort, 'review mode event rejected'); end;
    `);

    const result = await Effect.runPromise(
      Effect.either(
        setProjectReviewMode(
          {
            projectId: project.id,
            reviewMode: "direct",
            expectedVersion: project.version,
            idempotencyKey: "review-mode-rollback",
          },
          { type: "human", id: "local-human" },
          services(store),
        ),
      ),
    );
    const persisted = store.database
      .prepare<[string], { reviewMode: string; version: number }>(
        "select review_mode as reviewMode, version from projects where id = ?",
      )
      .get(project.id);
    const idempotencyCount = store.database
      .prepare<[string], number>("select count(*) from idempotency_records where key = ?")
      .pluck()
      .get("review-mode-rollback");

    expect(Either.isLeft(result) && result.left).toMatchObject({
      _tag: "ProjectPersistenceError",
    });
    expect(persisted).toEqual({ reviewMode: "required", version: 1 });
    expect(idempotencyCount).toBe(0);
    store.close();
  });

  it("accepts and rejects representative input through normal and compiled schemas", () => {
    const valid = { repositoryRoot: "/tmp/example", idempotencyKey: "request-1" };
    expect(createProjectInputSchema.parse(valid)).toEqual(valid);
    expect(compiledCreateProjectInputSchema.parse(valid)).toEqual(valid);
    expect(() => createProjectInputSchema.parse({ ...valid, repositoryRoot: "" })).toThrow();
    expect(() =>
      compiledCreateProjectInputSchema.parse({ ...valid, repositoryRoot: "" }),
    ).toThrow();
    const selection = {
      projectId: "project-1",
      expectedVersion: 0,
      idempotencyKey: "select-project",
    };
    expect(selectActiveProjectInputSchema.parse(selection)).toEqual(selection);
    expect(compiledSelectActiveProjectInputSchema.parse(selection)).toEqual(selection);
    expect(() =>
      selectActiveProjectInputSchema.parse({ ...selection, expectedVersion: -1 }),
    ).toThrow();
    expect(() =>
      compiledSelectActiveProjectInputSchema.parse({ ...selection, expectedVersion: -1 }),
    ).toThrow();
    const reviewMode = {
      projectId: "project-1",
      reviewMode: "required" as const,
      expectedVersion: 1,
      idempotencyKey: "review-mode",
    };
    expect(setProjectReviewModeInputSchema.parse(reviewMode)).toEqual(reviewMode);
    expect(compiledSetProjectReviewModeInputSchema.parse(reviewMode)).toEqual(reviewMode);
  });
});
