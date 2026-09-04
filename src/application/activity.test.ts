import { mkdir, mkdtemp, rm } from "node:fs/promises";
import { join } from "node:path";
import { tmpdir } from "node:os";

import { Effect, Either } from "effect";
import { afterEach, beforeEach, describe, expect, it } from "vitest";

import { registerAgentRun } from "./agents";
import {
  createAgentActivityEntry,
  createAgentManualBlocker,
  createHumanActivityEntry,
  createManualBlocker,
  listActivityEntries,
  listManualBlockers,
  readActivityEvents,
  resolveManualBlocker,
  withdrawActivityEntry,
  type ActivityServices,
} from "./activity";
import { createProject } from "./projects";
import {
  archiveTask,
  claimTask,
  createTask,
  getTaskContext,
  listTasks,
  reconcileTaskLeases,
  type TaskServices,
} from "./tasks";
import {
  compiledCreateAgentActivityEntryInputSchema,
  compiledCreateAgentManualBlockerInputSchema,
  compiledCreateHumanActivityEntryInputSchema,
  compiledReadActivityEventsInputSchema,
  createAgentActivityEntryInputSchema,
  createAgentManualBlockerInputSchema,
  createHumanActivityEntryInputSchema,
  importanceForEventKind,
  readActivityEventsInputSchema,
} from "../domain/activity";
import type { RegisteredAgentRun } from "../domain/agents";
import { emptyRichTextDocument, type RichTextDocument } from "../domain/tasks";
import { localRepositoryInspector } from "../infrastructure/repository-inspector.server";
import { createSqliteActivityStore } from "../infrastructure/sqlite-activity-store.server";
import { createSqliteAgentStore } from "../infrastructure/sqlite-agent-store.server";
import {
  createSqliteProjectStore,
  type SqliteProjectStore,
} from "../infrastructure/sqlite-project-store.server";
import { createSqliteTaskStore } from "../infrastructure/sqlite-task-store.server";

const human = { type: "human", id: "local-human" } as const;
let temporaryRoot: string;
let projectStore: SqliteProjectStore;
let projectId: string;
let taskServices: TaskServices;
let activityServices: ActivityServices;
let now: string;

function richText(text: string): RichTextDocument {
  return {
    version: 1,
    doc: {
      type: "doc",
      content: [
        {
          type: "paragraph",
          content: [
            { type: "text", text: text.slice(0, 4) },
            { type: "text", text: text.slice(4), marks: [{ type: "strong" }] },
          ],
        },
      ],
    },
  };
}

async function createReadyTask(key: string) {
  return Effect.runPromise(
    createTask(
      {
        projectId,
        parentTaskId: null,
        lifecycle: "ready",
        title: `Activity task ${key}`,
        description: emptyRichTextDocument,
        expectedOutcome: "Progress is durable.",
        acceptanceCriteria: "The timeline contains the entry.",
        agentContext: "",
        checklist: [{ id: "verify", text: "Verify activity", checked: false }],
        expectedVersion: 0,
        idempotencyKey: `create-task-${key}`,
      },
      human,
      taskServices,
    ),
  );
}

async function registerAgent(key: string): Promise<RegisteredAgentRun> {
  return Effect.runPromise(
    registerAgentRun(
      {
        profileKey: key,
        displayName: `Agent ${key}`,
        capabilities: ["typescript"],
        idempotencyKey: `register-${key}`,
      },
      { sessionId: `session-${key}`, clientName: "test", clientVersion: "1" },
      { store: createSqliteAgentStore(projectStore.database) },
    ),
  );
}

beforeEach(async () => {
  temporaryRoot = await mkdtemp(join(tmpdir(), "helm-activity-test-"));
  const repositoryRoot = join(temporaryRoot, "repository");
  await mkdir(join(repositoryRoot, ".git"), { recursive: true });
  projectStore = createSqliteProjectStore(join(temporaryRoot, "helm.db"));
  const project = await Effect.runPromise(
    createProject(
      { repositoryRoot, idempotencyKey: "create-project" },
      { store: projectStore, inspector: localRepositoryInspector },
    ),
  );
  projectId = project.id;
  now = "2026-09-04T10:00:00.000Z";
  taskServices = {
    store: createSqliteTaskStore(projectStore.database),
    clock: { today: () => "2026-09-04", now: () => now },
  };
  activityServices = {
    store: createSqliteActivityStore(projectStore.database),
    clock: { now: () => now },
  };
});

