import { mkdir, mkdtemp, rm } from "node:fs/promises";
import { join } from "node:path";
import { tmpdir } from "node:os";

import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { InMemoryTransport } from "@modelcontextprotocol/sdk/inMemory.js";
import { Effect } from "effect";
import { afterEach, describe, expect, it } from "vitest";

import { createProject } from "../application/projects";
import { localRepositoryInspector } from "../infrastructure/repository-inspector.server";
import {
  createSqliteProjectStore,
  type SqliteProjectStore,
} from "../infrastructure/sqlite-project-store.server";
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
    const server = createHelmMcpServer(services);
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
});
