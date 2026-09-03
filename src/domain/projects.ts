import { z } from "zod";

export const themeSchema = z.enum(["light", "dark", "system"]);
export type Theme = z.infer<typeof themeSchema>;

export const projectSchema = z.object({
  id: z.string(),
  sequence: z.number().int().positive(),
  name: z.string(),
  repositoryRoot: z.string(),
  version: z.number().int().positive(),
  createdAt: z.string(),
  updatedAt: z.string(),
});
export type Project = z.infer<typeof projectSchema>;

export const appStateSchema = z.object({
  activeProject: projectSchema.nullable(),
  theme: themeSchema,
});
export type AppState = z.infer<typeof appStateSchema>;

export const createProjectInputSchema = z.object({
  repositoryRoot: z.string().trim().min(1),
  idempotencyKey: z.string().trim().min(1).max(200),
});
export type CreateProjectInput = z.infer<typeof createProjectInputSchema>;

export const setThemeInputSchema = z.object({
  theme: themeSchema,
  idempotencyKey: z.string().trim().min(1).max(200),
});
export type SetThemeInput = z.infer<typeof setThemeInputSchema>;

// Compile stable synchronous schemas once. The normal schemas remain exported for
// adapter metadata and tests that verify both parsing paths.
export const compiledCreateProjectInputSchema = z.compile(createProjectInputSchema);
export const compiledSetThemeInputSchema = z.compile(setThemeInputSchema);
