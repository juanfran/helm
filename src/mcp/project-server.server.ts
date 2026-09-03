import { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { Effect } from "effect";
import { z } from "zod";

import { getAppState, listProjects, type ProjectServices } from "../application/projects";
import { appStateSchema, projectSchema } from "../domain/projects";

export function createHelmMcpServer(services: ProjectServices) {
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
