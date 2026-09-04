import { mkdir, mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { StreamableHTTPClientTransport } from "@modelcontextprotocol/sdk/client/streamableHttp.js";
import { Effect } from "effect";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { z } from "zod";

import { createProject } from "../application/projects";
import { reconcileActiveAgentRuns } from "../application/agents";
import { registeredAgentRunSchema } from "../domain/agents";
import {
  activityEntryMutationResultSchema,
  activityEntrySchema,
  activityEventPageSchema,
  manualBlockerMutationResultSchema,
} from "../domain/activity";
import {
  emptyRichTextDocument,
  richTextDocumentSchema,
  taskContextPackageSchema,
  taskDiscoveryPageSchema,
  taskLeaseGrantSchema,
  taskLeaseMutationResultSchema,
  taskSchema,
} from "../domain/tasks";
import { createSqliteAgentStore } from "../infrastructure/sqlite-agent-store.server";
import { createSqliteActivityStore } from "../infrastructure/sqlite-activity-store.server";
import { localRepositoryInspector } from "../infrastructure/repository-inspector.server";
import {
  createSqliteProjectStore,
  type SqliteProjectStore,
} from "../infrastructure/sqlite-project-store.server";
import { createSqliteTaskStore } from "../infrastructure/sqlite-task-store.server";
import { createMcpRequestHandler } from "./http-transport.server";

const successfulRegistrationSchema = z.object({
  ok: z.literal(true),
  registration: registeredAgentRunSchema,
});
const successfulTaskSchema = z.object({
  ok: z.literal(true),
  task: taskSchema,
});
const successfulDiscoverySchema = z.object({
  ok: z.literal(true),
  page: taskDiscoveryPageSchema,
});
const successfulContextSchema = z.object({
  ok: z.literal(true),
  context: taskContextPackageSchema,
});
const successfulLeaseGrantSchema = z.object({
  ok: z.literal(true),
  grant: taskLeaseGrantSchema,
});
const successfulLeaseMutationSchema = z.object({
  ok: z.literal(true),
  result: taskLeaseMutationResultSchema,
});
const successfulActivityMutationSchema = z.object({
  ok: z.literal(true),
  payload: activityEntryMutationResultSchema,
});
const successfulActivityEntriesSchema = z.object({
  ok: z.literal(true),
  payload: z.array(activityEntrySchema),
});
const successfulActivityEventsSchema = z.object({
  ok: z.literal(true),
  payload: activityEventPageSchema,
});
const successfulManualBlockerMutationSchema = z.object({
  ok: z.literal(true),
  payload: manualBlockerMutationResultSchema,
});

let temporaryRoot: string;
let projectStore: SqliteProjectStore;
let projectId: string;
let now: string;
let client: Client;
let transport: StreamableHTTPClientTransport;
let handleMcpRequest: ReturnType<typeof createMcpRequestHandler>;
let projectServices: Parameters<typeof createMcpRequestHandler>[0];
let taskServices: Parameters<typeof createMcpRequestHandler>[1];
let agentServices: Parameters<typeof createMcpRequestHandler>[2];
let activityServices: Parameters<typeof createMcpRequestHandler>[3];

async function connectClient() {
  transport = new StreamableHTTPClientTransport(new URL("http://helm.local/api/mcp"), {
    fetch: (url, init) => handleMcpRequest(new Request(url, init)),
  });
  client = new Client({ name: "helm-contract-test", version: "1.0.0" });
  await client.connect(transport);
}

beforeEach(async () => {
  temporaryRoot = await mkdtemp(join(tmpdir(), "helm-mcp-http-test-"));
  const repositoryRoot = join(temporaryRoot, "repository");
  await mkdir(join(repositoryRoot, ".git"), { recursive: true });
  await writeFile(
    join(repositoryRoot, "AGENTS.md"),
    "# Project instructions\n\nKeep repository artifacts in English.\n",
  );
  await mkdir(join(repositoryRoot, "src", "domain"), { recursive: true });
  await writeFile(
    join(repositoryRoot, "src", "AGENTS.md"),
    "# Source instructions\n\nKeep domain rules free of adapter imports.\n",
  );

  projectStore = createSqliteProjectStore(":memory:");
  projectServices = {
    store: projectStore,
    inspector: localRepositoryInspector,
  };
  const project = await Effect.runPromise(
    createProject({ repositoryRoot, idempotencyKey: "mcp-project" }, projectServices),
  );
  projectId = project.id;

  now = "2026-09-03T12:00:00.000Z";
  taskServices = {
    store: createSqliteTaskStore(projectStore.database),
    clock: {
      today: () => "2026-09-03",
      now: () => now,
    },
  };
  agentServices = { store: createSqliteAgentStore(projectStore.database) };
  activityServices = {
    store: createSqliteActivityStore(projectStore.database),
    clock: { now: () => now },
  };
  handleMcpRequest = createMcpRequestHandler(
    projectServices,
    taskServices,
    agentServices,
    activityServices,
  );
  await connectClient();
});

afterEach(async () => {
  await transport?.terminateSession();
  await client?.close();
  projectStore?.close();
  await rm(temporaryRoot, { recursive: true, force: true });
});

function readyTaskArguments(title: string, idempotencyKey: string, capabilities: string[]) {
  return {
    projectId,
    parentTaskId: null,
    lifecycle: "ready",
    title,
    description: emptyRichTextDocument,
    expectedOutcome: `${title} is available.`,
    acceptanceCriteria: `${title} is verified.`,
    agentContext: "Use the existing command and persistence boundaries.",
    checklist: [{ id: "verify", text: `Verify ${title}`, checked: false }],
    referencedPaths: ["src/domain/tasks.ts"],
    priority: "high",
    position: 1,
    requiredCapabilities: capabilities,
    expectedVersion: 0,
    idempotencyKey,
  };
}

function activityContent(text: string) {
  return richTextDocumentSchema.parse({
    version: 1,
    doc: {
      type: "doc",
      content: [{ type: "paragraph", content: [{ type: "text", text }] }],
    },
  });
}

function persistedLeaseState(leaseId: string) {
  return projectStore.database
    .prepare<
      [string],
      {
        attemptStatus: string;
        attemptSummary: string;
        invalidationReason: string | null;
        leaseStatus: string;
        runStatus: string;
        taskLifecycle: string;
        taskVersion: number;
      }
    >(
      `select
        a.status as attemptStatus,
        a.summary as attemptSummary,
        l.invalidation_reason as invalidationReason,
        l.status as leaseStatus,
        ar.status as runStatus,
        t.lifecycle as taskLifecycle,
        t.version as taskVersion
      from leases l
      join attempts a on a.id = l.attempt_id
      join agent_runs ar on ar.id = l.agent_run_id
      join tasks t on t.id = l.task_id
      where l.id = ?`,
    )
    .get(leaseId);
}

function persistedLeaseEvents(taskId: string) {
  return projectStore.database
    .prepare<
      [string],
      {
        actorId: string;
        actorType: string;
        changes: string;
        kind: string;
        payload: string;
      }
    >(
      `select
        actor_id as actorId,
        actor_type as actorType,
        changes_json as changes,
        kind,
        payload_json as payload
      from events
      where entity_id = ? and kind in ('task.lease.cancelled', 'task.lease.expired')
      order by cursor`,
    )
    .all(taskId);
}

function persistedSystemActivity(taskId: string) {
  return projectStore.database
    .prepare<
      [string],
      {
        id: string;
        attemptId: string;
        authorType: string;
        authorId: string;
        authorDisplayName: string;
        contentText: string;
      }
    >(
      `select
        id,
        attempt_id as attemptId,
        author_type as authorType,
        author_id as authorId,
        author_display_name as authorDisplayName,
        content_text as contentText
      from activity_entries
      where task_id = ? and kind = 'system'`,
    )
    .get(taskId);
}

describe("MCP agent run, work discovery, and lease contract", () => {
  it("claims chosen and next work, renews and releases leases, and rejects stale ownership", async () => {
    const tools = await client.listTools();
    expect(tools.tools.map((tool) => tool.name)).toEqual(
      expect.arrayContaining(["claim_task", "claim_next", "renew_lease", "release_lease"]),
    );
    expect(tools.tools.find((tool) => tool.name === "complete_task")?.description).toMatch(
      /currently unavailable.*lease-aware completion.*deferred/i,
    );

    const unregistered = await client.callTool({
      name: "claim_next",
      arguments: { projectId, idempotencyKey: "unregistered-claim" },
    });
    expect(unregistered).toMatchObject({
      isError: true,
      structuredContent: {
        ok: false,
        error: { type: "AgentRunRequiredError" },
      },
    });

    await client.callTool({
      name: "register_agent_run",
      arguments: {
        profileKey: "lease-agent",
        displayName: "Lease Agent",
        capabilities: ["typescript"],
        idempotencyKey: "register-lease-agent",
      },
    });
    const firstResult = await client.callTool({
      name: "create_task",
      arguments: readyTaskArguments("First ranked lease task", "first-lease-task", ["typescript"]),
    });
    const chosenResult = await client.callTool({
      name: "create_task",
      arguments: readyTaskArguments("Chosen lease task", "chosen-lease-task", ["typescript"]),
    });
    expect(firstResult.structuredContent).toMatchObject({ ok: true });
    expect(chosenResult.structuredContent).toMatchObject({ ok: true });
    const firstTask = successfulTaskSchema.parse(firstResult.structuredContent).task;
    const chosenTask = successfulTaskSchema.parse(chosenResult.structuredContent).task;
    const chosenArguments = {
      projectId,
      taskId: chosenTask.id,
      expectedVersion: chosenTask.version,
      leaseDurationSeconds: 300,
      idempotencyKey: "claim-chosen-task",
    };

    const chosenClaimResult = await client.callTool({
      name: "claim_task",
      arguments: chosenArguments,
    });
    const chosenClaim = successfulLeaseGrantSchema.parse(chosenClaimResult.structuredContent).grant;
    expect(chosenClaim).toMatchObject({
      task: { id: chosenTask.id, lifecycle: "in_progress" },
      attempt: { taskId: chosenTask.id, status: "active" },
      claim: {
        taskId: chosenTask.id,
        attemptId: chosenClaim.attempt.id,
        status: "active",
        agentDisplayName: "Lease Agent",
      },
    });
    expect(chosenClaim.leaseToken).toEqual(expect.any(String));

    const chosenRetry = await client.callTool({
      name: "claim_task",
      arguments: chosenArguments,
    });
    expect(chosenRetry.structuredContent).toEqual(chosenClaimResult.structuredContent);
    const unavailableClaim = await client.callTool({
      name: "claim_task",
      arguments: {
        ...chosenArguments,
        expectedVersion: chosenClaim.task.version,
        idempotencyKey: "claim-chosen-task-again",
      },
    });
    expect(unavailableClaim).toMatchObject({
      isError: true,
      structuredContent: {
        ok: false,
        error: {
          type: "TaskClaimUnavailableError",
          taskId: chosenTask.id,
          eligibilityStatus: "claimed",
          reasons: expect.any(Array),
        },
      },
    });

    const nextClaimResult = await client.callTool({
      name: "claim_next",
      arguments: {
        projectId,
        leaseDurationSeconds: 300,
        idempotencyKey: "claim-next-task",
      },
    });
    const nextClaim = successfulLeaseGrantSchema.parse(nextClaimResult.structuredContent).grant;
    expect(nextClaim.task).toMatchObject({
      id: firstTask.id,
      lifecycle: "in_progress",
    });

    const renewedResult = await client.callTool({
      name: "renew_lease",
      arguments: {
        leaseToken: chosenClaim.leaseToken,
        expectedVersion: chosenClaim.task.version,
        leaseDurationSeconds: 600,
        idempotencyKey: "renew-chosen-lease",
      },
    });
    const renewed = successfulLeaseGrantSchema.parse(renewedResult.structuredContent).grant;
    expect(renewed).toMatchObject({
      task: { id: chosenTask.id, lifecycle: "in_progress" },
      claim: { id: chosenClaim.claim.id, status: "active" },
      leaseToken: chosenClaim.leaseToken,
    });

    const foreignTransport = new StreamableHTTPClientTransport(
      new URL("http://helm.local/api/mcp"),
      { fetch: (url, init) => handleMcpRequest(new Request(url, init)) },
    );
    const foreignClient = new Client({
      name: "foreign-client",
      version: "1.0.0",
    });
    await foreignClient.connect(foreignTransport);
    try {
      await foreignClient.callTool({
        name: "register_agent_run",
        arguments: {
          profileKey: "foreign-agent",
          displayName: "Foreign Agent",
          capabilities: ["typescript"],
          idempotencyKey: "register-foreign-agent",
        },
      });
      const foreignRenewal = await foreignClient.callTool({
        name: "renew_lease",
        arguments: {
          leaseToken: nextClaim.leaseToken,
          expectedVersion: nextClaim.task.version,
          idempotencyKey: "foreign-renewal",
        },
      });
      expect(foreignRenewal).toMatchObject({
        isError: true,
        structuredContent: {
          ok: false,
          error: { type: "TaskLeaseError", leaseReason: "owner_mismatch" },
        },
      });
    } finally {
      await foreignTransport.terminateSession();
      await foreignClient.close();
    }

    const releaseArguments = {
      leaseToken: chosenClaim.leaseToken,
      expectedVersion: renewed.task.version,
      reason: "Return the task to the shared queue.",
      idempotencyKey: "release-chosen-lease",
    };
    const releaseResult = await client.callTool({
      name: "release_lease",
      arguments: releaseArguments,
    });
    const released = successfulLeaseMutationSchema.parse(releaseResult.structuredContent).result;
    expect(released).toMatchObject({
      task: { id: chosenTask.id, lifecycle: "ready", claim: null },
      claim: { id: chosenClaim.claim.id, status: "released" },
    });
    const releaseRetry = await client.callTool({
      name: "release_lease",
      arguments: releaseArguments,
    });
    expect(releaseRetry.structuredContent).toEqual(releaseResult.structuredContent);

    const staleRenewal = await client.callTool({
      name: "renew_lease",
      arguments: {
        leaseToken: chosenClaim.leaseToken,
        expectedVersion: released.task.version,
        idempotencyKey: "renew-released-lease",
      },
    });
    expect(staleRenewal).toMatchObject({
      isError: true,
      structuredContent: {
        ok: false,
        error: { type: "TaskLeaseError", leaseReason: "inactive" },
      },
    });

    const lateCompletion = await client.callTool({
      name: "complete_task",
      arguments: {
        taskId: chosenTask.id,
        expectedVersion: released.task.version,
        idempotencyKey: "complete-released-lease-task",
      },
    });
    expect(lateCompletion).toMatchObject({
      isError: true,
      structuredContent: {
        ok: false,
        error: { type: "TaskLeaseError", leaseReason: "required" },
      },
    });
  });

  it("serializes registration, paginated discovery, context, typed errors, and attribution", async () => {
    const tools = await client.listTools();
    expect(tools.tools.map((tool) => tool.name)).not.toContain("discover_tasks");
    const unregistered = await client.callTool({
      name: "find_work",
      arguments: { projectId, limit: 1 },
    });
    expect(unregistered.isError).toBe(true);
    expect(unregistered.structuredContent).toEqual({
      ok: false,
      error: {
        type: "AgentRunRequiredError",
        message: "Register an agent run for this MCP session first.",
      },
    });

    const registrationResult = await client.callTool({
      name: "register_agent_run",
      arguments: {
        profileKey: "contract-agent",
        displayName: "Contract Agent",
        capabilities: ["typescript"],
        idempotencyKey: "register-contract-agent",
      },
    });
    const registration = successfulRegistrationSchema.parse(registrationResult.structuredContent);
    expect(registrationResult.content).toEqual([
      {
        type: "text",
        text: JSON.stringify(registrationResult.structuredContent),
      },
    ]);
    expect(registration.registration.profile).toMatchObject({
      profileKey: "contract-agent",
      displayName: "Contract Agent",
      capabilities: ["typescript"],
    });
    expect(registration.registration.run).toMatchObject({
      mcpSessionId: transport.sessionId,
      status: "active",
      clientName: "helm-contract-test",
      clientVersion: "1.0.0",
    });
    const registrationRetry = await client.callTool({
      name: "register_agent_run",
      arguments: {
        profileKey: "contract-agent",
        displayName: "Contract Agent",
        capabilities: ["typescript"],
        idempotencyKey: "register-contract-agent",
      },
    });
    expect(registrationRetry.structuredContent).toEqual(registrationResult.structuredContent);

    const competingTransport = new StreamableHTTPClientTransport(
      new URL("http://helm.local/api/mcp"),
      { fetch: (url, init) => handleMcpRequest(new Request(url, init)) },
    );
    const competingClient = new Client({
      name: "competing-client",
      version: "1.0.0",
    });
    await competingClient.connect(competingTransport);
    const activeRunConflict = await competingClient.callTool({
      name: "register_agent_run",
      arguments: {
        profileKey: "contract-agent",
        displayName: "Contract Agent",
        capabilities: ["typescript"],
        resumeRunId: registration.registration.run.id,
        idempotencyKey: "competing-run",
      },
    });
    expect(activeRunConflict.isError).toBe(true);
    expect(activeRunConflict.structuredContent).toEqual({
      ok: false,
      error: {
        type: "AgentRunRegistrationError",
        runId: registration.registration.run.id,
        message:
          "That agent run is active in another MCP session; request an explicit takeover to recover it.",
      },
    });
    await competingTransport.terminateSession();
    await competingClient.close();

    const originalSessionId = transport.sessionId;
    await transport.terminateSession();
    await client.close();
    await connectClient();
    const resumedResult = await client.callTool({
      name: "register_agent_run",
      arguments: {
        profileKey: "contract-agent",
        displayName: "Contract Agent",
        capabilities: ["typescript"],
        resumeRunId: registration.registration.run.id,
        idempotencyKey: "resume-contract-agent",
      },
    });
    const resumed = successfulRegistrationSchema.parse(resumedResult.structuredContent);
    expect(resumed.registration.run).toMatchObject({
      id: registration.registration.run.id,
      mcpSessionId: transport.sessionId,
      status: "active",
    });
    expect(resumed.registration.run.mcpSessionId).not.toBe(originalSessionId);

    const firstResult = await client.callTool({
      name: "create_task",
      arguments: readyTaskArguments("First matching task", "first-task", ["typescript"]),
    });
    const secondResult = await client.callTool({
      name: "create_task",
      arguments: readyTaskArguments("Second matching task", "second-task", ["typescript"]),
    });
    await client.callTool({
      name: "create_task",
      arguments: readyTaskArguments("Incompatible task", "incompatible-task", ["sqlite"]),
    });
    expect(firstResult.structuredContent).toMatchObject({ ok: true });
    expect(secondResult.structuredContent).toMatchObject({ ok: true });
    const firstTask = successfulTaskSchema.parse(firstResult.structuredContent).task;
    const secondTask = successfulTaskSchema.parse(secondResult.structuredContent).task;
    expect(firstTask.eligibility).toMatchObject({
      claimable: true,
      missingCapabilities: [],
    });

    const eventCountBefore = projectStore.database
      .prepare("select count(*) from events where entity_type = 'task'")
      .pluck()
      .get();
    const firstPageResult = await client.callTool({
      name: "find_work",
      arguments: { projectId, limit: 1 },
    });
    const firstPage = successfulDiscoverySchema.parse(firstPageResult.structuredContent).page;
    const secondPageResult = await client.callTool({
      name: "find_work",
      arguments: {
        projectId,
        limit: 1,
        cursor: firstPage.nextCursor,
        fields: ["acceptanceCriteria"],
      },
    });
    const secondPage = successfulDiscoverySchema.parse(secondPageResult.structuredContent).page;
    const eventCountAfter = projectStore.database
      .prepare("select count(*) from events where entity_type = 'task'")
      .pluck()
      .get();

    expect(firstPage).toMatchObject({
      candidates: [
        {
          id: firstTask.id,
          eligibility: {
            claimable: true,
            orderingExplanation: expect.stringContaining("high lane"),
          },
        },
      ],
      nextCursor: expect.stringMatching(/^v3:/),
    });
    expect(firstPage.candidates[0]).not.toHaveProperty("acceptanceCriteria");
    expect(firstPage.candidates[0]).not.toHaveProperty("agentContext");
    expect(secondPage.candidates[0]).toHaveProperty("acceptanceCriteria");
    expect(secondPage.nextCursor).toBeNull();
    expect(eventCountAfter).toBe(eventCountBefore);

    const relationResult = await client.callTool({
      name: "create_task_relation",
      arguments: {
        projectId,
        sourceTaskId: firstTask.id,
        targetTaskId: secondTask.id,
        type: "related_to",
        expectedSourceVersion: firstTask.version,
        expectedTargetVersion: secondTask.version,
        idempotencyKey: "context-relation",
      },
    });
    expect(relationResult.structuredContent).toMatchObject({
      ok: true,
      relation: { sourceTaskId: firstTask.id, targetTaskId: secondTask.id },
    });
    const stalePageResult = await client.callTool({
      name: "find_work",
      arguments: { projectId, limit: 1, cursor: firstPage.nextCursor },
    });
    expect(stalePageResult).toMatchObject({
      isError: true,
      structuredContent: {
        ok: false,
        error: {
          type: "TaskDiscoveryCursorStaleError",
          cursorRevision: expect.any(Number),
          currentRevision: expect.any(Number),
        },
      },
    });
    projectStore.database
      .prepare(
        "insert into attempts (id, task_id, agent_run_id, status, summary, verification_json, created_at, completed_at) values (?, ?, ?, ?, ?, ?, ?, ?)",
      )
      .run(
        "prior-attempt",
        firstTask.id,
        resumed.registration.run.id,
        "failed",
        "The first approach exposed a version conflict.",
        JSON.stringify(["pnpm typecheck"]),
        "2026-09-02T10:00:00.000Z",
        "2026-09-02T10:05:00.000Z",
      );

    const contextResult = await client.callTool({
      name: "get_task_context",
      arguments: { projectId, taskId: firstTask.id },
    });
    const context = successfulContextSchema.parse(contextResult.structuredContent).context;
    expect(context).toMatchObject({
      projectId,
      task: {
        id: firstTask.id,
        eligibility: { claimable: true, missingCapabilities: [] },
      },
      acceptanceCriteria: "First matching task is verified.",
      agentContext: "Use the existing command and persistence boundaries.",
      checklist: [{ id: "verify", checked: false }],
      relations: {
        upstream: [],
        downstream: [
          {
            type: "related_to",
            sourceTaskId: firstTask.id,
            targetTaskId: secondTask.id,
          },
        ],
      },
      paths: {
        repositoryRoot: join(temporaryRoot, "repository"),
        referencedPaths: ["src/domain/tasks.ts"],
      },
      priorAttempts: [
        {
          id: "prior-attempt",
          agentRunId: resumed.registration.run.id,
          status: "failed",
          summary: "The first approach exposed a version conflict.",
          verification: ["pnpm typecheck"],
        },
      ],
      projectInstructions: [
        {
          path: "AGENTS.md",
          text: expect.stringContaining("Keep repository artifacts in English."),
        },
        {
          path: "src/AGENTS.md",
          text: expect.stringContaining("Keep domain rules free of adapter imports."),
        },
      ],
    });

    const missingContext = await client.callTool({
      name: "get_task_context",
      arguments: { projectId, taskId: "missing-task" },
    });
    expect(missingContext.isError).toBe(true);
    expect(missingContext.structuredContent).toMatchObject({
      ok: false,
      error: { type: "TaskNotFoundError", taskId: "missing-task" },
    });

    const attributedEvent = projectStore.database
      .prepare<[string], { actorType: string; actorId: string }>(
        "select actor_type as actorType, actor_id as actorId from events where entity_type = 'task' and entity_id = ? and kind = 'task.created'",
      )
      .get(firstTask.id);
    expect(attributedEvent).toEqual({
      actorType: "agent",
      actorId: resumed.registration.run.id,
    });
    const runEvents = projectStore.database
      .prepare<[], { kind: string; actorId: string }>(
        "select kind, actor_id as actorId from events where entity_type = 'agent_run' order by cursor",
      )
      .all();
    expect(runEvents).toEqual([
      { kind: "agent.run.registered", actorId: resumed.registration.run.id },
      { kind: "agent.run.closed", actorId: resumed.registration.run.id },
      { kind: "agent.run.resumed", actorId: resumed.registration.run.id },
    ]);
  });

  it("cancels a live lease and returns its task to ready when the session terminates", async () => {
    const registrationResult = await client.callTool({
      name: "register_agent_run",
      arguments: {
        profileKey: "session-close-agent",
        displayName: "Session Close Agent",
        capabilities: ["typescript"],
        idempotencyKey: "register-session-close-agent",
      },
    });
    const registration = successfulRegistrationSchema.parse(registrationResult.structuredContent);
    const taskResult = await client.callTool({
      name: "create_task",
      arguments: readyTaskArguments("Session close task", "session-close-task", ["typescript"]),
    });
    const task = successfulTaskSchema.parse(taskResult.structuredContent).task;
    const claimResult = await client.callTool({
      name: "claim_task",
      arguments: {
        projectId,
        taskId: task.id,
        expectedVersion: task.version,
        leaseDurationSeconds: 300,
        idempotencyKey: "claim-session-close-task",
      },
    });
    const grant = successfulLeaseGrantSchema.parse(claimResult.structuredContent).grant;

    await transport.terminateSession();
    await client.close();

    expect(persistedLeaseState(grant.claim.id)).toEqual({
      attemptStatus: "abandoned",
      attemptSummary: "Agent session closed.",
      invalidationReason: "Agent session closed.",
      leaseStatus: "cancelled",
      runStatus: "closed",
      taskLifecycle: "ready",
      taskVersion: grant.task.version + 1,
    });
    const events = persistedLeaseEvents(task.id);
    expect(events).toHaveLength(1);
    expect(events[0]).toMatchObject({
      actorId: "helm",
      actorType: "system",
      kind: "task.lease.cancelled",
    });
    expect(JSON.parse(events[0]?.payload ?? "{}")).toMatchObject({
      leaseId: grant.claim.id,
      attemptId: grant.attempt.id,
      agentRunId: registration.registration.run.id,
      previousVersion: grant.task.version,
      version: grant.task.version + 1,
      reason: "Agent session closed.",
      activityEntryId: `system-lease-cancelled-${grant.claim.id}`,
    });
    expect(JSON.parse(events[0]?.changes ?? "{}")).toMatchObject({
      activityEntryIds: [`system-lease-cancelled-${grant.claim.id}`],
      agentRunIds: [registration.registration.run.id],
      taskIds: [task.id],
      scopes: ["activity", "agents", "tasks"],
    });
    expect(persistedSystemActivity(task.id)).toEqual({
      id: `system-lease-cancelled-${grant.claim.id}`,
      attemptId: grant.attempt.id,
      authorType: "system",
      authorId: "helm",
      authorDisplayName: "Helm",
      contentText: "Agent session closed.",
    });
  });

  it("expires an elapsed lease instead of cancelling it when its session terminates", async () => {
    await client.callTool({
      name: "register_agent_run",
      arguments: {
        profileKey: "expired-close-agent",
        displayName: "Expired Close Agent",
        capabilities: ["typescript"],
        idempotencyKey: "register-expired-close-agent",
      },
    });
    const taskResult = await client.callTool({
      name: "create_task",
      arguments: readyTaskArguments("Expired session task", "expired-session-task", ["typescript"]),
    });
    const task = successfulTaskSchema.parse(taskResult.structuredContent).task;
    const claimResult = await client.callTool({
      name: "claim_task",
      arguments: {
        projectId,
        taskId: task.id,
        expectedVersion: task.version,
        leaseDurationSeconds: 30,
        idempotencyKey: "claim-expired-session-task",
      },
    });
    const grant = successfulLeaseGrantSchema.parse(claimResult.structuredContent).grant;
    now = grant.claim.expiresAt;

    await transport.terminateSession();
    await client.close();

    expect(persistedLeaseState(grant.claim.id)).toEqual({
      attemptStatus: "abandoned",
      attemptSummary: "Lease expired.",
      invalidationReason: "Lease expired.",
      leaseStatus: "expired",
      runStatus: "closed",
      taskLifecycle: "ready",
      taskVersion: grant.task.version + 1,
    });
    const events = persistedLeaseEvents(task.id);
    expect(events).toHaveLength(1);
    expect(events[0]).toMatchObject({
      actorId: "helm",
      actorType: "system",
      kind: "task.lease.expired",
    });
    expect(JSON.parse(events[0]?.payload ?? "{}")).toMatchObject({
      leaseId: grant.claim.id,
      attemptId: grant.attempt.id,
      previousVersion: grant.task.version,
      version: grant.task.version + 1,
      reason: "Lease expired.",
      activityEntryId: `system-lease-expired-${grant.claim.id}`,
    });
    expect(persistedSystemActivity(task.id)).toMatchObject({
      id: `system-lease-expired-${grant.claim.id}`,
      attemptId: grant.attempt.id,
      authorType: "system",
      authorId: "helm",
      contentText: "Lease expired.",
    });
  });

  it("reconciles a run left active by a server restart before resuming it", async () => {
    const registrationResult = await client.callTool({
      name: "register_agent_run",
      arguments: {
        profileKey: "restart-agent",
        displayName: "Restart Agent",
        capabilities: ["typescript"],
        idempotencyKey: "register-before-restart",
      },
    });
    const registration = successfulRegistrationSchema.parse(registrationResult.structuredContent);

    await Effect.runPromise(reconcileActiveAgentRuns(agentServices));
    handleMcpRequest = createMcpRequestHandler(
      projectServices,
      taskServices,
      agentServices,
      activityServices,
    );
    await connectClient();
    const resumedResult = await client.callTool({
      name: "register_agent_run",
      arguments: {
        profileKey: "restart-agent",
        displayName: "Restart Agent",
        capabilities: ["typescript"],
        idempotencyKey: "register-before-restart",
      },
    });
    const resumed = successfulRegistrationSchema.parse(resumedResult.structuredContent);
    const interruptionEvent = projectStore.database
      .prepare<[], { actorType: string; payload: string }>(
        "select actor_type as actorType, payload_json as payload from events where kind = 'agent.run.closed' order by cursor desc limit 1",
      )
      .get();

    expect(resumed.registration.run).toMatchObject({
      id: registration.registration.run.id,
      status: "active",
      mcpSessionId: transport.sessionId,
    });
    expect(interruptionEvent?.actorType).toBe("system");
    expect(JSON.parse(interruptionEvent?.payload ?? "{}")).toMatchObject({
      reason: "server_restart",
    });
  });

  it("requires takeover and ignores closure of the displaced session", async () => {
    const registrationResult = await client.callTool({
      name: "register_agent_run",
      arguments: {
        profileKey: "takeover-agent",
        displayName: "Takeover Agent",
        capabilities: ["typescript"],
        idempotencyKey: "register-takeover-agent",
      },
    });
    const registration = successfulRegistrationSchema.parse(registrationResult.structuredContent);
    const taskResult = await client.callTool({
      name: "create_task",
      arguments: readyTaskArguments("Takeover lease task", "takeover-lease-task", ["typescript"]),
    });
    const task = successfulTaskSchema.parse(taskResult.structuredContent).task;
    const claimResult = await client.callTool({
      name: "claim_task",
      arguments: {
        projectId,
        taskId: task.id,
        expectedVersion: task.version,
        leaseDurationSeconds: 300,
        idempotencyKey: "claim-takeover-lease-task",
      },
    });
    const grant = successfulLeaseGrantSchema.parse(claimResult.structuredContent).grant;
    const replacementTransport = new StreamableHTTPClientTransport(
      new URL("http://helm.local/api/mcp"),
      { fetch: (url, init) => handleMcpRequest(new Request(url, init)) },
    );
    const replacementClient = new Client({
      name: "replacement-client",
      version: "1.0.0",
    });
    await replacementClient.connect(replacementTransport);

    try {
      const takeoverResult = await replacementClient.callTool({
        name: "register_agent_run",
        arguments: {
          profileKey: "takeover-agent",
          displayName: "Takeover Agent",
          capabilities: ["typescript"],
          resumeRunId: registration.registration.run.id,
          takeoverActiveRun: true,
          idempotencyKey: "take-over-stale-run",
        },
      });
      const takeover = successfulRegistrationSchema.parse(takeoverResult.structuredContent);
      const displacedSession = await client.callTool({
        name: "find_work",
        arguments: { projectId, limit: 1 },
      });

      expect(takeover.registration.run).toMatchObject({
        id: registration.registration.run.id,
        mcpSessionId: replacementTransport.sessionId,
        status: "active",
      });
      expect(displacedSession).toMatchObject({
        isError: true,
        structuredContent: {
          ok: false,
          error: { type: "AgentRunRequiredError" },
        },
      });

      await transport.terminateSession();
      await client.close();
      const renewalResult = await replacementClient.callTool({
        name: "renew_lease",
        arguments: {
          leaseToken: grant.leaseToken,
          expectedVersion: grant.task.version,
          leaseDurationSeconds: 600,
          idempotencyKey: "renew-after-takeover",
        },
      });
      const renewed = successfulLeaseGrantSchema.parse(renewalResult.structuredContent).grant;

      expect(renewed).toMatchObject({
        leaseToken: grant.leaseToken,
        task: { id: task.id, lifecycle: "in_progress" },
        claim: { id: grant.claim.id, status: "active" },
      });
      expect(persistedLeaseState(grant.claim.id)).toMatchObject({
        attemptStatus: "active",
        invalidationReason: null,
        leaseStatus: "active",
        runStatus: "active",
        taskLifecycle: "in_progress",
      });
      const activeSessionId = projectStore.database
        .prepare<[string], string>("select mcp_session_id from agent_runs where id = ?")
        .pluck()
        .get(registration.registration.run.id);
      expect(activeSessionId).toBe(replacementTransport.sessionId);
    } finally {
      await replacementTransport.terminateSession();
      await replacementClient.close();
    }
  });
});

describe("MCP activity and event contract", () => {
  it("exposes narrow activity tools with registered-run attribution and idempotency", async () => {
    const activityToolNames = [
      "add_comment",
      "report_progress",
      "report_blocker",
      "record_decision",
      "request_change",
      "list_task_entries",
      "read_events",
    ];
    const tools = await client.listTools();
    const activityTools = tools.tools.filter((tool) => activityToolNames.includes(tool.name));

    expect(activityTools).toHaveLength(activityToolNames.length);
    expect(activityTools.map((tool) => tool.name)).toEqual(
      expect.arrayContaining(activityToolNames),
    );
    for (const tool of activityTools) {
      expect(tool.outputSchema).toMatchObject({
        type: "object",
        properties: {
          ok: expect.any(Object),
          payload: expect.any(Object),
          error: expect.any(Object),
        },
        required: ["ok"],
      });
    }
    const progressTool = activityTools.find((tool) => tool.name === "report_progress");
    expect(progressTool?.inputSchema).toMatchObject({
      type: "object",
      properties: { leaseToken: expect.any(Object) },
      required: expect.arrayContaining(["leaseToken"]),
    });
    expect(progressTool?.inputSchema.properties).not.toHaveProperty("kind");
    const blockerTool = activityTools.find((tool) => tool.name === "report_blocker");
    expect(blockerTool?.inputSchema).toMatchObject({
      type: "object",
      properties: { leaseToken: expect.any(Object) },
      required: expect.arrayContaining(["leaseToken"]),
    });
    expect(blockerTool?.inputSchema.properties).not.toHaveProperty("actor");
    expect(blockerTool?.inputSchema.properties).not.toHaveProperty("agentRunId");
    expect(tools.tools.find((tool) => tool.name === "resolve_blocker")).toBeUndefined();
    const commentTool = activityTools.find((tool) => tool.name === "add_comment");
    expect(commentTool?.inputSchema.properties).not.toHaveProperty("kind");
    expect(commentTool?.inputSchema.properties).not.toHaveProperty("actor");
    expect(commentTool?.inputSchema.properties).not.toHaveProperty("agentRunId");
    const listEntriesTool = activityTools.find((tool) => tool.name === "list_task_entries");
    expect(listEntriesTool?.inputSchema).toMatchObject({
      required: expect.arrayContaining(["projectId", "taskId"]),
    });
    expect(listEntriesTool?.inputSchema.properties).not.toHaveProperty("entryIds");
    const readEventsTool = activityTools.find((tool) => tool.name === "read_events");
    expect(readEventsTool?.inputSchema.properties).not.toHaveProperty("direction");
    expect(readEventsTool?.inputSchema.properties).not.toHaveProperty("beforeCursor");

    const unregistered = await client.callTool({
      name: "add_comment",
      arguments: {
        entryId: "unregistered-comment",
        projectId,
        taskId: "missing-task",
        content: activityContent("This must not be written."),
        expectedTaskVersion: 1,
        idempotencyKey: "unregistered-comment",
      },
    });
    expect(unregistered).toMatchObject({
      isError: true,
      structuredContent: {
        ok: false,
        error: { type: "AgentRunRequiredError" },
      },
    });
    const unregisteredRead = await client.callTool({
      name: "read_events",
      arguments: { projectId, afterCursor: 0, limit: 1 },
    });
    expect(unregisteredRead).toMatchObject({
      isError: true,
      structuredContent: {
        ok: false,
        error: { type: "AgentRunRequiredError" },
      },
    });

    const registrationResult = await client.callTool({
      name: "register_agent_run",
      arguments: {
        profileKey: "activity-agent",
        displayName: "Activity Agent",
        capabilities: ["typescript"],
        idempotencyKey: "register-activity-agent",
      },
    });
    const registration = successfulRegistrationSchema.parse(registrationResult.structuredContent);
    const taskResult = await client.callTool({
      name: "create_task",
      arguments: readyTaskArguments("Activity contract task", "activity-contract-task", [
        "typescript",
      ]),
    });
    const task = successfulTaskSchema.parse(taskResult.structuredContent).task;
    const commentArguments = {
      entryId: "activity-comment",
      projectId,
      taskId: task.id,
      content: activityContent("The adapter boundary is mapped."),
      expectedTaskVersion: task.version,
      idempotencyKey: "activity-comment-command",
    };

    const commentResult = await client.callTool({
      name: "add_comment",
      arguments: commentArguments,
    });
    const comment = successfulActivityMutationSchema.parse(commentResult.structuredContent).payload;
    expect(comment).toMatchObject({
      entry: {
        id: "activity-comment",
        kind: "comment",
        author: { type: "agent", id: registration.registration.run.id },
        authorDisplayName: "Activity Agent",
        agentProfileId: registration.registration.profile.id,
        contentText: "The adapter boundary is mapped.",
      },
      event: {
        kind: "task.entry.comment.created",
        actor: { type: "agent", id: registration.registration.run.id },
      },
      taskVersion: task.version,
    });

    const commentRetry = await client.callTool({
      name: "add_comment",
      arguments: commentArguments,
    });
    expect(commentRetry.structuredContent).toEqual(commentResult.structuredContent);
    const conflict = await client.callTool({
      name: "add_comment",
      arguments: {
        ...commentArguments,
        entryId: "conflicting-comment",
        content: activityContent("This is a different command."),
      },
    });
    expect(conflict).toMatchObject({
      isError: true,
      structuredContent: {
        ok: false,
        error: {
          type: "ActivityIdempotencyConflictError",
          key: commentArguments.idempotencyKey,
        },
      },
    });

    now = "2026-09-03T12:01:00.000Z";
    const decisionResult = await client.callTool({
      name: "record_decision",
      arguments: {
        ...commentArguments,
        entryId: "activity-decision",
        content: activityContent("Keep the application seam authoritative."),
        idempotencyKey: "activity-decision-command",
      },
    });
    expect(decisionResult.structuredContent).toMatchObject({
      ok: true,
      payload: { entry: { kind: "decision" } },
    });

    now = "2026-09-03T12:02:00.000Z";
    const changeResult = await client.callTool({
      name: "request_change",
      arguments: {
        ...commentArguments,
        entryId: "activity-change-request",
        content: activityContent("Add the forward event reader."),
        idempotencyKey: "activity-change-command",
      },
    });
    expect(changeResult.structuredContent).toMatchObject({
      ok: true,
      payload: {
        entry: { kind: "change_request" },
        event: {
          kind: "task.entry.change_request.created",
          importance: "attention",
        },
      },
    });

    const entriesResult = await client.callTool({
      name: "list_task_entries",
      arguments: { projectId, taskId: task.id, limit: 10 },
    });
    const entries = successfulActivityEntriesSchema.parse(entriesResult.structuredContent).payload;
    expect(entries.map(({ id, kind, contentText }) => ({ id, kind, contentText }))).toEqual([
      {
        id: "activity-comment",
        kind: "comment",
        contentText: "The adapter boundary is mapped.",
      },
      {
        id: "activity-decision",
        kind: "decision",
        contentText: "Keep the application seam authoritative.",
      },
      {
        id: "activity-change-request",
        kind: "change_request",
        contentText: "Add the forward event reader.",
      },
    ]);
    expect(
      projectStore.database
        .prepare("select count(*) from activity_entries where id = 'activity-comment'")
        .pluck()
        .get(),
    ).toBe(1);
  });

  it("binds progress to the registered run's lease and paginates events forward", async () => {
    const registrationResult = await client.callTool({
      name: "register_agent_run",
      arguments: {
        profileKey: "progress-agent",
        displayName: "Progress Agent",
        capabilities: ["typescript"],
        idempotencyKey: "register-progress-agent",
      },
    });
    const registration = successfulRegistrationSchema.parse(registrationResult.structuredContent);
    const taskResult = await client.callTool({
      name: "create_task",
      arguments: readyTaskArguments("Progress contract task", "progress-contract-task", [
        "typescript",
      ]),
    });
    const task = successfulTaskSchema.parse(taskResult.structuredContent).task;

    const invalidLease = await client.callTool({
      name: "report_progress",
      arguments: {
        entryId: "invalid-progress",
        projectId,
        taskId: task.id,
        content: activityContent("This lease is not valid."),
        expectedTaskVersion: task.version,
        idempotencyKey: "invalid-progress-command",
        leaseToken: "not-a-valid-lease",
      },
    });
    expect(invalidLease).toMatchObject({
      isError: true,
      structuredContent: {
        ok: false,
        error: {
          type: "TaskLeaseError",
          taskId: task.id,
          leaseReason: "not_found",
        },
      },
    });

    const claimResult = await client.callTool({
      name: "claim_task",
      arguments: {
        projectId,
        taskId: task.id,
        expectedVersion: task.version,
        leaseDurationSeconds: 300,
        idempotencyKey: "claim-progress-contract-task",
      },
    });
    const grant = successfulLeaseGrantSchema.parse(claimResult.structuredContent).grant;
    const staleComment = await client.callTool({
      name: "add_comment",
      arguments: {
        entryId: "stale-version-comment",
        projectId,
        taskId: task.id,
        content: activityContent("This is based on stale task context."),
        expectedTaskVersion: task.version,
        idempotencyKey: "stale-version-comment-command",
      },
    });
    expect(staleComment).toMatchObject({
      isError: true,
      structuredContent: {
        ok: false,
        error: {
          type: "TaskVersionConflictError",
          taskId: task.id,
          expectedVersion: task.version,
          currentVersion: grant.task.version,
          changeSummary: expect.stringContaining(`changed since version ${task.version}`),
        },
      },
    });
    const baselineResult = await client.callTool({
      name: "read_events",
      arguments: { projectId, afterCursor: 0, limit: 200 },
    });
    const baseline = successfulActivityEventsSchema.parse(baselineResult.structuredContent).payload;

    now = "2026-09-03T12:03:00.000Z";
    const progressArguments = {
      entryId: "leased-progress",
      projectId,
      taskId: task.id,
      content: activityContent("The MCP activity contract is implemented."),
      expectedTaskVersion: grant.task.version,
      idempotencyKey: "leased-progress-command",
      leaseToken: grant.leaseToken,
    };
    const progressResult = await client.callTool({
      name: "report_progress",
      arguments: progressArguments,
    });
    const progress = successfulActivityMutationSchema.parse(
      progressResult.structuredContent,
    ).payload;
    expect(progress).toMatchObject({
      entry: {
        kind: "progress",
        attemptId: grant.attempt.id,
        author: { type: "agent", id: registration.registration.run.id },
      },
      event: { kind: "task.entry.progress.created" },
      taskVersion: grant.task.version,
    });
    const progressRetry = await client.callTool({
      name: "report_progress",
      arguments: progressArguments,
    });
    expect(progressRetry.structuredContent).toEqual(progressResult.structuredContent);

    now = "2026-09-03T12:04:00.000Z";
    await client.callTool({
      name: "record_decision",
      arguments: {
        entryId: "post-progress-decision",
        projectId,
        taskId: task.id,
        content: activityContent("Keep the stream cursor monotonic."),
        expectedTaskVersion: grant.task.version,
        idempotencyKey: "post-progress-decision-command",
      },
    });

    const firstPageResult = await client.callTool({
      name: "read_events",
      arguments: { projectId, afterCursor: baseline.latestCursor, limit: 1 },
    });
    const firstPage = successfulActivityEventsSchema.parse(
      firstPageResult.structuredContent,
    ).payload;
    expect(firstPage).toMatchObject({
      direction: "forward",
      events: [{ kind: "task.entry.progress.created" }],
      hasMore: true,
    });
    expect(firstPage.nextCursor).toBe(firstPage.events[0]?.cursor);

    const secondPageResult = await client.callTool({
      name: "read_events",
      arguments: { projectId, afterCursor: firstPage.nextCursor, limit: 1 },
    });
    const secondPage = successfulActivityEventsSchema.parse(
      secondPageResult.structuredContent,
    ).payload;
    expect(secondPage).toMatchObject({
      direction: "forward",
      events: [{ kind: "task.entry.decision.created" }],
      hasMore: false,
    });
    expect(secondPage.events[0]?.cursor).toBeGreaterThan(firstPage.nextCursor);

    const foreignTransport = new StreamableHTTPClientTransport(
      new URL("http://helm.local/api/mcp"),
      { fetch: (url, init) => handleMcpRequest(new Request(url, init)) },
    );
    const foreignClient = new Client({
      name: "foreign-progress-client",
      version: "1.0.0",
    });
    await foreignClient.connect(foreignTransport);
    try {
      await foreignClient.callTool({
        name: "register_agent_run",
        arguments: {
          profileKey: "foreign-progress-agent",
          displayName: "Foreign Progress Agent",
          capabilities: ["typescript"],
          idempotencyKey: "register-foreign-progress-agent",
        },
      });
      const foreignProgress = await foreignClient.callTool({
        name: "report_progress",
        arguments: {
          ...progressArguments,
          entryId: "foreign-progress",
          idempotencyKey: "foreign-progress-command",
        },
      });
      expect(foreignProgress).toMatchObject({
        isError: true,
        structuredContent: {
          ok: false,
          error: {
            type: "TaskLeaseError",
            taskId: task.id,
            leaseId: grant.claim.id,
            leaseReason: "owner_mismatch",
          },
        },
      });
    } finally {
      await foreignTransport.terminateSession();
      await foreignClient.close();
    }
  });

  it("lets the registered lease owner report a blocker without exposing resolution", async () => {
    const registrationResult = await client.callTool({
      name: "register_agent_run",
      arguments: {
        profileKey: "blocker-agent",
        displayName: "Blocker Agent",
        capabilities: ["typescript"],
        idempotencyKey: "register-blocker-agent",
      },
    });
    const registration = successfulRegistrationSchema.parse(registrationResult.structuredContent);
    const taskResult = await client.callTool({
      name: "create_task",
      arguments: readyTaskArguments("Blocker contract task", "blocker-contract-task", [
        "typescript",
      ]),
    });
    const task = successfulTaskSchema.parse(taskResult.structuredContent).task;
    const preClaim = await client.callTool({
      name: "report_blocker",
      arguments: {
        blockerId: "preclaim-blocker",
        projectId,
        taskId: task.id,
        expectedTaskVersion: task.version,
        reason: "This command has no lease.",
        leaseToken: "not-a-valid-lease",
        idempotencyKey: "preclaim-blocker-command",
      },
    });
    expect(preClaim).toMatchObject({
      isError: true,
      structuredContent: {
        ok: false,
        error: {
          type: "TaskLeaseError",
          taskId: task.id,
          leaseReason: "not_found",
        },
      },
    });

    const claimResult = await client.callTool({
      name: "claim_task",
      arguments: {
        projectId,
        taskId: task.id,
        expectedVersion: task.version,
        leaseDurationSeconds: 300,
        idempotencyKey: "claim-blocker-contract-task",
      },
    });
    const grant = successfulLeaseGrantSchema.parse(claimResult.structuredContent).grant;
    const blockerArguments = {
      blockerId: "leased-agent-blocker",
      projectId,
      taskId: task.id,
      expectedTaskVersion: grant.task.version,
      reason: "The compatibility policy requires a human decision.",
      leaseToken: grant.leaseToken,
      idempotencyKey: "leased-agent-blocker-command",
    };
    const result = await client.callTool({
      name: "report_blocker",
      arguments: blockerArguments,
    });
    const blocker = successfulManualBlockerMutationSchema.parse(result.structuredContent).payload;
    const retry = await client.callTool({
      name: "report_blocker",
      arguments: blockerArguments,
    });

    expect(retry.structuredContent).toEqual(result.structuredContent);
    expect(blocker).toMatchObject({
      blocker: {
        id: blockerArguments.blockerId,
        status: "active",
        createdBy: { type: "agent", id: registration.registration.run.id },
      },
      taskVersion: grant.task.version + 1,
      event: {
        kind: "task.blocker.created",
        importance: "attention",
        actor: { type: "agent", id: registration.registration.run.id },
        payload: {
          leaseId: grant.claim.id,
          attemptId: grant.attempt.id,
          agentRunId: registration.registration.run.id,
        },
      },
    });
    expect(
      projectStore.database
        .prepare("select count(*) from manual_blockers where id = ?")
        .pluck()
        .get(blockerArguments.blockerId),
    ).toBe(1);
  });
});
