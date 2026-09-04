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
  emptyRichTextDocument,
  taskContextPackageSchema,
  taskDiscoveryPageSchema,
  taskLeaseGrantSchema,
  taskLeaseMutationResultSchema,
  taskSchema,
} from "../domain/tasks";
import { createSqliteAgentStore } from "../infrastructure/sqlite-agent-store.server";
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
const successfulTaskSchema = z.object({ ok: z.literal(true), task: taskSchema });
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
  projectServices = { store: projectStore, inspector: localRepositoryInspector };
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
  handleMcpRequest = createMcpRequestHandler(projectServices, taskServices, agentServices);
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
    .prepare<[string], { actorId: string; actorType: string; kind: string; payload: string }>(
      `select
        actor_id as actorId,
        actor_type as actorType,
        kind,
        payload_json as payload
      from events
      where entity_id = ? and kind in ('task.lease.cancelled', 'task.lease.expired')
      order by cursor`,
    )
    .all(taskId);
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
    expect(nextClaim.task).toMatchObject({ id: firstTask.id, lifecycle: "in_progress" });

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
    const foreignClient = new Client({ name: "foreign-client", version: "1.0.0" });
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
      { type: "text", text: JSON.stringify(registrationResult.structuredContent) },
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
    const competingClient = new Client({ name: "competing-client", version: "1.0.0" });
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
    expect(firstTask.eligibility).toMatchObject({ claimable: true, missingCapabilities: [] });

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
    handleMcpRequest = createMcpRequestHandler(projectServices, taskServices, agentServices);
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
    const replacementClient = new Client({ name: "replacement-client", version: "1.0.0" });
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
        structuredContent: { ok: false, error: { type: "AgentRunRequiredError" } },
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
