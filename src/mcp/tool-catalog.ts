import type { McpServer, ToolCallback } from "@modelcontextprotocol/sdk/server/mcp.js";
import {
  ListToolsRequestSchema,
  ToolSchema,
  type Tool,
  type ToolAnnotations,
} from "@modelcontextprotocol/sdk/types.js";
import { z } from "zod";

import { inputDescriptions } from "./tool-input-descriptions";

type Schema = z.ZodType | z.ZodRawShape;

function describeFields(schema: unknown) {
  if (!schema || typeof schema !== "object") return;
  const properties: unknown = Reflect.get(schema, "properties");
  if (properties && typeof properties === "object") {
    for (const [name, property] of Object.entries(properties)) {
      if (
        property &&
        typeof property === "object" &&
        !Reflect.get(property, "description") &&
        inputDescriptions[name]
      ) {
        Reflect.set(property, "description", inputDescriptions[name]);
      }
    }
  }
  for (const value of Object.values(schema)) {
    if (Array.isArray(value)) {
      for (const item of value) if (item && typeof item === "object") describeFields(item);
    } else if (value && typeof value === "object") {
      describeFields(value);
    }
  }
}

function exportSchema(schema: Schema | undefined, input: boolean): Tool["inputSchema"] {
  if (!schema) return { type: "object", properties: {}, additionalProperties: false };
  const object = schema instanceof z.ZodType ? schema : z.object(schema);
  const json = z.toJSONSchema(object, {
    target: "draft-7",
    io: "input",
    reused: "ref",
  });
  if (input) describeFields(json);
  // All Helm arguments/results are objects, including the two bulk-intent variants.
  return ToolSchema.shape.inputSchema.parse({ ...json, type: "object" });
}

/** Export Zod 4 unions and local references without changing SDK execution/validation. */
export function createToolCatalog(server: McpServer) {
  const tools: Tool[] = [];
  return {
    registerTool<Input extends Schema | undefined = undefined>(
      name: string,
      config: {
        title: string;
        description: string;
        inputSchema?: Input;
        outputSchema: Schema;
        annotations: ToolAnnotations;
      },
      callback: ToolCallback<Input>,
    ) {
      const annotations = {
        destructiveHint: !config.annotations.readOnlyHint,
        openWorldHint: false,
        ...config.annotations,
      };
      const registered = server.registerTool(name, { ...config, annotations }, callback);
      tools.push({
        name,
        title: config.title,
        description: config.description,
        annotations,
        execution: registered.execution,
        inputSchema: exportSchema(config.inputSchema, true),
        outputSchema: exportSchema(config.outputSchema, false),
      });
      return registered;
    },
    publish() {
      // The SDK's default exporter drops root unions and inlines reused schemas. Only
      // replace tools/list; tools/call still uses the original, fully typed Zod schemas.
      server.server.setRequestHandler(ListToolsRequestSchema, () => ({ tools }));
    },
  };
}
