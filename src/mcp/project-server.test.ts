import { mkdir, mkdtemp, rm } from "node:fs/promises";
import { join } from "node:path";
import { tmpdir } from "node:os";

import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { InMemoryTransport } from "@modelcontextprotocol/sdk/inMemory.js";
import { Effect } from "effect";
import { afterEach, describe, expect, it } from "vitest";
import { z } from "zod";

import { createProject } from "../application/projects";
import { emptyRichTextDocument, taskSchema } from "../domain/tasks";
import { localRepositoryInspector } from "../infrastructure/repository-inspector.server";
import {
  createSqliteProjectStore,
  type SqliteProjectStore,
} from "../infrastructure/sqlite-project-store.server";
import { createSqliteTaskStore } from "../infrastructure/sqlite-task-store.server";
import { createHelmMcpServer } from "./project-server.server";

const temporaryPaths: string[] = [];
const stores: SqliteProjectStore[] = [];

afterEach(async () => {
  stores.splice(0).forEach((store) => store.close());
  await Promise.all(
    temporaryPaths.splice(0).map((path) => rm(path, { recursive: true, force: true })),
  );
});

describe("project MCP contract", () => {
  it("lists projects and reads the same selected metadata without writing", async () => {
    const parent = await mkdtemp(join(tmpdir(), "helm-mcp-test-"));
    temporaryPaths.push(parent);
    const repositoryRoot = join(parent, "repository");
    await mkdir(join(repositoryRoot, ".git"), { recursive: true });
    const store = createSqliteProjectStore(":memory:");
    stores.push(store);
    const services = { store, inspector: localRepositoryInspector };
    const project = await Effect.runPromise(
      createProject({ repositoryRoot, idempotencyKey: "mcp-project" }, services),
    );
    const eventCountBefore = store.database
      .prepare("select count(*) as count from events")
      .pluck()
      .get();

    const [clientTransport, serverTransport] = InMemoryTransport.createLinkedPair();
    const server = createHelmMcpServer(services, { store: createSqliteTaskStore(store.database) });
    const client = new Client({ name: "helm-test", version: "1.0.0" });
    await server.connect(serverTransport);
    await client.connect(clientTransport);

    const listed = await client.callTool({ name: "list_projects" });
    const active = await client.callTool({ name: "get_active_project" });
    const eventCountAfter = store.database
      .prepare("select count(*) as count from events")
      .pluck()
      .get();

    expect(listed.structuredContent).toEqual({
      projects: [project],
      activeProjectId: project.id,
    });
    expect(active.structuredContent).toEqual({ activeProject: project, theme: "system" });
    expect(eventCountAfter).toBe(eventCountBefore);

    await client.close();
    await server.close();
  });

  it("creates backlog and ready tasks with connection-derived agent attribution", async () => {
    const parent = await mkdtemp(join(tmpdir(), "helm-mcp-task-test-"));
    temporaryPaths.push(parent);
    const repositoryRoot = join(parent, "repository");
    await mkdir(join(repositoryRoot, ".git"), { recursive: true });
    const store = createSqliteProjectStore(":memory:");
    stores.push(store);
    const services = { store, inspector: localRepositoryInspector };
    const project = await Effect.runPromise(
      createProject({ repositoryRoot, idempotencyKey: "mcp-task-project" }, services),
    );
    const taskServices = { store: createSqliteTaskStore(store.database) };
    const [clientTransport, serverTransport] = InMemoryTransport.createLinkedPair();
    const server = createHelmMcpServer(services, taskServices, {
      type: "agent",
      id: "test-agent-run",
    });
    const client = new Client({ name: "helm-task-test", version: "1.0.0" });
    await server.connect(serverTransport);
    await client.connect(clientTransport);

    const backlog = await client.callTool({
      name: "create_task",
      arguments: {
        projectId: project.id,
        parentTaskId: null,
        lifecycle: "backlog",
        title: "MCP capture",
        description: emptyRichTextDocument,
        expectedOutcome: "",
        acceptanceCriteria: "",
        agentContext: "",
        checklist: [],
        expectedVersion: 0,
        idempotencyKey: "mcp-backlog",
      },
    });
    const ready = await client.callTool({
      name: "create_task",
      arguments: {
        projectId: project.id,
        parentTaskId: null,
        lifecycle: "ready",
        title: "MCP ready work",
        description: emptyRichTextDocument,
        expectedOutcome: "The behavior is shipped.",
        acceptanceCriteria: "The verification suite passes.",
        agentContext: "Use the existing command boundary.",
        checklist: [{ id: "tests", text: "Run tests", checked: false }],
        priority: "urgent",
        position: 1,
        requiredCapabilities: ["typescript"],
        expectedVersion: 0,
        idempotencyKey: "mcp-ready",
      },
    });
    const incompatible = await client.callTool({
      name: "discover_tasks",
      arguments: { projectId: project.id, agentCapabilities: ["sqlite"], now: "2026-09-03" },
    });
    const compatible = await client.callTool({
      name: "discover_tasks",
      arguments: {
        projectId: project.id,
        agentCapabilities: ["typescript"],
        now: "2026-09-03",
      },
    });
    const events = store.database
      .prepare<[], { actorType: string; actorId: string }>(
        "select actor_type as actorType, actor_id as actorId from events where entity_type = 'task' order by cursor",
      )
      .all();

    expect(backlog.structuredContent).toMatchObject({
      ok: true,
      task: { lifecycle: "backlog", title: "MCP capture" },
    });
    expect(ready.structuredContent).toMatchObject({
      ok: true,
      task: { lifecycle: "ready", title: "MCP ready work", requiredCapabilities: ["typescript"] },
    });
    expect(incompatible.structuredContent).toEqual({ tasks: [] });
    expect(compatible.structuredContent).toMatchObject({
      tasks: [
        {
          title: "MCP ready work",
          priority: "urgent",
          eligibility: {
            claimable: true,
            orderingExplanation: expect.stringContaining("urgent lane"),
          },
        },
      ],
    });
    expect(events).toEqual([
      { actorType: "agent", actorId: "test-agent-run" },
      { actorType: "agent", actorId: "test-agent-run" },
    ]);

    await client.close();
    await server.close();
  });

  it("creates blocking relations through MCP and applies shared eligibility", async () => {
    const parent = await mkdtemp(join(tmpdir(), "helm-mcp-relation-test-"));
    temporaryPaths.push(parent);
    const repositoryRoot = join(parent, "repository");
    await mkdir(join(repositoryRoot, ".git"), { recursive: true });
    const store = createSqliteProjectStore(":memory:");
    stores.push(store);
    const services = { store, inspector: localRepositoryInspector };
    const project = await Effect.runPromise(
      createProject({ repositoryRoot, idempotencyKey: "mcp-relation-project" }, services),
    );
    const taskServices = { store: createSqliteTaskStore(store.database) };
    const [clientTransport, serverTransport] = InMemoryTransport.createLinkedPair();
    const server = createHelmMcpServer(services, taskServices, {
      type: "agent",
      id: "relation-agent-run",
    });
    const client = new Client({ name: "helm-relation-test", version: "1.0.0" });
    await server.connect(serverTransport);
    await client.connect(clientTransport);

    const blocker = await client.callTool({
      name: "create_task",
      arguments: {
        projectId: project.id,
        parentTaskId: null,
        lifecycle: "ready",
        title: "MCP blocker",
        description: emptyRichTextDocument,
        expectedOutcome: "The dependency is finished.",
        acceptanceCriteria: "The dependent can proceed.",
        agentContext: "",
        checklist: [{ id: "verify", text: "Verify blocker", checked: false }],
        expectedVersion: 0,
        idempotencyKey: "mcp-blocker",
      },
    });
    const dependent = await client.callTool({
      name: "create_task",
      arguments: {
        projectId: project.id,
        parentTaskId: null,
        lifecycle: "ready",
        title: "MCP dependent",
        description: emptyRichTextDocument,
        expectedOutcome: "The work waits for its blocker.",
        acceptanceCriteria: "Discovery excludes blocked work.",
        agentContext: "",
        checklist: [{ id: "verify", text: "Verify dependent", checked: false }],
        expectedVersion: 0,
        idempotencyKey: "mcp-dependent",
      },
    });
    const taskResultSchema = z.object({ ok: z.literal(true), task: taskSchema });
    const blockerTask = taskResultSchema.parse(blocker.structuredContent).task;
    const dependentTask = taskResultSchema.parse(dependent.structuredContent).task;

    const relation = await client.callTool({
      name: "create_task_relation",
      arguments: {
        projectId: project.id,
        sourceTaskId: blockerTask.id,
        targetTaskId: dependentTask.id,
        type: "blocks",
        expectedSourceVersion: blockerTask.version,
        expectedTargetVersion: dependentTask.version,
        idempotencyKey: "mcp-blocking-relation",
      },
    });
    const candidates = await client.callTool({
      name: "discover_tasks",
      arguments: { projectId: project.id, now: "2026-09-03" },
    });

    expect(relation.structuredContent).toMatchObject({
      ok: true,
      relation: {
        type: "blocks",
        sourceTitle: "MCP blocker",
        targetTitle: "MCP dependent",
      },
    });
    expect(candidates.structuredContent).toMatchObject({
      tasks: [expect.objectContaining({ id: blockerTask.id })],
    });
    const candidateTasks = z
      .object({ tasks: z.array(taskSchema) })
      .parse(candidates.structuredContent).tasks;
    expect(candidateTasks.map((task) => task.id)).not.toContain(dependentTask.id);

    await client.close();
    await server.close();
  });
});
