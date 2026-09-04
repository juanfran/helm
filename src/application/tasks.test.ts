import { createHash } from "node:crypto";
import { mkdir, mkdtemp, rm, symlink } from "node:fs/promises";
import { join, resolve } from "node:path";
import { tmpdir } from "node:os";
import { pathToFileURL } from "node:url";
import { Worker } from "node:worker_threads";

import { Effect, Either } from "effect";
import { afterEach, beforeEach, describe, expect, it } from "vitest";

import { registerAgentRun } from "./agents";
import { createProject, setProjectReviewMode } from "./projects";
import {
  archiveTask,
  claimNextTask,
  claimTask,
  completeTask,
  createTask,
  createTaskRelation,
  findWork,
  getTaskContext,
  invalidateTaskClaim,
  listTaskTags,
  listTasks,
  prepareTask,
  reconcileTaskLeases,
  releaseTaskLease,
  reopenTask,
  renewTaskLease,
  updateTaskPlanning,
} from "./tasks";
import {
  claimNextTaskInputSchema,
  claimTaskInputSchema,
  compiledClaimNextTaskInputSchema,
  compiledClaimTaskInputSchema,
  compiledCreateTaskRelationInputSchema,
  compiledCreateTaskInputSchema,
  compiledInvalidateTaskClaimInputSchema,
  compiledReleaseTaskLeaseInputSchema,
  compiledRenewTaskLeaseInputSchema,
  compiledUpdateTaskPlanningInputSchema,
  createTaskRelationInputSchema,
  createTaskInputSchema,
  emptyRichTextDocument,
  invalidateTaskClaimInputSchema,
  releaseTaskLeaseInputSchema,
  renewTaskLeaseInputSchema,
  updateTaskPlanningInputSchema,
  type Actor,
  type CreateTaskInput,
  type Task,
} from "../domain/tasks";
import type { RegisteredAgentRun } from "../domain/agents";
import { localRepositoryInspector } from "../infrastructure/repository-inspector.server";
import { createSqliteAgentStore } from "../infrastructure/sqlite-agent-store.server";
import {
  createSqliteProjectStore,
  type SqliteProjectStore,
} from "../infrastructure/sqlite-project-store.server";
import { createSqliteTaskStore } from "../infrastructure/sqlite-task-store.server";

const human: Actor = { type: "human", id: "local-human" };
const agent: Actor = { type: "agent", id: "run-42" };
let temporaryRoot: string;
let projectStore: SqliteProjectStore;
let projectId: string;
let taskServices: ReturnType<typeof taskFixtureServices>;
let databasePath: string;
let now: string;

type ConcurrentTaskOperation = {
  readonly command:
    | "claimTask"
    | "claimNextTask"
    | "renewTaskLease"
    | "releaseTaskLease"
    | "completeTask"
    | "failTask"
    | "cancelTask"
    | "invalidateTaskClaim"
    | "reconcileTaskLeases";
  readonly input?: unknown;
  readonly registration?: RegisteredAgentRun;
  readonly actor?: Actor;
  readonly now: string;
};

type ConcurrentTaskOutcome =
  | { readonly ok: true; readonly value: unknown }
  | {
      readonly ok: false;
      readonly error: {
        readonly _tag: string;
        readonly message: string;
        readonly reason?: string;
        readonly expectedVersion?: number;
        readonly currentVersion?: number;
      };
    };

function taskFixtureServices(store: SqliteProjectStore) {
  return {
    store: createSqliteTaskStore(store.database),
    clock: { today: () => "2026-09-03", now: () => now },
  };
}

async function registerAgent(
  profileKey: string,
  displayName: string,
  capabilities: readonly string[] = ["typescript"],
) {
  return Effect.runPromise(
    registerAgentRun(
      {
        profileKey,
        displayName,
        capabilities,
        idempotencyKey: `register-${profileKey}`,
      },
      {
        sessionId: `session-${profileKey}`,
        clientName: "application-test",
        clientVersion: "1.0.0",
      },
      { store: createSqliteAgentStore(projectStore.database) },
    ),
  );
}

function backlogInput(overrides: Partial<CreateTaskInput> = {}): CreateTaskInput {
  return {
    projectId,
    parentTaskId: null,
    lifecycle: "backlog",
    title: "Investigate flaky build",
    description: emptyRichTextDocument,
    expectedOutcome: "",
    acceptanceCriteria: "",
    agentContext: "",
    checklist: [],
    expectedVersion: 0,
    idempotencyKey: "create-task",
    ...overrides,
    referencedPaths: overrides.referencedPaths ?? [],
  };
}

function readyInput(overrides: Partial<CreateTaskInput> = {}): CreateTaskInput {
  return backlogInput({
    lifecycle: "ready",
    expectedOutcome: "The behavior is available.",
    acceptanceCriteria: "The verification is observable.",
    checklist: [{ id: "verify", text: "Verify the behavior", checked: false }],
    ...overrides,
  });
}

async function claimedTaskFixture(
  registration: RegisteredAgentRun,
  key: string,
  overrides: Partial<CreateTaskInput> = {},
) {
  const task = await Effect.runPromise(
    createTask(
      readyInput({
        title: `Claim fixture ${key}`,
        requiredCapabilities: ["typescript"],
        idempotencyKey: `create-${key}`,
        ...overrides,
      }),
      human,
      taskServices,
    ),
  );
  const command = {
    projectId,
    taskId: task.id,
    expectedVersion: task.version,
    leaseDurationSeconds: 300,
    idempotencyKey: `claim-${key}`,
  };
  const grant = await Effect.runPromise(claimTask(command, registration, taskServices));
  return { command, grant, task };
}

function completionReport(label: string) {
  return {
    resultSummary: `${label} completed.`,
    changedAreas: [`src/${label}.ts`],
    verificationResults: [
      { name: "Application tests", status: "passed" as const, details: "Passed." },
    ],
    references: [],
    risks: [],
    followUpWork: [],
  };
}

async function enableDirectCompletion(key: string) {
  const project = projectStore.database
    .prepare<[string], { version: number }>("select version from projects where id = ?")
    .get(projectId);
  if (!project) throw new Error("Expected the project fixture");
  await Effect.runPromise(
    setProjectReviewMode(
      {
        projectId,
        reviewMode: "direct",
        expectedVersion: project.version,
        idempotencyKey: `direct-${key}`,
      },
      human,
      { store: projectStore, inspector: localRepositoryInspector },
    ),
  );
}

async function completeReadyTask(task: Pick<Task, "id" | "version">, key: string) {
  await enableDirectCompletion(key);
  const registration = await registerAgent(`complete-${key}`, `Completer ${key}`);
  const grant = await Effect.runPromise(
    claimTask(
      {
        projectId,
        taskId: task.id,
        expectedVersion: task.version,
        idempotencyKey: `claim-complete-${key}`,
      },
      registration,
      taskServices,
    ),
  );
  const result = await Effect.runPromise(
    completeTask(
      {
        projectId,
        taskId: task.id,
        leaseToken: grant.leaseToken,
        expectedVersion: grant.task.version,
        report: completionReport(key),
        idempotencyKey: `complete-${key}`,
      },
      registration,
      taskServices,
    ),
  );
  return result.task;
}

function taskCommandWorkerSource() {
  const effectUrl = pathToFileURL(resolve("node_modules/effect/dist/esm/index.js")).href;
  const sqliteUrl = pathToFileURL(resolve("node_modules/better-sqlite3/lib/index.js")).href;
  const tsxApiUrl = pathToFileURL(resolve("node_modules/tsx/dist/esm/api/index.mjs")).href;
  const applicationUrl = pathToFileURL(resolve("src/application/tasks.ts")).href;
  const storeUrl = pathToFileURL(resolve("src/infrastructure/sqlite-task-store.server.ts")).href;
  const importerUrl = pathToFileURL(resolve("src/application/tasks.test.ts")).href;

  return `
    import { parentPort, workerData } from "node:worker_threads";
    import Database from ${JSON.stringify(sqliteUrl)};
    import { Effect } from ${JSON.stringify(effectUrl)};
    import { tsImport } from ${JSON.stringify(tsxApiUrl)};
    const {
      claimNextTask,
      claimTask,
      completeTask,
      failTask,
      cancelTask,
      invalidateTaskClaim,
      reconcileTaskLeases,
      releaseTaskLease,
      renewTaskLease,
    } = await tsImport(${JSON.stringify(applicationUrl)}, ${JSON.stringify(importerUrl)});
    const { createSqliteTaskStore } = await tsImport(
      ${JSON.stringify(storeUrl)},
      ${JSON.stringify(importerUrl)},
    );

    const barrier = new Int32Array(workerData.barrier);
    const database = new Database(workerData.databasePath);
    database.pragma("foreign_keys = ON");
    database.pragma("journal_mode = WAL");
    database.pragma("busy_timeout = 5000");
    const operation = workerData.operation;
    const services = {
      store: createSqliteTaskStore(database),
      clock: {
        today: () => operation.now.slice(0, 10),
        now: () => operation.now,
      },
    };
    const postOutcome = (outcome) => {
      Atomics.add(barrier, 3, 1);
      Atomics.notify(barrier, 3);
      parentPort.postMessage(outcome);
    };

    Atomics.add(barrier, 0, 1);
    Atomics.notify(barrier, 0);
    Atomics.wait(barrier, 1, 0);
    Atomics.add(barrier, 2, 1);
    Atomics.notify(barrier, 2);

    try {
      let effect;
      switch (operation.command) {
        case "claimTask":
          effect = claimTask(operation.input, operation.registration, services);
          break;
        case "claimNextTask":
          effect = claimNextTask(operation.input, operation.registration, services);
          break;
        case "renewTaskLease":
          effect = renewTaskLease(operation.input, operation.registration, services);
          break;
        case "releaseTaskLease":
          effect = releaseTaskLease(operation.input, operation.registration, services);
          break;
        case "completeTask":
          effect = completeTask(operation.input, operation.registration, services);
          break;
        case "failTask":
          effect = failTask(operation.input, operation.registration, services);
          break;
        case "cancelTask":
          effect = cancelTask(operation.input, operation.actor, services);
          break;
        case "invalidateTaskClaim":
          effect = invalidateTaskClaim(operation.input, operation.actor, services);
          break;
        case "reconcileTaskLeases":
          effect = reconcileTaskLeases(services);
          break;
        default:
          throw new Error(\`Unsupported worker command: \${operation.command}\`);
      }
      const result = await Effect.runPromise(Effect.either(effect));
      if (result._tag === "Right") {
        postOutcome({ ok: true, value: result.right });
      } else {
        const error = result.left;
        postOutcome({
          ok: false,
          error: {
            _tag: error?._tag ?? error?.name ?? "Error",
            message: error?.message ?? String(error),
            reason: error?.reason,
            expectedVersion: error?.expectedVersion,
            currentVersion: error?.currentVersion,
          },
        });
      }
    } catch (error) {
      postOutcome({
        ok: false,
        error: {
          _tag: error?._tag ?? error?.name ?? "Error",
          message: error?.message ?? String(error),
          reason: error?.reason,
          expectedVersion: error?.expectedVersion,
          currentVersion: error?.currentVersion,
        },
      });
    } finally {
      database.close();
      parentPort.close();
    }
  `;
}

// Each contention case starts fresh transpiling workers. Two-core hosted runners can spend much
// longer loading those modules than local machines, so these correctness tests need scheduling
// headroom without turning their assertions into timing tests.

function waitForBarrierCount(
  barrier: Int32Array<SharedArrayBuffer>,
  index: number,
  expected: number,
) {
  return new Promise<void>((settle, reject) => {
    const deadline = Date.now() + 10_000;
    const poll = () => {
      if (Atomics.load(barrier, index) >= expected) {
        settle();
      } else if (Date.now() >= deadline) {
        reject(new Error("Timed out waiting for task-command workers."));
      } else {
        setTimeout(poll, 1);
      }
    };
    poll();
  });
}

async function runContendingTaskOperations(
  operations: readonly ConcurrentTaskOperation[],
): Promise<readonly ConcurrentTaskOutcome[]> {
  const barrierBuffer = new SharedArrayBuffer(Int32Array.BYTES_PER_ELEMENT * 4);
  const barrier = new Int32Array(barrierBuffer);
  const source = taskCommandWorkerSource();
  const workers = operations.map(
    (operation) =>
      new Worker(new URL(`data:text/javascript,${encodeURIComponent(source)}`), {
        execArgv: [],
        workerData: { barrier: barrierBuffer, databasePath, operation },
      }),
  );
  const outcomesPromise = Promise.all(
    workers.map(
      (worker) =>
        new Promise<ConcurrentTaskOutcome>((settle, reject) => {
          worker.once("message", settle);
          worker.once("error", reject);
          worker.once("exit", (code) => {
            if (code !== 0) reject(new Error(`Task-command worker exited with code ${code}.`));
          });
        }),
    ),
  );
  // Observe startup failures immediately; awaiting the same promise below still propagates them.
  void outcomesPromise.catch(() => undefined);
  let blockingTransaction = false;

  try {
    await waitForBarrierCount(barrier, 0, workers.length);
    projectStore.database.exec("begin immediate");
    blockingTransaction = true;
    Atomics.store(barrier, 1, 1);
    Atomics.notify(barrier, 1, workers.length);
    await waitForBarrierCount(barrier, 2, workers.length);
    await new Promise((settle) => setTimeout(settle, 25));
    if (Atomics.load(barrier, 3) !== 0) {
      throw new Error("A contending task command escaped the held SQLite write transaction.");
    }
    projectStore.database.exec("commit");
    blockingTransaction = false;
    return await outcomesPromise;
  } finally {
    if (blockingTransaction) projectStore.database.exec("rollback");
    Atomics.store(barrier, 1, 1);
    Atomics.notify(barrier, 1, workers.length);
    await Promise.allSettled(workers.map((worker) => worker.terminate()));
  }
}

