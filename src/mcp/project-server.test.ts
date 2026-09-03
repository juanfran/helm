import { mkdir, mkdtemp, rm } from "node:fs/promises";
import { join } from "node:path";
import { tmpdir } from "node:os";

import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { InMemoryTransport } from "@modelcontextprotocol/sdk/inMemory.js";
import { Effect } from "effect";
import { afterEach, describe, expect, it } from "vitest";

import { createProject } from "../application/projects";
import { emptyRichTextDocument } from "../domain/tasks";
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
        lifecycle: "ready",
        title: "MCP ready work",
        description: emptyRichTextDocument,
        expectedOutcome: "The behavior is shipped.",
        acceptanceCriteria: "The verification suite passes.",
        agentContext: "Use the existing command boundary.",
        checklist: [{ id: "tests", text: "Run tests", checked: false }],
        expectedVersion: 0,
        idempotencyKey: "mcp-ready",
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
      task: { lifecycle: "ready", title: "MCP ready work" },
    });
    expect(events).toEqual([
      { actorType: "agent", actorId: "test-agent-run" },
      { actorType: "agent", actorId: "test-agent-run" },
    ]);

    await client.close();
    await server.close();
  });
});
