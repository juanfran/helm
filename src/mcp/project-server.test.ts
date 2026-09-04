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

let temporaryRoot: string;
let projectStore: SqliteProjectStore;
let projectId: string;
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

  taskServices = {
    store: createSqliteTaskStore(projectStore.database),
    clock: { today: () => "2026-09-03" },
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

describe("MCP agent run and work discovery contract", () => {
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

  it("requires an explicit takeover to recover a run from a stale live session", async () => {
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
    } finally {
      await replacementTransport.terminateSession();
      await replacementClient.close();
    }
  });
});
