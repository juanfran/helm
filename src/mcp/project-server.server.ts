import { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import type { RequestHandlerExtra } from "@modelcontextprotocol/sdk/shared/protocol.js";
import type { ServerNotification, ServerRequest } from "@modelcontextprotocol/sdk/types.js";
import { Effect, Either } from "effect";
import { z } from "zod";

import { toAgentErrorDto, type AgentErrorDto } from "../application/agent-errors";
import { registerAgentRun, requireAgentRun, type AgentServices } from "../application/agents";
import { getAppState, listProjects, type ProjectServices } from "../application/projects";
import { findWork, getTaskContext, type TaskServices } from "../application/tasks";
import { toTaskErrorDto } from "../application/task-errors";
import { registeredAgentRunSchema, registerAgentRunInputSchema } from "../domain/agents";
import { appStateSchema, projectSchema } from "../domain/projects";
import {
  completeTaskInputSchema,
  createTaskInputSchema,
  createTaskRelationInputSchema,
  findWorkInputSchema,
  reopenTaskInputSchema,
  taskContextInputSchema,
  taskContextPackageSchema,
  taskDiscoveryPageSchema,
  taskRelationSchema,
  taskSchema,
  type Actor,
} from "../domain/tasks";
import {
  executeCompleteTask,
  executeCreateTask,
  executeCreateTaskRelation,
  executeReopenTask,
} from "../server/task-adapter";

type McpExtra = RequestHandlerExtra<ServerRequest, ServerNotification>;
export type McpClientIdentity = {
  readonly clientName: string | null;
  readonly clientVersion: string | null;
};

const agentErrorSchema = z.discriminatedUnion("type", [
  z.object({ type: z.literal("InvalidAgentInputError"), message: z.string() }),
  z.object({ type: z.literal("AgentRunRequiredError"), message: z.string() }),
  z.object({
    type: z.literal("AgentRunRegistrationError"),
    message: z.string(),
    runId: z.string().optional(),
  }),
  z.object({
    type: z.literal("AgentIdempotencyConflictError"),
    message: z.string(),
    key: z.string(),
  }),
  z.object({ type: z.literal("AgentPersistenceError"), message: z.string() }),
]);

const taskErrorSchema = z.discriminatedUnion("type", [
  z.object({ type: z.literal("InvalidTaskInputError"), message: z.string() }),
  z.object({ type: z.literal("TaskNotFoundError"), message: z.string(), taskId: z.string() }),
  z.object({
    type: z.literal("TaskPreparationError"),
    message: z.string(),
    missingFields: z.array(z.string()),
  }),
  z.object({
    type: z.literal("TaskVersionConflictError"),
    message: z.string(),
    taskId: z.string(),
    expectedVersion: z.number(),
    currentVersion: z.number(),
    changeSummary: z.string(),
  }),
  z.object({
    type: z.literal("TaskAlreadyArchivedError"),
    message: z.string(),
    taskId: z.string(),
  }),
  z.object({
    type: z.literal("TaskLifecycleError"),
    message: z.string(),
    taskId: z.string(),
    lifecycle: z.string(),
  }),
  z.object({
    type: z.literal("TaskNestingError"),
    message: z.string(),
    taskId: z.string(),
    parentTaskId: z.string().optional(),
  }),
  z.object({
    type: z.literal("TaskRelationError"),
    message: z.string(),
    sourceTaskId: z.string(),
    targetTaskId: z.string(),
    relationPath: z.array(z.string()),
  }),
  z.object({
    type: z.literal("TaskIdempotencyConflictError"),
    message: z.string(),
    key: z.string(),
  }),
  z.object({
    type: z.literal("TaskTagConstraintError"),
    message: z.string(),
    group: z.string(),
    tagNames: z.array(z.string()),
  }),
  z.object({
    type: z.literal("TaskTagDefinitionConflictError"),
    message: z.string(),
    tagName: z.string(),
  }),
  z.object({ type: z.literal("TaskPathError"), message: z.string(), path: z.string() }),
  z.object({
    type: z.literal("TaskDiscoveryCursorStaleError"),
    message: z.string(),
    cursorRevision: z.number(),
    currentRevision: z.number(),
    staleBecause: z.enum(["queue_changed", "evaluation_context_changed"]),
  }),
  z.object({ type: z.literal("TaskPersistenceError"), message: z.string() }),
]);

function jsonToolResult<T extends object>(structuredContent: T, isError = false) {
  return {
    content: [{ type: "text" as const, text: JSON.stringify(structuredContent) }],
    structuredContent,
    isError,
  };
}

function sessionFromExtra(extra: McpExtra, client: McpClientIdentity) {
  const headers = extra.requestInfo?.headers ?? {};
  const sessionId = extra.sessionId ?? headers["mcp-session-id"] ?? headers["Mcp-Session-Id"];
  if (!sessionId) return null;
  return { sessionId, ...client };
}

function missingSessionError(): AgentErrorDto {
  return {
    type: "AgentRunRequiredError",
    message: "Register an agent run for this MCP session first.",
  };
}

async function registeredRunForTool(
  extra: McpExtra,
  services: AgentServices,
  client: McpClientIdentity,
) {
  const session = sessionFromExtra(extra, client);
  if (!session) return { ok: false as const, error: missingSessionError() };
  const result = await Effect.runPromise(Effect.either(requireAgentRun(session, services)));
  return Either.isRight(result)
    ? { ok: true as const, registration: result.right }
    : { ok: false as const, error: toAgentErrorDto(result.left) };
}

async function actorForTool(extra: McpExtra, services: AgentServices, client: McpClientIdentity) {
  const registered = await registeredRunForTool(extra, services, client);
  if (!registered.ok) return registered;
  return {
    ok: true as const,
    actor: { type: "agent", id: registered.registration.run.id } satisfies Actor,
    capabilities: registered.registration.profile.capabilities,
  };
}

export function createHelmMcpServer(
  services: ProjectServices,
  taskServices: TaskServices,
  agentServices: AgentServices,
  client: McpClientIdentity = { clientName: null, clientVersion: null },
) {
  const server = new McpServer({ name: "helm", version: "0.1.0" });

  server.registerTool(
    "register_agent_run",
    {
      title: "Register agent run",
      description: "Register or resume this MCP session as a durable Helm agent run.",
      inputSchema: registerAgentRunInputSchema,
      outputSchema: {
        ok: z.boolean(),
        registration: registeredAgentRunSchema.optional(),
        error: agentErrorSchema.optional(),
      },
      annotations: { readOnlyHint: false, idempotentHint: true },
    },
    async (input, extra) => {
      const session = sessionFromExtra(extra, client);
      if (!session) return jsonToolResult({ ok: false, error: missingSessionError() }, true);
      const result = await Effect.runPromise(
        Effect.either(registerAgentRun(input, session, agentServices)),
      );
      const structuredContent = Either.isRight(result)
        ? { ok: true, registration: result.right }
        : { ok: false, error: toAgentErrorDto(result.left) };
      return jsonToolResult(structuredContent, !structuredContent.ok);
    },
  );

  server.registerTool(
    "list_projects",
    {
      title: "List Helm projects",
      description: "List local projects in stable project sequence order.",
      outputSchema: {
        projects: z.array(projectSchema),
        activeProjectId: z.string().nullable(),
      },
      annotations: { readOnlyHint: true },
    },
    async () => {
      const [projects, state] = await Promise.all([
        Effect.runPromise(listProjects(services)),
        Effect.runPromise(getAppState(services)),
      ]);
      return jsonToolResult({
        projects: [...projects],
        activeProjectId: state.activeProject?.id ?? null,
      });
    },
  );

  server.registerTool(
    "find_work",
    {
      title: "Find claimable Helm work",
      description:
        "Return paginated claimable work for the registered agent profile using Helm ranking.",
      inputSchema: findWorkInputSchema,
      outputSchema: {
        ok: z.boolean(),
        page: taskDiscoveryPageSchema.optional(),
        error: z.union([agentErrorSchema, taskErrorSchema]).optional(),
      },
      annotations: { readOnlyHint: true },
    },
    async (input, extra) => {
      const registered = await registeredRunForTool(extra, agentServices, client);
      if (!registered.ok) return jsonToolResult({ ok: false, error: registered.error }, true);
      const result = await Effect.runPromise(
        Effect.either(findWork(input, registered.registration.profile.capabilities, taskServices)),
      );
      const structuredContent = Either.isRight(result)
        ? { ok: true, page: result.right }
        : { ok: false, error: toTaskErrorDto(result.left) };
      return jsonToolResult(structuredContent, !structuredContent.ok);
    },
  );

  server.registerTool(
    "get_task_context",
    {
      title: "Read task context",
      description:
        "Read a complete task context package for a registered agent without claiming work.",
      inputSchema: taskContextInputSchema,
      outputSchema: {
        ok: z.boolean(),
        context: taskContextPackageSchema.optional(),
        error: z.union([agentErrorSchema, taskErrorSchema]).optional(),
      },
      annotations: { readOnlyHint: true },
    },
    async (input, extra) => {
      const registered = await registeredRunForTool(extra, agentServices, client);
      if (!registered.ok) return jsonToolResult({ ok: false, error: registered.error }, true);
      const result = await Effect.runPromise(
        Effect.either(
          getTaskContext(input, registered.registration.profile.capabilities, taskServices),
        ),
      );
      const structuredContent = Either.isRight(result)
        ? { ok: true, context: result.right }
        : { ok: false, error: toTaskErrorDto(result.left) };
      return jsonToolResult(structuredContent, !structuredContent.ok);
    },
  );

  server.registerTool(
    "create_task",
    {
      title: "Create a Helm task",
      description:
        "Create backlog capture or fully prepared ready work through Helm's shared task command.",
      inputSchema: createTaskInputSchema,
      outputSchema: {
        ok: z.boolean(),
        task: taskSchema.optional(),
        error: z.union([agentErrorSchema, taskErrorSchema]).optional(),
      },
      annotations: { readOnlyHint: false, idempotentHint: true },
    },
    async (input, extra) => {
      const actor = await actorForTool(extra, agentServices, client);
      if (!actor.ok) return jsonToolResult({ ok: false, error: actor.error }, true);
      const response = await executeCreateTask(
        input,
        actor.actor,
        taskServices,
        actor.capabilities,
      );
      return jsonToolResult(response, !response.ok);
    },
  );

  server.registerTool(
    "create_task_relation",
    {
      title: "Create a Helm task relation",
      description:
        "Create a typed relation between two tasks through Helm's shared relation command.",
      inputSchema: createTaskRelationInputSchema,
      outputSchema: {
        ok: z.boolean(),
        relation: taskRelationSchema.optional(),
        error: z.union([agentErrorSchema, taskErrorSchema]).optional(),
      },
      annotations: { readOnlyHint: false, idempotentHint: true },
    },
    async (input, extra) => {
      const actor = await actorForTool(extra, agentServices, client);
      if (!actor.ok) return jsonToolResult({ ok: false, error: actor.error }, true);
      const response = await executeCreateTaskRelation(input, actor.actor, taskServices);
      return jsonToolResult(response, !response.ok);
    },
  );

  server.registerTool(
    "complete_task",
    {
      title: "Complete a Helm task",
      description:
        "Mark a task complete through the shared lifecycle command so dependent eligibility updates.",
      inputSchema: completeTaskInputSchema,
      outputSchema: {
        ok: z.boolean(),
        task: taskSchema.optional(),
        error: z.union([agentErrorSchema, taskErrorSchema]).optional(),
      },
      annotations: { readOnlyHint: false, idempotentHint: true },
    },
    async (input, extra) => {
      const actor = await actorForTool(extra, agentServices, client);
      if (!actor.ok) return jsonToolResult({ ok: false, error: actor.error }, true);
      const response = await executeCompleteTask(
        input,
        actor.actor,
        taskServices,
        actor.capabilities,
      );
      return jsonToolResult(response, !response.ok);
    },
  );

  server.registerTool(
    "reopen_task",
    {
      title: "Reopen a Helm task",
      description:
        "Reopen a complete task through the shared lifecycle command so dependent eligibility updates.",
      inputSchema: reopenTaskInputSchema,
      outputSchema: {
        ok: z.boolean(),
        task: taskSchema.optional(),
        error: z.union([agentErrorSchema, taskErrorSchema]).optional(),
      },
      annotations: { readOnlyHint: false, idempotentHint: true },
    },
    async (input, extra) => {
      const actor = await actorForTool(extra, agentServices, client);
      if (!actor.ok) return jsonToolResult({ ok: false, error: actor.error }, true);
      const response = await executeReopenTask(
        input,
        actor.actor,
        taskServices,
        actor.capabilities,
      );
      return jsonToolResult(response, !response.ok);
    },
  );

  server.registerTool(
    "get_active_project",
    {
      title: "Read the active Helm project",
      description: "Read the project metadata and theme currently selected by Helm.",
      outputSchema: appStateSchema,
      annotations: { readOnlyHint: true },
    },
    async () => jsonToolResult(await Effect.runPromise(getAppState(services))),
  );

  return server;
}
