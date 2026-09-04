import { z } from "zod";

import {
  canonicalizeTaskFilter,
  canonicalizeTaskSearchOrder,
  taskFilterV1Schema,
  taskSearchOrderListSchema,
  type TaskFilterV1,
  type TaskSearchOrder,
} from "./task-filters";

const savedViewIdSchema = z.string().trim().min(1).max(200);
const savedViewProjectIdSchema = z.string().trim().min(1).max(200);
const savedViewNameSchema = z.string().trim().min(1).max(120);
const savedViewReasonSchema = z.string().trim().min(1).max(1_000);
const savedViewIdempotencyKeySchema = z.string().trim().min(1).max(200);
const savedViewVersionSchema = z.number().int().positive();
const savedViewTimestampSchema = z.iso.datetime({ offset: true });

export const savedViewGroupingSchema = z.discriminatedUnion("type", [
  z.strictObject({ type: z.literal("none") }),
  z.strictObject({ type: z.literal("lifecycle") }),
  z.strictObject({ type: z.literal("priority") }),
  z.strictObject({ type: z.literal("eligibility") }),
  z.strictObject({
    type: z.literal("tag"),
    tagId: z.string().trim().min(1).max(200),
  }),
]);
export type SavedViewGrouping = z.infer<typeof savedViewGroupingSchema>;

export const savedViewVisibleFieldSchema = z.enum([
  "title",
  "lifecycle",
  "eligibility",
  "priority",
  "tags",
  "capabilities",
  "assignee",
  "not_before",
  "due_at",
  "updated_at",
]);
export type SavedViewVisibleField = z.infer<typeof savedViewVisibleFieldSchema>;

const savedViewVisibleFieldsSchema = z
  .array(savedViewVisibleFieldSchema)
  .min(1)
  .max(savedViewVisibleFieldSchema.options.length)
  .superRefine((fields, context) => {
    const seen = new Set<SavedViewVisibleField>();
    for (const [index, field] of fields.entries()) {
      if (seen.has(field)) {
        context.addIssue({
          code: "custom",
          message: `Visible field ${field} may only appear once.`,
          path: [index],
        });
      }
      seen.add(field);
    }
  });

export const savedViewPresentationSchema = z.enum(["list", "board"]);
export type SavedViewPresentation = z.infer<typeof savedViewPresentationSchema>;

function reportInvalidRelevanceOrder(
  definition: {
    readonly filter: TaskFilterV1;
    readonly order?: readonly TaskSearchOrder[];
  },
  context: z.RefinementCtx,
) {
  if (!definition.filter.search && definition.order?.some(({ field }) => field === "relevance")) {
    context.addIssue({
      code: "custom",
      message: "Relevance ordering requires a text search.",
      path: ["order"],
      input: definition.order,
    });
  }
}

export const savedViewDefinitionV1Schema = z
  .strictObject({
    schemaVersion: z.literal(1),
    filter: taskFilterV1Schema,
    order: taskSearchOrderListSchema,
    grouping: savedViewGroupingSchema,
    visibleFields: savedViewVisibleFieldsSchema,
    presentation: savedViewPresentationSchema.optional().default("list"),
  })
  .superRefine(reportInvalidRelevanceOrder);
export type SavedViewDefinitionV1 = z.infer<typeof savedViewDefinitionV1Schema>;

/**
 * The pre-release v0 format was the same persisted shape without a required
 * schema version. It also allowed the presentation, grouping, visible fields,
 * and order to be omitted. Keeping this schema strict makes migration reject
 * unknown data instead of silently discarding it.
 */
export const legacySavedViewDefinitionV0Schema = z
  .strictObject({
    schemaVersion: z.literal(0).optional(),
    filter: taskFilterV1Schema,
    order: taskSearchOrderListSchema.optional(),
    grouping: savedViewGroupingSchema.optional().default({ type: "none" }),
    visibleFields: savedViewVisibleFieldsSchema
      .optional()
      .default(["title", "lifecycle", "priority"]),
    presentation: savedViewPresentationSchema.optional().default("list"),
  })
  .superRefine(reportInvalidRelevanceOrder);
export type LegacySavedViewDefinitionV0 = z.infer<typeof legacySavedViewDefinitionV0Schema>;

export function canonicalizeSavedViewDefinition(
  definition: SavedViewDefinitionV1,
): SavedViewDefinitionV1 {
  const parsed = savedViewDefinitionV1Schema.parse(definition);
  const filter = canonicalizeTaskFilter(parsed.filter);
  return savedViewDefinitionV1Schema.parse({
    ...parsed,
    filter,
    order: canonicalizeTaskSearchOrder(parsed.order, filter),
  });
}

function explicitDefinitionVersion(input: unknown) {
  if (typeof input !== "object" || input === null) return undefined;
  if (!Object.prototype.hasOwnProperty.call(input, "schemaVersion")) return undefined;
  return (input as { readonly schemaVersion?: unknown }).schemaVersion;
}

