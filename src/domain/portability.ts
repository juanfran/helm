import { z } from "zod";

import { eventImportanceSchema, eventScopeSchema } from "./activity";
import { agentProfileKeySchema, agentRunStatusSchema } from "./agents";
import {
  customFieldDefinitionSchema,
  customFieldValueSchema,
  validateCustomFieldValue,
} from "./customization";
import { projectReviewModeSchema } from "./projects";
import { jsonValueSchema, richTextDocumentSchema } from "./rich-text";
import { savedViewSchema } from "./saved-views";
import {
  capabilityNameSchema,
  taskDateSchema,
  taskFailureClassificationSchema,
  taskLifecycleSchema,
  taskPrioritySchema,
  taskReferencedPathSchema,
  taskRelationTypeSchema,
  taskSizeSchema,
  taskVerificationStatusSchema,
} from "./tasks";

export const HELM_PROJECT_EXPORT_FORMAT = "helm-project-export" as const;
export const HELM_PROJECT_EXPORT_SCHEMA_VERSION = 1 as const;
export const HELM_PROJECT_EXPORT_LIMITS = Object.freeze({
  maxBytes: 64 * 1024 * 1024,
  maxTopLevelRecords: 100_000,
});
export const PROJECT_IMPORT_PREVIEW_TOKEN_PREFIX = "hip1" as const;
export const HELM_PROJECT_EXPORT_EXCLUDED_SECTIONS = [
  "leases",
  "tokenHashes",
  "idempotencyRecords",
  "preferences",
] as const;

const opaqueIdSchema = z.string().trim().min(1).max(200);
const timestampSchema = z.iso.datetime({ offset: true });
const hashSchema = z.string().regex(/^[a-f0-9]{64}$/);
const reasonSchema = z.string().trim().min(1).max(1_000);
const idempotencyKeySchema = z.string().trim().min(1).max(200);

function uniqueStrings(max: number) {
  return z
    .array(opaqueIdSchema)
    .max(max)
    .superRefine((values, context) => {
      const seen = new Set<string>();
      for (const [index, value] of values.entries()) {
        if (seen.has(value)) {
          context.addIssue({
            code: "custom",
            message: `Identifier ${value} may only appear once.`,
            path: [index],
            input: value,
          });
        }
        seen.add(value);
      }
    });
}

const actorSchema = z.strictObject({
  type: z.enum(["human", "agent", "system"]),
  id: opaqueIdSchema,
});

const eventChangeHintsSchema = z.strictObject({
  projectIds: uniqueStrings(10_000),
  taskIds: uniqueStrings(100_000),
  activityEntryIds: uniqueStrings(100_000),
  agentRunIds: uniqueStrings(100_000),
  savedViewIds: uniqueStrings(100_000),
  scopes: z.array(eventScopeSchema).max(eventScopeSchema.options.length),
});

export const exportedProjectSchema = z.strictObject({
  id: opaqueIdSchema,
  sequence: z.number().int().positive(),
  name: z.string().trim().min(1).max(300),
  repositoryRoot: z.string().trim().min(1).max(4_096),
  reviewMode: projectReviewModeSchema,
  version: z.number().int().positive(),
  createdAt: timestampSchema,
  updatedAt: timestampSchema,
});
export type ExportedProject = z.infer<typeof exportedProjectSchema>;

