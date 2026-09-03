import { randomUUID } from "node:crypto";

import Database from "better-sqlite3";
import { and, eq } from "drizzle-orm";
import { drizzle } from "drizzle-orm/better-sqlite3";
import { Effect } from "effect";

import {
  AgentPersistenceError,
  AgentRunRegistrationError,
  AgentRunRequiredError,
  type AgentCommandError,
} from "../application/agent-errors";
import type { AgentStore } from "../application/agents";
import {
  agentProfileSchema,
  agentRunSchema,
  registeredAgentRunSchema,
  type AgentProfile,
  type AgentRun,
  type McpSessionContext,
  type RegisteredAgentRun,
  type RegisterAgentRunInput,
} from "../domain/agents";
import { agentProfiles, agentRuns, events, schema } from "../db/schema";

type DrizzleDatabase = ReturnType<typeof drizzle<typeof schema>>;
type DrizzleTransaction = Parameters<Parameters<DrizzleDatabase["transaction"]>[0]>[0];
type DatabaseSession = DrizzleDatabase | DrizzleTransaction;
type AgentProfileRow = typeof agentProfiles.$inferSelect;
type AgentRunRow = typeof agentRuns.$inferSelect;

function persistenceError(error: unknown) {
  return new AgentPersistenceError({
    message: error instanceof Error ? error.message : "The agent database operation failed.",
  });
}

function normalizeCapabilities(capabilities: readonly string[] = []) {
  return [...new Set(capabilities.map((capability) => capability.trim()).filter(Boolean))].toSorted(
    (left, right) => left.localeCompare(right),
  );
}

function profileFromRow(row: AgentProfileRow): AgentProfile {
  return agentProfileSchema.parse({
    id: row.id,
    profileKey: row.profileKey,
    displayName: row.displayName,
    capabilities: JSON.parse(row.capabilitiesJson),
    createdAt: row.createdAt,
    updatedAt: row.updatedAt,
  });
}

function runFromRow(row: AgentRunRow): AgentRun {
  return agentRunSchema.parse(row);
}

function registeredFromRows(profile: AgentProfileRow, run: AgentRunRow): RegisteredAgentRun {
  return registeredAgentRunSchema.parse({
    profile: profileFromRow(profile),
    run: runFromRow(run),
  });
}

function recordRunEvent(
  db: DatabaseSession,
  run: AgentRunRow,
  kind: "agent.run.registered" | "agent.run.resumed" | "agent.run.closed",
  occurredAt: string,
) {
  db.insert(events)
    .values({
      projectId: null,
      kind,
      actorType: "agent",
      actorId: run.id,
      entityType: "agent_run",
      entityId: run.id,
      payloadJson: JSON.stringify({
        profileId: run.profileId,
        mcpSessionId: run.mcpSessionId,
        status: kind === "agent.run.closed" ? "closed" : "active",
      }),
      occurredAt,
    })
    .run();
}

function findProfileById(db: DatabaseSession, profileId: string) {
  return db.select().from(agentProfiles).where(eq(agentProfiles.id, profileId)).limit(1).get();
}

function findRunBySession(db: DatabaseSession, sessionId: string) {
  return db.select().from(agentRuns).where(eq(agentRuns.mcpSessionId, sessionId)).limit(1).get();
}

function upsertProfile(db: DatabaseSession, input: RegisterAgentRunInput, now: string) {
  const existing = db
    .select()
    .from(agentProfiles)
    .where(eq(agentProfiles.profileKey, input.profileKey))
    .limit(1)
    .get();
  const capabilitiesJson = JSON.stringify(normalizeCapabilities(input.capabilities));
  if (existing) {
    db.update(agentProfiles)
      .set({
        displayName: input.displayName,
        capabilitiesJson,
        updatedAt: now,
      })
      .where(eq(agentProfiles.id, existing.id))
      .run();
    return findProfileById(db, existing.id) ?? existing;
  }

  const profile = {
    id: randomUUID(),
    profileKey: input.profileKey,
    displayName: input.displayName,
    capabilitiesJson,
    createdAt: now,
    updatedAt: now,
  };
  db.insert(agentProfiles).values(profile).run();
  return profile;
}

function commandError(error: unknown): AgentCommandError {
  if (
    error instanceof AgentRunRegistrationError ||
    error instanceof AgentRunRequiredError ||
    error instanceof AgentPersistenceError
  ) {
    return error;
  }
  return persistenceError(error);
}

