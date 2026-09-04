import { z } from "zod";

export const themeSchema = z.enum(["light", "dark", "system"]);
export type Theme = z.infer<typeof themeSchema>;

export const projectReviewModeSchema = z.enum(["required", "direct"]);
export type ProjectReviewMode = z.infer<typeof projectReviewModeSchema>;

export const projectSchema = z.object({
  id: z.string(),
  sequence: z.number().int().positive(),
  name: z.string(),
  repositoryRoot: z.string(),
  reviewMode: projectReviewModeSchema.default("required"),
  version: z.number().int().positive(),
  createdAt: z.string(),
  updatedAt: z.string(),
});
export type Project = z.infer<typeof projectSchema>;

export const appStateSchema = z.object({
  activeProject: projectSchema.nullable(),
  activeProjectVersion: z.number().int().nonnegative(),
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

export const selectActiveProjectInputSchema = z.object({
  projectId: z.string().trim().min(1),
  expectedVersion: z.number().int().nonnegative(),
  idempotencyKey: z.string().trim().min(1).max(200),
});
export type SelectActiveProjectInput = z.infer<typeof selectActiveProjectInputSchema>;

export const setProjectReviewModeInputSchema = z.object({
  projectId: z.string().trim().min(1),
  reviewMode: projectReviewModeSchema,
  expectedVersion: z.number().int().positive(),
  idempotencyKey: z.string().trim().min(1).max(200),
});
export type SetProjectReviewModeInput = z.infer<typeof setProjectReviewModeInputSchema>;

// Compile stable synchronous schemas once. The normal schemas remain exported for
// adapter metadata and tests that verify both parsing paths.
export const compiledCreateProjectInputSchema = z.compile(createProjectInputSchema);
export const compiledSetThemeInputSchema = z.compile(setThemeInputSchema);
export const compiledSelectActiveProjectInputSchema = z.compile(selectActiveProjectInputSchema);
export const compiledSetProjectReviewModeInputSchema = z.compile(setProjectReviewModeInputSchema);