beforeEach(async () => {
  temporaryRoot = await mkdtemp(join(tmpdir(), "helm-task-test-"));
  const repositoryRoot = join(temporaryRoot, "repository");
  await mkdir(join(repositoryRoot, ".git"), { recursive: true });
  databasePath = join(temporaryRoot, "helm.db");
  now = "2026-09-03T12:00:00.000Z";
  projectStore = createSqliteProjectStore(databasePath);
  const project = await Effect.runPromise(
    createProject(
      { repositoryRoot, idempotencyKey: "project" },
      { store: projectStore, inspector: localRepositoryInspector },
    ),
  );
  projectId = project.id;
  taskServices = taskFixtureServices(projectStore);
});

afterEach(async () => {
  projectStore.close();
  await rm(temporaryRoot, { recursive: true, force: true });
});

describe("task application commands", () => {
  it("captures one title-only backlog task with an attributed event and retry-safe result", async () => {
    const command = backlogInput();
    const first = await Effect.runPromise(createTask(command, human, taskServices));
    const retry = await Effect.runPromise(createTask(command, human, taskServices));
    const visible = await Effect.runPromise(listTasks({ projectId }, taskServices));
    const event = projectStore.database
      .prepare<[], { kind: string; actorType: string; actorId: string }>(
        "select kind, actor_type as actorType, actor_id as actorId from events where entity_type = 'task'",
      )
      .get();
    const parsed = compiledCreateTaskInputSchema.parse(command);
    const {
      idempotencyKey: _idempotencyKey,
      referencedPaths: _referencedPaths,
      ...legacyCommand
    } = parsed;
    const legacyHash = createHash("sha256")
      .update(`task.create:${JSON.stringify(legacyCommand)}`)
      .digest("hex");
    const recordedHash = projectStore.database
      .prepare<[string], string>("select input_hash from idempotency_records where key = ?")
      .pluck()
      .get(command.idempotencyKey);

    expect(retry).toEqual(first);
    expect(recordedHash).toBe(legacyHash);
    expect(visible).toEqual([first]);
    expect(first).toMatchObject({ lifecycle: "backlog", version: 1, descriptionText: "" });
    expect(event).toEqual({ kind: "task.created", actorType: "human", actorId: "local-human" });
  });

  it("re-evaluates derived eligibility when an idempotent mutation is replayed", async () => {
    let today = "2026-09-03";
    taskServices = {
      store: taskServices.store,
      clock: { today: () => today, now: () => now },
    };
    const command = readyInput({
      title: "Scheduled TypeScript work",
      notBefore: "2026-09-04",
      requiredCapabilities: ["typescript"],
      idempotencyKey: "contextual-idempotent-result",
    });

    const scheduled = await Effect.runPromise(
      createTask(command, human, taskServices, ["typescript"]),
    );
    today = "2026-09-04";
    const capabilityMismatch = await Effect.runPromise(
      createTask(command, human, taskServices, []),
    );
    const claimable = await Effect.runPromise(
      createTask(command, human, taskServices, [" TypeScript ", "typescript"]),
    );

    expect(scheduled).toMatchObject({
      id: capabilityMismatch.id,
      version: 1,
      eligibility: { status: "scheduled", claimable: false },
    });
    expect(capabilityMismatch).toMatchObject({
      id: scheduled.id,
      version: 1,
      eligibility: { status: "capability_mismatch", claimable: false },
    });
    expect(claimable).toMatchObject({
      id: scheduled.id,
      version: 1,
      eligibility: { status: "claimable", claimable: true },
    });
    expect(
      projectStore.database
        .prepare("select count(*) from events where kind = 'task.created'")
        .pluck()
        .get(),
    ).toBe(1);
  });

  it("keeps replayed eligibility consistent with the cached task version", async () => {
    const blocker = await Effect.runPromise(
      createTask(
        readyInput({ title: "Blocker", idempotencyKey: "replay-blocker" }),
        human,
        taskServices,
      ),
    );
    const targetCommand = readyInput({
      title: "Target",
      idempotencyKey: "replay-target",
    });
    const target = await Effect.runPromise(createTask(targetCommand, human, taskServices));
    await Effect.runPromise(
      createTaskRelation(
        {
          projectId,
          sourceTaskId: blocker.id,
          targetTaskId: target.id,
          type: "blocks",
          expectedSourceVersion: blocker.version,
          expectedTargetVersion: target.version,
          idempotencyKey: "relation-after-cached-result",
        },
        human,
        taskServices,
      ),
    );

    const replay = await Effect.runPromise(createTask(targetCommand, human, taskServices));
    const current = (await Effect.runPromise(listTasks({ projectId }, taskServices))).find(
      (task) => task.id === target.id,
    );

    expect(replay).toMatchObject({
      version: 1,
      upstreamRelations: [],
      eligibility: { status: "claimable", blockingTaskIds: [] },
    });
    expect(current).toMatchObject({
      version: 2,
      upstreamRelations: [{ sourceTaskId: blocker.id, type: "blocks" }],
      eligibility: { status: "blocked", blockingTaskIds: [blocker.id] },
    });
  });

  it("rejects an unprepared ready task without writing a projection, event, or retry record", async () => {
    const result = await Effect.runPromise(
      Effect.either(createTask(backlogInput({ lifecycle: "ready" }), agent, taskServices)),
    );

    expect(Either.isLeft(result) && result.left["_tag"]).toBe("TaskPreparationError");
    if (Either.isLeft(result) && result.left["_tag"] === "TaskPreparationError") {
      expect(result.left.missingFields).toEqual([
        "expectedOutcome",
        "acceptanceCriteria",
        "checklist",
      ]);
    }
    expect(projectStore.database.prepare("select count(*) from tasks").pluck().get()).toBe(0);
    expect(
      projectStore.database
        .prepare("select count(*) from events where entity_type = 'task'")
        .pluck()
        .get(),
    ).toBe(0);
  });

  it("rejects symlink-escaping references atomically while allowing missing in-repository paths", async () => {
    const repositoryRoot = join(temporaryRoot, "repository");
    const outside = join(temporaryRoot, "outside");
    await mkdir(outside);
    await symlink(outside, join(repositoryRoot, "external"), "dir");

    const escaped = await Effect.runPromise(
      Effect.either(
        createTask(
          readyInput({
            referencedPaths: ["external/secret.ts"],
            idempotencyKey: "escaped-reference",
          }),
          human,
          taskServices,
        ),
      ),
    );
    const accepted = await Effect.runPromise(
      createTask(
        backlogInput({
          title: "Create a new in-repository file",
          referencedPaths: ["src/new/file.ts"],
          idempotencyKey: "missing-in-repository-reference",
        }),
        human,
        taskServices,
      ),
    );
    const escapedPreparation = await Effect.runPromise(
      Effect.either(
        prepareTask(
          {
            taskId: accepted.id,
            title: accepted.title,
            description: accepted.description,
            expectedOutcome: "The new file exists.",
            acceptanceCriteria: "The change is verified.",
            agentContext: "",
            checklist: [{ id: "verify", text: "Run tests", checked: false }],
            referencedPaths: ["external/secret.ts"],
            expectedVersion: accepted.version,
            idempotencyKey: "escaped-preparation-reference",
          },
          human,
          taskServices,
        ),
      ),
    );
    const [persisted] = await Effect.runPromise(listTasks({ projectId }, taskServices));

    expect(Either.isLeft(escaped) && escaped.left["_tag"]).toBe("TaskPathError");
    expect(Either.isLeft(escapedPreparation) && escapedPreparation.left["_tag"]).toBe(
      "TaskPathError",
    );
    expect(accepted.referencedPaths).toEqual(["src/new/file.ts"]);
    expect(persisted).toMatchObject({
      id: accepted.id,
      lifecycle: "backlog",
      version: 1,
      referencedPaths: ["src/new/file.ts"],
    });
    expect(projectStore.database.prepare("select count(*) from tasks").pluck().get()).toBe(1);
    expect(
      projectStore.database
        .prepare(
          "select count(*) from idempotency_records where key in ('escaped-reference', 'escaped-preparation-reference')",
        )
        .pluck()
        .get(),
    ).toBe(0);
  });

  it("revalidates selected discovery paths after the repository changes", async () => {
    const repositoryRoot = join(temporaryRoot, "repository");
    const referenceDirectory = join(repositoryRoot, "external");
    await mkdir(referenceDirectory);
    const task = await Effect.runPromise(
      createTask(
        readyInput({
          referencedPaths: ["external/file.ts"],
          idempotencyKey: "mutable-reference",
        }),
        human,
        taskServices,
      ),
    );

    await rm(referenceDirectory, { recursive: true, force: true });
    const outside = join(temporaryRoot, "outside-after-create");
    await mkdir(outside);
    await symlink(outside, referenceDirectory, "dir");

    const selectedPaths = await Effect.runPromise(
      Effect.either(findWork({ projectId, fields: ["referencedPaths"] }, [], taskServices)),
    );
    const compactDiscovery = await Effect.runPromise(findWork({ projectId }, [], taskServices));

    expect(Either.isLeft(selectedPaths) && selectedPaths.left["_tag"]).toBe("TaskPathError");
    expect(compactDiscovery.candidates).toMatchObject([{ id: task.id }]);
    expect(compactDiscovery.candidates[0]).not.toHaveProperty("referencedPaths");
  });

  it("prepares backlog work as ready and stores stable rich-text and plain-text projections", async () => {
    const backlog = await Effect.runPromise(createTask(backlogInput(), human, taskServices));
    const description = {
      version: 1 as const,
      doc: {
        type: "doc" as const,
        content: [
          {
            type: "heading",
            content: [{ type: "text", text: "Build signal" }],
          },
          {
            type: "paragraph",
            content: [{ type: "text", text: "Make retries visible." }],
          },
        ],
      },
    };
    const command = {
      taskId: backlog.id,
      title: backlog.title,
      description,
      expectedOutcome: "Operators can see retry state.",
      acceptanceCriteria: "A retry is visible before completion.",
      agentContext: "Keep the event cursor monotonic.",
      checklist: [{ id: "verify", text: "Run the application tests", checked: false }],
      expectedVersion: backlog.version,
      idempotencyKey: "prepare-task",
    };
    const prepared = await Effect.runPromise(prepareTask(command, agent, taskServices));
    const retry = await Effect.runPromise(prepareTask(command, agent, taskServices));
    const row = projectStore.database
      .prepare<[], { descriptionJson: string; descriptionText: string }>(
        "select description_json as descriptionJson, description_text as descriptionText from tasks",
      )
      .get();
    const event = projectStore.database
      .prepare<[], { actorType: string; actorId: string }>(
        "select actor_type as actorType, actor_id as actorId from events where kind = 'task.prepared'",
      )
      .get();

    expect(retry).toEqual(prepared);
    expect(prepared).toMatchObject({
      lifecycle: "ready",
      version: 2,
      description,
    });
    expect(prepared.descriptionText).toBe("Build signal\nMake retries visible.");
    expect(row).toEqual({
      descriptionJson: JSON.stringify(description),
      descriptionText: "Build signal\nMake retries visible.",
    });
    expect(event).toEqual({ actorType: "agent", actorId: "run-42" });
  });

  it("requires the explicit reopen command before a completed task can be prepared again", async () => {
    const ready = await Effect.runPromise(
      createTask(readyInput({ idempotencyKey: "ready-before-complete" }), human, taskServices),
    );
    const completed = await completeReadyTask(ready, "before-prepare");
    const eventCount = projectStore.database.prepare("select count(*) from events").pluck().get();

    const result = await Effect.runPromise(
      Effect.either(
        prepareTask(
          {
            taskId: completed.id,
            title: completed.title,
            description: completed.description,
            expectedOutcome: completed.expectedOutcome,
            acceptanceCriteria: completed.acceptanceCriteria,
            agentContext: completed.agentContext,
            checklist: completed.checklist,
            referencedPaths: completed.referencedPaths,
            expectedVersion: completed.version,
            idempotencyKey: "prepare-completed-task",
          },
          human,
          taskServices,
        ),
      ),
    );

    expect(Either.isLeft(result) && result.left["_tag"]).toBe("TaskLifecycleError");
    expect((await Effect.runPromise(listTasks({ projectId }, taskServices)))[0]?.lifecycle).toBe(
      "done",
    );
    expect(projectStore.database.prepare("select count(*) from events").pluck().get()).toBe(
      eventCount,
    );
  });

  it("returns a compact conflict and leaves state and history unchanged on a stale version", async () => {
    const backlog = await Effect.runPromise(createTask(backlogInput(), human, taskServices));
    const archived = await Effect.runPromise(
      archiveTask(
        {
          taskId: backlog.id,
          expectedVersion: backlog.version,
          reason: "No longer needed",
          idempotencyKey: "archive-first",
        },
        human,
        taskServices,
      ),
    );
    const eventCount = projectStore.database.prepare("select count(*) from events").pluck().get();
    const stale = await Effect.runPromise(
      Effect.either(
        archiveTask(
          {
            taskId: backlog.id,
            expectedVersion: backlog.version,
            reason: "Second archive",
            idempotencyKey: "archive-stale",
          },
          agent,
          taskServices,
        ),
      ),
    );

    expect(Either.isLeft(stale) && stale.left["_tag"]).toBe("TaskVersionConflictError");
    if (Either.isLeft(stale) && stale.left["_tag"] === "TaskVersionConflictError") {
      expect(stale.left).toMatchObject({
        currentVersion: archived.version,
        expectedVersion: 1,
      });
      expect(stale.left.changeSummary).toContain("archived");
    }
    expect(projectStore.database.prepare("select count(*) from events").pluck().get()).toBe(
      eventCount,
    );
  });

  it("archives work out of normal queues while retaining its data and audit history", async () => {
    const backlog = await Effect.runPromise(createTask(backlogInput(), human, taskServices));
    const command = {
      taskId: backlog.id,
      expectedVersion: backlog.version,
      reason: "Superseded by a smaller task",
      idempotencyKey: "archive-task",
    };
    const archived = await Effect.runPromise(archiveTask(command, human, taskServices));
    const retry = await Effect.runPromise(archiveTask(command, human, taskServices));
    const visible = await Effect.runPromise(listTasks({ projectId }, taskServices));
    const history = await Effect.runPromise(
      listTasks({ projectId, includeArchived: true }, taskServices),
    );

    expect(retry).toEqual(archived);
    expect(visible).toEqual([]);
    expect(history).toEqual([archived]);
    expect(archived).toMatchObject({
      id: backlog.id,
      title: backlog.title,
      version: 2,
    });
    expect(archived.archivedAt).not.toBeNull();
    expect(
      projectStore.database
        .prepare("select count(*) from events where entity_id = ?")
        .pluck()
        .get(backlog.id),
    ).toBe(2);
  });

  it("rolls projection and idempotency state back when the audit event fails", async () => {
    projectStore.database.exec(`
      create trigger reject_task_event
      before insert on events when NEW.kind = 'task.created'
      begin select raise(abort, 'event rejected'); end;
    `);
    const result = await Effect.runPromise(
      Effect.either(createTask(backlogInput(), human, taskServices)),
    );

    expect(Either.isLeft(result) && result.left["_tag"]).toBe("TaskPersistenceError");
    expect(projectStore.database.prepare("select count(*) from tasks").pluck().get()).toBe(0);
    expect(
      projectStore.database
        .prepare("select count(*) from idempotency_records where command = 'task.create'")
        .pluck()
        .get(),
    ).toBe(0);
  });

  it("excludes future work from claimable candidates without changing lifecycle", async () => {
    const scheduled = await Effect.runPromise(
      createTask(
        readyInput({
          title: "Starts tomorrow",
          notBefore: "2026-09-04",
          idempotencyKey: "scheduled",
        }),
        human,
        taskServices,
      ),
    );
    const boundary = await Effect.runPromise(
      createTask(
        readyInput({
          title: "Starts today",
          notBefore: "2026-09-03",
          idempotencyKey: "boundary",
        }),
        human,
        taskServices,
      ),
    );
    const listed = await Effect.runPromise(listTasks({ projectId }, taskServices));
    const { candidates } = await Effect.runPromise(
      findWork({ projectId, limit: 100 }, [], taskServices),
    );
    const spoofedClockCandidates = await Effect.runPromise(
      findWork({ projectId, limit: 100, now: "9999-12-31" }, [], taskServices),
    );

    expect(listed.find((task) => task.id === scheduled.id)).toMatchObject({
      lifecycle: "ready",
      eligibility: { claimable: false, status: "scheduled" },
    });
    expect(listed.find((task) => task.id === boundary.id)).toMatchObject({
      lifecycle: "ready",
      eligibility: { claimable: true, status: "claimable" },
    });
    expect(candidates.map((task) => task.id)).toEqual([boundary.id]);
    expect(spoofedClockCandidates.candidates.map((task) => task.id)).toEqual([boundary.id]);
  });

  it("orders candidates by priority, manual position, due date, and stable sequence", async () => {
    const lowDue = await Effect.runPromise(
      createTask(
        readyInput({
          title: "Low due soon",
          priority: "low",
          position: 1,
          dueAt: "2026-09-01",
          size: "s",
          idempotencyKey: "low-due",
        }),
        human,
        taskServices,
      ),
    );
    const urgentLater = await Effect.runPromise(
      createTask(
        readyInput({
          title: "Urgent later",
          priority: "urgent",
          position: 2,
          idempotencyKey: "urgent-later",
        }),
        human,
        taskServices,
      ),
    );
    const urgentFirst = await Effect.runPromise(
      createTask(
        readyInput({
          title: "Urgent first",
          priority: "urgent",
          position: 1,
          dueAt: "2026-09-10",
          idempotencyKey: "urgent-first",
        }),
        human,
        taskServices,
      ),
    );
    const urgentFirstEarlierDue = await Effect.runPromise(
      createTask(
        readyInput({
          title: "Urgent first earlier due",
          priority: "urgent",
          position: 1,
          dueAt: "2026-09-05",
          idempotencyKey: "urgent-first-earlier-due",
        }),
        human,
        taskServices,
      ),
    );
    const { candidates } = await Effect.runPromise(
      findWork({ projectId, limit: 100 }, [], taskServices),
    );

    expect(candidates.map((task) => task.id)).toEqual([
      urgentFirstEarlierDue.id,
      urgentFirst.id,
      urgentLater.id,
      lowDue.id,
    ]);
    expect(lowDue).toMatchObject({
      priority: "low",
      dueAt: "2026-09-01",
      size: "s",
    });
    expect(candidates[0]?.eligibility?.orderingExplanation).toContain("stable tie-breaker #4");
  });

  it("rejects a stale cursor when work changes and restarts without skipping", async () => {
    const first = await Effect.runPromise(
      createTask(
        readyInput({
          title: "First",
          position: 1,
          idempotencyKey: "page-first",
        }),
        human,
        taskServices,
      ),
    );
    const second = await Effect.runPromise(
      createTask(
        readyInput({
          title: "Second",
          position: 1,
          idempotencyKey: "page-second",
        }),
        human,
        taskServices,
      ),
    );
    const third = await Effect.runPromise(
      createTask(
        readyInput({
          title: "Third",
          position: 1,
          idempotencyKey: "page-third",
        }),
        human,
        taskServices,
      ),
    );
    const firstPage = await Effect.runPromise(findWork({ projectId, limit: 1 }, [], taskServices));
    if (!firstPage.nextCursor) throw new Error("Expected another discovery page");

    await completeReadyTask(first, "page-first");
    const stalePage = await Effect.runPromise(
      Effect.either(
        findWork({ projectId, limit: 1, cursor: firstPage.nextCursor }, [], taskServices),
      ),
    );
    const restartedPage = await Effect.runPromise(
      findWork({ projectId, limit: 1 }, [], taskServices),
    );

    expect(firstPage.candidates.map((task) => task.id)).toEqual([first.id]);
    expect(Either.isLeft(stalePage) && stalePage.left["_tag"]).toBe(
      "TaskDiscoveryCursorStaleError",
    );
    if (Either.isLeft(stalePage) && stalePage.left["_tag"] === "TaskDiscoveryCursorStaleError") {
      expect(stalePage.left.staleBecause).toBe("queue_changed");
    }
    expect(restartedPage.candidates.map((task) => task.id)).toEqual([second.id]);
    expect(restartedPage.candidates.map((task) => task.id)).not.toContain(third.id);
  });

  it("rejects a discovery cursor when the evaluation date changes", async () => {
    let today = "2026-09-03";
    taskServices = {
      store: taskServices.store,
      clock: { today: () => today, now: () => now },
    };
    const first = await Effect.runPromise(
      createTask(
        readyInput({
          title: "Available first",
          position: 2,
          idempotencyKey: "dated-first",
        }),
        human,
        taskServices,
      ),
    );
    const last = await Effect.runPromise(
      createTask(
        readyInput({
          title: "Available last",
          position: 3,
          idempotencyKey: "dated-last",
        }),
        human,
        taskServices,
      ),
    );
    const scheduled = await Effect.runPromise(
      createTask(
        readyInput({
          title: "Available tomorrow",
          position: 1,
          notBefore: "2026-09-04",
          idempotencyKey: "dated-scheduled",
        }),
        human,
        taskServices,
      ),
    );
    const firstPage = await Effect.runPromise(findWork({ projectId, limit: 1 }, [], taskServices));
    if (!firstPage.nextCursor) throw new Error("Expected another discovery page");

    today = "2026-09-04";
    const stalePage = await Effect.runPromise(
      Effect.either(
        findWork({ projectId, limit: 1, cursor: firstPage.nextCursor }, [], taskServices),
      ),
    );
    const restartedPage = await Effect.runPromise(
      findWork({ projectId, limit: 3 }, [], taskServices),
    );

    expect(firstPage.candidates.map((task) => task.id)).toEqual([first.id]);
    expect(last.position).toBe(3);
    if (Either.isLeft(stalePage) && stalePage.left["_tag"] === "TaskDiscoveryCursorStaleError") {
      expect(stalePage.left.staleBecause).toBe("evaluation_context_changed");
    } else {
      throw new Error("Expected the prior-date cursor to be stale");
    }
    expect(restartedPage.candidates.map((task) => task.id)).toEqual([
      scheduled.id,
      first.id,
      last.id,
    ]);
  });

  it("binds discovery cursors to normalized agent capabilities", async () => {
    const first = await Effect.runPromise(
      createTask(
        readyInput({
          title: "Open first",
          position: 2,
          idempotencyKey: "caps-first",
        }),
        human,
        taskServices,
      ),
    );
    const last = await Effect.runPromise(
      createTask(
        readyInput({
          title: "Open last",
          position: 3,
          idempotencyKey: "caps-last",
        }),
        human,
        taskServices,
      ),
    );
    const restricted = await Effect.runPromise(
      createTask(
        readyInput({
          title: "GPU first",
          position: 1,
          requiredCapabilities: ["GPU"],
          idempotencyKey: "caps-restricted",
        }),
        human,
        taskServices,
      ),
    );
    const withoutCapabilities = await Effect.runPromise(
      findWork({ projectId, limit: 1 }, [], taskServices),
    );
    if (!withoutCapabilities.nextCursor) throw new Error("Expected another discovery page");

    const stalePage = await Effect.runPromise(
      Effect.either(
        findWork(
          { projectId, limit: 1, cursor: withoutCapabilities.nextCursor },
          ["gpu"],
          taskServices,
        ),
      ),
    );
    const restartedPage = await Effect.runPromise(
      findWork({ projectId, limit: 1 }, [" GPU ", "gpu"], taskServices),
    );
    if (!restartedPage.nextCursor) throw new Error("Expected another discovery page");
    const normalizedContinuation = await Effect.runPromise(
      findWork({ projectId, limit: 1, cursor: restartedPage.nextCursor }, ["gpu"], taskServices),
    );

    expect(withoutCapabilities.candidates.map((task) => task.id)).toEqual([first.id]);
    expect(last.position).toBe(3);
    if (Either.isLeft(stalePage) && stalePage.left["_tag"] === "TaskDiscoveryCursorStaleError") {
      expect(stalePage.left.staleBecause).toBe("evaluation_context_changed");
    } else {
      throw new Error("Expected the changed-capabilities cursor to be stale");
    }
    expect(restartedPage.candidates.map((task) => task.id)).toEqual([restricted.id]);
    expect(normalizedContinuation.candidates.map((task) => task.id)).toEqual([first.id]);
  });

  it("stores tag definitions and rejects mutually exclusive assignments in the same group", async () => {
    const task = await Effect.runPromise(
      createTask(readyInput({ idempotencyKey: "tagged" }), human, taskServices),
    );
    const tagged = await Effect.runPromise(
      updateTaskPlanning(
        {
          taskId: task.id,
          priority: "high",
          position: 3,
          notBefore: null,
          dueAt: "2026-09-12",
          size: "m",
          tags: [
            {
              name: "frontend",
              description: "Browser work",
              color: "#2563eb",
              exclusiveGroup: "area",
            },
          ],
          requiredCapabilities: [],
          expectedVersion: task.version,
          idempotencyKey: "tag-task",
        },
        human,
        taskServices,
      ),
    );
    const eventCount = projectStore.database.prepare("select count(*) from events").pluck().get();
    const invalid = await Effect.runPromise(
      Effect.either(
        updateTaskPlanning(
          {
            taskId: task.id,
            priority: "high",
            position: 3,
            notBefore: null,
            dueAt: null,
            size: null,
            tags: [
              {
                name: "frontend",
                description: "Browser work",
                color: "#2563eb",
                exclusiveGroup: "area",
              },
              {
                name: "backend",
                description: "Server work",
                color: "#16a34a",
                exclusiveGroup: "area",
              },
            ],
            requiredCapabilities: [],
            expectedVersion: tagged.version,
            idempotencyKey: "invalid-exclusive-tags",
          },
          human,
          taskServices,
        ),
      ),
    );

    expect(tagged).toMatchObject({
      priority: "high",
      position: 3,
      dueAt: "2026-09-12",
      size: "m",
      tags: [
        {
          name: "frontend",
          description: "Browser work",
          color: "#2563eb",
          exclusiveGroup: "area",
        },
      ],
    });
    expect(Either.isLeft(invalid) && invalid.left["_tag"]).toBe("TaskTagConstraintError");
    expect(projectStore.database.prepare("select count(*) from events").pluck().get()).toBe(
      eventCount,
    );

    await Effect.runPromise(
      archiveTask(
        {
          taskId: tagged.id,
          expectedVersion: tagged.version,
          reason: "Verify retained project tag catalog",
          idempotencyKey: "archive-canonical-tag-task",
        },
        human,
        taskServices,
      ),
    );
    expect(await Effect.runPromise(listTaskTags({ projectId }, taskServices))).toEqual(tagged.tags);
  });

  it("keeps project tag definitions canonical when another task assigns the same name", async () => {
    const tagged = await Effect.runPromise(
      createTask(
        readyInput({
          title: "Canonical tags",
          tags: [
            {
              name: "frontend",
              description: "Browser work",
              color: "#2563eb",
              exclusiveGroup: "area",
            },
          ],
          idempotencyKey: "canonical-tag-task",
        }),
        human,
        taskServices,
      ),
    );
    const other = await Effect.runPromise(
      createTask(
        readyInput({ title: "Other task", idempotencyKey: "other-tag-task" }),
        human,
        taskServices,
      ),
    );
    const eventCount = projectStore.database.prepare("select count(*) from events").pluck().get();

    const conflict = await Effect.runPromise(
      Effect.either(
        updateTaskPlanning(
          {
            taskId: other.id,
            priority: other.priority,
            position: other.position,
            notBefore: null,
            dueAt: null,
            size: null,
            tags: [
              {
                name: "frontend",
                description: "Silently rewritten metadata",
                color: "#ff0000",
                exclusiveGroup: null,
              },
            ],
            requiredCapabilities: [],
            expectedVersion: other.version,
            idempotencyKey: "conflicting-tag-definition",
          },
          human,
          taskServices,
        ),
      ),
    );
    const tasksAfterConflict = await Effect.runPromise(listTasks({ projectId }, taskServices));

    expect(Either.isLeft(conflict) && conflict.left["_tag"]).toBe("TaskTagDefinitionConflictError");
    expect(tasksAfterConflict.find((task) => task.id === tagged.id)?.tags).toEqual(tagged.tags);
    expect(tasksAfterConflict.find((task) => task.id === other.id)?.version).toBe(other.version);
    expect(projectStore.database.prepare("select count(*) from events").pluck().get()).toBe(
      eventCount,
    );
  });

  it("matches required capabilities and returns them in task context", async () => {
    const task = await Effect.runPromise(
      createTask(
        readyInput({
          title: "Needs React and SQLite",
          requiredCapabilities: ["sqlite", "react"],
          idempotencyKey: "capability-task",
        }),
        agent,
        taskServices,
      ),
    );
    const missing = await Effect.runPromise(listTasks({ projectId }, taskServices, ["react"]));
    const incompatibleCandidates = (
      await Effect.runPromise(findWork({ projectId, limit: 100 }, ["react"], taskServices))
    ).candidates;
    const compatibleCandidates = (
      await Effect.runPromise(
        findWork({ projectId, limit: 100 }, ["sqlite", "react"], taskServices),
      )
    ).candidates;
    const context = await Effect.runPromise(
      getTaskContext({ projectId, taskId: task.id }, ["SQLITE", "React"], taskServices),
    );

    expect(task.requiredCapabilities).toEqual(["react", "sqlite"]);
    expect(missing[0]).toMatchObject({
      eligibility: {
        claimable: false,
        status: "capability_mismatch",
        missingCapabilities: ["sqlite"],
      },
    });
    expect(incompatibleCandidates).toEqual([]);
    expect(compatibleCandidates[0]).toMatchObject({
      id: task.id,
      requiredCapabilities: ["react", "sqlite"],
      eligibility: { claimable: true },
    });
    expect(context.task.eligibility).toMatchObject({
      claimable: true,
      missingCapabilities: [],
    });
  });

  it("rejects stale planning updates without changing routing state or history", async () => {
    const task = await Effect.runPromise(
      createTask(readyInput({ idempotencyKey: "stale-routing" }), human, taskServices),
    );
    const updated = await Effect.runPromise(
      updateTaskPlanning(
        {
          taskId: task.id,
          priority: "urgent",
          position: 1,
          notBefore: null,
          dueAt: null,
          size: null,
          tags: [],
          requiredCapabilities: [],
          expectedVersion: task.version,
          idempotencyKey: "routing-first",
        },
        human,
        taskServices,
      ),
    );
    const eventCount = projectStore.database.prepare("select count(*) from events").pluck().get();
    const stale = await Effect.runPromise(
      Effect.either(
        updateTaskPlanning(
          {
            taskId: task.id,
            priority: "low",
            position: 99,
            notBefore: "2026-09-10",
            dueAt: "2026-09-11",
            size: "xl",
            tags: [],
            requiredCapabilities: ["react"],
            expectedVersion: task.version,
            idempotencyKey: "routing-stale",
          },
          agent,
          taskServices,
        ),
      ),
    );
    const listed = await Effect.runPromise(listTasks({ projectId }, taskServices));

    expect(updated).toMatchObject({ priority: "urgent", version: 2 });
    expect(Either.isLeft(stale) && stale.left["_tag"]).toBe("TaskVersionConflictError");
    expect(listed[0]).toMatchObject({
      priority: "urgent",
      position: 1,
      version: 2,
    });
    expect(projectStore.database.prepare("select count(*) from events").pluck().get()).toBe(
      eventCount,
    );
  });

  it("allows one level of child tasks and rejects deeper nesting atomically", async () => {
    const parent = await Effect.runPromise(
      createTask(
        backlogInput({ title: "Parent task", idempotencyKey: "parent" }),
        human,
        taskServices,
      ),
    );
    const child = await Effect.runPromise(
      createTask(
        backlogInput({
          parentTaskId: parent.id,
          title: "Child task",
          idempotencyKey: "child",
        }),
        human,
        taskServices,
      ),
    );
    const eventCount = projectStore.database.prepare("select count(*) from events").pluck().get();
    const deeper = await Effect.runPromise(
      Effect.either(
        createTask(
          backlogInput({
            parentTaskId: child.id,
            title: "Too deep",
            idempotencyKey: "grandchild",
          }),
          agent,
          taskServices,
        ),
      ),
    );
    const listed = await Effect.runPromise(listTasks({ projectId }, taskServices));

    expect(listed.find((task) => task.id === parent.id)).toMatchObject({
      childTaskIds: [child.id],
    });
    expect(listed.find((task) => task.id === child.id)).toMatchObject({
      parentTaskId: parent.id,
      childTaskIds: [],
    });
    expect(Either.isLeft(deeper) && deeper.left["_tag"]).toBe("TaskNestingError");
    expect(projectStore.database.prepare("select count(*) from tasks").pluck().get()).toBe(2);
    expect(projectStore.database.prepare("select count(*) from events").pluck().get()).toBe(
      eventCount,
    );
  });

  it("rejects adding a child to a claimed parent without changing its derived children", async () => {
    const registration = await registerAgent("claimed-parent-owner", "Claimed Parent Owner");
    const parent = await Effect.runPromise(
      createTask(
        readyInput({
          title: "Claimed parent",
          requiredCapabilities: ["typescript"],
          idempotencyKey: "create-claimed-parent",
        }),
        human,
        taskServices,
      ),
    );
    const grant = await Effect.runPromise(
      claimTask(
        {
          projectId,
          taskId: parent.id,
          expectedVersion: parent.version,
          idempotencyKey: "claim-parent-before-child",
        },
        registration,
        taskServices,
      ),
    );
    const eventCount = projectStore.database.prepare("select count(*) from events").pluck().get();
    const result = await Effect.runPromise(
      Effect.either(
        createTask(
          backlogInput({
            parentTaskId: parent.id,
            title: "Rejected child of claimed parent",
            idempotencyKey: "child-of-claimed-parent",
          }),
          human,
          taskServices,
        ),
      ),
    );
    const [storedParent] = await Effect.runPromise(
      listTasks({ projectId }, taskServices, registration.profile.capabilities),
    );

    expect(Either.isLeft(result) && result.left).toMatchObject({
      _tag: "TaskLifecycleError",
      taskId: parent.id,
      lifecycle: "in_progress",
    });
    expect(storedParent).toMatchObject({
      id: parent.id,
      lifecycle: "in_progress",
      version: grant.task.version,
      childTaskIds: [],
    });
    expect(projectStore.database.prepare("select count(*) from tasks").pluck().get()).toBe(1);
    expect(projectStore.database.prepare("select count(*) from events").pluck().get()).toBe(
      eventCount,
    );
    expect(
      projectStore.database
        .prepare("select count(*) from idempotency_records where key = ?")
        .pluck()
        .get("child-of-claimed-parent"),
    ).toBe(0);
  });

  it("creates typed relations and only incomplete blocking dependencies affect eligibility", async () => {
    const blocker = await Effect.runPromise(
      createTask(readyInput({ title: "Blocker", idempotencyKey: "blocker" }), human, taskServices),
    );
    const dependent = await Effect.runPromise(
      createTask(
        readyInput({ title: "Dependent", idempotencyKey: "dependent" }),
        human,
        taskServices,
      ),
    );
    const related = await Effect.runPromise(
      createTask(readyInput({ title: "Related", idempotencyKey: "related" }), human, taskServices),
    );
    const blockingRelation = await Effect.runPromise(
      createTaskRelation(
        {
          projectId,
          sourceTaskId: blocker.id,
          targetTaskId: dependent.id,
          type: "blocks",
          expectedSourceVersion: blocker.version,
          expectedTargetVersion: dependent.version,
          idempotencyKey: "blocker-blocks-dependent",
        },
        agent,
        taskServices,
      ),
    );
    const retry = await Effect.runPromise(
      createTaskRelation(
        {
          projectId,
          sourceTaskId: blocker.id,
          targetTaskId: dependent.id,
          type: "blocks",
          expectedSourceVersion: blocker.version,
          expectedTargetVersion: dependent.version,
          idempotencyKey: "blocker-blocks-dependent",
        },
        agent,
        taskServices,
      ),
    );
    const afterBlocking = await Effect.runPromise(listTasks({ projectId }, taskServices));
    const blockedDependent = afterBlocking.find((task) => task.id === dependent.id);
    const blockerAfterRelation = afterBlocking.find((task) => task.id === blocker.id);
    if (!blockedDependent || !blockerAfterRelation) throw new Error("Expected related tasks");

    await Effect.runPromise(
      createTaskRelation(
        {
          projectId,
          sourceTaskId: related.id,
          targetTaskId: dependent.id,
          type: "related_to",
          expectedSourceVersion: related.version,
          expectedTargetVersion: blockedDependent.version,
          idempotencyKey: "related-to-dependent",
        },
        human,
        taskServices,
      ),
    );
    const blockedCandidates = (
      await Effect.runPromise(findWork({ projectId, limit: 100 }, [], taskServices))
    ).candidates;
    const completedBlocker = await completeReadyTask(blockerAfterRelation, "blocker");
    const unblocked = await Effect.runPromise(listTasks({ projectId }, taskServices));
    const reopenedBlocker = (
      await Effect.runPromise(
        reopenTask(
          {
            taskId: blocker.id,
            expectedVersion: completedBlocker.version,
            reason: "Need more work",
            idempotencyKey: "reopen-blocker",
          },
          human,
          taskServices,
        ),
      )
    ).task;
    const reblocked = await Effect.runPromise(listTasks({ projectId }, taskServices));
    const lifecycleEventHints = projectStore.database
      .prepare<[string], { kind: string; changesJson: string }>(
        `select kind, changes_json as changesJson
        from events
        where entity_id = ? and kind in ('task.completed', 'task.reopened')
        order by cursor`,
      )
      .all(blocker.id);

    expect(retry).toEqual(blockingRelation);
    expect(blockingRelation).toMatchObject({
      type: "blocks",
      sourceSequence: blocker.sequence,
      targetSequence: dependent.sequence,
    });
    expect(blockedDependent).toMatchObject({
      eligibility: {
        claimable: false,
        status: "blocked",
        blockingTaskIds: [blocker.id],
      },
      upstreamRelations: [expect.objectContaining({ type: "blocks" })],
    });
    expect(blockedCandidates.map((task) => task.id)).not.toContain(dependent.id);
    expect(unblocked.find((task) => task.id === dependent.id)).toMatchObject({
      eligibility: {
        claimable: true,
        status: "claimable",
        blockingTaskIds: [],
      },
      upstreamRelations: [
        expect.objectContaining({ type: "blocks" }),
        expect.objectContaining({ type: "related_to" }),
      ],
    });
    expect(reopenedBlocker.lifecycle).toBe("ready");
    expect(reblocked.find((task) => task.id === dependent.id)).toMatchObject({
      eligibility: {
        claimable: false,
        status: "blocked",
        blockingTaskIds: [blocker.id],
      },
    });
    expect(lifecycleEventHints.map((event) => event.kind)).toEqual([
      "task.completed",
      "task.reopened",
    ]);
    for (const event of lifecycleEventHints) {
      expect(JSON.parse(event.changesJson)).toMatchObject({
        taskIds: [blocker.id, dependent.id].toSorted(),
        scopes: expect.arrayContaining(["tasks"]),
      });
    }
  });

  it("treats an archived blocker as withdrawn instead of stranding its dependent", async () => {
    const blocker = await Effect.runPromise(
      createTask(
        readyInput({
          title: "Withdrawn blocker",
          idempotencyKey: "withdrawn-blocker",
        }),
        human,
        taskServices,
      ),
    );
    const dependent = await Effect.runPromise(
      createTask(
        readyInput({
          title: "Dependent work",
          idempotencyKey: "withdrawn-dependent",
        }),
        human,
        taskServices,
      ),
    );
    await Effect.runPromise(
      createTaskRelation(
        {
          projectId,
          sourceTaskId: blocker.id,
          targetTaskId: dependent.id,
          type: "blocks",
          expectedSourceVersion: blocker.version,
          expectedTargetVersion: dependent.version,
          idempotencyKey: "withdrawn-blocking-relation",
        },
        human,
        taskServices,
      ),
    );
    const blockedTasks = await Effect.runPromise(listTasks({ projectId }, taskServices));
    const currentBlocker = blockedTasks.find((task) => task.id === blocker.id);
    if (!currentBlocker) throw new Error("Expected the blocker");

    await Effect.runPromise(
      archiveTask(
        {
          taskId: blocker.id,
          expectedVersion: currentBlocker.version,
          reason: "The dependency was withdrawn",
          idempotencyKey: "archive-withdrawn-blocker",
        },
        human,
        taskServices,
      ),
    );
    const afterArchive = await Effect.runPromise(listTasks({ projectId }, taskServices));
    const archiveEvent = projectStore.database
      .prepare<[string], { changesJson: string }>(
        "select changes_json as changesJson from events where entity_id = ? and kind = 'task.archived'",
      )
      .get(blocker.id);

    expect(afterArchive.find((task) => task.id === dependent.id)).toMatchObject({
      eligibility: {
        claimable: true,
        status: "claimable",
        blockingTaskIds: [],
      },
      upstreamRelations: [expect.objectContaining({ sourceTaskId: blocker.id, type: "blocks" })],
    });
    expect(JSON.parse(archiveEvent!.changesJson)).toMatchObject({
      taskIds: [blocker.id, dependent.id].toSorted(),
      scopes: ["tasks"],
    });
  });

  it("rejects self-links and blocking cycles with an explainable path", async () => {
    const first = await Effect.runPromise(
      createTask(
        readyInput({ title: "First", idempotencyKey: "cycle-first" }),
        human,
        taskServices,
      ),
    );
    const second = await Effect.runPromise(
      createTask(
        readyInput({ title: "Second", idempotencyKey: "cycle-second" }),
        human,
        taskServices,
      ),
    );
    const third = await Effect.runPromise(
      createTask(
        readyInput({ title: "Third", idempotencyKey: "cycle-third" }),
        human,
        taskServices,
      ),
    );
    const self = await Effect.runPromise(
      Effect.either(
        createTaskRelation(
          {
            projectId,
            sourceTaskId: first.id,
            targetTaskId: first.id,
            type: "related_to",
            expectedSourceVersion: first.version,
            expectedTargetVersion: first.version,
            idempotencyKey: "self-link",
          },
          human,
          taskServices,
        ),
      ),
    );

    await Effect.runPromise(
      createTaskRelation(
        {
          projectId,
          sourceTaskId: first.id,
          targetTaskId: second.id,
          type: "blocks",
          expectedSourceVersion: first.version,
          expectedTargetVersion: second.version,
          idempotencyKey: "first-blocks-second",
        },
        human,
        taskServices,
      ),
    );
    const afterFirstEdge = await Effect.runPromise(listTasks({ projectId }, taskServices));
    const firstAfterEdge = afterFirstEdge.find((task) => task.id === first.id);
    const secondAfterEdge = afterFirstEdge.find((task) => task.id === second.id);
    if (!firstAfterEdge || !secondAfterEdge) throw new Error("Expected first blocking edge");
    await Effect.runPromise(
      createTaskRelation(
        {
          projectId,
          sourceTaskId: second.id,
          targetTaskId: third.id,
          type: "blocks",
          expectedSourceVersion: secondAfterEdge.version,
          expectedTargetVersion: third.version,
          idempotencyKey: "second-blocks-third",
        },
        human,
        taskServices,
      ),
    );
    const afterSecondEdge = await Effect.runPromise(listTasks({ projectId }, taskServices));
    const firstBeforeCycle = afterSecondEdge.find((task) => task.id === first.id);
    const thirdBeforeCycle = afterSecondEdge.find((task) => task.id === third.id);
    if (!firstBeforeCycle || !thirdBeforeCycle) throw new Error("Expected second blocking edge");
    const eventCount = projectStore.database.prepare("select count(*) from events").pluck().get();
    const cycle = await Effect.runPromise(
      Effect.either(
        createTaskRelation(
          {
            projectId,
            sourceTaskId: third.id,
            targetTaskId: first.id,
            type: "blocks",
            expectedSourceVersion: thirdBeforeCycle.version,
            expectedTargetVersion: firstBeforeCycle.version,
            idempotencyKey: "third-blocks-first",
          },
          agent,
          taskServices,
        ),
      ),
    );

    expect(Either.isLeft(self) && self.left["_tag"]).toBe("TaskRelationError");
    expect(Either.isLeft(cycle) && cycle.left["_tag"]).toBe("TaskRelationError");
    if (Either.isLeft(cycle) && cycle.left["_tag"] === "TaskRelationError") {
      expect(cycle.left.relationPath).toEqual(["#3", "#1", "#2", "#3"]);
    }
    expect(projectStore.database.prepare("select count(*) from task_relations").pluck().get()).toBe(
      2,
    );
    expect(projectStore.database.prepare("select count(*) from events").pluck().get()).toBe(
      eventCount,
    );
  });

  it("returns a typed error for a duplicate relation without partial writes", async () => {
    const source = await Effect.runPromise(
      createTask(
        readyInput({
          title: "Duplicate source",
          idempotencyKey: "duplicate-source",
        }),
        human,
        taskServices,
      ),
    );
    const target = await Effect.runPromise(
      createTask(
        readyInput({
          title: "Duplicate target",
          idempotencyKey: "duplicate-target",
        }),
        human,
        taskServices,
      ),
    );
    await Effect.runPromise(
      createTaskRelation(
        {
          projectId,
          sourceTaskId: source.id,
          targetTaskId: target.id,
          type: "related_to",
          expectedSourceVersion: source.version,
          expectedTargetVersion: target.version,
          idempotencyKey: "first-duplicate-relation",
        },
        human,
        taskServices,
      ),
    );
    const [currentSource, currentTarget] = (
      await Effect.runPromise(listTasks({ projectId }, taskServices))
    ).filter((task) => task.id === source.id || task.id === target.id);
    if (!currentSource || !currentTarget) throw new Error("Expected both related tasks");
    const eventCount = projectStore.database.prepare("select count(*) from events").pluck().get();

    const duplicate = await Effect.runPromise(
      Effect.either(
        createTaskRelation(
          {
            projectId,
            sourceTaskId: source.id,
            targetTaskId: target.id,
            type: "related_to",
            expectedSourceVersion: currentSource.version,
            expectedTargetVersion: currentTarget.version,
            idempotencyKey: "second-duplicate-relation",
          },
          agent,
          taskServices,
        ),
      ),
    );

    expect(Either.isLeft(duplicate) && duplicate.left["_tag"]).toBe("TaskRelationError");
    expect(projectStore.database.prepare("select count(*) from task_relations").pluck().get()).toBe(
      1,
    );
    expect(projectStore.database.prepare("select count(*) from events").pluck().get()).toBe(
      eventCount,
    );
  });

  it("rejects stale relation versions without changing graph or audit history", async () => {
    const source = await Effect.runPromise(
      createTask(
        readyInput({ title: "Source", idempotencyKey: "stale-source" }),
        human,
        taskServices,
      ),
    );
    const target = await Effect.runPromise(
      createTask(
        readyInput({ title: "Target", idempotencyKey: "stale-target" }),
        human,
        taskServices,
      ),
    );
    await Effect.runPromise(
      updateTaskPlanning(
        {
          taskId: target.id,
          priority: "high",
          position: 1,
          notBefore: null,
          dueAt: null,
          size: null,
          tags: [],
          requiredCapabilities: [],
          expectedVersion: target.version,
          idempotencyKey: "change-target-version",
        },
        human,
        taskServices,
      ),
    );
    const eventCount = projectStore.database.prepare("select count(*) from events").pluck().get();
    const stale = await Effect.runPromise(
      Effect.either(
        createTaskRelation(
          {
            projectId,
            sourceTaskId: source.id,
            targetTaskId: target.id,
            type: "blocks",
            expectedSourceVersion: source.version,
            expectedTargetVersion: target.version,
            idempotencyKey: "stale-relation-version",
          },
          agent,
          taskServices,
        ),
      ),
    );

    expect(Either.isLeft(stale) && stale.left["_tag"]).toBe("TaskVersionConflictError");
    expect(projectStore.database.prepare("select count(*) from task_relations").pluck().get()).toBe(
      0,
    );
    expect(projectStore.database.prepare("select count(*) from events").pluck().get()).toBe(
      eventCount,
    );
  });

  it("claims chosen work atomically, returns an idempotent grant, and enforces active uniqueness", async () => {
    const registration = await registerAgent("chosen-agent", "Chosen Agent");
    const { command, grant, task } = await claimedTaskFixture(registration, "chosen");
    const retry = await Effect.runPromise(claimTask(command, registration, taskServices));
    const storedTask = projectStore.database
      .prepare<[string], { lifecycle: string; version: number }>(
        "select lifecycle, version from tasks where id = ?",
      )
      .get(task.id);
    const storedAttempt = projectStore.database
      .prepare<
        [string],
        {
          id: string;
          agentRunId: string;
          status: string;
          completedAt: string | null;
        }
      >(
        "select id, agent_run_id as agentRunId, status, completed_at as completedAt from attempts where task_id = ?",
      )
      .get(task.id);
    const storedLease = projectStore.database
      .prepare<
        [string],
        {
          id: string;
          attemptId: string;
          agentRunId: string;
          tokenHash: string;
          status: string;
          expiresAt: string;
        }
      >(
        "select id, attempt_id as attemptId, agent_run_id as agentRunId, token_hash as tokenHash, status, expires_at as expiresAt from leases where task_id = ?",
      )
      .get(task.id);
    const claimEvents = projectStore.database
      .prepare<[string], { actorType: string; actorId: string; payload: string }>(
        "select actor_type as actorType, actor_id as actorId, payload_json as payload from events where entity_id = ? and kind = 'task.claimed'",
      )
      .all(task.id);

    expect(retry).toEqual(grant);
    expect(grant).toMatchObject({
      task: {
        id: task.id,
        lifecycle: "in_progress",
        version: 2,
        claim: { id: grant.claim.id, status: "active" },
        eligibility: { status: "claimed", claimable: false },
      },
      attempt: {
        id: grant.claim.attemptId,
        taskId: task.id,
        agentRunId: registration.run.id,
        status: "active",
      },
      claim: {
        taskId: task.id,
        agentRunId: registration.run.id,
        agentProfileId: registration.profile.id,
        agentDisplayName: "Chosen Agent",
        status: "active",
        acquiredAt: now,
        expiresAt: "2026-09-03T12:05:00.000Z",
      },
      leaseToken: expect.any(String),
    });
    expect(storedTask).toEqual({ lifecycle: "in_progress", version: 2 });
    expect(storedAttempt).toEqual({
      id: grant.attempt.id,
      agentRunId: registration.run.id,
      status: "active",
      completedAt: null,
    });
    expect(storedLease).toMatchObject({
      id: grant.claim.id,
      attemptId: grant.attempt.id,
      agentRunId: registration.run.id,
      tokenHash: createHash("sha256").update(grant.leaseToken).digest("hex"),
      status: "active",
      expiresAt: "2026-09-03T12:05:00.000Z",
    });
    expect(claimEvents).toHaveLength(1);
    expect(claimEvents[0]).toMatchObject({
      actorType: "agent",
      actorId: registration.run.id,
    });
    expect(JSON.parse(claimEvents[0]!.payload)).toMatchObject({
      leaseId: grant.claim.id,
      attemptId: grant.attempt.id,
      previousVersion: 1,
      version: 2,
      selection: "chosen",
    });
    expect(
      projectStore.database
        .prepare("select count(*) from idempotency_records where command = 'task.claim'")
        .pluck()
        .get(),
    ).toBe(1);

    expect(() =>
      projectStore.database
        .prepare(
          "insert into attempts (id, task_id, agent_run_id, status, summary, verification_json, created_at, completed_at) values (?, ?, ?, 'active', '', '[]', ?, null)",
        )
        .run("duplicate-active-attempt", task.id, registration.run.id, now),
    ).toThrow(/UNIQUE constraint failed/);
    expect(() =>
      projectStore.database
        .prepare(
          "insert into leases (id, task_id, attempt_id, agent_run_id, token_hash, status, acquired_at, expires_at, invalidated_at, invalidation_reason) values (?, ?, ?, ?, ?, 'active', ?, ?, null, null)",
        )
        .run(
          "duplicate-active-lease",
          task.id,
          grant.attempt.id,
          registration.run.id,
          "different-token-hash",
          now,
          "2026-09-03T12:10:00.000Z",
        ),
    ).toThrow(/UNIQUE constraint failed/);
  });

  it("claims the next task by Helm ranking and replays the same selection safely", async () => {
    const registration = await registerAgent("ranking-agent", "Ranking Agent");
    const low = await Effect.runPromise(
      createTask(
        readyInput({
          title: "Low ranked task",
          priority: "low",
          position: 1,
          requiredCapabilities: ["typescript"],
          idempotencyKey: "create-low-ranked-claim",
        }),
        human,
        taskServices,
      ),
    );
    const urgent = await Effect.runPromise(
      createTask(
        readyInput({
          title: "Urgent ranked task",
          priority: "urgent",
          position: 9,
          requiredCapabilities: ["typescript"],
          idempotencyKey: "create-urgent-ranked-claim",
        }),
        human,
        taskServices,
      ),
    );
    const command = {
      projectId,
      leaseDurationSeconds: 300,
      idempotencyKey: "claim-ranked-next",
    };

    const first = await Effect.runPromise(claimNextTask(command, registration, taskServices));
    const retry = await Effect.runPromise(claimNextTask(command, registration, taskServices));
    const second = await Effect.runPromise(
      claimNextTask(
        { ...command, idempotencyKey: "claim-second-ranked-next" },
        registration,
        taskServices,
      ),
    );

    expect(first.task.id).toBe(urgent.id);
    expect(retry).toEqual(first);
    expect(second.task.id).toBe(low.id);
    const selections = projectStore.database
      .prepare<[string], string>(
        "select payload_json from events where project_id = ? and kind = 'task.claimed' order by cursor",
      )
      .pluck()
      .all(projectId)
      .map((payload) => JSON.parse(payload).selection);
    expect(selections).toEqual(["next", "next"]);
  });

  it("serializes genuinely contending claims across worker-thread SQLite connections", async () => {
    const firstAgent = await registerAgent("race-first", "Race First");
    const secondAgent = await registerAgent("race-second", "Race Second");
    const contested = await Effect.runPromise(
      createTask(
        readyInput({
          title: "Contested task",
          requiredCapabilities: ["typescript"],
          idempotencyKey: "create-contested-task",
        }),
        human,
        taskServices,
      ),
    );
    const competingResults = await runContendingTaskOperations([
      {
        command: "claimTask",
        input: {
          projectId,
          taskId: contested.id,
          expectedVersion: contested.version,
          idempotencyKey: "competing-claim-first",
        },
        registration: firstAgent,
        now,
      },
      {
        command: "claimTask",
        input: {
          projectId,
          taskId: contested.id,
          expectedVersion: contested.version,
          idempotencyKey: "competing-claim-second",
        },
        registration: secondAgent,
        now,
      },
    ]);

    expect(competingResults.filter((result) => result.ok)).toHaveLength(1);
    expect(competingResults.filter((result) => !result.ok)).toHaveLength(1);
    const rejected = competingResults.find((result) => !result.ok);
    if (rejected && !rejected.ok) {
      expect(["TaskClaimUnavailableError", "TaskVersionConflictError"]).toContain(
        rejected.error["_tag"],
      );
    }
    expect(
      projectStore.database
        .prepare("select count(*) from leases where task_id = ? and status = 'active'")
        .pluck()
        .get(contested.id),
    ).toBe(1);
    expect(
      projectStore.database
        .prepare("select count(*) from attempts where task_id = ? and status = 'active'")
        .pluck()
        .get(contested.id),
    ).toBe(1);
    expect(
      projectStore.database
        .prepare("select count(*) from events where entity_id = ? and kind = 'task.claimed'")
        .pluck()
        .get(contested.id),
    ).toBe(1);

    const nextContested = await Effect.runPromise(
      createTask(
        readyInput({
          title: "Contested claim-next task",
          requiredCapabilities: ["typescript"],
          idempotencyKey: "create-contested-claim-next",
        }),
        human,
        taskServices,
      ),
    );
    const nextResults = await runContendingTaskOperations([
      {
        command: "claimNextTask",
        input: { projectId, idempotencyKey: "competing-claim-next-first" },
        registration: firstAgent,
        now,
      },
      {
        command: "claimNextTask",
        input: { projectId, idempotencyKey: "competing-claim-next-second" },
        registration: secondAgent,
        now,
      },
    ]);
    const nextClaimEvent = projectStore.database
      .prepare<[string], string>(
        "select payload_json from events where entity_id = ? and kind = 'task.claimed'",
      )
      .pluck()
      .get(nextContested.id);

    expect(nextResults.filter((result) => result.ok)).toHaveLength(1);
    expect(nextResults.find((result) => !result.ok)).toMatchObject({
      error: { _tag: "TaskClaimUnavailableError" },
    });
    expect(
      projectStore.database
        .prepare("select count(*) from leases where task_id = ? and status = 'active'")
        .pluck()
        .get(nextContested.id),
    ).toBe(1);
    expect(nextClaimEvent).toBeDefined();
    expect(JSON.parse(nextClaimEvent ?? "{}")).toMatchObject({
      selection: "next",
    });

    const retryTask = await Effect.runPromise(
      createTask(
        readyInput({
          title: "Concurrent retry task",
          requiredCapabilities: ["typescript"],
          idempotencyKey: "create-concurrent-retry-task",
        }),
        human,
        taskServices,
      ),
    );
    const retryCommand = {
      projectId,
      taskId: retryTask.id,
      expectedVersion: retryTask.version,
      idempotencyKey: "concurrent-idempotent-claim",
    };
    const retryResults = await runContendingTaskOperations([
      {
        command: "claimTask",
        input: retryCommand,
        registration: firstAgent,
        now,
      },
      {
        command: "claimTask",
        input: retryCommand,
        registration: firstAgent,
        now,
      },
    ]);

    const successfulRetries = retryResults.filter((result) => result.ok);
    const failedRetries = retryResults.filter((result) => !result.ok);
    expect(successfulRetries.length).toBeGreaterThanOrEqual(1);
    if (successfulRetries.length === 2) {
      expect(successfulRetries[1]).toEqual(successfulRetries[0]);
    } else {
      expect(failedRetries).toEqual([
        expect.objectContaining({
          error: expect.objectContaining({
            _tag: "TaskLeaseError",
            reason: "inactive",
          }),
        }),
      ]);
    }
    expect(
      projectStore.database
        .prepare("select count(*) from leases where task_id = ?")
        .pluck()
        .get(retryTask.id),
    ).toBe(1);
    expect(
      projectStore.database
        .prepare("select count(*) from idempotency_records where key = ?")
        .pluck()
        .get(retryCommand.idempotencyKey),
    ).toBe(1);
    expect(
      projectStore.database
        .prepare("select count(*) from events where entity_id = ? and kind = 'task.claimed'")
        .pluck()
        .get(retryTask.id),
    ).toBe(1);
  }, 60_000);

  it("renews only for the current owner, task version, and active registered run", async () => {
    const registration = await registerAgent("renew-owner", "Renew Owner");
    const foreignRegistration = await registerAgent("renew-foreign", "Renew Foreign");
    const { grant } = await claimedTaskFixture(registration, "renewal");
    now = "2026-09-03T12:01:00.000Z";
    const command = {
      leaseToken: grant.leaseToken,
      expectedVersion: grant.task.version,
      leaseDurationSeconds: 600,
      idempotencyKey: "renew-owned-lease",
    };

    const renewed = await Effect.runPromise(renewTaskLease(command, registration, taskServices));
    const retry = await Effect.runPromise(renewTaskLease(command, registration, taskServices));
    const wrongOwner = await Effect.runPromise(
      Effect.either(
        renewTaskLease(
          {
            ...command,
            expectedVersion: renewed.task.version,
            idempotencyKey: "renew-wrong-owner",
          },
          foreignRegistration,
          taskServices,
        ),
      ),
    );
    const staleVersion = await Effect.runPromise(
      Effect.either(
        renewTaskLease(
          { ...command, idempotencyKey: "renew-stale-version" },
          registration,
          taskServices,
        ),
      ),
    );
    const missingRunRegistration: RegisteredAgentRun = {
      profile: registration.profile,
      run: {
        ...registration.run,
        id: "missing-agent-run",
        mcpSessionId: "missing-agent-session",
      },
    };
    const inactiveRun = await Effect.runPromise(
      Effect.either(
        renewTaskLease(
          {
            ...command,
            expectedVersion: renewed.task.version,
            idempotencyKey: "renew-inactive-run",
          },
          missingRunRegistration,
          taskServices,
        ),
      ),
    );

    expect(retry).toEqual(renewed);
    expect(renewed).toMatchObject({
      task: { id: grant.task.id, lifecycle: "in_progress", version: 3 },
      claim: {
        id: grant.claim.id,
        status: "active",
        expiresAt: "2026-09-03T12:11:00.000Z",
      },
      leaseToken: grant.leaseToken,
    });
    expect(Either.isLeft(wrongOwner) && wrongOwner.left).toMatchObject({
      _tag: "TaskLeaseError",
      reason: "owner_mismatch",
    });
    expect(Either.isLeft(staleVersion) && staleVersion.left).toMatchObject({
      _tag: "TaskVersionConflictError",
      expectedVersion: 2,
      currentVersion: 3,
    });
    expect(Either.isLeft(inactiveRun) && inactiveRun.left).toMatchObject({
      _tag: "TaskLeaseError",
      reason: "inactive_run",
    });
    expect(
      projectStore.database
        .prepare("select count(*) from events where entity_id = ? and kind = 'task.lease.renewed'")
        .pluck()
        .get(grant.task.id),
    ).toBe(1);
  });

  it("serializes competing renewals and deduplicates identical renewal retries across workers", async () => {
    const registration = await registerAgent("renew-race-owner", "Renew Race Owner");
    const { grant } = await claimedTaskFixture(registration, "renew-race");
    now = "2026-09-03T12:01:00.000Z";
    const competingRenewals = await runContendingTaskOperations([
      {
        command: "renewTaskLease",
        input: {
          leaseToken: grant.leaseToken,
          expectedVersion: grant.task.version,
          leaseDurationSeconds: 600,
          idempotencyKey: "renew-race-first",
        },
        registration,
        now,
      },
      {
        command: "renewTaskLease",
        input: {
          leaseToken: grant.leaseToken,
          expectedVersion: grant.task.version,
          leaseDurationSeconds: 600,
          idempotencyKey: "renew-race-second",
        },
        registration,
        now,
      },
    ]);
    const competingState = projectStore.database
      .prepare<
        [string],
        {
          lifecycle: string;
          version: number;
          leaseStatus: string;
          expiresAt: string;
        }
      >(
        `select tasks.lifecycle, tasks.version, leases.status as leaseStatus, leases.expires_at as expiresAt
         from tasks join leases on leases.task_id = tasks.id where tasks.id = ?`,
      )
      .get(grant.task.id);

    expect(competingRenewals.filter((result) => result.ok)).toHaveLength(1);
    expect(competingRenewals.find((result) => !result.ok)).toMatchObject({
      error: {
        _tag: "TaskVersionConflictError",
        expectedVersion: grant.task.version,
        currentVersion: grant.task.version + 1,
      },
    });
    expect(competingState).toEqual({
      lifecycle: "in_progress",
      version: 3,
      leaseStatus: "active",
      expiresAt: "2026-09-03T12:11:00.000Z",
    });
    expect(
      projectStore.database
        .prepare("select count(*) from events where entity_id = ? and kind = 'task.lease.renewed'")
        .pluck()
        .get(grant.task.id),
    ).toBe(1);
    expect(
      projectStore.database
        .prepare(
          "select count(*) from idempotency_records where key in ('renew-race-first', 'renew-race-second')",
        )
        .pluck()
        .get(),
    ).toBe(1);

    const { grant: retryGrant } = await claimedTaskFixture(registration, "renew-retry-race");
    now = "2026-09-03T12:02:00.000Z";
    const retryInput = {
      leaseToken: retryGrant.leaseToken,
      expectedVersion: retryGrant.task.version,
      leaseDurationSeconds: 300,
      idempotencyKey: "renew-identical-race",
    };
    const retryResults = await runContendingTaskOperations([
      { command: "renewTaskLease", input: retryInput, registration, now },
      { command: "renewTaskLease", input: retryInput, registration, now },
    ]);

    expect(retryResults.every((result) => result.ok)).toBe(true);
    expect(retryResults[1]).toEqual(retryResults[0]);
    expect(
      projectStore.database
        .prepare("select version from tasks where id = ?")
        .pluck()
        .get(retryGrant.task.id),
    ).toBe(3);
    expect(
      projectStore.database
        .prepare("select count(*) from events where entity_id = ? and kind = 'task.lease.renewed'")
        .pluck()
        .get(retryGrant.task.id),
    ).toBe(1);
    expect(
      projectStore.database
        .prepare("select count(*) from idempotency_records where key = ?")
        .pluck()
        .get(retryInput.idempotencyKey),
    ).toBe(1);
  }, 60_000);

  it("keeps renewal and human cancellation coherent under genuine contention", async () => {
    const registration = await registerAgent("cancel-race-owner", "Cancel Race Owner");
    const { grant } = await claimedTaskFixture(registration, "cancel-race");
    now = "2026-09-03T12:01:00.000Z";
    const [renewal, cancellation] = await runContendingTaskOperations([
      {
        command: "renewTaskLease",
        input: {
          leaseToken: grant.leaseToken,
          expectedVersion: grant.task.version,
          leaseDurationSeconds: 600,
          idempotencyKey: "renew-against-cancellation",
        },
        registration,
        now,
      },
      {
        command: "invalidateTaskClaim",
        input: {
          taskId: grant.task.id,
          expectedVersion: grant.task.version,
          disposition: "cancelled",
          reason: "Human cancellation won or lost a real race.",
          idempotencyKey: "cancel-against-renewal",
        },
        actor: human,
        now,
      },
    ]);
    const state = projectStore.database
      .prepare<
        [string],
        {
          lifecycle: string;
          version: number;
          leaseStatus: string;
          attemptStatus: string;
        }
      >(
        `select tasks.lifecycle, tasks.version, leases.status as leaseStatus,
                attempts.status as attemptStatus
         from tasks
         join leases on leases.task_id = tasks.id
         join attempts on attempts.id = leases.attempt_id
         where tasks.id = ?`,
      )
      .get(grant.task.id);
    const mutationEvents = projectStore.database
      .prepare<[string], string>(
        "select kind from events where entity_id = ? and kind in ('task.lease.renewed', 'task.lease.cancelled') order by cursor",
      )
      .pluck()
      .all(grant.task.id);
    expect([renewal, cancellation].filter((result) => result?.ok)).toHaveLength(1);
    expect(state?.version).toBe(3);
    expect(mutationEvents).toHaveLength(1);
    if (renewal?.ok) {
      expect(cancellation).toMatchObject({
        ok: false,
        error: {
          _tag: "TaskVersionConflictError",
          expectedVersion: 2,
          currentVersion: 3,
        },
      });
      expect(state).toEqual({
        lifecycle: "in_progress",
        version: 3,
        leaseStatus: "active",
        attemptStatus: "active",
      });
      expect(mutationEvents).toEqual(["task.lease.renewed"]);
    } else {
      expect(cancellation?.ok).toBe(true);
      expect(renewal).toMatchObject({
        ok: false,
        error: { _tag: "TaskLeaseError", reason: "inactive" },
      });
      expect(state).toEqual({
        lifecycle: "ready",
        version: 3,
        leaseStatus: "cancelled",
        attemptStatus: "abandoned",
      });
      expect(mutationEvents).toEqual(["task.lease.cancelled"]);
    }
    expect(
      projectStore.database
        .prepare(
          "select count(*) from idempotency_records where key in ('renew-against-cancellation', 'cancel-against-renewal')",
        )
        .pluck()
        .get(),
    ).toBe(1);
  }, 60_000);

  it("keeps renewal and expiration coherent when their clocks straddle the deadline", async () => {
    const registration = await registerAgent("expiry-race-owner", "Expiry Race Owner");
    const { grant } = await claimedTaskFixture(registration, "expiry-race");
    const [renewal, reconciliation] = await runContendingTaskOperations([
      {
        command: "renewTaskLease",
        input: {
          leaseToken: grant.leaseToken,
          expectedVersion: grant.task.version,
          leaseDurationSeconds: 300,
          idempotencyKey: "renew-against-expiration",
        },
        registration,
        now: "2026-09-03T12:04:59.000Z",
      },
      { command: "reconcileTaskLeases", now: grant.claim.expiresAt },
    ]);
    const state = projectStore.database
      .prepare<
        [string],
        {
          lifecycle: string;
          version: number;
          leaseStatus: string;
          expiresAt: string;
          attemptStatus: string;
        }
      >(
        `select tasks.lifecycle, tasks.version, leases.status as leaseStatus,
                leases.expires_at as expiresAt, attempts.status as attemptStatus
         from tasks
         join leases on leases.task_id = tasks.id
         join attempts on attempts.id = leases.attempt_id
         where tasks.id = ?`,
      )
      .get(grant.task.id);
    const mutationEvents = projectStore.database
      .prepare<[string], string>(
        "select kind from events where entity_id = ? and kind in ('task.lease.renewed', 'task.lease.expired') order by cursor",
      )
      .pluck()
      .all(grant.task.id);
    const renewalRecordCount = projectStore.database
      .prepare("select count(*) from idempotency_records where key = 'renew-against-expiration'")
      .pluck()
      .get();

    expect(reconciliation?.ok).toBe(true);
    expect(state?.version).toBe(3);
    expect(mutationEvents).toHaveLength(1);
    if (renewal?.ok) {
      expect(reconciliation).toEqual({ ok: true, value: 0 });
      expect(renewalRecordCount).toBe(1);
      expect(state).toEqual({
        lifecycle: "in_progress",
        version: 3,
        leaseStatus: "active",
        expiresAt: "2026-09-03T12:09:59.000Z",
        attemptStatus: "active",
      });
      expect(mutationEvents).toEqual(["task.lease.renewed"]);
    } else {
      expect(renewal).toMatchObject({
        ok: false,
        error: { _tag: "TaskLeaseError", reason: "expired" },
      });
      expect(reconciliation).toEqual({ ok: true, value: 1 });
      expect(renewalRecordCount).toBe(0);
      expect(state).toEqual({
        lifecycle: "ready",
        version: 3,
        leaseStatus: "expired",
        expiresAt: grant.claim.expiresAt,
        attemptStatus: "abandoned",
      });
      expect(mutationEvents).toEqual(["task.lease.expired"]);
    }
  }, 60_000);

  it("releases a lease idempotently and rejects stale renewal and late agent completion", async () => {
    const registration = await registerAgent("release-owner", "Release Owner");
    const { grant } = await claimedTaskFixture(registration, "release");
    now = "2026-09-03T12:02:00.000Z";
    const command = {
      leaseToken: grant.leaseToken,
      expectedVersion: grant.task.version,
      reason: "Return work to the shared queue.",
      idempotencyKey: "release-owned-lease",
    };

    const released = await Effect.runPromise(releaseTaskLease(command, registration, taskServices));
    const retry = await Effect.runPromise(releaseTaskLease(command, registration, taskServices));
    const staleRenewal = await Effect.runPromise(
      Effect.either(
        renewTaskLease(
          {
            leaseToken: grant.leaseToken,
            expectedVersion: released.task.version,
            idempotencyKey: "renew-released-lease",
          },
          registration,
          taskServices,
        ),
      ),
    );
    const lateCompletion = await Effect.runPromise(
      Effect.either(
        completeTask(
          {
            projectId,
            taskId: grant.task.id,
            leaseToken: grant.leaseToken,
            expectedVersion: released.task.version,
            report: completionReport("late-agent-completion"),
            idempotencyKey: "late-agent-completion",
          },
          registration,
          taskServices,
        ),
      ),
    );
    const attempt = projectStore.database
      .prepare<[string], { status: string; summary: string; completedAt: string | null }>(
        "select status, summary, completed_at as completedAt from attempts where id = ?",
      )
      .get(grant.attempt.id);

    expect(retry).toEqual(released);
    expect(released).toMatchObject({
      task: {
        id: grant.task.id,
        lifecycle: "ready",
        version: 3,
        claim: null,
        eligibility: { status: "claimable", claimable: true },
      },
      claim: {
        id: grant.claim.id,
        status: "released",
        invalidatedAt: now,
        invalidationReason: command.reason,
      },
    });
    expect(attempt).toEqual({
      status: "abandoned",
      summary: command.reason,
      completedAt: now,
    });
    expect(Either.isLeft(staleRenewal) && staleRenewal.left).toMatchObject({
      _tag: "TaskLeaseError",
      reason: "inactive",
    });
    expect(Either.isLeft(lateCompletion) && lateCompletion.left).toMatchObject({
      _tag: "TaskLeaseError",
      reason: "inactive",
    });
    expect(
      projectStore.database
        .prepare("select count(*) from events where entity_id = ? and kind = 'task.completed'")
        .pluck()
        .get(grant.task.id),
    ).toBe(0);
  });

  it("expires claims deterministically, abandons attempts, and makes work claimable once", async () => {
    const registration = await registerAgent("expiry-owner", "Expiry Owner");
    const { grant } = await claimedTaskFixture(registration, "expiry");
    now = grant.claim.expiresAt;

    const reconciled = await Effect.runPromise(reconcileTaskLeases(taskServices));
    const repeated = await Effect.runPromise(reconcileTaskLeases(taskServices));
    const [task] = await Effect.runPromise(
      listTasks({ projectId }, taskServices, registration.profile.capabilities),
    );
    const staleRenewal = await Effect.runPromise(
      Effect.either(
        renewTaskLease(
          {
            leaseToken: grant.leaseToken,
            expectedVersion: task!.version,
            idempotencyKey: "renew-expired-lease",
          },
          registration,
          taskServices,
        ),
      ),
    );
    const lease = projectStore.database
      .prepare<[string], { status: string; invalidatedAt: string; reason: string }>(
        "select status, invalidated_at as invalidatedAt, invalidation_reason as reason from leases where id = ?",
      )
      .get(grant.claim.id);
    const attempt = projectStore.database
      .prepare<[string], { status: string; summary: string; completedAt: string }>(
        "select status, summary, completed_at as completedAt from attempts where id = ?",
      )
      .get(grant.attempt.id);
    const event = projectStore.database
      .prepare<[string], { actorType: string; actorId: string; payload: string }>(
        "select actor_type as actorType, actor_id as actorId, payload_json as payload from events where entity_id = ? and kind = 'task.lease.expired'",
      )
      .get(grant.task.id);

    expect(reconciled).toBe(1);
    expect(repeated).toBe(0);
    expect(task).toMatchObject({
      id: grant.task.id,
      lifecycle: "ready",
      version: 3,
      claim: null,
      eligibility: { status: "claimable", claimable: true },
    });
    expect(lease).toEqual({
      status: "expired",
      invalidatedAt: now,
      reason: "Lease expired.",
    });
    expect(attempt).toEqual({
      status: "abandoned",
      summary: "Lease expired.",
      completedAt: now,
    });
    expect(event).toMatchObject({ actorType: "system", actorId: "helm" });
    expect(JSON.parse(event!.payload)).toMatchObject({
      leaseId: grant.claim.id,
      attemptId: grant.attempt.id,
      previousVersion: 2,
      version: 3,
      reason: "Lease expired.",
    });
    expect(Either.isLeft(staleRenewal) && staleRenewal.left).toMatchObject({
      _tag: "TaskLeaseError",
      reason: "expired",
    });
  });

  it("records human cancellation and reassignment while invalidating both stale tokens", async () => {
    const firstAgent = await registerAgent("invalidate-first", "Invalidate First");
    const secondAgent = await registerAgent("invalidate-second", "Invalidate Second");
    const { grant: firstGrant } = await claimedTaskFixture(firstAgent, "invalidate");
    now = "2026-09-03T12:01:00.000Z";
    const cancelled = await Effect.runPromise(
      invalidateTaskClaim(
        {
          taskId: firstGrant.task.id,
          expectedVersion: firstGrant.task.version,
          disposition: "cancelled",
          reason: "Human cancelled the active execution.",
          idempotencyKey: "cancel-active-claim",
        },
        human,
        taskServices,
      ),
    );
    const cancelledToken = await Effect.runPromise(
      Effect.either(
        renewTaskLease(
          {
            leaseToken: firstGrant.leaseToken,
            expectedVersion: cancelled.task.version,
            idempotencyKey: "renew-cancelled-claim",
          },
          firstAgent,
          taskServices,
        ),
      ),
    );
    now = "2026-09-03T12:02:00.000Z";
    const secondGrant = await Effect.runPromise(
      claimTask(
        {
          projectId,
          taskId: firstGrant.task.id,
          expectedVersion: cancelled.task.version,
          idempotencyKey: "claim-for-reassignment",
        },
        secondAgent,
        taskServices,
      ),
    );
    const reassigned = await Effect.runPromise(
      invalidateTaskClaim(
        {
          taskId: secondGrant.task.id,
          expectedVersion: secondGrant.task.version,
          disposition: "reassigned",
          reason: "Move execution to another agent.",
          idempotencyKey: "reassign-active-claim",
        },
        human,
        taskServices,
      ),
    );
    const reassignedToken = await Effect.runPromise(
      Effect.either(
        renewTaskLease(
          {
            leaseToken: secondGrant.leaseToken,
            expectedVersion: reassigned.task.version,
            idempotencyKey: "renew-reassigned-claim",
          },
          secondAgent,
          taskServices,
        ),
      ),
    );
    const leaseStatuses = projectStore.database
      .prepare<[string], string>(
        "select status from leases where task_id = ? order by acquired_at, id",
      )
      .pluck()
      .all(firstGrant.task.id);
    const invalidationEvents = projectStore.database
      .prepare<[string], { kind: string; actorType: string; actorId: string }>(
        "select kind, actor_type as actorType, actor_id as actorId from events where entity_id = ? and kind in ('task.lease.cancelled', 'task.lease.reassigned') order by cursor",
      )
      .all(firstGrant.task.id);

    expect(cancelled).toMatchObject({
      task: { lifecycle: "ready", version: 3, claim: null },
      claim: { status: "cancelled" },
    });
    expect(reassigned).toMatchObject({
      task: { lifecycle: "ready", version: 5, claim: null },
      claim: { status: "reassigned" },
    });
    expect(Either.isLeft(cancelledToken) && cancelledToken.left).toMatchObject({
      _tag: "TaskLeaseError",
      reason: "inactive",
    });
    expect(Either.isLeft(reassignedToken) && reassignedToken.left).toMatchObject({
      _tag: "TaskLeaseError",
      reason: "inactive",
    });
    expect(leaseStatuses).toEqual(["cancelled", "reassigned"]);
    expect(invalidationEvents).toEqual([
      {
        kind: "task.lease.cancelled",
        actorType: "human",
        actorId: "local-human",
      },
      {
        kind: "task.lease.reassigned",
        actorType: "human",
        actorId: "local-human",
      },
    ]);
  });

  it("rolls task, attempt, lease, event, and idempotency state back when claim audit fails", async () => {
    const registration = await registerAgent("rollback-agent", "Rollback Agent");
    const task = await Effect.runPromise(
      createTask(
        readyInput({
          title: "Rollback claim",
          requiredCapabilities: ["typescript"],
          idempotencyKey: "create-rollback-claim",
        }),
        human,
        taskServices,
      ),
    );
    projectStore.database.exec(`
      create trigger reject_claim_event
      before insert on events when NEW.kind = 'task.claimed'
      begin select raise(abort, 'claim event rejected'); end;
    `);

    const result = await Effect.runPromise(
      Effect.either(
        claimTask(
          {
            projectId,
            taskId: task.id,
            expectedVersion: task.version,
            idempotencyKey: "claim-with-rejected-event",
          },
          registration,
          taskServices,
        ),
      ),
    );
    const storedTask = projectStore.database
      .prepare<[string], { lifecycle: string; version: number }>(
        "select lifecycle, version from tasks where id = ?",
      )
      .get(task.id);

    expect(Either.isLeft(result) && result.left["_tag"]).toBe("TaskPersistenceError");
    expect(storedTask).toEqual({ lifecycle: "ready", version: 1 });
    expect(
      projectStore.database
        .prepare("select count(*) from attempts where task_id = ?")
        .pluck()
        .get(task.id),
    ).toBe(0);
    expect(
      projectStore.database
        .prepare("select count(*) from leases where task_id = ?")
        .pluck()
        .get(task.id),
    ).toBe(0);
    expect(
      projectStore.database
        .prepare("select count(*) from idempotency_records where key = ?")
        .pluck()
        .get("claim-with-rejected-event"),
    ).toBe(0);
    expect(
      projectStore.database
        .prepare("select count(*) from events where entity_id = ? and kind = 'task.claimed'")
        .pluck()
        .get(task.id),
    ).toBe(0);
  });

  it("serializes completion, failure, and human cancellation races", async () => {
    const registration = await registerAgent("result-race", "Result Racer");
    const scenarios = [
      ["completeTask", "failTask"],
      ["completeTask", "cancelTask"],
      ["failTask", "cancelTask"],
    ] as const;

    for (const [scenarioIndex, commands] of scenarios.entries()) {
      const key = `result-race-${scenarioIndex}`;
      // Each scenario owns the database exclusively so only its two commands contend.
      // oxlint-disable-next-line no-await-in-loop
      const { grant } = await claimedTaskFixture(registration, key);
      const inputs = {
        completeTask: {
          projectId,
          taskId: grant.task.id,
          leaseToken: grant.leaseToken,
          expectedVersion: grant.task.version,
          report: completionReport(key),
          idempotencyKey: `complete-${key}`,
        },
        failTask: {
          projectId,
          taskId: grant.task.id,
          leaseToken: grant.leaseToken,
          expectedVersion: grant.task.version,
          report: {
            classification: "verification" as const,
            reason: "The race fixture failed verification.",
            changedAreas: ["src/race.ts"],
            verificationResults: [
              {
                name: "Race verification",
                status: "failed" as const,
                details: "The competing result won.",
              },
            ],
            references: [],
            risks: [],
            followUpWork: [],
          },
          idempotencyKey: `fail-${key}`,
        },
        cancelTask: {
          taskId: grant.task.id,
          expectedVersion: grant.task.version,
          reason: "The human stopped this contending execution.",
          idempotencyKey: `cancel-${key}`,
        },
      };
      // oxlint-disable-next-line no-await-in-loop
      const outcomes = await runContendingTaskOperations(
        commands.map((command) => ({
          command,
          input: inputs[command],
          registration: command === "cancelTask" ? undefined : registration,
          actor: command === "cancelTask" ? human : undefined,
          now,
        })),
      );
      const winnerIndex = outcomes.findIndex((outcome) => outcome.ok);
      const winner = commands[winnerIndex];
      if (!winner) throw new Error("Expected one result command to win");
      const expected = {
        completeTask: {
          lifecycle: "review",
          attemptStatus: "completed",
          eventKind: "task.review.requested",
        },
        failTask: {
          lifecycle: "ready",
          attemptStatus: "failed",
          eventKind: "task.attempt.failed",
        },
        cancelTask: {
          lifecycle: "cancelled",
          attemptStatus: "cancelled",
          eventKind: "task.cancelled",
        },
      }[winner];
      const state = projectStore.database
        .prepare<[string], { lifecycle: string; attemptStatus: string; leaseStatus: string }>(
          `select tasks.lifecycle,
                  attempts.status as attemptStatus,
                  leases.status as leaseStatus
           from tasks
           join attempts on attempts.task_id = tasks.id
           join leases on leases.attempt_id = attempts.id
           where tasks.id = ?`,
        )
        .get(grant.task.id);
      const resultEvents = projectStore.database
        .prepare<[string], string>(
          `select kind from events
           where entity_id = ?
             and kind in ('task.review.requested', 'task.attempt.failed', 'task.cancelled')`,
        )
        .pluck()
        .all(grant.task.id);
      const resultRecords = projectStore.database
        .prepare<[string, string, string], number>(
          "select count(*) from idempotency_records where key in (?, ?, ?)",
        )
        .pluck()
        .get(`complete-${key}`, `fail-${key}`, `cancel-${key}`);

      expect(outcomes.filter((outcome) => outcome.ok)).toHaveLength(1);
      expect(outcomes.filter((outcome) => !outcome.ok)).toHaveLength(1);
      expect(state).toEqual({
        lifecycle: expected.lifecycle,
        attemptStatus: expected.attemptStatus,
        leaseStatus: expected.attemptStatus === "cancelled" ? "cancelled" : "released",
      });
      expect(resultEvents).toEqual([expected.eventKind]);
      expect(resultRecords).toBe(1);
    }
  }, 60_000);

  it("accepts representative input through normal and compiled task schemas", () => {
    const valid = backlogInput();
    expect(createTaskInputSchema.parse(valid)).toEqual(valid);
    expect(compiledCreateTaskInputSchema.parse(valid)).toEqual(valid);
    expect(() => createTaskInputSchema.parse({ ...valid, expectedVersion: 1 })).toThrow();
    expect(() => compiledCreateTaskInputSchema.parse({ ...valid, title: "" })).toThrow();
    expect(() => createTaskInputSchema.parse({ ...valid, notBefore: "2026-02-30" })).toThrow();
    expect(() =>
      compiledCreateTaskInputSchema.parse({
        ...valid,
        referencedPaths: ["../outside.ts"],
      }),
    ).toThrow();
    expect(() =>
      compiledCreateTaskInputSchema.parse({
        ...valid,
        referencedPaths: [`src/${"a".repeat(256)}`],
      }),
    ).toThrow();
    expect(() =>
      compiledCreateTaskInputSchema.parse({
        ...valid,
        referencedPaths: ["src/\0outside.ts"],
      }),
    ).toThrow();
    const planning = {
      taskId: "task-1",
      priority: "normal" as const,
      position: 1,
      notBefore: null,
      dueAt: null,
      size: null,
      tags: [],
      requiredCapabilities: [],
      expectedVersion: 1,
      idempotencyKey: "planning",
    };
    expect(updateTaskPlanningInputSchema.parse(planning)).toEqual(planning);
    expect(compiledUpdateTaskPlanningInputSchema.parse(planning)).toEqual(planning);
    const relation = {
      projectId: "project-1",
      sourceTaskId: "task-1",
      targetTaskId: "task-2",
      type: "blocks" as const,
      expectedSourceVersion: 1,
      expectedTargetVersion: 1,
      idempotencyKey: "relation",
    };
    expect(createTaskRelationInputSchema.parse(relation)).toEqual(relation);
    expect(compiledCreateTaskRelationInputSchema.parse(relation)).toEqual(relation);

    const chosenClaim = {
      projectId: "project-1",
      taskId: "task-1",
      expectedVersion: 1,
      leaseDurationSeconds: 300,
      idempotencyKey: "chosen-claim",
    };
    expect(claimTaskInputSchema.parse(chosenClaim)).toEqual(chosenClaim);
    expect(compiledClaimTaskInputSchema.parse(chosenClaim)).toEqual(chosenClaim);

    const nextClaim = {
      projectId: "project-1",
      leaseDurationSeconds: 300,
      idempotencyKey: "next-claim",
    };
    expect(claimNextTaskInputSchema.parse(nextClaim)).toEqual(nextClaim);
    expect(compiledClaimNextTaskInputSchema.parse(nextClaim)).toEqual(nextClaim);

    const renewal = {
      leaseToken: "lease-token",
      expectedVersion: 2,
      leaseDurationSeconds: 300,
      idempotencyKey: "renew-lease",
    };
    expect(renewTaskLeaseInputSchema.parse(renewal)).toEqual(renewal);
    expect(compiledRenewTaskLeaseInputSchema.parse(renewal)).toEqual(renewal);

    const release = {
      leaseToken: "lease-token",
      expectedVersion: 2,
      reason: "Return work to the ready queue.",
      idempotencyKey: "release-lease",
    };
    expect(releaseTaskLeaseInputSchema.parse(release)).toEqual(release);
    expect(compiledReleaseTaskLeaseInputSchema.parse(release)).toEqual(release);

    const invalidation = {
      taskId: "task-1",
      expectedVersion: 2,
      disposition: "cancelled" as const,
      reason: "Stop the current execution.",
      idempotencyKey: "invalidate-claim",
    };
    expect(invalidateTaskClaimInputSchema.parse(invalidation)).toEqual(invalidation);
    expect(compiledInvalidateTaskClaimInputSchema.parse(invalidation)).toEqual(invalidation);

    expect(() =>
      compiledClaimTaskInputSchema.parse({
        ...chosenClaim,
        leaseDurationSeconds: 29,
      }),
    ).toThrow();
  });
});
