import { createFileRoute } from "@tanstack/react-router";

import { createMcpRequestHandler } from "../../mcp/http-transport.server";
import {
  activityServices,
  agentServices,
  projectServices,
  taskServices,
} from "../../server/project-runtime.server";

const handleMcpRequest = createMcpRequestHandler(
  projectServices,
  taskServices,
  agentServices,
  activityServices,
);

export const Route = createFileRoute("/api/mcp")({
  server: {
    handlers: {
      GET: ({ request }) => handleMcpRequest(request),
      POST: ({ request }) => handleMcpRequest(request),
      DELETE: ({ request }) => handleMcpRequest(request),
    },
  },
});