afterEach(async () => {
  projectStore.close();
  await rm(temporaryRoot, { recursive: true, force: true });
});

describe("activity application seam", () => {
  it("keeps compiled and regular boundary schemas equivalent", () => {
    const humanInput = {
      entryId: "entry-schema-human",
      projectId: "project",
      taskId: "task",
      kind: "decision",
      content: richText("Use WAL mode."),
      expectedTaskVersion: 2,
      idempotencyKey: "entry-schema-human-key",
    };
    const agentInput = {
      ...humanInput,
      entryId: "entry-schema-agent",
      kind: "progress",
      leaseToken: "secret-token",
      idempotencyKey: "entry-schema-agent-key",
    } as const;
    expect(compiledCreateHumanActivityEntryInputSchema.parse(humanInput)).toEqual(
      createHumanActivityEntryInputSchema.parse(humanInput),
    );
    expect(compiledCreateAgentActivityEntryInputSchema.parse(agentInput)).toEqual(
      createAgentActivityEntryInputSchema.parse(agentInput),
    );
    const agentBlockerInput = {
      blockerId: "agent-blocker",
      projectId: "project",
      taskId: "task",
      expectedTaskVersion: 2,
      reason: "A human decision is required.",
      leaseToken: "secret-token",
      idempotencyKey: "agent-blocker-key",
    };
    expect(compiledCreateAgentManualBlockerInputSchema.parse(agentBlockerInput)).toEqual(
      createAgentManualBlockerInputSchema.parse(agentBlockerInput),
    );
    expect(
      compiledReadActivityEventsInputSchema.parse({
        projectId: "project",
        direction: "backward",
        beforeCursor: null,
        limit: 20,
      }),
    ).toEqual(
      readActivityEventsInputSchema.parse({
        projectId: "project",
        direction: "backward",
        beforeCursor: null,
        limit: 20,
      }),
    );
    expect(
      createAgentActivityEntryInputSchema.safeParse({
        ...agentInput,
        leaseToken: undefined,
      }).success,
    ).toBe(false);
    expect(
      createAgentManualBlockerInputSchema.safeParse({
        ...agentBlockerInput,
        leaseToken: undefined,
      }).success,
    ).toBe(false);
  });

  it("creates immutable semantic entries with stable text and retry-safe client IDs", async () => {
    const task = await createReadyTask("human-entry");
    const command = {
      entryId: "entry-human-1",
      projectId,
      taskId: task.id,
      kind: "decision" as const,
      content: richText("Use WAL mode."),
      expectedTaskVersion: task.version,
      idempotencyKey: "create-human-entry",
    };
    const first = await Effect.runPromise(
      createHumanActivityEntry(command, human, activityServices),
    );
    const retry = await Effect.runPromise(
      createHumanActivityEntry(command, human, activityServices),
    );
    const visible = await Effect.runPromise(
      listActivityEntries({ projectId, taskId: task.id }, activityServices),
    );

    expect(retry).toEqual(first);
    expect(first.entry).toMatchObject({
      id: command.entryId,
      kind: "decision",
      author: human,
      authorDisplayName: "You",
      contentText: "Use WAL mode.",
      attemptId: null,
    });
    expect(first.taskVersion).toBe(task.version);
    expect(first.event).toMatchObject({
      id: String(first.event.cursor),
      kind: "task.entry.decision.created",
      importance: "routine",
      changes: {
        projectIds: [projectId],
        taskIds: [task.id],
        activityEntryIds: [command.entryId],
        agentRunIds: [],
        scopes: ["activity", "tasks"],
      },
    });
    expect(visible).toEqual([first.entry]);
    expect(
      projectStore.database
        .prepare("select count(*) as count from activity_entries where id = ?")
        .get(command.entryId),
    ).toEqual({ count: 1 });
  });

  it("binds progress to the active lease while allowing registered agent discussion", async () => {
    const task = await createReadyTask("agent-entry");
    const owner = await registerAgent("owner");
    const grant = await Effect.runPromise(
      claimTask(
        {
          projectId,
          taskId: task.id,
          expectedVersion: task.version,
          leaseDurationSeconds: 300,
          idempotencyKey: "claim-agent-entry",
        },
        owner,
        taskServices,
      ),
    );
    const progress = await Effect.runPromise(
      createAgentActivityEntry(
        {
          entryId: "entry-agent-progress",
          projectId,
          taskId: task.id,
          kind: "progress",
          content: richText("Implemented the store."),
          expectedTaskVersion: grant.task.version,
          leaseToken: grant.leaseToken,
          idempotencyKey: "agent-progress",
        },
        owner,
        activityServices,
      ),
    );
    const comment = await Effect.runPromise(
      createAgentActivityEntry(
        {
          entryId: "entry-agent-comment",
          projectId,
          taskId: task.id,
          kind: "comment",
          content: richText("Review the naming."),
          expectedTaskVersion: grant.task.version,
          idempotencyKey: "agent-comment",
        },
        owner,
        activityServices,
      ),
    );

    expect(progress).toMatchObject({
      taskVersion: grant.task.version,
      entry: {
        attemptId: grant.attempt.id,
        author: { type: "agent", id: owner.run.id },
        authorDisplayName: "Agent owner",
        agentProfileId: owner.profile.id,
      },
    });
    expect(comment.entry.attemptId).toBeNull();
    const currentTask = (await Effect.runPromise(listTasks({ projectId }, taskServices))).find(
      (candidate) => candidate.id === task.id,
    );
    expect(currentTask?.version).toBe(grant.task.version);

    const otherAgent = await registerAgent("other");
    const rejected = await Effect.runPromise(
      Effect.either(
        createAgentActivityEntry(
          {
            entryId: "entry-agent-spoof",
            projectId,
            taskId: task.id,
            kind: "progress",
            content: richText("Pretend progress."),
            expectedTaskVersion: grant.task.version,
            leaseToken: grant.leaseToken,
            idempotencyKey: "agent-spoof",
          },
          otherAgent,
          activityServices,
        ),
      ),
    );
    expect(Either.isLeft(rejected) && rejected.left).toMatchObject({
      _tag: "TaskLeaseError",
      reason: "owner_mismatch",
    });
  });

  it("rejects stale or expired agent progress without appending anything", async () => {
    const task = await createReadyTask("late-progress");
    const owner = await registerAgent("late-owner");
    const grant = await Effect.runPromise(
      claimTask(
        {
          projectId,
          taskId: task.id,
          expectedVersion: task.version,
          leaseDurationSeconds: 30,
          idempotencyKey: "claim-late-progress",
        },
        owner,
        taskServices,
      ),
    );
    const countBefore = projectStore.database
      .prepare<[], { count: number }>("select count(*) as count from events")
      .get()!.count;
    now = "2026-09-04T10:01:00.000Z";
    const result = await Effect.runPromise(
      Effect.either(
        createAgentActivityEntry(
          {
            entryId: "entry-late-progress",
            projectId,
            taskId: task.id,
            kind: "progress",
            content: richText("This is too late."),
            expectedTaskVersion: grant.task.version,
            leaseToken: grant.leaseToken,
            idempotencyKey: "late-progress",
          },
          owner,
          activityServices,
        ),
      ),
    );
    expect(Either.isLeft(result) && result.left).toMatchObject({
      _tag: "TaskLeaseError",
      reason: "expired",
    });
    expect(
      projectStore.database
        .prepare<[], { count: number }>("select count(*) as count from events")
        .get()!.count,
    ).toBe(countBefore);
    expect(
      projectStore.database
        .prepare("select count(*) as count from activity_entries where id = ?")
        .get("entry-late-progress"),
    ).toEqual({ count: 0 });
  });

  it("withdraws the projection without erasing authored content or attribution", async () => {
    const task = await createReadyTask("withdrawal");
    const createCommand = {
      entryId: "entry-withdrawn",
      projectId,
      taskId: task.id,
      kind: "comment" as const,
      content: richText("Sensitive correction."),
      expectedTaskVersion: task.version,
      idempotencyKey: "create-withdrawn-entry",
    };
    const created = await Effect.runPromise(
      createHumanActivityEntry(createCommand, human, activityServices),
    );
    now = "2026-09-04T10:02:00.000Z";
    const command = {
      projectId,
      entryId: created.entry.id,
      expectedTaskVersion: task.version,
      reason: "Posted to the wrong task.",
      idempotencyKey: "withdraw-entry",
    };
    const withdrawn = await Effect.runPromise(
      withdrawActivityEntry(command, human, activityServices),
    );
    const retry = await Effect.runPromise(withdrawActivityEntry(command, human, activityServices));
    const createRetryAfterWithdrawal = await Effect.runPromise(
      createHumanActivityEntry(createCommand, human, activityServices),
    );
    const durable = projectStore.database
      .prepare<
        [string],
        {
          contentJson: string;
          contentText: string;
          authorType: string;
          authorId: string;
        }
      >(
        "select content_json as contentJson, content_text as contentText, author_type as authorType, author_id as authorId from activity_entries where id = ?",
      )
      .get(created.entry.id);

    expect(retry).toEqual(withdrawn);
    expect(createRetryAfterWithdrawal).toEqual(created);
    expect(createRetryAfterWithdrawal.entry.withdrawnAt).toBeNull();
    expect(withdrawn.entry).toMatchObject({
      content: null,
      contentText: "",
      author: human,
      withdrawalReason: command.reason,
      withdrawnBy: human,
    });
    expect(durable?.contentText).toBe("Sensitive correction.");
    expect(JSON.parse(durable!.contentJson)).toEqual(created.entry.content);
    expect(durable).toMatchObject({
      authorType: "human",
      authorId: "local-human",
    });
    const context = await Effect.runPromise(
      getTaskContext({ projectId, taskId: task.id }, [], taskServices),
    );
    expect(context.entries).toEqual([withdrawn.entry]);
  });

  it("pages project and global events deterministically in both directions", async () => {
    const task = await createReadyTask("cursor");
    const kinds: readonly ("comment" | "decision" | "change_request")[] = [
      "comment",
      "decision",
      "change_request",
    ];
    const createdEvents = (
      await Promise.all(
        kinds.map((kind, index) =>
          Effect.runPromise(
            createHumanActivityEntry(
              {
                entryId: `entry-cursor-${index}`,
                projectId,
                taskId: task.id,
                kind,
                content: richText(`Event ${index}.`),
                expectedTaskVersion: task.version,
                idempotencyKey: `cursor-event-${index}`,
              },
              human,
              activityServices,
            ),
          ),
        ),
      )
    ).map((result) => result.event);
    const firstCursor = createdEvents[0]!.cursor;
    const forward = await Effect.runPromise(
      readActivityEvents({ projectId, afterCursor: firstCursor - 1, limit: 2 }, activityServices),
    );
    const latest = await Effect.runPromise(
      readActivityEvents(
        { projectId, direction: "backward", beforeCursor: null, limit: 2 },
        activityServices,
      ),
    );
    const global = await Effect.runPromise(
      readActivityEvents({ projectId: null, afterCursor: 0, limit: 200 }, activityServices),
    );

    expect(forward.events.map((event) => event.cursor)).toEqual([
      createdEvents[0]!.cursor,
      createdEvents[1]!.cursor,
    ]);
    expect(forward).toMatchObject({
      direction: "forward",
      nextCursor: createdEvents[1]!.cursor,
      hasMore: true,
    });
    expect(latest.events.map((event) => event.cursor)).toEqual([
      createdEvents[1]!.cursor,
      createdEvents[2]!.cursor,
    ]);
    expect(latest.previousCursor).toBe(createdEvents[1]!.cursor);
    expect(global.events.length).toBeGreaterThan(latest.events.length);
    expect(createdEvents.map((event) => event.importance)).toEqual([
      "routine",
      "routine",
      "attention",
    ]);
    expect(importanceForEventKind("task.attempt.failed")).toBe("critical");
  });

  it("creates and resolves versioned manual blockers that control eligibility", async () => {
    const task = await createReadyTask("blocker");
    const createCommand = {
      blockerId: "blocker-network",
      projectId,
      taskId: task.id,
      expectedTaskVersion: task.version,
      reason: "Waiting for the local service.",
      idempotencyKey: "create-blocker",
    };
    const created = await Effect.runPromise(
      createManualBlocker(createCommand, human, activityServices),
    );
    const blockedTask = (await Effect.runPromise(listTasks({ projectId }, taskServices))).find(
      (candidate) => candidate.id === task.id,
    );
    const active = await Effect.runPromise(
      listManualBlockers({ projectId, taskId: task.id, includeResolved: false }, activityServices),
    );

    expect(created).toMatchObject({
      taskVersion: task.version + 1,
      event: { importance: "attention", kind: "task.blocker.created" },
    });
    expect(blockedTask?.eligibility).toMatchObject({
      claimable: false,
      status: "blocked",
      manualBlockerIds: [created.blocker.id],
    });
    expect(active).toHaveLength(1);

    now = "2026-09-04T10:03:00.000Z";
    const resolved = await Effect.runPromise(
      resolveManualBlocker(
        {
          blockerId: created.blocker.id,
          projectId,
          taskId: task.id,
          expectedTaskVersion: created.taskVersion,
          resolution: "The local service is running.",
          idempotencyKey: "resolve-blocker",
        },
        human,
        activityServices,
      ),
    );
    const unblockedTask = (await Effect.runPromise(listTasks({ projectId }, taskServices))).find(
      (candidate) => candidate.id === task.id,
    );
    const history = await Effect.runPromise(
      listManualBlockers({ projectId, taskId: task.id }, activityServices),
    );
    const createRetryAfterResolution = await Effect.runPromise(
      createManualBlocker(createCommand, human, activityServices),
    );
    expect(resolved).toMatchObject({
      taskVersion: task.version + 2,
      blocker: {
        status: "resolved",
        resolution: "The local service is running.",
      },
    });
    expect(unblockedTask?.eligibility?.claimable).toBe(true);
    expect(history).toEqual([resolved.blocker]);
    expect(createRetryAfterResolution).toEqual(created);
    expect(createRetryAfterResolution.blocker.status).toBe("active");
  });

  it("lets only the active lease owner report a blocker and keeps resolution human-gated", async () => {
    const task = await createReadyTask("agent-blocker");
    const owner = await registerAgent("blocker-owner");
    const other = await registerAgent("blocker-other");
    const grant = await Effect.runPromise(
      claimTask(
        {
          projectId,
          taskId: task.id,
          expectedVersion: task.version,
          leaseDurationSeconds: 300,
          idempotencyKey: "claim-agent-blocker",
        },
        owner,
        taskServices,
      ),
    );
    const rejected = await Effect.runPromise(
      Effect.either(
        createAgentManualBlocker(
          {
            blockerId: "blocker-agent-spoof",
            projectId,
            taskId: task.id,
            expectedTaskVersion: grant.task.version,
            reason: "This run does not own the task.",
            leaseToken: grant.leaseToken,
            idempotencyKey: "agent-blocker-spoof",
          },
          other,
          activityServices,
        ),
      ),
    );
    expect(Either.isLeft(rejected) && rejected.left).toMatchObject({
      _tag: "TaskLeaseError",
      reason: "owner_mismatch",
    });

    const command = {
      blockerId: "blocker-agent-owned",
      projectId,
      taskId: task.id,
      expectedTaskVersion: grant.task.version,
      reason: "A human must choose the compatibility policy.",
      leaseToken: grant.leaseToken,
      idempotencyKey: "agent-blocker-owned",
    };
    const created = await Effect.runPromise(
      createAgentManualBlocker(command, owner, activityServices),
    );
    const retry = await Effect.runPromise(
      createAgentManualBlocker(command, owner, activityServices),
    );

    expect(retry).toEqual(created);
    expect(created).toMatchObject({
      blocker: {
        id: command.blockerId,
        status: "active",
        createdBy: { type: "agent", id: owner.run.id },
      },
      taskVersion: grant.task.version + 1,
      event: {
        kind: "task.blocker.created",
        importance: "attention",
        actor: { type: "agent", id: owner.run.id },
        payload: {
          leaseId: grant.claim.id,
          attemptId: grant.attempt.id,
          agentRunId: owner.run.id,
        },
        changes: {
          taskIds: [task.id],
          agentRunIds: [owner.run.id],
          scopes: ["activity", "agents", "tasks"],
        },
      },
    });

    const agentResolution = await Effect.runPromise(
      Effect.either(
        resolveManualBlocker(
          {
            blockerId: created.blocker.id,
            projectId,
            taskId: task.id,
            expectedTaskVersion: created.taskVersion,
            resolution: "Agents must not resolve their own escalation.",
            idempotencyKey: "agent-resolve-blocker",
          },
          { type: "agent", id: owner.run.id },
          activityServices,
        ),
      ),
    );
    expect(Either.isLeft(agentResolution) && agentResolution.left).toMatchObject({
      _tag: "ActivityAttributionError",
    });
    expect(
      await Effect.runPromise(
        listManualBlockers(
          { projectId, taskId: task.id, includeResolved: false },
          activityServices,
        ),
      ),
    ).toEqual([created.blocker]);

    const resolved = await Effect.runPromise(
      resolveManualBlocker(
        {
          blockerId: created.blocker.id,
          projectId,
          taskId: task.id,
          expectedTaskVersion: created.taskVersion,
          resolution: "Use the compatibility layer.",
          idempotencyKey: "human-resolve-agent-blocker",
        },
        human,
        activityServices,
      ),
    );
    expect(resolved.blocker).toMatchObject({
      status: "resolved",
      resolvedBy: human,
    });
  });

  it("adds an attributed system timeline entry when an active lease expires", async () => {
    const task = await createReadyTask("system-expiry");
    const owner = await registerAgent("system-expiry-owner");
    const grant = await Effect.runPromise(
      claimTask(
        {
          projectId,
          taskId: task.id,
          expectedVersion: task.version,
          leaseDurationSeconds: 30,
          idempotencyKey: "claim-system-expiry",
        },
        owner,
        taskServices,
      ),
    );
    now = grant.claim.expiresAt;

    expect(await Effect.runPromise(reconcileTaskLeases(taskServices))).toBe(1);
    expect(await Effect.runPromise(reconcileTaskLeases(taskServices))).toBe(0);
    const entries = await Effect.runPromise(
      listActivityEntries({ projectId, taskId: task.id }, activityServices),
    );
    const events = await Effect.runPromise(
      readActivityEvents({ projectId, afterCursor: 0, limit: 200 }, activityServices),
    );
    const event = events.events.find((candidate) => candidate.kind === "task.lease.expired");
    const entryId = `system-lease-expired-${grant.claim.id}`;

    expect(entries).toEqual([
      expect.objectContaining({
        id: entryId,
        taskId: task.id,
        attemptId: grant.attempt.id,
        kind: "system",
        author: { type: "system", id: "helm" },
        authorDisplayName: "Helm",
        agentProfileId: null,
        contentText: "Lease expired.",
      }),
    ]);
    expect(event).toMatchObject({
      actor: { type: "system", id: "helm" },
      payload: { activityEntryId: entryId, reason: "Lease expired." },
      changes: {
        activityEntryIds: [entryId],
        agentRunIds: [owner.run.id],
        taskIds: [task.id],
        scopes: ["activity", "agents", "tasks"],
      },
    });
  });

  it("rolls back automatic lease expiry if its system timeline entry cannot be written", async () => {
    const task = await createReadyTask("system-expiry-rollback");
    const owner = await registerAgent("system-expiry-rollback-owner");
    const grant = await Effect.runPromise(
      claimTask(
        {
          projectId,
          taskId: task.id,
          expectedVersion: task.version,
          leaseDurationSeconds: 30,
          idempotencyKey: "claim-system-expiry-rollback",
        },
        owner,
        taskServices,
      ),
    );
    projectStore.database.exec(`
      create trigger reject_system_activity
      before insert on activity_entries
      when new.kind = 'system'
      begin
        select raise(abort, 'system activity rejected');
      end
    `);
    now = grant.claim.expiresAt;

    const result = await Effect.runPromise(Effect.either(reconcileTaskLeases(taskServices)));
    expect(Either.isLeft(result) && result.left).toMatchObject({
      _tag: "TaskPersistenceError",
    });
    expect(
      projectStore.database.prepare("select status from leases where id = ?").get(grant.claim.id),
    ).toEqual({ status: "active" });
    expect(
      projectStore.database
        .prepare("select status from attempts where id = ?")
        .get(grant.attempt.id),
    ).toEqual({ status: "active" });
    expect(
      projectStore.database
        .prepare("select lifecycle, version from tasks where id = ?")
        .get(task.id),
    ).toEqual({
      lifecycle: "in_progress",
      version: grant.task.version,
    });
    expect(
      projectStore.database
        .prepare(
          "select count(*) as count from events where kind = 'task.lease.expired' and entity_id = ?",
        )
        .get(task.id),
    ).toEqual({ count: 0 });
  });

  it("serializes competing blocker changes through optimistic task versions", async () => {
    const task = await createReadyTask("blocker-race");
    const operations = ["first", "second"].map((suffix) =>
      Effect.runPromise(
        Effect.either(
          createManualBlocker(
            {
              blockerId: `blocker-race-${suffix}`,
              projectId,
              taskId: task.id,
              expectedTaskVersion: task.version,
              reason: `Blocker ${suffix}.`,
              idempotencyKey: `blocker-race-${suffix}-key`,
            },
            human,
            activityServices,
          ),
        ),
      ),
    );
    const results = await Promise.all(operations);
    expect(results.filter(Either.isRight)).toHaveLength(1);
    expect(results.filter(Either.isLeft)).toHaveLength(1);
    const failure = results.find(Either.isLeft);
    expect(failure && failure.left).toMatchObject({
      _tag: "TaskVersionConflictError",
    });
    expect(
      await Effect.runPromise(listManualBlockers({ projectId, taskId: task.id }, activityServices)),
    ).toHaveLength(1);
  });

  it("reads targeted task deltas including archived records", async () => {
    const task = await createReadyTask("delta");
    const other = await createReadyTask("delta-other");
    const archived = await Effect.runPromise(
      archiveTask(
        {
          taskId: task.id,
          expectedVersion: task.version,
          reason: "No longer needed.",
          idempotencyKey: "archive-delta-task",
        },
        human,
        taskServices,
      ),
    );
    const active = await Effect.runPromise(listTasks({ projectId }, taskServices));
    const delta = await Effect.runPromise(
      listTasks({ projectId, taskIds: [task.id] }, taskServices),
    );

    expect(active.map((candidate) => candidate.id)).toContain(other.id);
    expect(active.map((candidate) => candidate.id)).not.toContain(task.id);
    expect(delta).toHaveLength(1);
    expect(delta[0]).toMatchObject({
      id: task.id,
      archivedAt: archived.archivedAt,
    });
  });

  it("rolls back entry and idempotency projections when event append fails", async () => {
    const task = await createReadyTask("rollback");
    projectStore.database.exec(`
      create trigger reject_activity_event
      before insert on events
      when new.kind = 'task.entry.comment.created'
      begin
        select raise(abort, 'event append rejected');
      end
    `);
    const result = await Effect.runPromise(
      Effect.either(
        createHumanActivityEntry(
          {
            entryId: "entry-rollback",
            projectId,
            taskId: task.id,
            kind: "comment",
            content: richText("Must roll back."),
            expectedTaskVersion: task.version,
            idempotencyKey: "entry-rollback-key",
          },
          human,
          activityServices,
        ),
      ),
    );
    expect(Either.isLeft(result) && result.left["_tag"]).toBe("ActivityPersistenceError");
    expect(
      projectStore.database
        .prepare("select count(*) as count from activity_entries where id = ?")
        .get("entry-rollback"),
    ).toEqual({ count: 0 });
    expect(
      projectStore.database
        .prepare("select count(*) as count from idempotency_records where key = ?")
        .get("entry-rollback-key"),
    ).toEqual({ count: 0 });
  });
});
