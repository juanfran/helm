import { z } from "zod";

import { capabilityNameSchema } from "./tasks";

export const agentProfileKeySchema = z
  .string()
  .trim()
  .min(1)
  .max(120)
  .regex(/^[a-z0-9][a-z0-9._:-]*$/i, "Use letters, numbers, dots, underscores, colons, or dashes.");

export const agentProfileSchema = z.object({
  id: z.string(),
  profileKey: agentProfileKeySchema,
  displayName: z.string(),
  capabilities: z.array(capabilityNameSchema),
  createdAt: z.string(),
  updatedAt: z.string(),
});
export type AgentProfile = z.infer<typeof agentProfileSchema>;

export const agentRunStatusSchema = z.enum(["active", "closed"]);

export const agentRunSchema = z.object({
  id: z.string(),
  profileId: z.string(),
  mcpSessionId: z.string(),
  status: agentRunStatusSchema,
  clientName: z.string().nullable(),
  clientVersion: z.string().nullable(),
  createdAt: z.string(),
  lastSeenAt: z.string(),
  endedAt: z.string().nullable(),
});
export type AgentRun = z.infer<typeof agentRunSchema>;

export const registeredAgentRunSchema = z.object({
  profile: agentProfileSchema,
  run: agentRunSchema,
});
export type RegisteredAgentRun = z.infer<typeof registeredAgentRunSchema>;

export const agentRunSummarySchema = z.strictObject({
  id: z.string(),
  profileId: z.string(),
  profileKey: agentProfileKeySchema,
  displayName: z.string(),
  capabilities: z.array(capabilityNameSchema),
  status: agentRunStatusSchema,
  clientName: z.string().nullable(),
  clientVersion: z.string().nullable(),
  createdAt: z.string(),
  lastSeenAt: z.string(),
  endedAt: z.string().nullable(),
});
export type AgentRunSummary = z.infer<typeof agentRunSummarySchema>;

export const listAgentRunsInputSchema = z.strictObject({
  status: agentRunStatusSchema.optional().default("active"),
  limit: z.number().int().positive().max(200).optional().default(50),
});
export type ListAgentRunsInput = z.infer<typeof listAgentRunsInputSchema>;

export const mcpSessionContextSchema = z.object({
  sessionId: z.string().trim().min(1),
  clientName: z.string().trim().min(1).max(200).nullable().optional().default(null),
  clientVersion: z.string().trim().min(1).max(80).nullable().optional().default(null),
});
export type McpSessionContext = z.infer<typeof mcpSessionContextSchema>;

export const registerAgentRunInputSchema = z.object({
  profileKey: agentProfileKeySchema,
  displayName: z.string().trim().min(1).max(200),
  capabilities: z.array(capabilityNameSchema).max(100).optional().default([]),
  resumeRunId: z.string().trim().min(1).nullable().optional().default(null),
  takeoverActiveRun: z.boolean().optional().default(false),
  idempotencyKey: z.string().trim().min(1).max(200),
});
export type RegisterAgentRunInput = z.infer<typeof registerAgentRunInputSchema>;

export const compiledAgentRunSummarySchema = z.compile(agentRunSummarySchema);
export const compiledListAgentRunsInputSchema = z.compile(listAgentRunsInputSchema);
export const compiledMcpSessionContextSchema = z.compile(mcpSessionContextSchema);
export const compiledRegisterAgentRunInputSchema = z.compile(registerAgentRunInputSchema);
