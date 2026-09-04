import { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import type { RequestHandlerExtra } from "@modelcontextprotocol/sdk/shared/protocol.js";
import type { ServerNotification, ServerRequest } from "@modelcontextprotocol/sdk/types.js";
import { Effect, Either } from "effect";
import { z } from "zod";

import {
  listActivityEntries,
  readActivityEvents,
  type ActivityServices,
} from "../application/activity";
import { toActivityErrorDto, type ActivityErrorDto } from "../application/activity-errors";
import { toAgentErrorDto, type AgentErrorDto } from "../application/agent-errors";
import { registerAgentRun, requireAgentRun, type AgentServices } from "../application/agents";
import { getAppState, listProjects, type ProjectServices } from "../application/projects";
import {
  claimNextTask,
  claimTask,
  findWork,
  getTaskContext,
  releaseTaskLease,
  renewTaskLease,
  type TaskServices,
} from "../application/tasks";
import { toTaskErrorDto } from "../application/task-errors";
import { registeredAgentRunSchema, registerAgentRunInputSchema } from "../domain/agents";
import {
  activityEntryMutationResultSchema,
  activityEntrySchema,
  activityEventPageSchema,
  createAgentActivityEntryInputSchema,
  createAgentManualBlockerInputSchema,
  listActivityEntriesInputSchema,
  manualBlockerMutationResultSchema,
  readActivityEventsInputSchema,
} from "../domain/activity";
import { appStateSchema, projectSchema } from "../domain/projects";
import {
  claimNextTaskInputSchema,
  claimTaskInputSchema,
  completeTaskInputSchema,
  createTaskInputSchema,
  createTaskRelationInputSchema,
  findWorkInputSchema,
  releaseTaskLeaseInputSchema,
  reopenTaskInputSchema,
  renewTaskLeaseInputSchema,
  taskContextInputSchema,
  taskContextPackageSchema,
  taskDiscoveryPageSchema,
  taskLeaseGrantSchema,
  taskLeaseMutationResultSchema,
  taskRelationSchema,
  taskSchema,
  type Actor,
} from "../domain/tasks";
import {
  executeCreateAgentActivityEntry,
  executeCreateAgentManualBlocker,
} from "../server/activity-adapter";
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
  z.object({
    type: z.literal("TaskNotFoundError"),
    message: z.string(),
    taskId: z.string(),
  }),
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
  z.object({
    type: z.literal("TaskPathError"),
    message: z.string(),
    path: z.string(),
  }),
  z.object({
    type: z.literal("TaskDiscoveryCursorStaleError"),
    message: z.string(),
    cursorRevision: z.number(),
    currentRevision: z.number(),
    staleBecause: z.enum(["queue_changed", "evaluation_context_changed"]),
  }),
  z.object({
    type: z.literal("TaskClaimUnavailableError"),
    message: z.string(),
    taskId: z.string().optional(),
    eligibilityStatus: z.string().optional(),
    reasons: z.array(z.string()),
  }),
  z.object({
    type: z.literal("TaskLeaseError"),
    message: z.string(),
    taskId: z.string().optional(),
    leaseId: z.string().optional(),
    leaseReason: z.enum([
      "not_found",
      "required",
      "expired",
      "inactive",
      "owner_mismatch",
      "inactive_run",
    ]),
  }),
  z.object({ type: z.literal("TaskPersistenceError"), message: z.string() }),
]);

const activityErrorSchema = z.object({
  type: z.enum([
    "InvalidActivityInputError",
    "ActivityEntryNotFoundError",
    "ActivityEntryWithdrawnError",
    "ActivityAttributionError",
    "ActivityIdempotencyConflictError",
    "ManualBlockerNotFoundError",
    "ManualBlockerStateError",
    "TaskNotFoundError",
    "TaskVersionConflictError",
    "TaskLeaseError",
    "ActivityPersistenceError",
  ]),
  message: z.string(),
  entryId: z.string().optional(),
  blockerId: z.string().optional(),
  taskId: z.string().optional(),
  leaseId: z.string().optional(),
  expectedVersion: z.number().optional(),
  currentVersion: z.number().optional(),
  changeSummary: z.string().optional(),
  status: z.string().optional(),
  key: z.string().optional(),
  leaseReason: z
    .enum(["not_found", "required", "expired", "inactive", "owner_mismatch", "inactive_run"])
    .optional(),
});

