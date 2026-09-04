import { randomUUID } from "node:crypto";

import { WebStandardStreamableHTTPServerTransport } from "@modelcontextprotocol/sdk/server/webStandardStreamableHttp.js";
import { InitializeRequestSchema, isInitializeRequest } from "@modelcontextprotocol/sdk/types.js";
import { Effect } from "effect";

import type { ActivityServices } from "../application/activity";
import { closeAgentRun, type AgentServices } from "../application/agents";
import type { ProjectServices } from "../application/projects";
import type { TaskQueryServices } from "../application/task-queries";
import { cancelTaskLeasesForRun, type TaskServices } from "../application/tasks";
import { createHelmMcpServer } from "./project-server.server";

type McpHttpSession = {
  readonly server: ReturnType<typeof createHelmMcpServer>;
  readonly transport: WebStandardStreamableHTTPServerTransport;
};

function jsonRpcError(status: number, code: number, message: string) {
  return Response.json({ jsonrpc: "2.0", error: { code, message }, id: null }, { status });
}

async function readRequestBody(request: Request) {
  try {
    return await request.clone().json();
  } catch {
    return null;
  }
}

export function createMcpRequestHandler(
  projectServices: ProjectServices,
  taskServices: TaskServices,
  agentServices: AgentServices,
  activityServices: ActivityServices,
  taskQueryServices: TaskQueryServices,
) {
  const sessions = new Map<string, McpHttpSession>();
  const closingSessions = new Set<string>();

  async function closeSession(sessionId: string) {
    sessions.delete(sessionId);
    if (closingSessions.has(sessionId)) return;
    closingSessions.add(sessionId);
    try {
      const closedRunId = await Effect.runPromise(closeAgentRun(sessionId, agentServices));
      if (closedRunId) {
        await Effect.runPromise(cancelTaskLeasesForRun(closedRunId, taskServices));
      }
    } catch (error) {
      const message = error instanceof Error ? error.message : "unknown error";
      process.stderr.write(`[helm] MCP session cleanup failed: ${message}\n`);
    } finally {
      closingSessions.delete(sessionId);
    }
  }

  return async function handleMcpRequest(request: Request) {
    const sessionId = request.headers.get("mcp-session-id");
    const existing = sessionId ? sessions.get(sessionId) : null;
    if (existing) return existing.transport.handleRequest(request);

    if (sessionId) {
      return jsonRpcError(404, -32001, "Session not found");
    }

    if (request.method !== "POST") {
      return jsonRpcError(400, -32000, "Missing MCP session ID");
    }

    const body = await readRequestBody(request);
    if (!isInitializeRequest(body)) {
      return jsonRpcError(400, -32600, "Invalid Request: initialize before using tools");
    }
    const initializeRequest = InitializeRequestSchema.parse(body);

    let session: McpHttpSession | null = null;
    const transport = new WebStandardStreamableHTTPServerTransport({
      sessionIdGenerator: () => randomUUID(),
      enableJsonResponse: true,
      onsessioninitialized: (initializedSessionId) => {
        if (session) sessions.set(initializedSessionId, session);
      },
      onsessionclosed: closeSession,
    });
    const server = createHelmMcpServer(
      projectServices,
      taskServices,
      agentServices,
      activityServices,
      taskQueryServices,
      {
        clientName: initializeRequest.params.clientInfo.name,
        clientVersion: initializeRequest.params.clientInfo.version,
      },
    );
    session = { server, transport };
    // The MCP Transport interface exposes a callback property rather than EventTarget methods.
    // oxlint-disable-next-line unicorn/prefer-add-event-listener
    transport.onclose = () => {
      const closedSessionId = transport.sessionId;
      if (closedSessionId) void closeSession(closedSessionId);
    };
    await server.connect(transport);
    return transport.handleRequest(request, { parsedBody: body });
  };
}