export function createSqliteAgentStore(database: Database.Database): AgentStore {
  const db = drizzle(database, { schema });

  return {
    registerRun(input: RegisterAgentRunInput, session: McpSessionContext) {
      return Effect.try({
        try: () =>
          db.transaction((tx) => {
            const now = new Date().toISOString();
            const profile = upsertProfile(tx, input, now);
            const sessionRun = findRunBySession(tx, session.sessionId);
            if (sessionRun) {
              if (sessionRun.profileId !== profile.id) {
                throw new AgentRunRegistrationError({
                  runId: sessionRun.id,
                  message: "That MCP session is already registered to a different agent profile.",
                });
              }
              if (input.resumeRunId && sessionRun.id !== input.resumeRunId) {
                throw new AgentRunRegistrationError({
                  runId: input.resumeRunId,
                  message: "That MCP session is already registered to a different agent run.",
                });
              }
              tx.update(agentRuns)
                .set({
                  profileId: profile.id,
                  status: "active",
                  clientName: session.clientName,
                  clientVersion: session.clientVersion,
                  lastSeenAt: now,
                  endedAt: null,
                })
                .where(eq(agentRuns.id, sessionRun.id))
                .run();
              const updated = tx
                .select()
                .from(agentRuns)
                .where(eq(agentRuns.id, sessionRun.id))
                .limit(1)
                .get();
              if (!updated) throw new Error("Registered run could not be read.");
              recordRunEvent(tx, updated, "agent.run.registered", now);
              return registeredFromRows(profile, updated);
            }

            if (input.resumeRunId) {
              const resumed = tx
                .select()
                .from(agentRuns)
                .where(
                  and(eq(agentRuns.id, input.resumeRunId), eq(agentRuns.profileId, profile.id)),
                )
                .limit(1)
                .get();
              if (!resumed) {
                throw new AgentRunRegistrationError({
                  runId: input.resumeRunId,
                  message: "That agent run cannot be resumed for this profile.",
                });
              }
              if (resumed.status === "active" && resumed.mcpSessionId !== session.sessionId) {
                throw new AgentRunRegistrationError({
                  runId: input.resumeRunId,
                  message: "That agent run is already active in another MCP session.",
                });
              }
              tx.update(agentRuns)
                .set({
                  mcpSessionId: session.sessionId,
                  status: "active",
                  clientName: session.clientName,
                  clientVersion: session.clientVersion,
                  lastSeenAt: now,
                  endedAt: null,
                })
                .where(eq(agentRuns.id, resumed.id))
                .run();
              const updated = tx
                .select()
                .from(agentRuns)
                .where(eq(agentRuns.id, resumed.id))
                .limit(1)
                .get();
              if (!updated) throw new Error("Resumed run could not be read.");
              recordRunEvent(tx, updated, "agent.run.resumed", now);
              return registeredFromRows(profile, updated);
            }

            const run = {
              id: randomUUID(),
              profileId: profile.id,
              mcpSessionId: session.sessionId,
              status: "active" as const,
              clientName: session.clientName,
              clientVersion: session.clientVersion,
              createdAt: now,
              lastSeenAt: now,
              endedAt: null,
            };
            tx.insert(agentRuns).values(run).run();
            recordRunEvent(tx, run, "agent.run.registered", now);
            return registeredFromRows(profile, run);
          }),
        catch: commandError,
      });
    },
    resolveRun(session: McpSessionContext) {
      return Effect.try({
        try: () => {
          const run = findRunBySession(db, session.sessionId);
          if (!run || run.status !== "active") {
            throw new AgentRunRequiredError({
              message: "Register an agent run for this MCP session first.",
            });
          }
          const profile = findProfileById(db, run.profileId);
          if (!profile) {
            throw new AgentRunRequiredError({
              message: "The registered agent profile no longer exists.",
            });
          }
          return registeredFromRows(profile, run);
        },
        catch: commandError,
      });
    },
    closeRun(sessionId: string) {
      return Effect.try({
        try: () =>
          db.transaction((tx) => {
            const run = findRunBySession(tx, sessionId);
            if (!run || run.status === "closed") return;
            const now = new Date().toISOString();
            tx.update(agentRuns)
              .set({ status: "closed", endedAt: now, lastSeenAt: now })
              .where(eq(agentRuns.id, run.id))
              .run();
            recordRunEvent(
              tx,
              { ...run, status: "closed", endedAt: now, lastSeenAt: now },
              "agent.run.closed",
              now,
            );
          }),
        catch: persistenceError,
      });
    },
  };
}