const activityToolErrorSchema = z.union([agentErrorSchema, activityErrorSchema]);
const agentActivityEntryInputSchema = createAgentActivityEntryInputSchema.options[1].omit({
  kind: true,
});
const reportProgressInputSchema = createAgentActivityEntryInputSchema.options[0].omit({
  kind: true,
});
const listTaskEntriesInputSchema = listActivityEntriesInputSchema
  .omit({ entryIds: true })
  .required({ taskId: true });
const readForwardEventsInputSchema = readActivityEventsInputSchema.omit({
  direction: true,
  beforeCursor: true,
});

function activityToolOutputSchema<TPayload extends z.ZodType>(payload: TPayload) {
  return {
    ok: z.boolean(),
    payload: payload.optional(),
    error: activityToolErrorSchema.optional(),
  };
}

function jsonToolResult<T extends object>(structuredContent: T, isError = false) {
  return {
    content: [{ type: "text" as const, text: JSON.stringify(structuredContent) }],
    structuredContent,
    isError,
  };
}

function activityMutationToolResult(
  response:
    | { readonly ok: true; readonly result: object }
    | { readonly ok: false; readonly error: ActivityErrorDto },
) {
  const structuredContent = response.ok
    ? { ok: true, payload: response.result }
    : { ok: false, error: response.error };
  return jsonToolResult(structuredContent, !structuredContent.ok);
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
    actor: {
      type: "agent",
      id: registered.registration.run.id,
    } satisfies Actor,
    capabilities: registered.registration.profile.capabilities,
  };
}

