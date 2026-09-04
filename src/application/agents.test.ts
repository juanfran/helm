import { Effect, Either } from "effect";
import { afterEach, beforeEach, describe, expect, it } from "vitest";

import { closeAgentRun, listAgentRuns, registerAgentRun, type AgentServices } from "./agents";
import { compiledListAgentRunsInputSchema, listAgentRunsInputSchema } from "../domain/agents";
import { createSqliteAgentStore } from "../infrastructure/sqlite-agent-store.server";
import {
  createSqliteProjectStore,
  type SqliteProjectStore,
} from "../infrastructure/sqlite-project-store.server";

let projectStore: SqliteProjectStore;
let services: AgentServices;

async function register(key: string) {
  return Effect.runPromise(
    registerAgentRun(
      {
        profileKey: key,
        displayName: `${key} agent`,
        capabilities: ["typescript", key],
        idempotencyKey: `register-${key}`,
      },
      {
        sessionId: `private-session-${key}`,
        clientName: `${key}-client`,
        clientVersion: "1.0.0",
      },
      services,
    ),
  );
}

beforeEach(() => {
  projectStore = createSqliteProjectStore(":memory:");
  services = { store: createSqliteAgentStore(projectStore.database) };
});

afterEach(() => {
  projectStore.close();
});

describe("agent-run application queries", () => {
  it("keeps the bounded compiled input equivalent to the regular schema", () => {
    const input = { status: "closed", limit: 200 } as const;

    expect(compiledListAgentRunsInputSchema.parse(input)).toEqual(
      listAgentRunsInputSchema.parse(input),
    );
    expect(compiledListAgentRunsInputSchema.safeParse({ limit: 201 }).success).toBe(false);
  });

  it("filters active and closed runs without exposing MCP session identifiers", async () => {
    const alpha = await register("alpha");
    const beta = await register("beta");
    await Effect.runPromise(closeAgentRun("private-session-alpha", services));

    const active = await Effect.runPromise(
      listAgentRuns({ status: "active", limit: 50 }, services),
    );
    const closed = await Effect.runPromise(
      listAgentRuns({ status: "closed", limit: 50 }, services),
    );

    expect(active).toEqual([
      expect.objectContaining({
        id: beta.run.id,
        profileId: beta.profile.id,
        profileKey: "beta",
        displayName: "beta agent",
        status: "active",
        clientName: "beta-client",
      }),
    ]);
    expect(closed).toEqual([
      expect.objectContaining({ id: alpha.run.id, profileKey: "alpha", status: "closed" }),
    ]);
    expect(active[0]).not.toHaveProperty("mcpSessionId");
    expect(closed[0]).not.toHaveProperty("mcpSessionId");
    expect(JSON.stringify({ active, closed })).not.toContain("private-session-");
    const eventPayloads = projectStore.database
      .prepare<[], { payload: string }>(
        "select payload_json as payload from events where kind like 'agent.run.%' order by cursor",
      )
      .all();
    expect(JSON.stringify(eventPayloads)).not.toContain("private-session-");
  });

  it("orders equal recency deterministically, honors the limit, and appends no events", async () => {
    const alpha = await register("alpha");
    const beta = await register("beta");
    const timestamp = "2026-09-04T12:00:00.000Z";
    projectStore.database
      .prepare("update agent_runs set last_seen_at = ? where id in (?, ?)")
      .run(timestamp, alpha.run.id, beta.run.id);
    const eventCountBefore = projectStore.database
      .prepare<[], number>("select count(*) from events")
      .pluck()
      .get();

    const all = await Effect.runPromise(listAgentRuns({ status: "active", limit: 50 }, services));
    const first = await Effect.runPromise(listAgentRuns({ status: "active", limit: 1 }, services));
    const eventCountAfter = projectStore.database
      .prepare<[], number>("select count(*) from events")
      .pluck()
      .get();

    expect(all.map(({ id }) => id)).toEqual([alpha.run.id, beta.run.id].toSorted());
    expect(first).toEqual(all.slice(0, 1));
    expect(eventCountAfter).toBe(eventCountBefore);
  });

  it("returns a typed validation error before reading the store", async () => {
    const result = await Effect.runPromise(Effect.either(listAgentRuns({ limit: 201 }, services)));

    expect(Either.isLeft(result)).toBe(true);
    if (Either.isLeft(result)) expect(result.left["_tag"]).toBe("InvalidAgentInputError");
  });
});