export function migrateSavedViewDefinition(input: unknown): SavedViewDefinitionV1 {
  const version = explicitDefinitionVersion(input);
  if (version !== undefined && version !== 0 && version !== 1) {
    const renderedVersion = JSON.stringify(version) ?? typeof version;
    throw new TypeError(`Unsupported saved-view definition schema version: ${renderedVersion}.`);
  }
  if (version === 1) {
    return canonicalizeSavedViewDefinition(savedViewDefinitionV1Schema.parse(input));
  }
  const legacy = legacySavedViewDefinitionV0Schema.parse(input);
  const filter = canonicalizeTaskFilter(legacy.filter);
  return canonicalizeSavedViewDefinition({
    schemaVersion: 1,
    filter,
    order: canonicalizeTaskSearchOrder(legacy.order, filter),
    grouping: legacy.grouping,
    visibleFields: legacy.visibleFields,
    presentation: legacy.presentation,
  });
}

export function savedViewProjectMatches(
  projectId: string,
  definition: Pick<SavedViewDefinitionV1, "filter">,
) {
  return definition.filter.projectId === projectId;
}

export function assertSavedViewProjectMatches(
  projectId: string,
  definition: Pick<SavedViewDefinitionV1, "filter">,
): void {
  if (!savedViewProjectMatches(projectId, definition)) {
    throw new RangeError(
      `Saved-view project ${projectId} does not match filter project ${definition.filter.projectId}.`,
    );
  }
}

function reportProjectMismatch(
  input: { readonly projectId: string; readonly definition: SavedViewDefinitionV1 },
  context: z.RefinementCtx,
) {
  if (!savedViewProjectMatches(input.projectId, input.definition)) {
    context.addIssue({
      code: "custom",
      message: "The saved-view filter must target the saved view's project.",
      path: ["definition", "filter", "projectId"],
    });
  }
}

export const savedViewSchema = z
  .strictObject({
    id: savedViewIdSchema,
    projectId: savedViewProjectIdSchema,
    sequence: z.number().int().positive(),
    name: savedViewNameSchema,
    definition: savedViewDefinitionV1Schema,
    version: savedViewVersionSchema,
    archivedAt: savedViewTimestampSchema.nullable(),
    createdAt: savedViewTimestampSchema,
    updatedAt: savedViewTimestampSchema,
  })
  .superRefine(reportProjectMismatch);
export type SavedView = z.infer<typeof savedViewSchema>;

export const listSavedViewsInputSchema = z.strictObject({
  projectId: savedViewProjectIdSchema,
  includeArchived: z.boolean().optional().default(false),
});
export type ListSavedViewsInput = z.infer<typeof listSavedViewsInputSchema>;

export const getSavedViewInputSchema = z.strictObject({
  projectId: savedViewProjectIdSchema,
  savedViewId: savedViewIdSchema,
});
export type GetSavedViewInput = z.infer<typeof getSavedViewInputSchema>;

export const createSavedViewInputSchema = z
  .strictObject({
    projectId: savedViewProjectIdSchema,
    name: savedViewNameSchema,
    definition: savedViewDefinitionV1Schema,
    idempotencyKey: savedViewIdempotencyKeySchema,
  })
  .superRefine(reportProjectMismatch);
export type CreateSavedViewInput = z.infer<typeof createSavedViewInputSchema>;

export const updateSavedViewInputSchema = z
  .strictObject({
    projectId: savedViewProjectIdSchema,
    savedViewId: savedViewIdSchema,
    name: savedViewNameSchema,
    definition: savedViewDefinitionV1Schema,
    expectedVersion: savedViewVersionSchema,
    idempotencyKey: savedViewIdempotencyKeySchema,
  })
  .superRefine(reportProjectMismatch);
export type UpdateSavedViewInput = z.infer<typeof updateSavedViewInputSchema>;

const savedViewArchiveCommandFields = {
  projectId: savedViewProjectIdSchema,
  savedViewId: savedViewIdSchema,
  expectedVersion: savedViewVersionSchema,
  reason: savedViewReasonSchema,
  idempotencyKey: savedViewIdempotencyKeySchema,
};

export const archiveSavedViewInputSchema = z.strictObject(savedViewArchiveCommandFields);
export type ArchiveSavedViewInput = z.infer<typeof archiveSavedViewInputSchema>;

export const restoreSavedViewInputSchema = z.strictObject(savedViewArchiveCommandFields);
export type RestoreSavedViewInput = z.infer<typeof restoreSavedViewInputSchema>;

export const compiledSavedViewDefinitionV1Schema = z.compile(savedViewDefinitionV1Schema);
export const compiledSavedViewSchema = z.compile(savedViewSchema);
export const compiledListSavedViewsInputSchema = z.compile(listSavedViewsInputSchema);
export const compiledGetSavedViewInputSchema = z.compile(getSavedViewInputSchema);
export const compiledCreateSavedViewInputSchema = z.compile(createSavedViewInputSchema);
export const compiledUpdateSavedViewInputSchema = z.compile(updateSavedViewInputSchema);
export const compiledArchiveSavedViewInputSchema = z.compile(archiveSavedViewInputSchema);
export const compiledRestoreSavedViewInputSchema = z.compile(restoreSavedViewInputSchema);

export type SavedViewTaskFilter = TaskFilterV1;
export type SavedViewTaskOrder = TaskSearchOrder;