export function createHelmMcpServer(
  services: ProjectServices,
  taskServices: TaskServices,
  agentServices: AgentServices,
  activityServices: ActivityServices,
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
    "add_comment",
    {
      title: "Add task comment",
      description: "Add an attributed comment to a task as the registered agent run.",
      inputSchema: agentActivityEntryInputSchema,
      outputSchema: activityToolOutputSchema(activityEntryMutationResultSchema),
      annotations: { readOnlyHint: false, idempotentHint: true },
    },
    async (input, extra) => {
      const registered = await registeredRunForTool(extra, agentServices, client);
      if (!registered.ok) return jsonToolResult({ ok: false, error: registered.error }, true);
      const response = await executeCreateAgentActivityEntry(
        { ...input, kind: "comment" },
        registered.registration,
        activityServices,
      );
      return activityMutationToolResult(response);
    },
  );

  server.registerTool(
    "report_progress",
    {
      title: "Report task progress",
      description:
        "Report progress for the registered agent's active task attempt using its lease token.",
      inputSchema: reportProgressInputSchema,
      outputSchema: activityToolOutputSchema(activityEntryMutationResultSchema),
      annotations: { readOnlyHint: false, idempotentHint: true },
    },
    async (input, extra) => {
      const registered = await registeredRunForTool(extra, agentServices, client);
      if (!registered.ok) return jsonToolResult({ ok: false, error: registered.error }, true);
      const response = await executeCreateAgentActivityEntry(
        { ...input, kind: "progress" },
        registered.registration,
        activityServices,
      );
      return activityMutationToolResult(response);
    },
  );

  server.registerTool(
    "report_blocker",
    {
      title: "Report task blocker",
      description:
        "Report an explicit blocker for the registered agent's active task attempt using its lease token.",
      inputSchema: createAgentManualBlockerInputSchema,
      outputSchema: activityToolOutputSchema(manualBlockerMutationResultSchema),
      annotations: { readOnlyHint: false, idempotentHint: true },
    },
    async (input, extra) => {
      const registered = await registeredRunForTool(extra, agentServices, client);
      if (!registered.ok) return jsonToolResult({ ok: false, error: registered.error }, true);
      const response = await executeCreateAgentManualBlocker(
        input,
        registered.registration,
        activityServices,
      );
      return activityMutationToolResult(response);
    },
  );

  server.registerTool(
    "record_decision",
    {
      title: "Record task decision",
      description: "Record an attributed decision on a task as the registered agent run.",
      inputSchema: agentActivityEntryInputSchema,
      outputSchema: activityToolOutputSchema(activityEntryMutationResultSchema),
      annotations: { readOnlyHint: false, idempotentHint: true },
    },
    async (input, extra) => {
      const registered = await registeredRunForTool(extra, agentServices, client);
      if (!registered.ok) return jsonToolResult({ ok: false, error: registered.error }, true);
      const response = await executeCreateAgentActivityEntry(
        { ...input, kind: "decision" },
        registered.registration,
        activityServices,
      );
      return activityMutationToolResult(response);
    },
  );

  server.registerTool(
    "request_change",
    {
      title: "Request a task change",
      description: "Record an attributed change request on a task as the registered agent run.",
      inputSchema: agentActivityEntryInputSchema,
      outputSchema: activityToolOutputSchema(activityEntryMutationResultSchema),
      annotations: { readOnlyHint: false, idempotentHint: true },
    },
    async (input, extra) => {
      const registered = await registeredRunForTool(extra, agentServices, client);
      if (!registered.ok) return jsonToolResult({ ok: false, error: registered.error }, true);
      const response = await executeCreateAgentActivityEntry(
        { ...input, kind: "change_request" },
        registered.registration,
        activityServices,
      );
      return activityMutationToolResult(response);
    },
  );

  server.registerTool(
    "list_task_entries",
    {
      title: "List task activity entries",
      description: "List attributed activity entries for one task in deterministic order.",
      inputSchema: listTaskEntriesInputSchema,
      outputSchema: activityToolOutputSchema(z.array(activityEntrySchema)),
      annotations: { readOnlyHint: true },
    },
    async (input, extra) => {
      const registered = await registeredRunForTool(extra, agentServices, client);
      if (!registered.ok) return jsonToolResult({ ok: false, error: registered.error }, true);
      const result = await Effect.runPromise(
        Effect.either(listActivityEntries(input, activityServices)),
      );
      const structuredContent = Either.isRight(result)
        ? { ok: true, payload: [...result.right] }
        : { ok: false, error: toActivityErrorDto(result.left) };
      return jsonToolResult(structuredContent, !structuredContent.ok);
    },
  );

  server.registerTool(
    "read_events",
    {
      title: "Read Helm events",
      description:
        "Read committed project events after a durable cursor in forward deterministic order.",
      inputSchema: readForwardEventsInputSchema,
      outputSchema: activityToolOutputSchema(activityEventPageSchema),
      annotations: { readOnlyHint: true },
    },
    async (input, extra) => {
      const registered = await registeredRunForTool(extra, agentServices, client);
      if (!registered.ok) return jsonToolResult({ ok: false, error: registered.error }, true);
      const result = await Effect.runPromise(
        Effect.either(
          readActivityEvents(
            { ...input, direction: "forward", beforeCursor: null },
            activityServices,
          ),
        ),
      );
      const structuredContent = Either.isRight(result)
        ? { ok: true, payload: result.right }
        : { ok: false, error: toActivityErrorDto(result.left) };
      return jsonToolResult(structuredContent, !structuredContent.ok);
    },
  );

  server.registerTool(
    "claim_task",
    {
      title: "Claim a Helm task",
      description:
        "Atomically claim a chosen eligible task for the registered agent run and return its renewable lease.",
      inputSchema: claimTaskInputSchema,
      // SDK 1.30 clients validate structured errors against this root schema despite isError.
      outputSchema: {
        ok: z.boolean(),
        grant: taskLeaseGrantSchema.optional(),
        error: z.union([agentErrorSchema, taskErrorSchema]).optional(),
      },
      annotations: { readOnlyHint: false, idempotentHint: true },
    },
    async (input, extra) => {
      const registered = await registeredRunForTool(extra, agentServices, client);
      if (!registered.ok) return jsonToolResult({ ok: false, error: registered.error }, true);
      const result = await Effect.runPromise(
        Effect.either(claimTask(input, registered.registration, taskServices)),
      );
      const structuredContent = Either.isRight(result)
        ? { ok: true, grant: result.right }
        : { ok: false, error: toTaskErrorDto(result.left) };
      return jsonToolResult(structuredContent, !structuredContent.ok);
    },
  );

  server.registerTool(
    "claim_next",
    {
      title: "Claim the next Helm task",
      description:
        "Atomically select and claim the highest-ranked eligible task for the registered agent run.",
      inputSchema: claimNextTaskInputSchema,
      outputSchema: {
        ok: z.boolean(),
        grant: taskLeaseGrantSchema.optional(),
        error: z.union([agentErrorSchema, taskErrorSchema]).optional(),
      },
      annotations: { readOnlyHint: false, idempotentHint: true },
    },
    async (input, extra) => {
      const registered = await registeredRunForTool(extra, agentServices, client);
      if (!registered.ok) return jsonToolResult({ ok: false, error: registered.error }, true);
      const result = await Effect.runPromise(
        Effect.either(claimNextTask(input, registered.registration, taskServices)),
      );
      const structuredContent = Either.isRight(result)
        ? { ok: true, grant: result.right }
        : { ok: false, error: toTaskErrorDto(result.left) };
      return jsonToolResult(structuredContent, !structuredContent.ok);
    },
  );

  server.registerTool(
    "renew_lease",
    {
      title: "Renew a Helm task lease",
      description:
        "Renew an active task lease owned by the registered agent run using its opaque lease token.",
      inputSchema: renewTaskLeaseInputSchema,
      outputSchema: {
        ok: z.boolean(),
        grant: taskLeaseGrantSchema.optional(),
        error: z.union([agentErrorSchema, taskErrorSchema]).optional(),
      },
      annotations: { readOnlyHint: false, idempotentHint: true },
    },
    async (input, extra) => {
      const registered = await registeredRunForTool(extra, agentServices, client);
      if (!registered.ok) return jsonToolResult({ ok: false, error: registered.error }, true);
      const result = await Effect.runPromise(
        Effect.either(renewTaskLease(input, registered.registration, taskServices)),
      );
      const structuredContent = Either.isRight(result)
        ? { ok: true, grant: result.right }
        : { ok: false, error: toTaskErrorDto(result.left) };
      return jsonToolResult(structuredContent, !structuredContent.ok);
    },
  );

  server.registerTool(
    "release_lease",
    {
      title: "Release a Helm task lease",
      description:
        "Release an active task lease owned by the registered agent run and return the task to ready work.",
      inputSchema: releaseTaskLeaseInputSchema,
      outputSchema: {
        ok: z.boolean(),
        result: taskLeaseMutationResultSchema.optional(),
        error: z.union([agentErrorSchema, taskErrorSchema]).optional(),
      },
      annotations: { readOnlyHint: false, idempotentHint: true },
    },
    async (input, extra) => {
      const registered = await registeredRunForTool(extra, agentServices, client);
      if (!registered.ok) return jsonToolResult({ ok: false, error: registered.error }, true);
      const result = await Effect.runPromise(
        Effect.either(releaseTaskLease(input, registered.registration, taskServices)),
      );
      const structuredContent = Either.isRight(result)
        ? { ok: true, result: result.right }
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
        "Agent completion is currently unavailable; lease-aware completion with structured attempt reports is deferred to the execution-reporting slice.",
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
