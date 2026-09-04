import { Effect } from "effect";

import {
  compiledMcpSessionContextSchema,
  compiledRegisterAgentRunInputSchema,
  type McpSessionContext,
  type RegisteredAgentRun,
  type RegisterAgentRunInput,
} from "../domain/agents";
import {
  AgentPersistenceError,
  AgentRunRequiredError,
  InvalidAgentInputError,
  type AgentCommandError,
} from "./agent-errors";

export interface AgentStore {
  registerRun(
    input: RegisterAgentRunInput,
    session: McpSessionContext,
  ): Effect.Effect<RegisteredAgentRun, AgentCommandError>;
  resolveRun(session: McpSessionContext): Effect.Effect<RegisteredAgentRun, AgentCommandError>;
  closeRun(sessionId: string): Effect.Effect<string | null, AgentPersistenceError>;
  reconcileActiveRuns(): Effect.Effect<void, AgentPersistenceError>;
}

export type AgentServices = { store: AgentStore };

function parseInput<A>(parse: () => A): Effect.Effect<A, InvalidAgentInputError> {
  return Effect.try({
    try: parse,
    catch: () => new InvalidAgentInputError({ message: "The agent command input is invalid." }),
  });
}

function parseSession(input: unknown) {
  return parseInput(() => compiledMcpSessionContextSchema.parse(input));
}

export function registerAgentRun(input: unknown, session: unknown, services: AgentServices) {
  return Effect.flatMap(parseSession(session), (parsedSession) =>
    Effect.flatMap(
      parseInput(() => compiledRegisterAgentRunInputSchema.parse(input)),
      (parsedInput) => services.store.registerRun(parsedInput, parsedSession),
    ),
  );
}

export function resolveAgentRun(session: unknown, services: AgentServices) {
  return Effect.flatMap(parseSession(session), (parsedSession) =>
    services.store.resolveRun(parsedSession),
  );
}

export function requireAgentRun(session: unknown, services: AgentServices) {
  return Effect.catchTag(resolveAgentRun(session, services), "AgentRunRequiredError", () =>
    Effect.fail(
      new AgentRunRequiredError({ message: "Register an agent run for this MCP session first." }),
    ),
  );
}

export function closeAgentRun(sessionId: string, services: AgentServices) {
  return services.store.closeRun(sessionId);
}

export function reconcileActiveAgentRuns(services: AgentServices) {
  return services.store.reconcileActiveRuns();
}
