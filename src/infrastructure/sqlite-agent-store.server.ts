import { createHash, randomUUID } from "node:crypto";

import Database from "better-sqlite3";
import { and, asc, desc, eq } from "drizzle-orm";
import { drizzle } from "drizzle-orm/better-sqlite3";
import { Effect } from "effect";

import {
  AgentIdempotencyConflictError,
  AgentPersistenceError,
  AgentRunRegistrationError,
  AgentRunRequiredError,
  type AgentCommandError,
} from "../application/agent-errors";
import type { AgentStore } from "../application/agents";
import {
  compiledAgentRunSummarySchema,
  agentProfileSchema,
  agentRunSchema,
  registeredAgentRunSchema,
  type AgentProfile,
  type AgentRun,
  type AgentRunSummary,
  type ListAgentRunsInput,
  type McpSessionContext,
  type RegisteredAgentRun,
  type RegisterAgentRunInput,
} from "../domain/agents";
import { agentProfiles, agentRuns, events, idempotencyRecords, schema } from "../db/schema";
import { normalizeCapabilities } from "../domain/tasks";
import { importanceForEventKind, normalizeEventChangeHints } from "../domain/activity";

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

function registrationHash(input: RegisterAgentRunInput) {
  return createHash("sha256")
    .update(
      JSON.stringify({
        profileKey: input.profileKey,
        displayName: input.displayName,
        capabilities: normalizeCapabilities(input.capabilities),
        resumeRunId: input.resumeRunId,
      }),
    )
    .digest("hex");
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

function summaryFromRows(profile: AgentProfileRow, run: AgentRunRow): AgentRunSummary {
  return compiledAgentRunSummarySchema.parse({
    id: run.id,
    profileId: profile.id,
    profileKey: profile.profileKey,
    displayName: profile.displayName,
    capabilities: JSON.parse(profile.capabilitiesJson),
    status: run.status,
    clientName: run.clientName,
    clientVersion: run.clientVersion,
    createdAt: run.createdAt,
    lastSeenAt: run.lastSeenAt,
    endedAt: run.endedAt,
  });
}

function recordRunEvent(
  db: DatabaseSession,
  run: AgentRunRow,
  kind: "agent.run.registered" | "agent.run.resumed" | "agent.run.closed",
  occurredAt: string,
  options: {
    actorType?: "agent" | "system";
    actorId?: string;
    reason?: string;
  } = {},
) {
  db.insert(events)
    .values({
      projectId: null,
      kind,
      importance: importanceForEventKind(kind),
      actorType: options.actorType ?? "agent",
      actorId: options.actorId ?? run.id,
      entityType: "agent_run",
      entityId: run.id,
      payloadJson: JSON.stringify({
        profileId: run.profileId,
        status: kind === "agent.run.closed" ? "closed" : "active",
        ...(options.reason ? { reason: options.reason } : {}),
      }),
      changesJson: JSON.stringify(
        normalizeEventChangeHints({ agentRunIds: [run.id], scopes: ["agents"] }),
      ),
      occurredAt,
    })
    .run();
}

function findIdempotentRegistration(
  db: DatabaseSession,
  key: string,
  hash: string,
  session: McpSessionContext,
  takeoverActiveRun: boolean,
) {
  const existing = db
    .select()
    .from(idempotencyRecords)
    .where(eq(idempotencyRecords.key, key))
    .limit(1)
    .get();
  if (!existing) return null;
  if (existing.command !== "agent.run.register" || existing.inputHash !== hash) {
    throw new AgentIdempotencyConflictError({
      key,
      message: "That idempotency key was already used for a different command.",
    });
  }
  const recorded = registeredAgentRunSchema.parse(JSON.parse(existing.resultJson));
  const run = db.select().from(agentRuns).where(eq(agentRuns.id, recorded.run.id)).limit(1).get();
  const profile = run ? findProfileById(db, run.profileId) : null;
  if (!run || !profile) {
    throw new AgentRunRegistrationError({
      runId: recorded.run.id,
      message: "The idempotent agent run no longer exists.",
    });
  }
  if (run.status === "active" && run.mcpSessionId === session.sessionId) {
    return registeredFromRows(profile, run);
  }
  if (run.status === "active" && !takeoverActiveRun) {
    throw new AgentRunRegistrationError({
      runId: run.id,
      message:
        "That idempotent agent run is active in another MCP session; request an explicit takeover to recover it.",
    });
  }

  const occupiedSession = findRunBySession(db, session.sessionId);
  if (occupiedSession && occupiedSession.id !== run.id) {
    throw new AgentRunRegistrationError({
      runId: occupiedSession.id,
      message: "That MCP session is already registered to a different agent run.",
    });
  }

  const now = new Date().toISOString();
  db.update(agentRuns)
    .set({
      mcpSessionId: session.sessionId,
      status: "active",
      clientName: session.clientName,
      clientVersion: session.clientVersion,
      lastSeenAt: now,
      endedAt: null,
    })
    .where(eq(agentRuns.id, run.id))
    .run();
  const resumed = {
    ...run,
    mcpSessionId: session.sessionId,
    status: "active" as const,
    clientName: session.clientName,
    clientVersion: session.clientVersion,
    lastSeenAt: now,
    endedAt: null,
  };
  const registration = registeredFromRows(profile, resumed);
  recordRunEvent(db, resumed, "agent.run.resumed", now, { reason: "idempotent_reconnect" });
  db.update(idempotencyRecords)
    .set({ resultJson: JSON.stringify(registration) })
    .where(eq(idempotencyRecords.key, key))
    .run();
  return registration;
}

function recordRegistration(
  db: DatabaseSession,
  key: string,
  hash: string,
  registration: RegisteredAgentRun,
  kind: "agent.run.registered" | "agent.run.resumed",
  occurredAt: string,
) {
  recordRunEvent(db, registration.run, kind, occurredAt);
  db.insert(idempotencyRecords)
    .values({
      key,
      command: "agent.run.register",
      inputHash: hash,
      resultJson: JSON.stringify(registration),
      createdAt: occurredAt,
    })
    .run();
  return registration;
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
    error instanceof AgentIdempotencyConflictError ||
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
    listRuns(input: ListAgentRunsInput) {
      return Effect.try({
        try: () =>
          db
            .select({ profile: agentProfiles, run: agentRuns })
            .from(agentRuns)
            .innerJoin(agentProfiles, eq(agentRuns.profileId, agentProfiles.id))
            .where(eq(agentRuns.status, input.status))
            .orderBy(desc(agentRuns.lastSeenAt), asc(agentRuns.id))
            .limit(input.limit)
            .all()
            .map(({ profile, run }) => summaryFromRows(profile, run)),
        catch: persistenceError,
      });
    },
    registerRun(input: RegisterAgentRunInput, session: McpSessionContext) {
      return Effect.try({
        try: () =>
          db.transaction((tx) => {
            const hash = registrationHash(input);
            const idempotent = findIdempotentRegistration(
              tx,
              input.idempotencyKey,
              hash,
              session,
              input.takeoverActiveRun,
            );
            if (idempotent) return idempotent;
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
              return recordRegistration(
                tx,
                input.idempotencyKey,
                hash,
                registeredFromRows(profile, updated),
                "agent.run.registered",
                now,
              );
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
              if (
                resumed.status === "active" &&
                resumed.mcpSessionId !== session.sessionId &&
                !input.takeoverActiveRun
              ) {
                throw new AgentRunRegistrationError({
                  runId: input.resumeRunId,
                  message:
                    "That agent run is active in another MCP session; request an explicit takeover to recover it.",
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
              return recordRegistration(
                tx,
                input.idempotencyKey,
                hash,
                registeredFromRows(profile, updated),
                "agent.run.resumed",
                now,
              );
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
            return recordRegistration(
              tx,
              input.idempotencyKey,
              hash,
              registeredFromRows(profile, run),
              "agent.run.registered",
              now,
            );
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
            if (!run || run.status === "closed") return null;
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
            return run.id;
          }),
        catch: persistenceError,
      });
    },
    reconcileActiveRuns() {
      return Effect.try({
        try: () =>
          db.transaction((tx) => {
            const activeRuns = tx
              .select()
              .from(agentRuns)
              .where(eq(agentRuns.status, "active"))
              .all();
            if (activeRuns.length === 0) return;
            const now = new Date().toISOString();
            for (const run of activeRuns) {
              const closedRun = {
                ...run,
                status: "closed" as const,
                endedAt: now,
                lastSeenAt: now,
              };
              tx.update(agentRuns)
                .set({ status: "closed", endedAt: now, lastSeenAt: now })
                .where(eq(agentRuns.id, run.id))
                .run();
              recordRunEvent(tx, closedRun, "agent.run.closed", now, {
                actorType: "system",
                actorId: "helm",
                reason: "server_restart",
              });
            }
          }),
        catch: persistenceError,
      });
    },
  };
}