export const exportedTagSchema = z.strictObject({
  id: opaqueIdSchema,
  projectId: opaqueIdSchema,
  name: z.string().trim().min(1).max(80),
  description: z.string().max(1_000),
  color: z.string().regex(/^#[0-9a-f]{6}$/i),
  exclusiveGroup: z.string().trim().min(1).max(80).nullable(),
  reviewModeOverride: projectReviewModeSchema.nullable(),
  createdAt: timestampSchema,
  updatedAt: timestampSchema,
});
export type ExportedTag = z.infer<typeof exportedTagSchema>;

export const exportedTaskCustomFieldValueSchema = z.strictObject({
  fieldId: opaqueIdSchema,
  value: customFieldValueSchema,
  updatedAt: timestampSchema,
});
export type ExportedTaskCustomFieldValue = z.infer<typeof exportedTaskCustomFieldValueSchema>;

const exportedChecklistItemSchema = z.strictObject({
  id: opaqueIdSchema,
  text: z.string().trim().min(1).max(2_000),
  checked: z.boolean(),
});

export const exportedTaskSchema = z.strictObject({
  id: opaqueIdSchema,
  projectId: opaqueIdSchema,
  sequence: z.number().int().positive(),
  parentTaskId: opaqueIdSchema.nullable(),
  title: z.string().trim().min(1).max(300),
  lifecycle: taskLifecycleSchema,
  priority: taskPrioritySchema,
  position: z.number().int().nonnegative(),
  notBefore: taskDateSchema.nullable(),
  dueAt: taskDateSchema.nullable(),
  size: taskSizeSchema.nullable(),
  description: richTextDocumentSchema,
  expectedOutcome: z.string().max(10_000),
  acceptanceCriteria: z.string().max(20_000),
  agentContext: z.string().max(20_000),
  checklist: z.array(exportedChecklistItemSchema).max(200),
  reviewModeOverride: projectReviewModeSchema.nullable(),
  reviewAttemptId: opaqueIdSchema.nullable(),
  cancelledFromLifecycle: z.enum(["backlog", "ready", "in_progress", "review"]).nullable(),
  version: z.number().int().positive(),
  archivedAt: timestampSchema.nullable(),
  createdAt: timestampSchema,
  updatedAt: timestampSchema,
  tagIds: uniqueStrings(50),
  customFieldValues: z.array(exportedTaskCustomFieldValueSchema).max(50),
  requiredCapabilities: z.array(capabilityNameSchema).max(100),
  referencedPaths: z.array(taskReferencedPathSchema).max(100),
});
export type ExportedTask = z.infer<typeof exportedTaskSchema>;

export const exportedTaskRelationSchema = z.strictObject({
  id: opaqueIdSchema,
  projectId: opaqueIdSchema,
  sourceTaskId: opaqueIdSchema,
  targetTaskId: opaqueIdSchema,
  type: taskRelationTypeSchema,
  createdAt: timestampSchema,
});
export type ExportedTaskRelation = z.infer<typeof exportedTaskRelationSchema>;

export const exportedAgentProfileSchema = z.strictObject({
  id: opaqueIdSchema,
  profileKey: agentProfileKeySchema,
  displayName: z.string().trim().min(1).max(200),
  capabilities: z.array(capabilityNameSchema).max(100),
  createdAt: timestampSchema,
  updatedAt: timestampSchema,
});
export type ExportedAgentProfile = z.infer<typeof exportedAgentProfileSchema>;

/** Import-safe historical run: source status is retained, but the portable run is closed. */
export const exportedAgentRunSchema = z.strictObject({
  id: opaqueIdSchema,
  profileId: opaqueIdSchema,
  sourceStatus: agentRunStatusSchema,
  status: z.literal("closed"),
  clientName: z.string().max(200).nullable(),
  clientVersion: z.string().max(80).nullable(),
  createdAt: timestampSchema,
  lastSeenAt: timestampSchema,
  endedAt: timestampSchema,
});
export type ExportedAgentRun = z.infer<typeof exportedAgentRunSchema>;

const exportedVerificationResultSchema = z.strictObject({
  name: z.string().trim().min(1).max(300),
  status: taskVerificationStatusSchema,
  details: z.string().max(2_000),
});

export const exportedAttemptSchema = z.strictObject({
  id: opaqueIdSchema,
  taskId: opaqueIdSchema,
  attemptNumber: z.number().int().positive(),
  agentRunId: opaqueIdSchema.nullable(),
  agentProfileId: opaqueIdSchema.nullable(),
  agentDisplayName: z.string().max(200).nullable(),
  status: z.enum(["active", "completed", "failed", "abandoned", "cancelled"]),
  summary: z.string().max(20_000),
  changedAreas: z.array(z.string().max(1_000)).max(25),
  verificationResults: z.array(exportedVerificationResultSchema).max(25),
  references: z.array(z.string().max(1_000)).max(25),
  risks: z.array(z.string().max(1_000)).max(25),
  followUpWork: z.array(z.string().max(1_000)).max(25),
  failureClassification: taskFailureClassificationSchema.nullable(),
  createdAt: timestampSchema,
  completedAt: timestampSchema.nullable(),
});
export type ExportedAttempt = z.infer<typeof exportedAttemptSchema>;

export const exportedActivityEntrySchema = z.strictObject({
  id: opaqueIdSchema,
  projectId: opaqueIdSchema,
  taskId: opaqueIdSchema,
  attemptId: opaqueIdSchema.nullable(),
  kind: z.enum(["comment", "progress", "decision", "change_request", "system"]),
  author: actorSchema,
  authorDisplayName: z.string().max(200),
  agentProfileId: opaqueIdSchema.nullable(),
  agentRunId: opaqueIdSchema.nullable(),
  content: richTextDocumentSchema,
  contentText: z.string(),
  createdAt: timestampSchema,
  withdrawnAt: timestampSchema.nullable(),
  withdrawnBy: actorSchema.nullable(),
  withdrawalReason: z.string().max(2_000).nullable(),
});
export type ExportedActivityEntry = z.infer<typeof exportedActivityEntrySchema>;

export const exportedManualBlockerSchema = z.strictObject({
  id: opaqueIdSchema,
  projectId: opaqueIdSchema,
  taskId: opaqueIdSchema,
  reason: z.string().trim().min(1).max(2_000),
  status: z.enum(["active", "resolved"]),
  createdBy: actorSchema,
  createdAt: timestampSchema,
  resolvedBy: actorSchema.nullable(),
  resolvedAt: timestampSchema.nullable(),
  resolution: z.string().max(2_000).nullable(),
});
export type ExportedManualBlocker = z.infer<typeof exportedManualBlockerSchema>;

export const sourceEventProvenanceSchema = z.strictObject({
  sourceCursor: z.number().int().positive(),
  projectId: opaqueIdSchema,
  kind: z.string().trim().min(1).max(200),
  importance: eventImportanceSchema,
  actor: actorSchema,
  entity: z.strictObject({ type: z.string().trim().min(1), id: opaqueIdSchema }),
  payload: z.record(z.string(), jsonValueSchema),
  changes: eventChangeHintsSchema,
  occurredAt: timestampSchema,
});
export type SourceEventProvenance = z.infer<typeof sourceEventProvenanceSchema>;

function reportDuplicateIds(
  values: readonly { readonly id: string }[],
  path: string,
  context: z.RefinementCtx,
) {
  const seen = new Set<string>();
  for (const [index, value] of values.entries()) {
    if (seen.has(value.id)) {
      context.addIssue({
        code: "custom",
        message: `${path} id ${value.id} may only appear once.`,
        path: [path, index, "id"],
        input: value.id,
      });
    }
    seen.add(value.id);
  }
}

export const helmProjectExportV1Schema = z
  .strictObject({
    format: z.literal(HELM_PROJECT_EXPORT_FORMAT),
    schemaVersion: z.literal(HELM_PROJECT_EXPORT_SCHEMA_VERSION),
    exportedAt: timestampSchema,
    project: exportedProjectSchema,
    tags: z.array(exportedTagSchema),
    customFieldDefinitions: z.array(customFieldDefinitionSchema),
    tasks: z.array(exportedTaskSchema),
    relations: z.array(exportedTaskRelationSchema),
    savedViews: z.array(savedViewSchema),
    agentProfiles: z.array(exportedAgentProfileSchema),
    agentRuns: z.array(exportedAgentRunSchema),
    attempts: z.array(exportedAttemptSchema),
    activityEntries: z.array(exportedActivityEntrySchema),
    manualBlockers: z.array(exportedManualBlockerSchema),
    sourceEvents: z.array(sourceEventProvenanceSchema),
  })
  .superRefine((artifact, context) => {
    const projectId = artifact.project.id;
    const projectCollections = [
      ["tags", artifact.tags],
      ["customFieldDefinitions", artifact.customFieldDefinitions],
      ["tasks", artifact.tasks],
      ["relations", artifact.relations],
      ["savedViews", artifact.savedViews],
      ["activityEntries", artifact.activityEntries],
      ["manualBlockers", artifact.manualBlockers],
      ["sourceEvents", artifact.sourceEvents],
    ] as const;
    for (const [path, values] of projectCollections) {
      for (const [index, value] of values.entries()) {
        if (value.projectId !== projectId) {
          context.addIssue({
            code: "custom",
            message: `Every ${path} record must belong to the exported project.`,
            path: [path, index, "projectId"],
            input: value.projectId,
          });
        }
      }
    }

    for (const [path, values] of [
      ["tags", artifact.tags],
      ["customFieldDefinitions", artifact.customFieldDefinitions],
      ["tasks", artifact.tasks],
      ["relations", artifact.relations],
      ["savedViews", artifact.savedViews],
      ["agentProfiles", artifact.agentProfiles],
      ["agentRuns", artifact.agentRuns],
      ["attempts", artifact.attempts],
      ["activityEntries", artifact.activityEntries],
      ["manualBlockers", artifact.manualBlockers],
    ] as const) {
      reportDuplicateIds(values, path, context);
    }

    const taskIds = new Set(artifact.tasks.map(({ id }) => id));
    const tagIds = new Set(artifact.tags.map(({ id }) => id));
    const definitions = new Map(
      artifact.customFieldDefinitions.map((definition) => [definition.id, definition]),
    );
    for (const [index, task] of artifact.tasks.entries()) {
      if (task.parentTaskId !== null && !taskIds.has(task.parentTaskId)) {
        context.addIssue({
          code: "custom",
          message: `Parent task ${task.parentTaskId} is not present in the export.`,
          path: ["tasks", index, "parentTaskId"],
          input: task.parentTaskId,
        });
      }
      for (const tagId of task.tagIds) {
        if (!tagIds.has(tagId)) {
          context.addIssue({
            code: "custom",
            message: `Tag ${tagId} is not present in the export.`,
            path: ["tasks", index, "tagIds"],
            input: tagId,
          });
        }
      }
      for (const [valueIndex, explicit] of task.customFieldValues.entries()) {
        const definition = definitions.get(explicit.fieldId);
        if (!definition) {
          context.addIssue({
            code: "custom",
            message: `Custom field ${explicit.fieldId} is not present in the export.`,
            path: ["tasks", index, "customFieldValues", valueIndex, "fieldId"],
            input: explicit.fieldId,
          });
        } else {
          for (const issue of validateCustomFieldValue(definition, explicit.value)) {
            context.addIssue({
              code: "custom",
              message: issue.message,
              path: ["tasks", index, "customFieldValues", valueIndex, "value"],
              input: explicit.value,
            });
          }
        }
      }
    }
    for (const [index, relation] of artifact.relations.entries()) {
      if (!taskIds.has(relation.sourceTaskId) || !taskIds.has(relation.targetTaskId)) {
        context.addIssue({
          code: "custom",
          message: "Relation endpoints must be present in the export.",
          path: ["relations", index],
          input: relation,
        });
      }
    }
  });
export type HelmProjectExportV1 = z.infer<typeof helmProjectExportV1Schema>;
export const helmProjectExportSchema = helmProjectExportV1Schema;
export type HelmProjectExport = HelmProjectExportV1;

export const exportProjectInputSchema = z.strictObject({ projectId: opaqueIdSchema });
export type ExportProjectInput = z.infer<typeof exportProjectInputSchema>;

export const exportProjectMarkdownInputSchema = z.strictObject({
  projectId: opaqueIdSchema,
  savedViewId: opaqueIdSchema.nullable().optional().default(null),
});
export type ExportProjectMarkdownInput = z.infer<typeof exportProjectMarkdownInputSchema>;

export const projectImportSourceSchema = z.discriminatedUnion("format", [
  z.strictObject({ format: z.literal("json"), content: z.string().min(1) }),
  z.strictObject({ format: z.literal("csv"), content: z.string().min(1) }),
]);
export type ProjectImportSource = z.infer<typeof projectImportSourceSchema>;

export const previewProjectImportInputSchema = z
  .strictObject({
    source: projectImportSourceSchema,
    targetProjectId: opaqueIdSchema.nullable(),
    repositoryRoot: z.string().trim().min(1).max(4_096).optional(),
    reason: reasonSchema,
  })
  .superRefine((input, context) => {
    if (input.targetProjectId === null && input.repositoryRoot === undefined) {
      context.addIssue({
        code: "custom",
        message: "A repository root is required when importing as a new project.",
        path: ["repositoryRoot"],
        input: input.repositoryRoot,
      });
    }
  });
export type PreviewProjectImportInput = z.infer<typeof previewProjectImportInputSchema>;

export const projectImportPreviewTokenSchema = z
  .string()
  .regex(
    new RegExp(`^${PROJECT_IMPORT_PREVIEW_TOKEN_PREFIX}:[a-f0-9]{64}:[a-f0-9]{64}$`),
    "Use the deterministic import-preview token returned by Helm.",
  );
export type ProjectImportPreviewToken = z.infer<typeof projectImportPreviewTokenSchema>;

export function createProjectImportPreviewToken(sourceHash: string, targetStateHash: string) {
  const source = hashSchema.parse(sourceHash);
  const target = hashSchema.parse(targetStateHash);
  return projectImportPreviewTokenSchema.parse(
    `${PROJECT_IMPORT_PREVIEW_TOKEN_PREFIX}:${source}:${target}`,
  );
}

export const executeProjectImportInputSchema = z
  .strictObject({
    source: projectImportSourceSchema,
    targetProjectId: opaqueIdSchema.nullable(),
    repositoryRoot: z.string().trim().min(1).max(4_096).optional(),
    reason: reasonSchema,
    previewToken: projectImportPreviewTokenSchema,
    idempotencyKey: idempotencyKeySchema,
  })
  .superRefine((input, context) => {
    if (input.targetProjectId === null && input.repositoryRoot === undefined) {
      context.addIssue({
        code: "custom",
        message: "A repository root is required when importing as a new project.",
        path: ["repositoryRoot"],
        input: input.repositoryRoot,
      });
    }
  });
export type ExecuteProjectImportInput = z.infer<typeof executeProjectImportInputSchema>;

export const projectImportEntityTypeSchema = z.enum([
  "project",
  "tag",
  "custom_field_definition",
  "task",
  "task_relation",
  "saved_view",
  "agent_profile",
  "agent_run",
  "attempt",
  "activity_entry",
  "manual_blocker",
]);
export type ProjectImportEntityType = z.infer<typeof projectImportEntityTypeSchema>;

export const projectImportChangeSchema = z.strictObject({
  entityType: projectImportEntityTypeSchema,
  sourceId: opaqueIdSchema,
  targetId: opaqueIdSchema.nullable(),
  message: z.string().trim().min(1).max(2_000),
});
export type ProjectImportChange = z.infer<typeof projectImportChangeSchema>;

const diagnosticFields = {
  code: z
    .string()
    .trim()
    .min(1)
    .max(100)
    .regex(/^[a-z][a-z0-9_]*$/),
  message: z.string().trim().min(1).max(2_000),
  entityType: projectImportEntityTypeSchema.nullable(),
  sourceId: opaqueIdSchema.nullable(),
  targetId: opaqueIdSchema.nullable(),
  path: z.array(z.union([z.string(), z.number().int().nonnegative()])).max(30),
};

export const projectImportConflictSchema = z.strictObject({
  category: z.literal("conflict"),
  ...diagnosticFields,
});
export type ProjectImportConflict = z.infer<typeof projectImportConflictSchema>;

export const projectImportUnsupportedSchema = z.strictObject({
  category: z.literal("unsupported"),
  ...diagnosticFields,
});
export type ProjectImportUnsupported = z.infer<typeof projectImportUnsupportedSchema>;

const importOutcomeFields = {
  sourceFormat: z.enum(["json", "csv"]),
  sourceProjectId: opaqueIdSchema.nullable(),
  targetProjectId: opaqueIdSchema.nullable(),
  creates: z.array(projectImportChangeSchema),
  updates: z.array(projectImportChangeSchema),
  noOps: z.array(projectImportChangeSchema),
  conflicts: z.array(projectImportConflictSchema),
  unsupported: z.array(projectImportUnsupportedSchema),
};

export const projectImportPreviewSchema = z
  .strictObject({
    format: z.literal("helm-project-import-preview"),
    schemaVersion: z.literal(1),
    ...importOutcomeFields,
    executable: z.boolean(),
    previewToken: projectImportPreviewTokenSchema,
  })
  .superRefine((preview, context) => {
    const expected = preview.conflicts.length === 0 && preview.unsupported.length === 0;
    if (preview.executable !== expected) {
      context.addIssue({
        code: "custom",
        message: "A preview is executable exactly when it has no conflicts or unsupported data.",
        path: ["executable"],
        input: preview.executable,
      });
    }
  });
export type ProjectImportPreview = z.infer<typeof projectImportPreviewSchema>;

export const projectImportExecutionResultSchema = z
  .strictObject({
    format: z.literal("helm-project-import-result"),
    schemaVersion: z.literal(1),
    ...importOutcomeFields,
    executed: z.boolean(),
    operationId: opaqueIdSchema.nullable(),
    eventCursors: z.array(z.number().int().positive()),
  })
  .superRefine((result, context) => {
    if (result.executed && (result.conflicts.length > 0 || result.unsupported.length > 0)) {
      context.addIssue({
        code: "custom",
        message: "An executed import cannot contain blocking diagnostics.",
        path: ["executed"],
        input: result.executed,
      });
    }
    if (!result.executed && result.eventCursors.length > 0) {
      context.addIssue({
        code: "custom",
        message: "A rejected import cannot append events.",
        path: ["eventCursors"],
        input: result.eventCursors,
      });
    }
  });
export type ProjectImportExecutionResult = z.infer<typeof projectImportExecutionResultSchema>;

function rendered(value: unknown) {
  return JSON.stringify(value) ?? String(value);
}

export class UnsupportedProjectExportFormatError extends TypeError {
  readonly name = "UnsupportedProjectExportFormatError";
  constructor(readonly receivedFormat: unknown) {
    super(`Unsupported project export format: ${rendered(receivedFormat)}.`);
  }
}

export class UnsupportedProjectExportSchemaVersionError extends TypeError {
  readonly name = "UnsupportedProjectExportSchemaVersionError";
  constructor(readonly receivedVersion: unknown) {
    super(`Unsupported project export schema version: ${rendered(receivedVersion)}.`);
  }
}

function envelopeField(input: unknown, field: "format" | "schemaVersion") {
  return typeof input === "object" && input !== null ? Reflect.get(input, field) : undefined;
}

export function assertSupportedHelmProjectExportEnvelope(input: unknown): void {
  const format = envelopeField(input, "format");
  if (format !== HELM_PROJECT_EXPORT_FORMAT) throw new UnsupportedProjectExportFormatError(format);
  const version = envelopeField(input, "schemaVersion");
  if (version !== HELM_PROJECT_EXPORT_SCHEMA_VERSION) {
    throw new UnsupportedProjectExportSchemaVersionError(version);
  }
}

export function parseHelmProjectExport(input: unknown): HelmProjectExportV1 {
  assertSupportedHelmProjectExportEnvelope(input);
  return helmProjectExportV1Schema.parse(input);
}

function compareText(left: string, right: string) {
  return left < right ? -1 : left > right ? 1 : 0;
}

export function canonicalizeHelmProjectExport(input: unknown): HelmProjectExportV1 {
  const artifact = parseHelmProjectExport(input);
  return helmProjectExportV1Schema.parse({
    ...artifact,
    tags: artifact.tags.toSorted(
      (left, right) => compareText(left.name, right.name) || compareText(left.id, right.id),
    ),
    customFieldDefinitions: artifact.customFieldDefinitions.toSorted(
      (left, right) => left.position - right.position || compareText(left.id, right.id),
    ),
    tasks: artifact.tasks
      .map((task) => ({
        ...task,
        tagIds: task.tagIds.toSorted(compareText),
        customFieldValues: task.customFieldValues.toSorted((left, right) =>
          compareText(left.fieldId, right.fieldId),
        ),
        requiredCapabilities: task.requiredCapabilities.toSorted(compareText),
        referencedPaths: task.referencedPaths.toSorted(compareText),
      }))
      .toSorted((left, right) => left.sequence - right.sequence || compareText(left.id, right.id)),
    relations: artifact.relations.toSorted(
      (left, right) =>
        compareText(left.createdAt, right.createdAt) || compareText(left.id, right.id),
    ),
    savedViews: artifact.savedViews.toSorted(
      (left, right) => left.sequence - right.sequence || compareText(left.id, right.id),
    ),
    agentProfiles: artifact.agentProfiles.toSorted(
      (left, right) =>
        compareText(left.profileKey, right.profileKey) || compareText(left.id, right.id),
    ),
    agentRuns: artifact.agentRuns.toSorted(
      (left, right) =>
        compareText(left.createdAt, right.createdAt) || compareText(left.id, right.id),
    ),
    attempts: artifact.attempts.toSorted(
      (left, right) =>
        compareText(left.taskId, right.taskId) ||
        left.attemptNumber - right.attemptNumber ||
        compareText(left.id, right.id),
    ),
    activityEntries: artifact.activityEntries.toSorted(
      (left, right) =>
        compareText(left.createdAt, right.createdAt) || compareText(left.id, right.id),
    ),
    manualBlockers: artifact.manualBlockers.toSorted(
      (left, right) =>
        compareText(left.createdAt, right.createdAt) || compareText(left.id, right.id),
    ),
    sourceEvents: artifact.sourceEvents.toSorted(
      (left, right) => left.sourceCursor - right.sourceCursor,
    ),
  });
}

function canonicalJsonValue(value: unknown): unknown {
  if (value === null || typeof value === "string" || typeof value === "boolean") return value;
  if (typeof value === "number") {
    if (!Number.isFinite(value))
      throw new TypeError("Canonical JSON only supports finite numbers.");
    return value;
  }
  if (Array.isArray(value)) return value.map(canonicalJsonValue);
  if (typeof value === "object" && value !== null) {
    return Object.fromEntries(
      Object.entries(value)
        .toSorted(([left], [right]) => compareText(left, right))
        .map(([key, child]) => [key, canonicalJsonValue(child)]),
    );
  }
  throw new TypeError("Canonical JSON only supports JSON values.");
}

export function stablePortabilityJson(value: unknown) {
  return JSON.stringify(canonicalJsonValue(value));
}

export function canonicalHelmProjectExportJson(input: unknown) {
  return stablePortabilityJson(canonicalizeHelmProjectExport(input));
}

export function parseHelmProjectExportJson(content: string) {
  return parseHelmProjectExport(JSON.parse(content) as unknown);
}

export const compiledHelmProjectExportSchema = z.compile(helmProjectExportSchema);
export const compiledExportProjectInputSchema = z.compile(exportProjectInputSchema);
export const compiledExportProjectMarkdownInputSchema = z.compile(exportProjectMarkdownInputSchema);
export const compiledPreviewProjectImportInputSchema = z.compile(previewProjectImportInputSchema);
export const compiledExecuteProjectImportInputSchema = z.compile(executeProjectImportInputSchema);
export const compiledProjectImportPreviewSchema = z.compile(projectImportPreviewSchema);
export const compiledProjectImportExecutionResultSchema = z.compile(
  projectImportExecutionResultSchema,
);
