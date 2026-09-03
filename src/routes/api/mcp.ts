import { WebStandardStreamableHTTPServerTransport } from "@modelcontextprotocol/sdk/server/webStandardStreamableHttp.js";
import { createFileRoute } from "@tanstack/react-router";

import { createHelmMcpServer } from "../../mcp/project-server.server";
import { projectServices, taskServices } from "../../server/project-runtime.server";

async function handleMcpRequest(request: Request) {
  const transport = new WebStandardStreamableHTTPServerTransport({ enableJsonResponse: true });
  const server = createHelmMcpServer(projectServices, taskServices);
  await server.connect(transport);
  return transport.handleRequest(request);
}

export const Route = createFileRoute("/api/mcp")({
  server: {
    handlers: {
      GET: ({ request }) => handleMcpRequest(request),
      POST: ({ request }) => handleMcpRequest(request),
      DELETE: ({ request }) => handleMcpRequest(request),
    },
  },
});
