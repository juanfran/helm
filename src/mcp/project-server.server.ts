import { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { Effect } from "effect";
import { z } from "zod";

import { getAppState, listProjects, type ProjectServices } from "../application/projects";
import { discoverTasks, type TaskServices } from "../application/tasks";
import { appStateSchema, projectSchema } from "../domain/projects";
import {
  completeTaskInputSchema,
  createTaskInputSchema,
  createTaskRelationInputSchema,
  discoverTasksInputSchema,
  reopenTaskInputSchema,
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

const DEFAULT_MCP_ACTOR: Actor = { type: "agent", id: "local-mcp-client" };

export function createHelmMcpServer(
  services: ProjectServices,
  taskServices: TaskServices,
  actor: Actor = DEFAULT_MCP_ACTOR,
) {
  const server = new McpServer({ name: "helm", version: "0.1.0" });

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
      const structuredContent = {
        projects: [...projects],
        activeProjectId: state.activeProject?.id ?? null,
      };
      return {
        content: [{ type: "text" as const, text: JSON.stringify(structuredContent) }],
        structuredContent,
      };
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
        error: z
          .object({
            type: z.string(),
            message: z.string(),
            taskId: z.string().optional(),
            missingFields: z.array(z.string()).optional(),
            expectedVersion: z.number().optional(),
            currentVersion: z.number().optional(),
            changeSummary: z.string().optional(),
            group: z.string().optional(),
            tagNames: z.array(z.string()).optional(),
            lifecycle: z.string().optional(),
            parentTaskId: z.string().optional(),
            sourceTaskId: z.string().optional(),
            targetTaskId: z.string().optional(),
            relationPath: z.array(z.string()).optional(),
          })
          .optional(),
      },
      annotations: { readOnlyHint: false, idempotentHint: true },
    },
    async (input) => {
      const response = await executeCreateTask(input, actor, taskServices);
      const structuredContent = response.ok
        ? { ok: true, task: response.task }
        : { ok: false, error: response.error };
      return {
        content: [{ type: "text" as const, text: JSON.stringify(structuredContent) }],
        structuredContent,
        isError: !response.ok,
      };
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
        error: z
          .object({
            type: z.string(),
            message: z.string(),
            taskId: z.string().optional(),
            expectedVersion: z.number().optional(),
            currentVersion: z.number().optional(),
            changeSummary: z.string().optional(),
            sourceTaskId: z.string().optional(),
            targetTaskId: z.string().optional(),
            relationPath: z.array(z.string()).optional(),
          })
          .optional(),
      },
      annotations: { readOnlyHint: false, idempotentHint: true },
    },
    async (input) => {
      const response = await executeCreateTaskRelation(input, actor, taskServices);
      const structuredContent = response.ok
        ? { ok: true, relation: response.relation }
        : { ok: false, error: response.error };
      return {
        content: [{ type: "text" as const, text: JSON.stringify(structuredContent) }],
        structuredContent,
        isError: !response.ok,
      };
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
        error: z.object({ type: z.string(), message: z.string() }).optional(),
      },
      annotations: { readOnlyHint: false, idempotentHint: true },
    },
    async (input) => {
      const response = await executeCompleteTask(input, actor, taskServices);
      const structuredContent = response.ok
        ? { ok: true, task: response.task }
        : { ok: false, error: response.error };
      return {
        content: [{ type: "text" as const, text: JSON.stringify(structuredContent) }],
        structuredContent,
        isError: !response.ok,
      };
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
        error: z.object({ type: z.string(), message: z.string() }).optional(),
      },
      annotations: { readOnlyHint: false, idempotentHint: true },
    },
    async (input) => {
      const response = await executeReopenTask(input, actor, taskServices);
      const structuredContent = response.ok
        ? { ok: true, task: response.task }
        : { ok: false, error: response.error };
      return {
        content: [{ type: "text" as const, text: JSON.stringify(structuredContent) }],
        structuredContent,
        isError: !response.ok,
      };
    },
  );

  server.registerTool(
    "discover_tasks",
    {
      title: "Discover claimable Helm tasks",
      description:
        "Return claimable ready work in the same deterministic order and with the same eligibility explanation used by Helm task lists.",
      inputSchema: discoverTasksInputSchema,
      outputSchema: {
        tasks: z.array(taskSchema),
      },
      annotations: { readOnlyHint: true },
    },
    async (input) => {
      const tasks = await Effect.runPromise(discoverTasks(input, taskServices));
      const structuredContent = { tasks: [...tasks] };
      return {
        content: [{ type: "text" as const, text: JSON.stringify(structuredContent) }],
        structuredContent,
      };
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
    async () => {
      const structuredContent = await Effect.runPromise(getAppState(services));
      return {
        content: [{ type: "text" as const, text: JSON.stringify(structuredContent) }],
        structuredContent,
      };
    },
  );

  return server;
}
