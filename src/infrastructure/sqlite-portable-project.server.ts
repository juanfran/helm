import { createHash, randomUUID } from "node:crypto";
import { lstatSync, realpathSync, statSync } from "node:fs";

import Database from "better-sqlite3";
import { and, asc, eq } from "drizzle-orm";
import { drizzle } from "drizzle-orm/better-sqlite3";
import type { ZodIssue, ZodType } from "zod";

import type { PortabilityExportContext } from "../application/portability";
import {
  InvalidPortabilityInputError,
  PortabilityAuthorizationError,
  PortabilityConflictError,
  PortabilityIdempotencyConflictError,
  PortabilityNotFoundError,
  PortabilityPreviewStaleError,
  UnsupportedPortabilityVersionError,
  type PortabilityConflict,
} from "../application/portability-errors";
import {
  eventChangeHintsSchema,
  normalizeEventChangeHints,
  type ActivityActor,
} from "../domain/activity";
import {
  MAX_CUSTOM_FIELD_DEFINITIONS,
  customFieldDefinitionSchema,
  validateCustomFieldValue,
} from "../domain/customization";
import {
  HELM_PROJECT_EXPORT_FORMAT,
  HELM_PROJECT_EXPORT_LIMITS,
  HELM_PROJECT_EXPORT_SCHEMA_VERSION,
  UnsupportedProjectExportFormatError,
  UnsupportedProjectExportSchemaVersionError,
  assertSupportedHelmProjectExportEnvelope,
  canonicalizeHelmProjectExport,
  createProjectImportPreviewToken,
  exportedActivityEntrySchema,
  exportedAgentProfileSchema,
  exportedAgentRunSchema,
  exportedAttemptSchema,
  exportedManualBlockerSchema,
  exportedProjectSchema,
  exportedTagSchema,
  exportedTaskRelationSchema,
  exportedTaskSchema,
  projectImportExecutionResultSchema,
  projectImportPreviewSchema,
  sourceEventProvenanceSchema,
  stablePortabilityJson,
  type ExecuteProjectImportInput,
  type ExportProjectInput,
  type HelmProjectExport,
  type PreviewProjectImportInput,
  type ProjectImportChange,
  type ProjectImportConflict,
  type ProjectImportEntityType,
  type ProjectImportExecutionResult,
  type ProjectImportPreview,
  type ProjectImportUnsupported,
} from "../domain/portability";
import { richTextDocumentSchema, richTextToPlainText } from "../domain/rich-text";
import { migrateSavedViewDefinition, savedViewSchema } from "../domain/saved-views";
import {
  duplicateExclusiveTagGroups,
  missingReadyPreparation,
  normalizeCapabilities,
  type Actor,
} from "../domain/tasks";
import {
  activityEntries,
  agentProfiles,
  agentRuns,
  attempts,
  customFieldDefinitions,
  events,
  idempotencyRecords,
  leases,
  manualBlockers,
  preferences,
  projects,
  savedViews,
  schema,
  tags,
  taskCapabilityRequirements,
  taskCustomFieldValues,
  taskReferencedPaths,
  taskRelations,
  tasks,
  taskTags,
} from "../db/schema";
import {
  ProjectPathEscapeError,
  ProjectPathValidationError,
  validateProjectReferencedPaths,
} from "./project-instructions.server";

const PREFERENCES_ID = 1;
const IMPORT_EVENT_BATCH_SIZE = 200;
const PROJECT_IMPORT_COMMAND = "project.import.execute";
const MAX_UNKNOWN_JSON_FIELDS = 1_000;
const SQLITE_INSERT_BATCH_SIZE = 25;

function parseJson(value: string): unknown {
  return JSON.parse(value);
}

function sha256(value: string) {
  return createHash("sha256").update(value).digest("hex");
}

function mapById<T extends { readonly id: string }>(rows: readonly T[]) {
  return new Map(rows.map((row) => [row.id, row]));
}

function idsOf(values: readonly { readonly id: string }[] | undefined) {
  return new Set((values ?? []).map(({ id }) => id));
}

function groupBy<T>(rows: readonly T[], key: (row: T) => string) {
  const groups = new Map<string, T[]>();
  for (const row of rows) {
    const groupKey = key(row);
    const group = groups.get(groupKey);
    if (group) group.push(row);
    else groups.set(groupKey, [row]);
  }
  return groups;
}

function indexBy<T>(rows: readonly T[], key: (row: T) => string) {
  const index = new Map<string, T>();
  for (const row of rows) {
    const rowKey = key(row);
    if (!index.has(rowKey)) index.set(rowKey, row);
  }
  return index;
}

function loadPortableState(database: Database.Database) {
  const db = drizzle(database, { schema });
  const projectRows = db.select().from(projects).orderBy(asc(projects.sequence)).all();
  const savedViewRows = db.select().from(savedViews).all();
  const customFieldRows = db.select().from(customFieldDefinitions).all();
  const taskRows = db.select().from(tasks).all();
  const taskCustomFieldRows = db.select().from(taskCustomFieldValues).all();
  const relationRows = db.select().from(taskRelations).all();
  const tagRows = db.select().from(tags).all();
  const taskTagRows = db.select().from(taskTags).all();
  const capabilityRows = db.select().from(taskCapabilityRequirements).all();
  const referencedPathRows = db.select().from(taskReferencedPaths).all();
  const profileRows = db.select().from(agentProfiles).all();
  const runRows = db.select().from(agentRuns).all();
  const attemptRows = db.select().from(attempts).all();
  const leaseRows = db.select().from(leases).all();
  const activityRows = db.select().from(activityEntries).all();
  const blockerRows = db.select().from(manualBlockers).all();
  const eventRows = db.select().from(events).orderBy(asc(events.cursor)).all();

  return {
    projects: projectRows,
    projectsById: mapById(projectRows),
    savedViews: savedViewRows,
    savedViewsById: mapById(savedViewRows),
    customFields: customFieldRows,
    customFieldsById: mapById(customFieldRows),
    tasks: taskRows,
    tasksById: mapById(taskRows),
    taskCustomFieldsByTask: groupBy(taskCustomFieldRows, (row) => row.taskId),
    relations: relationRows,
    relationsById: mapById(relationRows),
    tags: tagRows,
    tagsById: mapById(tagRows),
    taskTagsByTask: groupBy(taskTagRows, (row) => row.taskId),
    capabilitiesByTask: groupBy(capabilityRows, (row) => row.taskId),
    referencedPathsByTask: groupBy(referencedPathRows, (row) => row.taskId),
    profiles: profileRows,
    profilesById: mapById(profileRows),
    runs: runRows,
    runsById: mapById(runRows),
    attempts: attemptRows,
    attemptsById: mapById(attemptRows),
    leases: leaseRows,
    activityEntries: activityRows,
    activityEntriesById: mapById(activityRows),
    blockers: blockerRows,
    blockersById: mapById(blockerRows),
    events: eventRows,
  };
}

type PortableState = ReturnType<typeof loadPortableState>;
type ProjectRow = PortableState["projects"][number];
type SavedViewRow = PortableState["savedViews"][number];
type CustomFieldRow = PortableState["customFields"][number];
type TaskRow = PortableState["tasks"][number];
type RelationRow = PortableState["relations"][number];
type TagRow = PortableState["tags"][number];
type ProfileRow = PortableState["profiles"][number];
type RunRow = PortableState["runs"][number];
type AttemptRow = PortableState["attempts"][number];
type ActivityRow = PortableState["activityEntries"][number];
type BlockerRow = PortableState["blockers"][number];

type ExistingProjectRepositorySnapshot =
  | {
      readonly status: "trusted" | "untrusted";
      readonly canonicalRoot: string;
      readonly device: string;
      readonly inode: string;
    }
  | {
      readonly status: "unavailable";
      readonly errorCode: string;
    };

function filesystemErrorCode(error: unknown) {
  if (typeof error !== "object" || error === null || !("code" in error)) return "unknown";
  const code = Reflect.get(error, "code");
  return typeof code === "string" ? code : "unknown";
}

function existingProjectRepositorySnapshot(
  state: PortableState,
  targetProjectId: string | null,
): ExistingProjectRepositorySnapshot | null {
  if (targetProjectId === null) return null;
  const project = state.projectsById.get(targetProjectId);
  if (!project) return null;
  try {
    const entry = lstatSync(project.repositoryRoot);
    const canonicalRoot = realpathSync(project.repositoryRoot);
    const resolved = statSync(canonicalRoot);
    return {
      status:
        entry.isDirectory() && resolved.isDirectory() && canonicalRoot === project.repositoryRoot
          ? "trusted"
          : "untrusted",
      canonicalRoot,
      device: String(resolved.dev),
      inode: String(resolved.ino),
    };
  } catch (error) {
    return { status: "unavailable", errorCode: filesystemErrorCode(error) };
  }
}

function portableProject(row: ProjectRow) {
  return {
    id: row.id,
    sequence: row.sequence,
    name: row.name,
    repositoryRoot: row.repositoryRoot,
    reviewMode: row.reviewMode,
    version: row.version,
    createdAt: row.createdAt,
    updatedAt: row.updatedAt,
  };
}

function portableTag(row: TagRow) {
  return {
    id: row.id,
    projectId: row.projectId,
    name: row.name,
    description: row.description,
    color: row.color,
    exclusiveGroup: row.exclusiveGroup,
    reviewModeOverride: row.reviewModeOverride,
    createdAt: row.createdAt,
    updatedAt: row.updatedAt,
  };
}

function portableCustomField(row: CustomFieldRow) {
  return customFieldDefinitionSchema.parse({
    id: row.id,
    projectId: row.projectId,
    key: row.fieldKey,
    type: row.type,
    validation: parseJson(row.validationJson),
    defaultValue: row.defaultValueJson === null ? null : parseJson(row.defaultValueJson),
    display: { label: row.displayLabel, description: row.description },
    position: row.position,
    retiredAt: row.retiredAt,
    createdAt: row.createdAt,
    updatedAt: row.updatedAt,
  });
}

function portableTask(state: PortableState, row: TaskRow) {
  return {
    id: row.id,
    projectId: row.projectId,
    sequence: row.sequence,
    parentTaskId: row.parentTaskId,
    title: row.title,
    lifecycle: row.lifecycle,
    priority: row.priority,
    position: row.position,
    notBefore: row.notBefore,
    dueAt: row.dueAt,
    size: row.size,
    description: richTextDocumentSchema.parse(parseJson(row.descriptionJson)),
    expectedOutcome: row.expectedOutcome,
    acceptanceCriteria: row.acceptanceCriteria,
    agentContext: row.agentContext,
    checklist: parseJson(row.checklistJson),
    reviewModeOverride: row.reviewModeOverride,
    reviewAttemptId: row.reviewAttemptId,
    cancelledFromLifecycle: row.cancelledFromLifecycle,
    version: row.version,
    archivedAt: row.archivedAt,
    createdAt: row.createdAt,
    updatedAt: row.updatedAt,
    tagIds: (state.taskTagsByTask.get(row.id) ?? []).map(({ tagId }) => tagId),
    customFieldValues: (state.taskCustomFieldsByTask.get(row.id) ?? []).map((value) => ({
      fieldId: value.definitionId,
      value: parseJson(value.valueJson),
      updatedAt: value.updatedAt,
    })),
    requiredCapabilities: normalizeCapabilities(
      (state.capabilitiesByTask.get(row.id) ?? []).map(({ capability }) => capability),
    ),
    referencedPaths: (state.referencedPathsByTask.get(row.id) ?? []).map(({ path }) => path),
  };
}

function portableRelation(row: RelationRow) {
  return {
    id: row.id,
    projectId: row.projectId,
    sourceTaskId: row.sourceTaskId,
    targetTaskId: row.targetTaskId,
    type: row.type,
    createdAt: row.createdAt,
  };
}

function portableSavedView(row: SavedViewRow) {
  return {
    id: row.id,
    projectId: row.projectId,
    sequence: row.sequence,
    name: row.name,
    definition: migrateSavedViewDefinition(parseJson(row.definitionJson)),
    version: row.version,
    archivedAt: row.archivedAt,
    createdAt: row.createdAt,
    updatedAt: row.updatedAt,
  };
}

function portableProfile(row: ProfileRow) {
  const storedCapabilities = parseJson(row.capabilitiesJson);
  return {
    id: row.id,
    profileKey: row.profileKey,
    displayName: row.displayName,
    capabilities: normalizeCapabilities(
      Array.isArray(storedCapabilities)
        ? storedCapabilities.filter((value): value is string => typeof value === "string")
        : [],
    ),
    createdAt: row.createdAt,
    updatedAt: row.updatedAt,
  };
}

function portableRun(row: RunRow, exportedAt: string) {
  return {
    id: row.id,
    profileId: row.profileId,
    sourceStatus: row.status,
    status: "closed" as const,
    clientName: row.clientName,
    clientVersion: row.clientVersion,
    createdAt: row.createdAt,
    lastSeenAt: row.lastSeenAt,
    endedAt: row.endedAt ?? exportedAt,
  };
}

function normalizedVerificationResults(value: string) {
  const parsed = parseJson(value);
  if (!Array.isArray(parsed)) return [];
  return parsed.map((result) =>
    typeof result === "string"
      ? {
          name: result,
          status: "not_run" as const,
          details: "Imported from a legacy verification note.",
        }
      : result,
  );
}

function portableAttempt(row: AttemptRow) {
  return {
    id: row.id,
    taskId: row.taskId,
    attemptNumber: row.attemptNumber,
    agentRunId: row.agentRunId,
    agentProfileId: row.agentProfileId,
    agentDisplayName: row.agentDisplayName,
    status: row.status,
    summary: row.summary,
    changedAreas: parseJson(row.changedAreasJson),
    verificationResults: normalizedVerificationResults(row.verificationJson),
    references: parseJson(row.referencesJson),
    risks: parseJson(row.risksJson),
    followUpWork: parseJson(row.followUpWorkJson),
    failureClassification: row.failureClassification,
    createdAt: row.createdAt,
    completedAt: row.completedAt,
  };
}

function actor(type: ActivityActor["type"], id: string): ActivityActor {
  return { type, id };
}

function portableActivityEntry(row: ActivityRow) {
  return {
    id: row.id,
    projectId: row.projectId,
    taskId: row.taskId,
    attemptId: row.attemptId,
    kind: row.kind,
    author: actor(row.authorType, row.authorId),
    authorDisplayName: row.authorDisplayName,
    agentProfileId: row.agentProfileId,
    agentRunId: row.agentRunId,
    content: richTextDocumentSchema.parse(parseJson(row.contentJson)),
    contentText: row.contentText,
    createdAt: row.createdAt,
    withdrawnAt: row.withdrawnAt,
    withdrawnBy:
      row.withdrawnByType === null || row.withdrawnById === null
        ? null
        : actor(row.withdrawnByType, row.withdrawnById),
    withdrawalReason: row.withdrawalReason,
  };
}

function portableBlocker(row: BlockerRow) {
  return {
    id: row.id,
    projectId: row.projectId,
    taskId: row.taskId,
    reason: row.reason,
    status: row.status,
    createdBy: actor(row.createdByType, row.createdById),
    createdAt: row.createdAt,
    resolvedBy:
      row.resolvedByType === null || row.resolvedById === null
        ? null
        : actor(row.resolvedByType, row.resolvedById),
    resolvedAt: row.resolvedAt,
    resolution: row.resolution,
  };
}

function readProjectFromState(
  state: PortableState,
  projectId: string,
  exportedAt: string,
): HelmProjectExport {
  const projectRow = state.projectsById.get(projectId);
  if (!projectRow) {
    throw new PortabilityNotFoundError({
      entityType: "project",
      entityId: projectId,
      message: "The project does not exist.",
    });
  }

  const projectTasks = state.tasks.filter((row) => row.projectId === projectId);
  const taskIds = new Set(projectTasks.map(({ id }) => id));
  const projectAttempts = state.attempts.filter((row) => taskIds.has(row.taskId));
  const projectActivity = state.activityEntries.filter((row) => row.projectId === projectId);
  const projectEvents = state.events
    .filter((row) => row.projectId === projectId)
    .map((row) => ({
      sourceCursor: row.cursor,
      projectId,
      kind: row.kind,
      importance: row.importance,
      actor: actor(row.actorType, row.actorId),
      entity: { type: row.entityType, id: row.entityId },
      payload: parseJson(row.payloadJson),
      changes: normalizeEventChangeHints(eventChangeHintsSchema.parse(parseJson(row.changesJson))),
      occurredAt: row.occurredAt,
    }));
  const runIds = new Set([
    ...[...projectAttempts, ...projectActivity]
      .map(({ agentRunId }) => agentRunId)
      .filter((id): id is string => id !== null),
    ...projectEvents.flatMap((event) => [
      ...(event.actor.type === "agent" ? [event.actor.id] : []),
      ...event.changes.agentRunIds,
    ]),
  ]);
  const projectRuns = state.runs.filter((row) => runIds.has(row.id));
  const profileIds = new Set(
    [
      ...projectRuns.map(({ profileId }) => profileId),
      ...projectAttempts.map(({ agentProfileId }) => agentProfileId),
      ...projectActivity.map(({ agentProfileId }) => agentProfileId),
    ].filter((id): id is string => id !== null),
  );

  return canonicalizeHelmProjectExport({
    format: HELM_PROJECT_EXPORT_FORMAT,
    schemaVersion: HELM_PROJECT_EXPORT_SCHEMA_VERSION,
    exportedAt,
    project: portableProject(projectRow),
    tags: state.tags.filter((row) => row.projectId === projectId).map(portableTag),
    customFieldDefinitions: state.customFields
      .filter((row) => row.projectId === projectId)
      .map(portableCustomField),
    tasks: projectTasks.map((row) => portableTask(state, row)),
    relations: state.relations.filter((row) => row.projectId === projectId).map(portableRelation),
    savedViews: state.savedViews
      .filter((row) => row.projectId === projectId)
      .map(portableSavedView),
    agentProfiles: state.profiles.filter((row) => profileIds.has(row.id)).map(portableProfile),
    agentRuns: projectRuns.map((row) => portableRun(row, exportedAt)),
    attempts: projectAttempts.map(portableAttempt),
    activityEntries: projectActivity.map(portableActivityEntry),
    manualBlockers: state.blockers
      .filter((row) => row.projectId === projectId)
      .map(portableBlocker),
    sourceEvents: projectEvents,
  });
}

export function exportSqliteProject(
  database: Database.Database,
  input: ExportProjectInput,
  context: PortabilityExportContext,
): HelmProjectExport {
  return database
    .transaction(() => {
      const artifact = readProjectFromState(
        loadPortableState(database),
        input.projectId,
        context.now,
      );
      assertBoundedProjectExport(artifact, "export");
      assertJsonProjectSize(stablePortabilityJson(artifact), "export", 1);
      return artifact;
    })
    .deferred();
}

function targetStateHash(
  state: PortableState,
  input: Pick<PreviewProjectImportInput, "targetProjectId" | "repositoryRoot">,
  artifact: HelmProjectExport | null,
  repositorySnapshot: ExistingProjectRepositorySnapshot | null,
) {
  const projectId = artifact?.project.id ?? input.targetProjectId;
  const taskIds = idsOf(artifact?.tasks);
  const savedViewIds = idsOf(artifact?.savedViews);
  const customFieldIds = idsOf(artifact?.customFieldDefinitions);
  const relationIds = idsOf(artifact?.relations);
  const tagIds = idsOf(artifact?.tags);
  const profileIds = idsOf(artifact?.agentProfiles);
  const profileKeys = new Set(artifact?.agentProfiles.map(({ profileKey }) => profileKey) ?? []);
  const runIds = idsOf(artifact?.agentRuns);
  const attemptIds = idsOf(artifact?.attempts);
  const activityIds = idsOf(artifact?.activityEntries);
  const blockerIds = idsOf(artifact?.manualBlockers);
  const relevantTasks = state.tasks.filter(
    (row) => row.projectId === projectId || taskIds.has(row.id),
  );
  const relevantAttempts = state.attempts.filter(
    (row) => taskIds.has(row.taskId) || attemptIds.has(row.id),
  );
  const relevantRuns = state.runs.filter((row) => runIds.has(row.id));
  const selectors = {
    targetProjectId: input.targetProjectId,
    ...(input.repositoryRoot === undefined ? {} : { repositoryRoot: input.repositoryRoot }),
  };
  const scopedState = {
    targetRepository: repositorySnapshot,
    projects: state.projects.map((row) =>
      row.id === projectId
        ? row
        : {
            id: row.id,
            sequence: row.sequence,
            repositoryRoot: row.repositoryRoot,
          },
    ),
    savedViews: state.savedViews
      .filter((row) => row.projectId === projectId || savedViewIds.has(row.id))
      .map((row) =>
        savedViewIds.has(row.id)
          ? row
          : {
              id: row.id,
              projectId: row.projectId,
              sequence: row.sequence,
              name: row.name,
              archivedAt: row.archivedAt,
            },
      ),
    customFields: state.customFields
      .filter((row) => row.projectId === projectId || customFieldIds.has(row.id))
      .map((row) =>
        customFieldIds.has(row.id)
          ? row
          : {
              id: row.id,
              projectId: row.projectId,
              fieldKey: row.fieldKey,
              position: row.position,
            },
      ),
    tasks: relevantTasks.map((row) =>
      taskIds.has(row.id) ? row : { id: row.id, projectId: row.projectId, sequence: row.sequence },
    ),
    taskCustomFields: [...taskIds].flatMap(
      (taskId) => state.taskCustomFieldsByTask.get(taskId) ?? [],
    ),
    relations: state.relations
      .filter((row) => row.projectId === projectId || relationIds.has(row.id))
      .map((row) =>
        relationIds.has(row.id)
          ? row
          : {
              id: row.id,
              projectId: row.projectId,
              sourceTaskId: row.sourceTaskId,
              targetTaskId: row.targetTaskId,
              type: row.type,
            },
      ),
    tags: state.tags
      .filter((row) => row.projectId === projectId || tagIds.has(row.id))
      .map((row) =>
        tagIds.has(row.id) ? row : { id: row.id, projectId: row.projectId, name: row.name },
      ),
    taskTags: [...taskIds].flatMap((taskId) => state.taskTagsByTask.get(taskId) ?? []),
    taskCapabilities: [...taskIds].flatMap((taskId) => state.capabilitiesByTask.get(taskId) ?? []),
    taskReferencedPaths: [...taskIds].flatMap(
      (taskId) => state.referencedPathsByTask.get(taskId) ?? [],
    ),
    profiles: state.profiles.filter(
      (row) => profileIds.has(row.id) || profileKeys.has(row.profileKey),
    ),
    runs: relevantRuns,
    attempts: relevantAttempts.map((row) =>
      attemptIds.has(row.id)
        ? row
        : {
            id: row.id,
            taskId: row.taskId,
            attemptNumber: row.attemptNumber,
            agentRunId: row.agentRunId,
            status: row.status,
          },
    ),
    leases: state.leases
      .filter((row) => taskIds.has(row.taskId))
      .map(({ id, taskId, status }) => ({ id, taskId, status })),
    activityEntries: state.activityEntries.filter((row) => activityIds.has(row.id)),
    blockers: state.blockers.filter((row) => blockerIds.has(row.id)),
  };
  return sha256(stablePortabilityJson({ selectors, scopedState }));
}

function previewDescriptorHash(input: PreviewProjectImportInput) {
  return sha256(
    stablePortabilityJson({
      source: input.source,
      targetProjectId: input.targetProjectId,
      ...(input.repositoryRoot === undefined ? {} : { repositoryRoot: input.repositoryRoot }),
      reason: input.reason,
    }),
  );
}

function assertLocalHuman(actorValue: Actor) {
  if (actorValue.type !== "human") {
    throw new PortabilityAuthorizationError({
      message: "Only the local human can import project data.",
    });
  }
}

const boundedProjectExportCollections = [
  "tags",
  "customFieldDefinitions",
  "tasks",
  "relations",
  "savedViews",
  "agentProfiles",
  "agentRuns",
  "attempts",
  "activityEntries",
  "manualBlockers",
  "sourceEvents",
] as const;

type ProjectLimitBoundary = "import" | "export";

function projectLimitMessage(boundary: ProjectLimitBoundary) {
  return boundary === "import"
    ? "The JSON source exceeds Helm's project import limits."
    : "The project exceeds Helm's portable JSON export limits.";
}

function assertBoundedProjectExport(input: unknown, boundary: ProjectLimitBoundary = "import") {
  if (typeof input !== "object" || input === null) return;
  for (const collection of boundedProjectExportCollections) {
    const value = Reflect.get(input, collection);
    if (Array.isArray(value) && value.length > HELM_PROJECT_EXPORT_LIMITS.maxTopLevelRecords) {
      throw new InvalidPortabilityInputError({
        message: projectLimitMessage(boundary),
        issues: [
          `${collection} may contain at most ${HELM_PROJECT_EXPORT_LIMITS.maxTopLevelRecords} records.`,
        ],
      });
    }
  }
}

function assertJsonProjectSize(
  content: string,
  boundary: ProjectLimitBoundary,
  additionalBytes = 0,
) {
  const byteLength = Buffer.byteLength(content, "utf8") + additionalBytes;
  if (byteLength <= HELM_PROJECT_EXPORT_LIMITS.maxBytes) return;
  throw new InvalidPortabilityInputError({
    message: projectLimitMessage(boundary),
    issues: [
      `Portable JSON may contain at most ${HELM_PROJECT_EXPORT_LIMITS.maxBytes} bytes${
        boundary === "export" ? " including the download's trailing newline" : ""
      }.`,
    ],
  });
}

type ParsedJsonImportSource = {
  readonly artifact: HelmProjectExport;
  readonly unsupported: readonly ProjectImportUnsupported[];
};

function jsonObjectAtPath(value: unknown, path: readonly (string | number)[]) {
  let current = value;
  for (const segment of path) {
    if (typeof current !== "object" || current === null) return null;
    current = Reflect.get(current, segment);
  }
  return typeof current === "object" && current !== null ? current : null;
}

function collectionEntityType(collection: string | null): ProjectImportEntityType | null {
  switch (collection) {
    case "project":
      return "project";
    case "tags":
      return "tag";
    case "customFieldDefinitions":
      return "custom_field_definition";
    case "tasks":
      return "task";
    case "relations":
      return "task_relation";
    case "savedViews":
      return "saved_view";
    case "agentProfiles":
      return "agent_profile";
    case "agentRuns":
      return "agent_run";
    case "attempts":
      return "attempt";
    case "activityEntries":
      return "activity_entry";
    case "manualBlockers":
      return "manual_blocker";
    default:
      return null;
  }
}

const portableTopLevelFields = new Set([
  "format",
  "schemaVersion",
  "exportedAt",
  "project",
  "tags",
  "customFieldDefinitions",
  "tasks",
  "relations",
  "savedViews",
  "agentProfiles",
  "agentRuns",
  "attempts",
  "activityEntries",
  "manualBlockers",
  "sourceEvents",
]);

type PortableRecordLocation = {
  readonly path: readonly (string | number)[];
  readonly noun: string;
  readonly entityType: ProjectImportEntityType | null;
};

type PortablePreflightArtifact = Pick<
  HelmProjectExport,
  | "project"
  | "tags"
  | "customFieldDefinitions"
  | "tasks"
  | "relations"
  | "savedViews"
  | "agentProfiles"
  | "agentRuns"
  | "attempts"
  | "activityEntries"
  | "manualBlockers"
  | "sourceEvents"
>;

function portablePathLabel(path: readonly (string | number)[]) {
  return path.reduce(
    (label, segment) =>
      typeof segment === "number"
        ? `${label}[${segment}]`
        : label
          ? `${label}.${segment}`
          : segment,
    "",
  );
}

function invalidPortableRecord(location: PortableRecordLocation): never {
  throw new InvalidPortabilityInputError({
    message: "The JSON source is not a valid Helm project export.",
    issues: [
      `${portablePathLabel(location.path)} is not a valid portable ${location.noun} record.`,
    ],
  });
}

function invalidPortableStructure(path: readonly (string | number)[], message: string): never {
  throw new InvalidPortabilityInputError({
    message: "The JSON source is not a valid Helm project export.",
    issues: [`${portablePathLabel(path)} ${message}`],
  });
}

function appendUnknownJsonField(
  unsupported: ProjectImportUnsupported[],
  target: object,
  key: string,
  fieldPath: readonly (string | number)[],
  entityType: ProjectImportEntityType | null,
  sourceId: string | null,
) {
  if (unsupported.length >= MAX_UNKNOWN_JSON_FIELDS) {
    throw new InvalidPortabilityInputError({
      message: "The JSON source contains too many unsupported fields.",
      issues: [`At most ${MAX_UNKNOWN_JSON_FIELDS} unknown fields can be reported.`],
    });
  }
  if (fieldPath.length > 30) {
    throw new InvalidPortabilityInputError({
      message: "The JSON source contains an unsupported field nested too deeply.",
    });
  }
  unsupported.push({
    category: "unsupported",
    code: "unknown_field",
    message: `Unknown JSON field ${fieldPath.join(".")} is not supported.`,
    entityType,
    sourceId,
    targetId: sourceId,
    path: [...fieldPath],
  });
  Reflect.deleteProperty(target, key);
}

function issuePath(issue: ZodIssue) {
  return issue.path.filter(
    (segment): segment is string | number =>
      typeof segment === "string" || typeof segment === "number",
  );
}

function preflightPortableRecord<T>(
  schemaValue: ZodType<T>,
  value: unknown,
  location: PortableRecordLocation,
  unsupported: ProjectImportUnsupported[],
): T {
  for (;;) {
    const validation = schemaValue.safeParse(value);
    if (validation.success) return validation.data;

    let strippedUnknownField = false;
    for (const issue of validation.error.issues) {
      if (issue.code !== "unrecognized_keys") continue;
      const relativePath = issuePath(issue);
      const target = jsonObjectAtPath(value, relativePath);
      if (!target) continue;
      const sourceIdValue =
        typeof value === "object" && value !== null ? Reflect.get(value, "id") : undefined;
      const sourceId = typeof sourceIdValue === "string" ? sourceIdValue : null;
      for (const key of issue.keys) {
        appendUnknownJsonField(
          unsupported,
          target,
          key,
          [...location.path, ...relativePath, key],
          location.entityType,
          sourceId,
        );
        strippedUnknownField = true;
      }
    }
    if (!strippedUnknownField) invalidPortableRecord(location);
  }
}

function preflightPortableCollection<T>(
  decoded: object,
  collection: string,
  noun: string,
  schemaValue: ZodType<T>,
  unsupported: ProjectImportUnsupported[],
): T[] {
  const value = Reflect.get(decoded, collection);
  if (!Array.isArray(value)) {
    invalidPortableStructure([collection], "must be an array of portable records.");
  }
  const parsed: T[] = [];
  for (const [index, record] of value.entries()) {
    const result = preflightPortableRecord(
      schemaValue,
      record,
      {
        path: [collection, index],
        noun,
        entityType: collectionEntityType(collection),
      },
      unsupported,
    );
    value[index] = result;
    parsed.push(result);
  }
  return parsed;
}

function assertUniquePortableIds(collection: string, values: readonly { readonly id: string }[]) {
  const ids = new Set<string>();
  for (const [index, value] of values.entries()) {
    if (ids.has(value.id)) {
      invalidPortableStructure([collection, index, "id"], "duplicates an earlier identifier.");
    }
    ids.add(value.id);
  }
}

function assertProjectMembership(
  projectId: string,
  collection: string,
  values: readonly { readonly projectId: string }[],
) {
  for (const [index, value] of values.entries()) {
    if (value.projectId !== projectId) {
      invalidPortableStructure(
        [collection, index, "projectId"],
        "must match the exported project.",
      );
    }
  }
}

function assertPortableCrossRecordStructure(artifact: PortablePreflightArtifact) {
  const projectId = artifact.project.id;
  assertProjectMembership(projectId, "tags", artifact.tags);
  assertProjectMembership(projectId, "customFieldDefinitions", artifact.customFieldDefinitions);
  assertProjectMembership(projectId, "tasks", artifact.tasks);
  assertProjectMembership(projectId, "relations", artifact.relations);
  assertProjectMembership(projectId, "savedViews", artifact.savedViews);
  assertProjectMembership(projectId, "activityEntries", artifact.activityEntries);
  assertProjectMembership(projectId, "manualBlockers", artifact.manualBlockers);
  assertProjectMembership(projectId, "sourceEvents", artifact.sourceEvents);

  for (const [collection, values] of [
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
    assertUniquePortableIds(collection, values);
  }

  const taskIds = new Set(artifact.tasks.map(({ id }) => id));
  const tagIds = new Set(artifact.tags.map(({ id }) => id));
  const definitions = new Map(
    artifact.customFieldDefinitions.map((definition) => [definition.id, definition]),
  );
  for (const [taskIndex, task] of artifact.tasks.entries()) {
    if (task.parentTaskId !== null && !taskIds.has(task.parentTaskId)) {
      invalidPortableStructure(
        ["tasks", taskIndex, "parentTaskId"],
        "references a task outside the archive.",
      );
    }
    for (const [tagIndex, tagId] of task.tagIds.entries()) {
      if (!tagIds.has(tagId)) {
        invalidPortableStructure(
          ["tasks", taskIndex, "tagIds", tagIndex],
          "references a tag outside the archive.",
        );
      }
    }
    for (const [valueIndex, explicit] of task.customFieldValues.entries()) {
      const definition = definitions.get(explicit.fieldId);
      if (!definition) {
        invalidPortableStructure(
          ["tasks", taskIndex, "customFieldValues", valueIndex, "fieldId"],
          "references a custom field outside the archive.",
        );
      }
      if (validateCustomFieldValue(definition, explicit.value).length > 0) {
        invalidPortableStructure(
          ["tasks", taskIndex, "customFieldValues", valueIndex, "value"],
          "does not satisfy its custom-field definition.",
        );
      }
    }
  }
  for (const [index, relation] of artifact.relations.entries()) {
    if (!taskIds.has(relation.sourceTaskId) || !taskIds.has(relation.targetTaskId)) {
      invalidPortableStructure(
        ["relations", index],
        "must reference task endpoints present in the archive.",
      );
    }
  }
}

function preflightAndStripUnknownJsonFields(decoded: unknown): ProjectImportUnsupported[] {
  const object = jsonObjectAtPath(decoded, []);
  if (!object || Array.isArray(object)) {
    throw new InvalidPortabilityInputError({
      message: "The JSON source is not a valid Helm project export.",
    });
  }
  const unsupported: ProjectImportUnsupported[] = [];
  for (const key of Object.keys(object)) {
    if (portableTopLevelFields.has(key)) continue;
    appendUnknownJsonField(unsupported, object, key, [key], null, null);
  }

  const project = preflightPortableRecord(
    exportedProjectSchema,
    Reflect.get(object, "project"),
    { path: ["project"], noun: "project", entityType: "project" },
    unsupported,
  );
  Reflect.set(object, "project", project);
  const artifact: PortablePreflightArtifact = {
    project,
    tags: preflightPortableCollection(object, "tags", "tag", exportedTagSchema, unsupported),
    customFieldDefinitions: preflightPortableCollection(
      object,
      "customFieldDefinitions",
      "custom-field definition",
      customFieldDefinitionSchema,
      unsupported,
    ),
    tasks: preflightPortableCollection(object, "tasks", "task", exportedTaskSchema, unsupported),
    relations: preflightPortableCollection(
      object,
      "relations",
      "task relation",
      exportedTaskRelationSchema,
      unsupported,
    ),
    savedViews: preflightPortableCollection(
      object,
      "savedViews",
      "saved view",
      savedViewSchema,
      unsupported,
    ),
    agentProfiles: preflightPortableCollection(
      object,
      "agentProfiles",
      "agent profile",
      exportedAgentProfileSchema,
      unsupported,
    ),
    agentRuns: preflightPortableCollection(
      object,
      "agentRuns",
      "agent run",
      exportedAgentRunSchema,
      unsupported,
    ),
    attempts: preflightPortableCollection(
      object,
      "attempts",
      "attempt",
      exportedAttemptSchema,
      unsupported,
    ),
    activityEntries: preflightPortableCollection(
      object,
      "activityEntries",
      "activity entry",
      exportedActivityEntrySchema,
      unsupported,
    ),
    manualBlockers: preflightPortableCollection(
      object,
      "manualBlockers",
      "manual blocker",
      exportedManualBlockerSchema,
      unsupported,
    ),
    sourceEvents: preflightPortableCollection(
      object,
      "sourceEvents",
      "source event",
      sourceEventProvenanceSchema,
      unsupported,
    ),
  };
  assertPortableCrossRecordStructure(artifact);
  return unsupported;
}

function parseJsonImportSource(content: string): ParsedJsonImportSource {
  assertJsonProjectSize(content, "import");
  try {
    const decoded: unknown = JSON.parse(content);
    assertSupportedHelmProjectExportEnvelope(decoded);
    assertBoundedProjectExport(decoded);
    const unsupported = preflightAndStripUnknownJsonFields(decoded);
    return { artifact: canonicalizeHelmProjectExport(decoded), unsupported };
  } catch (error) {
    if (error instanceof InvalidPortabilityInputError) throw error;
    if (error instanceof UnsupportedProjectExportSchemaVersionError) {
      throw new UnsupportedPortabilityVersionError({
        receivedVersion: error.receivedVersion,
        message: "The project export schema version is not supported.",
      });
    }
    if (error instanceof UnsupportedProjectExportFormatError) {
      throw new InvalidPortabilityInputError({
        message: "The JSON source is not a Helm project export.",
      });
    }
    throw new InvalidPortabilityInputError({
      message: "The JSON source is not a valid Helm project export.",
    });
  }
}

type ImportEntity = {
  readonly entityType: ProjectImportEntityType;
  readonly sourceId: string;
  readonly value: unknown;
  readonly version: number | null;
};

function importEntities(artifact: HelmProjectExport): ImportEntity[] {
  return [
    {
      entityType: "project",
      sourceId: artifact.project.id,
      value: artifact.project,
      version: artifact.project.version,
    },
    ...artifact.tags.map((value) => ({
      entityType: "tag" as const,
      sourceId: value.id,
      value,
      version: null,
    })),
    ...artifact.customFieldDefinitions.map((value) => ({
      entityType: "custom_field_definition" as const,
      sourceId: value.id,
      value,
      version: null,
    })),
    ...artifact.tasks.map((value) => ({
      entityType: "task" as const,
      sourceId: value.id,
      value,
      version: value.version,
    })),
    ...artifact.relations.map((value) => ({
      entityType: "task_relation" as const,
      sourceId: value.id,
      value,
      version: null,
    })),
    ...artifact.savedViews.map((value) => ({
      entityType: "saved_view" as const,
      sourceId: value.id,
      value,
      version: value.version,
    })),
    ...artifact.agentProfiles.map((value) => ({
      entityType: "agent_profile" as const,
      sourceId: value.id,
      value,
      version: null,
    })),
    ...artifact.agentRuns.map((value) => ({
      entityType: "agent_run" as const,
      sourceId: value.id,
      value,
      version: null,
    })),
    ...artifact.attempts.map((value) => ({
      entityType: "attempt" as const,
      sourceId: value.id,
      value,
      version: null,
    })),
    ...artifact.activityEntries.map((value) => ({
      entityType: "activity_entry" as const,
      sourceId: value.id,
      value,
      version: null,
    })),
    ...artifact.manualBlockers.map((value) => ({
      entityType: "manual_blocker" as const,
      sourceId: value.id,
      value,
      version: null,
    })),
  ];
}

function importEntityKey(entityType: ProjectImportEntityType, sourceId: string) {
  return `${entityType}\u0000${sourceId}`;
}

function importEntityMap(artifact: HelmProjectExport) {
  return new Map(
    importEntities(artifact).map((entity) => [
      importEntityKey(entity.entityType, entity.sourceId),
      entity,
    ]),
  );
}

function existingEntityValue(
  state: PortableState,
  entity: ImportEntity,
  exportedAt: string,
): {
  readonly value: unknown;
  readonly version: number | null;
  readonly projectId: string | null;
} | null {
  switch (entity.entityType) {
    case "project": {
      const row = state.projectsById.get(entity.sourceId);
      return row
        ? {
            value: portableProject(row),
            version: row.version,
            projectId: row.id,
          }
        : null;
    }
    case "tag": {
      const row = state.tagsById.get(entity.sourceId);
      return row ? { value: portableTag(row), version: null, projectId: row.projectId } : null;
    }
    case "custom_field_definition": {
      const row = state.customFieldsById.get(entity.sourceId);
      return row
        ? {
            value: portableCustomField(row),
            version: null,
            projectId: row.projectId,
          }
        : null;
    }
    case "task": {
      const row = state.tasksById.get(entity.sourceId);
      return row
        ? {
            value: portableTask(state, row),
            version: row.version,
            projectId: row.projectId,
          }
        : null;
    }
    case "task_relation": {
      const row = state.relationsById.get(entity.sourceId);
      return row
        ? {
            value: portableRelation(row),
            version: null,
            projectId: row.projectId,
          }
        : null;
    }
    case "saved_view": {
      const row = state.savedViewsById.get(entity.sourceId);
      return row
        ? {
            value: portableSavedView(row),
            version: row.version,
            projectId: row.projectId,
          }
        : null;
    }
    case "agent_profile": {
      const row = state.profilesById.get(entity.sourceId);
      return row ? { value: portableProfile(row), version: null, projectId: null } : null;
    }
    case "agent_run": {
      const row = state.runsById.get(entity.sourceId);
      return row
        ? {
            value: portableRun(row, exportedAt),
            version: null,
            projectId: null,
          }
        : null;
    }
    case "attempt": {
      const row = state.attemptsById.get(entity.sourceId);
      return row ? { value: portableAttempt(row), version: null, projectId: null } : null;
    }
    case "activity_entry": {
      const row = state.activityEntriesById.get(entity.sourceId);
      return row
        ? {
            value: portableActivityEntry(row),
            version: null,
            projectId: row.projectId,
          }
        : null;
    }
    case "manual_blocker": {
      const row = state.blockersById.get(entity.sourceId);
      return row
        ? {
            value: portableBlocker(row),
            version: null,
            projectId: row.projectId,
          }
        : null;
    }
  }
  return null;
}

function change(entity: ImportEntity, kind: "create" | "update" | "no_op"): ProjectImportChange {
  return {
    entityType: entity.entityType,
    sourceId: entity.sourceId,
    targetId: entity.sourceId,
    message:
      kind === "create"
        ? `Create ${entity.entityType} ${entity.sourceId}.`
        : kind === "update"
          ? `Update ${entity.entityType} ${entity.sourceId} at its matched expected version.`
          : `${entity.entityType} ${entity.sourceId} is already identical.`,
  };
}

function conflict(
  code: string,
  message: string,
  entity: ImportEntity,
  path: readonly (string | number)[] = [],
): ProjectImportConflict {
  return {
    category: "conflict",
    code,
    message,
    entityType: entity.entityType,
    sourceId: entity.sourceId,
    targetId: entity.sourceId,
    path: [...path],
  };
}

function projectIdOf(value: unknown) {
  if (typeof value !== "object" || value === null || !("projectId" in value)) return null;
  const projectId = Reflect.get(value, "projectId");
  return typeof projectId === "string" ? projectId : null;
}

function repositoryRootOf(value: unknown) {
  if (typeof value !== "object" || value === null || !("repositoryRoot" in value)) return null;
  const repositoryRoot = Reflect.get(value, "repositoryRoot");
  return typeof repositoryRoot === "string" ? repositoryRoot : null;
}

function entityField(value: unknown, key: string): unknown {
  return typeof value === "object" && value !== null ? Reflect.get(value, key) : undefined;
}

function immutableEntityValue(entityType: ProjectImportEntityType, value: unknown) {
  switch (entityType) {
    case "project":
      return {
        id: entityField(value, "id"),
        sequence: entityField(value, "sequence"),
        repositoryRoot: entityField(value, "repositoryRoot"),
        createdAt: entityField(value, "createdAt"),
      };
    case "task":
      return {
        id: entityField(value, "id"),
        projectId: entityField(value, "projectId"),
        sequence: entityField(value, "sequence"),
        parentTaskId: entityField(value, "parentTaskId"),
        createdAt: entityField(value, "createdAt"),
      };
    case "saved_view":
      return {
        id: entityField(value, "id"),
        projectId: entityField(value, "projectId"),
        sequence: entityField(value, "sequence"),
        createdAt: entityField(value, "createdAt"),
      };
    default:
      return value;
  }
}

function activeTaskExecutionConflict(
  indexes: ImportAnalysisIndexes,
  entity: ImportEntity,
): ProjectImportConflict | null {
  if (entity.entityType !== "task") return null;
  const taskId = entity.sourceId;
  return indexes.activeTaskIds.has(taskId)
    ? conflict(
        "active_execution_conflict",
        `Task ${taskId} cannot be updated while its local execution state is active.`,
        entity,
        ["tasks", taskId],
      )
    : null;
}

function importAnalysisIndexes(state: PortableState, artifact: HelmProjectExport) {
  const activeTaskIds = new Set<string>();
  for (const lease of state.leases) {
    if (lease.status === "active") activeTaskIds.add(lease.taskId);
  }
  for (const attempt of state.attempts) {
    if (attempt.status === "active") activeTaskIds.add(attempt.taskId);
  }

  return {
    activeTaskIds,
    source: {
      tagsById: mapById(artifact.tags),
      customFieldsById: mapById(artifact.customFieldDefinitions),
      tasksById: mapById(artifact.tasks),
      relationsById: mapById(artifact.relations),
      savedViewsById: mapById(artifact.savedViews),
      profilesById: mapById(artifact.agentProfiles),
      attemptsById: mapById(artifact.attempts),
    },
    target: {
      projectsByRepositoryRoot: indexBy(state.projects, ({ repositoryRoot }) => repositoryRoot),
      projectsBySequence: indexBy(state.projects, ({ sequence }) => String(sequence)),
      tagsByProjectAndName: indexBy(
        state.tags,
        ({ projectId, name }) => `${projectId}\u0000${name}`,
      ),
      customFieldsByProjectAndKey: indexBy(
        state.customFields,
        ({ projectId, fieldKey }) => `${projectId}\u0000${fieldKey}`,
      ),
      tasksByProjectAndSequence: indexBy(
        state.tasks,
        ({ projectId, sequence }) => `${projectId}\u0000${sequence}`,
      ),
      relationsByTuple: indexBy(
        state.relations,
        ({ sourceTaskId, targetTaskId, type }) =>
          `${sourceTaskId}\u0000${targetTaskId}\u0000${type}`,
      ),
      savedViewsByProjectAndSequence: indexBy(
        state.savedViews,
        ({ projectId, sequence }) => `${projectId}\u0000${sequence}`,
      ),
      activeSavedViewsByProjectAndName: indexBy(
        state.savedViews.filter(({ archivedAt }) => archivedAt === null),
        ({ projectId, name }) => `${projectId}\u0000${name}`,
      ),
      profilesByKey: indexBy(state.profiles, ({ profileKey }) => profileKey),
      attemptsByTaskAndNumber: indexBy(
        state.attempts,
        ({ taskId, attemptNumber }) => `${taskId}\u0000${attemptNumber}`,
      ),
    },
  };
}

type ImportAnalysisIndexes = ReturnType<typeof importAnalysisIndexes>;

function uniquenessConflict(
  indexes: ImportAnalysisIndexes,
  artifact: HelmProjectExport,
  entity: ImportEntity,
): ProjectImportConflict | null {
  const targetProjectId = artifact.project.id;
  switch (entity.entityType) {
    case "project": {
      const source = artifact.project;
      const repositoryCollision = indexes.target.projectsByRepositoryRoot.get(
        source.repositoryRoot,
      );
      if (repositoryCollision && repositoryCollision.id !== source.id) {
        return conflict(
          "repository_conflict",
          `Repository root is already assigned to project ${repositoryCollision.id}.`,
          entity,
          ["project", "repositoryRoot"],
        );
      }
      const sequenceCollision = indexes.target.projectsBySequence.get(String(source.sequence));
      return sequenceCollision && sequenceCollision.id !== source.id
        ? conflict(
            "sequence_conflict",
            `Project sequence ${source.sequence} is already in use.`,
            entity,
            ["project", "sequence"],
          )
        : null;
    }
    case "tag": {
      const source = indexes.source.tagsById.get(entity.sourceId);
      const collision = source
        ? indexes.target.tagsByProjectAndName.get(`${targetProjectId}\u0000${source.name}`)
        : null;
      return collision && collision.id !== source?.id
        ? conflict(
            "duplicate_identity",
            `Tag name ${source?.name ?? ""} is already in use.`,
            entity,
          )
        : null;
    }
    case "custom_field_definition": {
      const source = indexes.source.customFieldsById.get(entity.sourceId);
      const collision = source
        ? indexes.target.customFieldsByProjectAndKey.get(`${targetProjectId}\u0000${source.key}`)
        : null;
      return collision && collision.id !== source?.id
        ? conflict(
            "duplicate_identity",
            `Custom-field key ${source?.key ?? ""} is already in use.`,
            entity,
          )
        : null;
    }
    case "task": {
      const source = indexes.source.tasksById.get(entity.sourceId);
      const collision = source
        ? indexes.target.tasksByProjectAndSequence.get(`${targetProjectId}\u0000${source.sequence}`)
        : null;
      return collision && collision.id !== source?.id
        ? conflict(
            "sequence_conflict",
            `Task sequence ${source?.sequence ?? ""} is already in use.`,
            entity,
          )
        : null;
    }
    case "task_relation": {
      const source = indexes.source.relationsById.get(entity.sourceId);
      const collision = source
        ? indexes.target.relationsByTuple.get(
            `${source.sourceTaskId}\u0000${source.targetTaskId}\u0000${source.type}`,
          )
        : null;
      return collision && collision.id !== source?.id
        ? conflict("duplicate_identity", "That task relation already has another identity.", entity)
        : null;
    }
    case "saved_view": {
      const source = indexes.source.savedViewsById.get(entity.sourceId);
      const sequenceCollision = source
        ? indexes.target.savedViewsByProjectAndSequence.get(
            `${targetProjectId}\u0000${source.sequence}`,
          )
        : null;
      const nameCollision =
        source?.archivedAt === null
          ? indexes.target.activeSavedViewsByProjectAndName.get(
              `${targetProjectId}\u0000${source.name}`,
            )
          : null;
      return (sequenceCollision && sequenceCollision.id !== source?.id) ||
        (nameCollision && nameCollision.id !== source?.id)
        ? conflict("sequence_conflict", "The saved-view sequence or active name is in use.", entity)
        : null;
    }
    case "agent_profile": {
      const source = indexes.source.profilesById.get(entity.sourceId);
      const collision = source ? indexes.target.profilesByKey.get(source.profileKey) : null;
      return collision && collision.id !== source?.id
        ? conflict(
            "profile_key_conflict",
            `Agent profile key ${source?.profileKey ?? ""} is already in use.`,
            entity,
          )
        : null;
    }
    case "attempt": {
      const source = indexes.source.attemptsById.get(entity.sourceId);
      const collision = source
        ? indexes.target.attemptsByTaskAndNumber.get(
            `${source.taskId}\u0000${source.attemptNumber}`,
          )
        : null;
      return collision && collision.id !== source?.id
        ? conflict("sequence_conflict", "The task attempt number is already in use.", entity)
        : null;
    }
    case "agent_run":
    case "activity_entry":
    case "manual_blocker":
      return null;
  }
  return null;
}

function dependencyConflicts(artifact: HelmProjectExport): ProjectImportConflict[] {
  const conflicts: ProjectImportConflict[] = [];
  const entities = importEntityMap(artifact);
  const tasksById = new Map(artifact.tasks.map((value) => [value.id, value]));
  const profilesById = new Map(artifact.agentProfiles.map((value) => [value.id, value]));
  const runsById = new Map(artifact.agentRuns.map((value) => [value.id, value]));
  const attemptsById = new Map(artifact.attempts.map((value) => [value.id, value]));

  function missing(
    ownerType: ProjectImportEntityType,
    ownerId: string,
    dependencyId: string,
    path: readonly (string | number)[],
  ) {
    const owner = entities.get(importEntityKey(ownerType, ownerId));
    if (!owner) return;
    conflicts.push(
      conflict(
        "missing_dependency",
        `Required dependency ${dependencyId} is absent from the project export.`,
        owner,
        path,
      ),
    );
  }

  for (const task of artifact.tasks) {
    if (task.parentTaskId !== null) {
      const parent = tasksById.get(task.parentTaskId);
      if (!parent) {
        missing("task", task.id, task.parentTaskId, ["tasks", task.id, "parentTaskId"]);
      } else if (parent.id === task.id || parent.parentTaskId !== null) {
        const owner = entities.get(importEntityKey("task", task.id));
        if (owner) {
          conflicts.push(
            conflict(
              "immutable_mismatch",
              "Imported task nesting may contain only a parent and its direct children.",
              owner,
              ["tasks", task.id, "parentTaskId"],
            ),
          );
        }
      }
    }
    if (task.reviewAttemptId !== null) {
      const reviewAttempt = attemptsById.get(task.reviewAttemptId);
      if (!reviewAttempt || reviewAttempt.taskId !== task.id) {
        missing("task", task.id, task.reviewAttemptId, ["tasks", task.id, "reviewAttemptId"]);
      }
    }
  }
  for (const run of artifact.agentRuns) {
    if (!profilesById.has(run.profileId)) {
      missing("agent_run", run.id, run.profileId, ["agentRuns", run.id, "profileId"]);
    }
  }
  for (const attempt of artifact.attempts) {
    if (!tasksById.has(attempt.taskId)) {
      missing("attempt", attempt.id, attempt.taskId, ["attempts", attempt.id, "taskId"]);
    }
    const attemptRun = attempt.agentRunId === null ? null : runsById.get(attempt.agentRunId);
    if (attempt.agentRunId !== null && !attemptRun) {
      missing("attempt", attempt.id, attempt.agentRunId, ["attempts", attempt.id, "agentRunId"]);
    }
    if (attempt.agentProfileId !== null && !profilesById.has(attempt.agentProfileId)) {
      missing("attempt", attempt.id, attempt.agentProfileId, [
        "attempts",
        attempt.id,
        "agentProfileId",
      ]);
    }
    if (
      attemptRun &&
      attempt.agentProfileId !== null &&
      attemptRun.profileId !== attempt.agentProfileId
    ) {
      missing("attempt", attempt.id, attempt.agentProfileId, [
        "attempts",
        attempt.id,
        "agentProfileId",
      ]);
    }
  }
  for (const entry of artifact.activityEntries) {
    if (!tasksById.has(entry.taskId)) {
      missing("activity_entry", entry.id, entry.taskId, ["activityEntries", entry.id, "taskId"]);
    }
    const entryAttempt = entry.attemptId === null ? null : attemptsById.get(entry.attemptId);
    if (entry.attemptId !== null && (!entryAttempt || entryAttempt.taskId !== entry.taskId)) {
      missing("activity_entry", entry.id, entry.attemptId, [
        "activityEntries",
        entry.id,
        "attemptId",
      ]);
    }
    const entryRun = entry.agentRunId === null ? null : runsById.get(entry.agentRunId);
    if (entry.agentRunId !== null && !entryRun) {
      missing("activity_entry", entry.id, entry.agentRunId, [
        "activityEntries",
        entry.id,
        "agentRunId",
      ]);
    }
    if (entry.agentProfileId !== null && !profilesById.has(entry.agentProfileId)) {
      missing("activity_entry", entry.id, entry.agentProfileId, [
        "activityEntries",
        entry.id,
        "agentProfileId",
      ]);
    }
    if (entryRun && entry.agentProfileId !== null && entryRun.profileId !== entry.agentProfileId) {
      missing("activity_entry", entry.id, entry.agentProfileId, [
        "activityEntries",
        entry.id,
        "agentProfileId",
      ]);
    }
  }
  for (const blocker of artifact.manualBlockers) {
    if (!tasksById.has(blocker.taskId)) {
      missing("manual_blocker", blocker.id, blocker.taskId, [
        "manualBlockers",
        blocker.id,
        "taskId",
      ]);
    }
  }
  return conflicts;
}

function sourceUniquenessConflicts(artifact: HelmProjectExport): ProjectImportConflict[] {
  const conflicts: ProjectImportConflict[] = [];
  const entities = importEntityMap(artifact);
  const entity = (entityType: ProjectImportEntityType, sourceId: string) =>
    entities.get(importEntityKey(entityType, sourceId));

  function duplicates<T>(
    values: readonly T[],
    key: (value: T) => string,
    identity: (value: T) => {
      readonly entityType: ProjectImportEntityType;
      readonly id: string;
    },
    message: string,
  ) {
    const firstByKey = new Map<string, T>();
    for (const value of values) {
      const uniqueKey = key(value);
      if (!firstByKey.has(uniqueKey)) {
        firstByKey.set(uniqueKey, value);
        continue;
      }
      const owner = identity(value);
      const importEntity = entity(owner.entityType, owner.id);
      if (importEntity) {
        conflicts.push(conflict("duplicate_identity", message, importEntity));
      }
    }
  }

  duplicates(
    artifact.tasks,
    (task) => String(task.sequence),
    (task) => ({ entityType: "task", id: task.id }),
    "Task sequences must be unique within a project export.",
  );
  duplicates(
    artifact.savedViews,
    (view) => String(view.sequence),
    (view) => ({ entityType: "saved_view", id: view.id }),
    "Saved-view sequences must be unique within a project export.",
  );
  duplicates(
    artifact.savedViews.filter(({ archivedAt }) => archivedAt === null),
    (view) => view.name,
    (view) => ({ entityType: "saved_view", id: view.id }),
    "Active saved-view names must be unique within a project export.",
  );
  duplicates(
    artifact.tags,
    (tag) => tag.name,
    (tag) => ({ entityType: "tag", id: tag.id }),
    "Tag names must be unique within a project export.",
  );
  duplicates(
    artifact.customFieldDefinitions,
    (definition) => definition.key,
    (definition) => ({
      entityType: "custom_field_definition",
      id: definition.id,
    }),
    "Custom-field keys must be unique within a project export.",
  );
  duplicates(
    artifact.customFieldDefinitions,
    (definition) => String(definition.position),
    (definition) => ({
      entityType: "custom_field_definition",
      id: definition.id,
    }),
    "Custom-field positions must be unique within a project export.",
  );
  duplicates(
    artifact.relations,
    (relation) => `${relation.sourceTaskId}\u0000${relation.targetTaskId}\u0000${relation.type}`,
    (relation) => ({ entityType: "task_relation", id: relation.id }),
    "Task relation endpoint and type tuples must be unique within a project export.",
  );
  duplicates(
    artifact.attempts,
    (attempt) => `${attempt.taskId}\u0000${attempt.attemptNumber}`,
    (attempt) => ({ entityType: "attempt", id: attempt.id }),
    "Attempt numbers must be unique for each task in a project export.",
  );
  duplicates(
    artifact.agentProfiles,
    (profile) => profile.profileKey,
    (profile) => ({ entityType: "agent_profile", id: profile.id }),
    "Agent profile keys must be unique within a project export.",
  );
  const projectEntity = entity("project", artifact.project.id);
  if (artifact.customFieldDefinitions.length > MAX_CUSTOM_FIELD_DEFINITIONS && projectEntity) {
    conflicts.push(
      conflict(
        "immutable_mismatch",
        `A project may contain at most ${MAX_CUSTOM_FIELD_DEFINITIONS} custom-field definitions.`,
        projectEntity,
        ["customFieldDefinitions"],
      ),
    );
  }
  if (projectEntity) {
    const sourceCursors = new Set<number>();
    for (const sourceEvent of artifact.sourceEvents) {
      if (sourceCursors.has(sourceEvent.sourceCursor)) {
        conflicts.push(
          conflict(
            "duplicate_identity",
            `Source event cursor ${sourceEvent.sourceCursor} appears more than once.`,
            projectEntity,
            ["sourceEvents", sourceEvent.sourceCursor],
          ),
        );
      }
      sourceCursors.add(sourceEvent.sourceCursor);
    }
  }
  for (const task of artifact.tasks) {
    const taskEntity = entity("task", task.id);
    if (!taskEntity) continue;
    for (const [label, values] of [
      ["tag assignments", task.tagIds],
      ["capability requirements", task.requiredCapabilities],
      ["referenced paths", task.referencedPaths],
      ["custom-field assignments", task.customFieldValues.map(({ fieldId }) => fieldId)],
    ] as const) {
      if (new Set(values).size !== values.length) {
        conflicts.push(
          conflict(
            "duplicate_identity",
            `Task ${task.id} contains duplicate ${label}.`,
            taskEntity,
          ),
        );
      }
    }
    if (
      normalizeCapabilities(task.requiredCapabilities).length !== task.requiredCapabilities.length
    ) {
      conflicts.push(
        conflict(
          "duplicate_identity",
          `Task ${task.id} contains duplicate capability requirements after normalization.`,
          taskEntity,
          ["tasks", task.id, "requiredCapabilities"],
        ),
      );
    }
  }
  for (const profile of artifact.agentProfiles) {
    const profileEntity = entity("agent_profile", profile.id);
    if (
      profileEntity &&
      normalizeCapabilities(profile.capabilities).length !== profile.capabilities.length
    ) {
      conflicts.push(
        conflict(
          "duplicate_identity",
          `Agent profile ${profile.id} contains duplicate capabilities after normalization.`,
          profileEntity,
          ["agentProfiles", profile.id, "capabilities"],
        ),
      );
    }
  }
  return conflicts;
}

function combinedCustomizationConflicts(
  state: PortableState,
  artifact: HelmProjectExport,
): ProjectImportConflict[] {
  const conflicts: ProjectImportConflict[] = [];
  const entities = importEntityMap(artifact);
  const targetDefinitions = state.customFields.filter(
    ({ projectId }) => projectId === artifact.project.id,
  );
  const targetIds = new Set(targetDefinitions.map(({ id }) => id));
  const newDefinitions = artifact.customFieldDefinitions.filter(
    ({ id }) => !targetIds.has(id) && !state.customFieldsById.has(id),
  );
  const projectEntity = entities.get(importEntityKey("project", artifact.project.id));
  if (
    projectEntity &&
    targetDefinitions.length + newDefinitions.length > MAX_CUSTOM_FIELD_DEFINITIONS
  ) {
    conflicts.push(
      conflict(
        "immutable_mismatch",
        `The merged project would exceed ${MAX_CUSTOM_FIELD_DEFINITIONS} custom-field definitions.`,
        projectEntity,
        ["customFieldDefinitions"],
      ),
    );
  }
  for (const definition of newDefinitions) {
    const owner = entities.get(importEntityKey("custom_field_definition", definition.id));
    if (!owner) continue;
    const positionCollision = targetDefinitions.find(
      (target) => target.id !== definition.id && target.position === definition.position,
    );
    if (positionCollision) {
      conflicts.push(
        conflict(
          "duplicate_identity",
          `Custom-field position ${definition.position} is already used by ${positionCollision.id}.`,
          owner,
          ["customFieldDefinitions", definition.id, "position"],
        ),
      );
    }
  }
  return conflicts;
}

function lifecycleConflicts(artifact: HelmProjectExport): ProjectImportConflict[] {
  const conflicts: ProjectImportConflict[] = [];
  const entities = importEntityMap(artifact);
  const taskEntity = (taskId: string) => entities.get(importEntityKey("task", taskId));
  const attemptEntity = (attemptId: string) => entities.get(importEntityKey("attempt", attemptId));
  const attemptsByTask = groupBy(artifact.attempts, ({ taskId }) => taskId);
  const attemptsById = new Map(artifact.attempts.map((attempt) => [attempt.id, attempt]));
  const tagsById = new Map(artifact.tags.map((tag) => [tag.id, tag]));

  for (const task of artifact.tasks) {
    const owner = taskEntity(task.id);
    if (!owner) continue;
    if (["ready", "in_progress", "review", "done"].includes(task.lifecycle)) {
      const missing = missingReadyPreparation(task);
      if (missing.length > 0) {
        conflicts.push(
          conflict(
            "immutable_mismatch",
            `Prepared task ${task.id} requires: ${missing.join(", ")}.`,
            owner,
            ["tasks", task.id, "lifecycle"],
          ),
        );
      }
    }
    const retainsReviewAttempt =
      task.lifecycle === "review" ||
      (task.lifecycle === "cancelled" && task.cancelledFromLifecycle === "review");
    if (retainsReviewAttempt) {
      const reviewAttempt =
        task.reviewAttemptId === null ? null : attemptsById.get(task.reviewAttemptId);
      if (
        !reviewAttempt ||
        reviewAttempt.taskId !== task.id ||
        reviewAttempt.status !== "completed"
      ) {
        conflicts.push(
          conflict(
            "immutable_mismatch",
            `Task ${task.id} requires a completed review attempt for its review lifecycle.`,
            owner,
            ["tasks", task.id, "reviewAttemptId"],
          ),
        );
      }
    } else if (task.reviewAttemptId !== null) {
      conflicts.push(
        conflict(
          "immutable_mismatch",
          `Only review tasks or tasks cancelled from review may retain reviewAttemptId metadata.`,
          owner,
          ["tasks", task.id, "reviewAttemptId"],
        ),
      );
    }
    if (
      (task.lifecycle === "cancelled" && task.cancelledFromLifecycle === null) ||
      (task.lifecycle !== "cancelled" && task.cancelledFromLifecycle !== null)
    ) {
      conflicts.push(
        conflict(
          "immutable_mismatch",
          `Task ${task.id} has inconsistent cancelled-lifecycle metadata.`,
          owner,
          ["tasks", task.id, "cancelledFromLifecycle"],
        ),
      );
    }
    const activeAttempts = (attemptsByTask.get(task.id) ?? []).filter(
      ({ status }) => status === "active",
    );
    const expectsActiveAttempt = task.lifecycle === "in_progress" && task.archivedAt === null;
    if (
      (expectsActiveAttempt && activeAttempts.length !== 1) ||
      (!expectsActiveAttempt && activeAttempts.length > 0)
    ) {
      conflicts.push(
        conflict(
          "immutable_mismatch",
          `Task ${task.id} has inconsistent active-attempt metadata.`,
          owner,
          ["tasks", task.id, "lifecycle"],
        ),
      );
    }
    if (
      task.lifecycle === "done" &&
      !(attemptsByTask.get(task.id) ?? []).some(({ status }) => status === "completed")
    ) {
      conflicts.push(
        conflict(
          "immutable_mismatch",
          `Done task ${task.id} requires completed attempt evidence.`,
          owner,
          ["tasks", task.id, "lifecycle"],
        ),
      );
    }
    const assignedTags = task.tagIds.flatMap((tagId) => {
      const tag = tagsById.get(tagId);
      return tag ? [tag] : [];
    });
    if (duplicateExclusiveTagGroups(assignedTags).length > 0) {
      conflicts.push(
        conflict("immutable_mismatch", `Task ${task.id} assigns mutually exclusive tags.`, owner, [
          "tasks",
          task.id,
          "tagIds",
        ]),
      );
    }
  }
  for (const attempt of artifact.attempts) {
    const owner = attemptEntity(attempt.id);
    if (!owner) continue;
    if (
      (attempt.status === "active" && attempt.completedAt !== null) ||
      (attempt.status !== "active" && attempt.completedAt === null)
    ) {
      conflicts.push(
        conflict(
          "immutable_mismatch",
          `Attempt ${attempt.id} has inconsistent completion metadata.`,
          owner,
          ["attempts", attempt.id, "completedAt"],
        ),
      );
    }
    if (
      (attempt.status === "failed" && attempt.failureClassification === null) ||
      (attempt.status !== "failed" && attempt.failureClassification !== null)
    ) {
      conflicts.push(
        conflict(
          "immutable_mismatch",
          `Attempt ${attempt.id} has inconsistent failure metadata.`,
          owner,
          ["attempts", attempt.id, "failureClassification"],
        ),
      );
    }
  }
  for (const entry of artifact.activityEntries) {
    const owner = entities.get(importEntityKey("activity_entry", entry.id));
    if (!owner) continue;
    const completeWithdrawal =
      entry.withdrawnAt !== null &&
      entry.withdrawnBy !== null &&
      entry.withdrawalReason !== null &&
      entry.withdrawalReason.trim().length > 0;
    const absentWithdrawal =
      entry.withdrawnAt === null && entry.withdrawnBy === null && entry.withdrawalReason === null;
    if (!completeWithdrawal && !absentWithdrawal) {
      conflicts.push(
        conflict(
          "immutable_mismatch",
          `Activity entry ${entry.id} has inconsistent withdrawal metadata.`,
          owner,
          ["activityEntries", entry.id, "withdrawnAt"],
        ),
      );
    }
    if (richTextToPlainText(entry.content) !== entry.contentText) {
      conflicts.push(
        conflict(
          "immutable_mismatch",
          `Activity entry ${entry.id} contentText does not match its rich-text content.`,
          owner,
          ["activityEntries", entry.id, "contentText"],
        ),
      );
    }
  }
  for (const blocker of artifact.manualBlockers) {
    const owner = entities.get(importEntityKey("manual_blocker", blocker.id));
    if (!owner) continue;
    const completeResolution =
      blocker.resolvedBy !== null &&
      blocker.resolvedAt !== null &&
      blocker.resolution !== null &&
      blocker.resolution.trim().length > 0;
    const absentResolution =
      blocker.resolvedBy === null && blocker.resolvedAt === null && blocker.resolution === null;
    if (
      (blocker.status === "active" && !absentResolution) ||
      (blocker.status === "resolved" && !completeResolution)
    ) {
      conflicts.push(
        conflict(
          "immutable_mismatch",
          `Manual blocker ${blocker.id} has inconsistent resolution metadata.`,
          owner,
          ["manualBlockers", blocker.id, "status"],
        ),
      );
    }
  }
  return conflicts;
}

function attributionConflicts(artifact: HelmProjectExport): ProjectImportConflict[] {
  const conflicts: ProjectImportConflict[] = [];
  const entities = importEntityMap(artifact);
  const runsById = new Map(artifact.agentRuns.map((run) => [run.id, run]));
  const attemptsById = new Map(artifact.attempts.map((attempt) => [attempt.id, attempt]));
  const owner = (entityType: ProjectImportEntityType, sourceId: string) =>
    entities.get(importEntityKey(entityType, sourceId));

  for (const entry of artifact.activityEntries) {
    const entryOwner = owner("activity_entry", entry.id);
    if (!entryOwner) continue;
    const run = entry.agentRunId === null ? null : runsById.get(entry.agentRunId);
    const validAgentAttribution =
      entry.author.type === "agent" &&
      entry.agentRunId !== null &&
      entry.author.id === entry.agentRunId &&
      entry.agentProfileId !== null &&
      run?.profileId === entry.agentProfileId;
    const validNonAgentAttribution =
      entry.author.type !== "agent" && entry.agentRunId === null && entry.agentProfileId === null;
    if (!validAgentAttribution && !validNonAgentAttribution) {
      conflicts.push(
        conflict(
          "immutable_mismatch",
          `Activity entry ${entry.id} has incoherent actor and agent-run attribution.`,
          entryOwner,
          ["activityEntries", entry.id, "author"],
        ),
      );
    }
    const entryAttempt = entry.attemptId === null ? null : attemptsById.get(entry.attemptId);
    if (
      entryAttempt &&
      entry.author.type === "agent" &&
      (entryAttempt.agentRunId !== entry.agentRunId ||
        entryAttempt.agentProfileId !== entry.agentProfileId)
    ) {
      conflicts.push(
        conflict(
          "immutable_mismatch",
          `Activity entry ${entry.id} attribution does not match its execution attempt.`,
          entryOwner,
          ["activityEntries", entry.id, "attemptId"],
        ),
      );
    }
    const validSystemAttribution =
      entry.kind === "system"
        ? entry.author.type === "system" && entry.author.id === "helm"
        : entry.author.type !== "system";
    if (!validSystemAttribution) {
      conflicts.push(
        conflict(
          "immutable_mismatch",
          `Activity entry ${entry.id} has invalid reserved system attribution.`,
          entryOwner,
          ["activityEntries", entry.id, "kind"],
        ),
      );
    }
    if (entry.withdrawnBy?.type === "agent" && !runsById.has(entry.withdrawnBy.id)) {
      conflicts.push(
        conflict(
          "missing_dependency",
          `Activity entry ${entry.id} names an unknown agent run as its withdrawing actor.`,
          entryOwner,
          ["activityEntries", entry.id, "withdrawnBy", "id"],
        ),
      );
    }
  }

  for (const blocker of artifact.manualBlockers) {
    const blockerOwner = owner("manual_blocker", blocker.id);
    if (!blockerOwner) continue;
    for (const [field, actorValue] of [
      ["createdBy", blocker.createdBy],
      ["resolvedBy", blocker.resolvedBy],
    ] as const) {
      if (actorValue?.type !== "agent" || runsById.has(actorValue.id)) continue;
      conflicts.push(
        conflict(
          "missing_dependency",
          `Manual blocker ${blocker.id} names an unknown agent run in ${field}.`,
          blockerOwner,
          ["manualBlockers", blocker.id, field, "id"],
        ),
      );
    }
  }
  return conflicts;
}

function relationPolicyConflicts(
  state: PortableState,
  artifact: HelmProjectExport,
): ProjectImportConflict[] {
  const conflicts: ProjectImportConflict[] = [];
  const entities = importEntityMap(artifact);
  const relationEntity = (relationId: string) =>
    entities.get(importEntityKey("task_relation", relationId));
  const targetProjectId = artifact.project.id;
  const existingRelations = state.relations.filter(
    ({ projectId }) => projectId === targetProjectId,
  );
  const knownTuples = new Set(
    existingRelations.map(
      (relation) => `${relation.sourceTaskId}\u0000${relation.targetTaskId}\u0000${relation.type}`,
    ),
  );
  type BlockingImportEdge = {
    readonly sourceTaskId: string;
    readonly targetTaskId: string;
    readonly importedRelationId: string | null;
  };
  const blockingEdges: BlockingImportEdge[] = existingRelations
    .filter(({ type }) => type === "blocks")
    .map(({ sourceTaskId, targetTaskId }) => ({
      sourceTaskId,
      targetTaskId,
      importedRelationId: null,
    }));

  for (const relation of artifact.relations) {
    const owner = relationEntity(relation.id);
    if (!owner) continue;
    if (relation.sourceTaskId === relation.targetTaskId) {
      conflicts.push(
        conflict("immutable_mismatch", "A task cannot be related to itself.", owner, [
          "relations",
          relation.id,
        ]),
      );
      continue;
    }
    const tuple = `${relation.sourceTaskId}\u0000${relation.targetTaskId}\u0000${relation.type}`;
    if (knownTuples.has(tuple)) continue;
    knownTuples.add(tuple);
    if (relation.type !== "blocks") continue;
    blockingEdges.push({
      sourceTaskId: relation.sourceTaskId,
      targetTaskId: relation.targetTaskId,
      importedRelationId: relation.id,
    });
  }

  const adjacency = new Map<string, BlockingImportEdge[]>();
  for (const edge of blockingEdges) {
    const outgoing = adjacency.get(edge.sourceTaskId);
    if (outgoing) outgoing.push(edge);
    else adjacency.set(edge.sourceTaskId, [edge]);
    if (!adjacency.has(edge.targetTaskId)) adjacency.set(edge.targetTaskId, []);
  }
  for (const edges of adjacency.values()) {
    edges.sort(
      (left, right) =>
        left.targetTaskId.localeCompare(right.targetTaskId) ||
        (left.importedRelationId ?? "").localeCompare(right.importedRelationId ?? ""),
    );
  }
  const colors = new Map<string, "visiting" | "visited">();
  const parentEdges = new Map<string, BlockingImportEdge>();
  for (const start of [...adjacency.keys()].toSorted()) {
    if (colors.has(start)) continue;
    colors.set(start, "visiting");
    const stack: Array<{ readonly taskId: string; nextEdge: number }> = [
      { taskId: start, nextEdge: 0 },
    ];
    while (stack.length > 0) {
      const frame = stack.at(-1);
      if (!frame) break;
      const outgoing = adjacency.get(frame.taskId) ?? [];
      const edge = outgoing[frame.nextEdge];
      if (!edge) {
        colors.set(frame.taskId, "visited");
        stack.pop();
        continue;
      }
      frame.nextEdge += 1;
      const targetColor = colors.get(edge.targetTaskId);
      if (!targetColor) {
        colors.set(edge.targetTaskId, "visiting");
        parentEdges.set(edge.targetTaskId, edge);
        stack.push({ taskId: edge.targetTaskId, nextEdge: 0 });
        continue;
      }
      if (targetColor === "visited") continue;
      const cycleEdges = [edge];
      let cursor = frame.taskId;
      while (cursor !== edge.targetTaskId) {
        const parent = parentEdges.get(cursor);
        if (!parent) break;
        cycleEdges.push(parent);
        cursor = parent.sourceTaskId;
      }
      const imported = cycleEdges
        .flatMap(({ importedRelationId }) =>
          importedRelationId === null ? [] : [importedRelationId],
        )
        .toSorted()[0];
      if (!imported) continue;
      const owner = relationEntity(imported);
      if (!owner) continue;
      conflicts.push(
        conflict(
          "immutable_mismatch",
          `Blocking relation ${imported} would create a dependency cycle.`,
          owner,
          ["relations", imported],
        ),
      );
      return conflicts;
    }
  }
  return conflicts;
}

function desiredImportArtifact(
  source: HelmProjectExport,
  input: PreviewProjectImportInput,
  state: PortableState,
  repositorySnapshot: ExistingProjectRepositorySnapshot | null,
) {
  if (input.targetProjectId === null && input.repositoryRoot === undefined) {
    throw new InvalidPortabilityInputError({
      message: "A canonical repository root is required for a new project import.",
    });
  }
  const destinationRepositoryRoot =
    input.targetProjectId === null
      ? input.repositoryRoot
      : (state.projectsById.get(input.targetProjectId)?.repositoryRoot ??
        source.project.repositoryRoot);
  if (destinationRepositoryRoot === undefined) {
    throw new InvalidPortabilityInputError({
      message: "A canonical repository root is required for project import path validation.",
    });
  }
  const sourceSequenceIsOccupied = state.projects.some(
    (row) => row.id !== source.project.id && row.sequence === source.project.sequence,
  );
  const nextProjectSequence =
    state.projects.reduce((maximum, row) => Math.max(maximum, row.sequence), 0) + 1;
  const referencedPathIssues: Array<{
    readonly taskId: string;
    readonly reason: string;
    readonly index: number | null;
  }> = [];
  const targetRepositoryIsTrusted =
    input.targetProjectId === null || repositorySnapshot?.status === "trusted";
  const normalizedTasks = source.tasks.map((task) => {
    let referencedPaths = task.referencedPaths;
    if (targetRepositoryIsTrusted) {
      try {
        referencedPaths = validateProjectReferencedPaths(
          destinationRepositoryRoot,
          task.referencedPaths,
        );
      } catch (error) {
        if (
          !(error instanceof ProjectPathEscapeError) &&
          !(error instanceof ProjectPathValidationError)
        ) {
          throw error;
        }
        const index = task.referencedPaths.indexOf(error.path);
        referencedPathIssues.push({
          taskId: task.id,
          reason: error.reason,
          index: index < 0 ? null : index,
        });
      }
    }
    return {
      ...task,
      requiredCapabilities: normalizeCapabilities(task.requiredCapabilities),
      referencedPaths,
    };
  });
  const artifact = canonicalizeHelmProjectExport({
    ...source,
    project: {
      ...source.project,
      repositoryRoot:
        input.targetProjectId === null ? input.repositoryRoot : source.project.repositoryRoot,
      sequence:
        input.targetProjectId === null && sourceSequenceIsOccupied
          ? nextProjectSequence
          : source.project.sequence,
    },
    tasks: normalizedTasks,
    agentProfiles: source.agentProfiles.map((profile) => ({
      ...profile,
      capabilities: normalizeCapabilities(profile.capabilities),
    })),
  });
  const entities = importEntityMap(artifact);
  const projectEntity = entities.get(importEntityKey("project", artifact.project.id));
  return {
    artifact,
    repositoryRootConflicts:
      targetRepositoryIsTrusted || !projectEntity
        ? []
        : [
            conflict(
              "repository_conflict",
              "The target project's registered repository root is unavailable or no longer resolves to its canonical directory.",
              projectEntity,
              ["project", "repositoryRoot"],
            ),
          ],
    referencedPathConflicts: referencedPathIssues.flatMap(({ taskId, reason, index }) => {
      const entity = entities.get(importEntityKey("task", taskId));
      return entity
        ? [
            conflict(
              "invalid_path",
              `Task ${taskId} has an invalid referenced path (${reason}).`,
              entity,
              ["tasks", taskId, "referencedPaths", ...(index === null ? [] : [index])],
            ),
          ]
        : [];
    }),
  };
}

function analyzeJsonImport(
  state: PortableState,
  source: HelmProjectExport,
  input: PreviewProjectImportInput,
  repositorySnapshot: ExistingProjectRepositorySnapshot | null,
) {
  if (input.targetProjectId !== null && !state.projectsById.has(input.targetProjectId)) {
    throw new PortabilityNotFoundError({
      entityType: "project",
      entityId: input.targetProjectId,
      message: "The target project does not exist.",
    });
  }
  const desired = desiredImportArtifact(source, input, state, repositorySnapshot);
  const artifact = desired.artifact;
  const targetProjectId = input.targetProjectId ?? artifact.project.id;

  const entities = importEntities(artifact);
  const entitiesByKey = new Map(
    entities.map((entity) => [importEntityKey(entity.entityType, entity.sourceId), entity]),
  );
  const indexes = importAnalysisIndexes(state, artifact);
  const creates: ProjectImportChange[] = [];
  const updates: ProjectImportChange[] = [];
  const noOps: ProjectImportChange[] = [];
  const conflicts = [
    ...dependencyConflicts(artifact),
    ...sourceUniquenessConflicts(source),
    ...combinedCustomizationConflicts(state, artifact),
    ...lifecycleConflicts(artifact),
    ...attributionConflicts(artifact),
    ...relationPolicyConflicts(state, artifact),
    ...desired.repositoryRootConflicts,
    ...desired.referencedPathConflicts,
  ];
  const createOnlyProjectCollision =
    input.targetProjectId === null && state.projectsById.has(artifact.project.id);
  if (createOnlyProjectCollision) {
    const projectEntity = entitiesByKey.get(importEntityKey("project", artifact.project.id));
    if (projectEntity) {
      conflicts.push(
        conflict(
          "duplicate_identity",
          `New-project import cannot reuse existing project identity ${artifact.project.id}. Choose the existing project explicitly to merge.`,
          projectEntity,
          ["project", "id"],
        ),
      );
    }
  }

  if (targetProjectId !== artifact.project.id) {
    const projectEntity = entities.find(({ entityType }) => entityType === "project");
    if (projectEntity) {
      conflicts.push(
        conflict(
          "duplicate_identity",
          "Initial JSON import preserves the source project identity and cannot remap it.",
          projectEntity,
          ["targetProjectId"],
        ),
      );
    }
  }

  for (const entity of entities) {
    const existing = existingEntityValue(state, entity, artifact.exportedAt);
    if (existing) {
      if (createOnlyProjectCollision && entity.entityType === "project") continue;
      const sourceProjectId = projectIdOf(entity.value);
      if (sourceProjectId !== null && existing.projectId !== sourceProjectId) {
        conflicts.push(
          conflict(
            "duplicate_identity",
            `${entity.entityType} ${entity.sourceId} belongs to a different local project.`,
            entity,
            [entity.entityType, "projectId"],
          ),
        );
        continue;
      }
      if (stablePortabilityJson(existing.value) === stablePortabilityJson(entity.value)) {
        noOps.push(change(entity, "no_op"));
        continue;
      }
      if (
        entity.entityType === "project" &&
        repositoryRootOf(existing.value) !== artifact.project.repositoryRoot
      ) {
        conflicts.push(
          conflict(
            "repository_conflict",
            "The project identity is registered for a different repository root.",
            entity,
            ["project", "repositoryRoot"],
          ),
        );
        continue;
      }

      if (entity.version !== null && existing.version !== null) {
        if (entity.version !== existing.version) {
          conflicts.push(
            conflict(
              "version_conflict",
              `${entity.entityType} ${entity.sourceId} does not match the expected local version.`,
              entity,
              [entity.entityType, "version"],
            ),
          );
          continue;
        }
        if (
          stablePortabilityJson(immutableEntityValue(entity.entityType, existing.value)) !==
          stablePortabilityJson(immutableEntityValue(entity.entityType, entity.value))
        ) {
          conflicts.push(
            conflict(
              "immutable_mismatch",
              `${entity.entityType} ${entity.sourceId} changes immutable identity fields.`,
              entity,
            ),
          );
          continue;
        }
        const activeExecution = activeTaskExecutionConflict(indexes, entity);
        if (activeExecution) {
          conflicts.push(activeExecution);
          continue;
        }
        const unique = uniquenessConflict(indexes, artifact, entity);
        if (unique) conflicts.push(unique);
        else updates.push(change(entity, "update"));
        continue;
      }

      conflicts.push(
        conflict(
          "immutable_mismatch",
          `${entity.entityType} ${entity.sourceId} differs from its immutable local record.`,
          entity,
        ),
      );
      continue;
    }

    const unique = uniquenessConflict(indexes, artifact, entity);
    if (unique) conflicts.push(unique);
    else creates.push(change(entity, "create"));
  }

  const createdKeys = new Set(
    creates.map(({ entityType, sourceId }) => `${entityType}:${sourceId}`),
  );
  const explicitlyUpdatedTaskIds = new Set(
    updates.filter(({ entityType }) => entityType === "task").map(({ sourceId }) => sourceId),
  );
  const displacedNoOpKeys = new Set<string>();
  const aggregateTaskIds = new Set<string>();
  for (const relation of artifact.relations) {
    if (!createdKeys.has(`task_relation:${relation.id}`)) continue;
    aggregateTaskIds.add(relation.sourceTaskId);
    aggregateTaskIds.add(relation.targetTaskId);
  }
  for (const blocker of artifact.manualBlockers) {
    if (createdKeys.has(`manual_blocker:${blocker.id}`)) aggregateTaskIds.add(blocker.taskId);
  }
  for (const taskId of aggregateTaskIds) {
    const existing = state.tasksById.get(taskId);
    if (
      !existing ||
      existing.projectId !== artifact.project.id ||
      createdKeys.has(`task:${taskId}`) ||
      explicitlyUpdatedTaskIds.has(taskId)
    ) {
      continue;
    }
    const taskEntity = entitiesByKey.get(importEntityKey("task", taskId));
    if (!taskEntity) continue;
    const activeExecution = activeTaskExecutionConflict(indexes, taskEntity);
    if (activeExecution) {
      conflicts.push(activeExecution);
      continue;
    }
    displacedNoOpKeys.add(importEntityKey("task", taskId));
    updates.push({
      entityType: "task",
      sourceId: taskId,
      targetId: taskId,
      message: `Increment task ${taskId} once for imported task-owned changes.`,
    });
  }

  for (const attempt of artifact.attempts) {
    if (!createdKeys.has(`attempt:${attempt.id}`)) continue;
    const taskEntity = entitiesByKey.get(importEntityKey("task", attempt.taskId));
    if (!taskEntity || !state.tasksById.has(attempt.taskId)) continue;
    const activeExecution = activeTaskExecutionConflict(indexes, taskEntity);
    if (!activeExecution) continue;
    const attemptEntity = entitiesByKey.get(importEntityKey("attempt", attempt.id));
    if (attemptEntity) {
      conflicts.push(
        conflict(
          "active_execution_conflict",
          `Attempt ${attempt.id} cannot be merged into a task with active local execution.`,
          attemptEntity,
          ["attempts", attempt.id],
        ),
      );
    }
  }

  const createsCustomField = creates.some(
    ({ entityType }) => entityType === "custom_field_definition",
  );
  const updatesProject = updates.some(({ entityType }) => entityType === "project");
  if (createsCustomField && state.projectsById.has(artifact.project.id) && !updatesProject) {
    displacedNoOpKeys.add(importEntityKey("project", artifact.project.id));
    updates.push({
      entityType: "project",
      sourceId: artifact.project.id,
      targetId: artifact.project.id,
      message: `Increment project ${artifact.project.id} once for imported customization changes.`,
    });
  }

  return {
    artifact,
    conflicts,
    creates,
    updates,
    noOps: noOps.filter(
      ({ entityType, sourceId }) => !displacedNoOpKeys.has(importEntityKey(entityType, sourceId)),
    ),
    targetProjectId,
  };
}

function previewInCurrentSnapshot(
  database: Database.Database,
  input: PreviewProjectImportInput,
  actorValue: Actor,
): ProjectImportPreview {
  assertLocalHuman(actorValue);

  if (input.source.format === "csv") {
    const state = loadPortableState(database);
    const repositorySnapshot = existingProjectRepositorySnapshot(state, input.targetProjectId);
    const stateHash = targetStateHash(state, input, null, repositorySnapshot);
    return projectImportPreviewSchema.parse({
      format: "helm-project-import-preview",
      schemaVersion: 1,
      sourceFormat: "csv",
      sourceProjectId: null,
      targetProjectId: input.targetProjectId,
      creates: [],
      updates: [],
      noOps: [],
      conflicts: [],
      unsupported: [
        {
          category: "unsupported",
          code: "csv_not_supported",
          message: "This persistence seam only plans semantic JSON project imports.",
          entityType: null,
          sourceId: null,
          targetId: input.targetProjectId,
          path: ["source", "format"],
        },
      ],
      executable: false,
      previewToken: createProjectImportPreviewToken(previewDescriptorHash(input), stateHash),
    });
  }

  const source = parseJsonImportSource(input.source.content);
  const state = loadPortableState(database);
  const repositorySnapshot = existingProjectRepositorySnapshot(state, input.targetProjectId);
  const stateHash = targetStateHash(state, input, source.artifact, repositorySnapshot);
  const analysis = analyzeJsonImport(state, source.artifact, input, repositorySnapshot);
  return projectImportPreviewSchema.parse({
    format: "helm-project-import-preview",
    schemaVersion: 1,
    sourceFormat: "json",
    sourceProjectId: source.artifact.project.id,
    targetProjectId: analysis.targetProjectId,
    creates: analysis.creates,
    updates: analysis.updates,
    noOps: analysis.noOps,
    conflicts: analysis.conflicts,
    unsupported: source.unsupported,
    executable: analysis.conflicts.length === 0 && source.unsupported.length === 0,
    previewToken: createProjectImportPreviewToken(previewDescriptorHash(input), stateHash),
  });
}

export function previewSqliteProjectImport(
  database: Database.Database,
  input: PreviewProjectImportInput,
  actorValue: Actor,
  _context: PortabilityExportContext,
): ProjectImportPreview {
  return database
    .transaction(() => previewInCurrentSnapshot(database, input, actorValue))
    .deferred();
}

function createdSet(preview: ProjectImportPreview) {
  return new Set(
    preview.creates.map(({ entityType, sourceId }) => importEntityKey(entityType, sourceId)),
  );
}

function updatedSet(preview: ProjectImportPreview) {
  return new Set(
    preview.updates.map(({ entityType, sourceId }) => importEntityKey(entityType, sourceId)),
  );
}

function requireCasChange(
  result: { readonly changes: number },
  entityType: ProjectImportEntityType,
  entityId: string,
) {
  if (result.changes === 1) return;
  throw new PortabilityPreviewStaleError({
    message: `${entityType} ${entityId} changed after the import preview. Preview again.`,
  });
}

function resetsSourceExecution(task: HelmProjectExport["tasks"][number]) {
  return task.lifecycle === "in_progress" && task.archivedAt === null;
}

function insertBatches<T>(rows: readonly T[], insert: (batch: T[]) => void) {
  for (const batch of chunks(rows, SQLITE_INSERT_BATCH_SIZE)) insert(batch);
}

function insertArtifact(
  database: Database.Database,
  initialState: PortableState,
  artifact: HelmProjectExport,
  preview: ProjectImportPreview,
  operationId: string,
  now: string,
) {
  const db = drizzle(database, { schema });
  const created = createdSet(preview);
  const updated = updatedSet(preview);
  const shouldCreate = (entityType: ProjectImportEntityType, id: string) =>
    created.has(importEntityKey(entityType, id));
  const shouldUpdate = (entityType: ProjectImportEntityType, id: string) =>
    updated.has(importEntityKey(entityType, id));

  if (shouldCreate("project", artifact.project.id)) {
    db.insert(projects).values(artifact.project).run();
  } else if (shouldUpdate("project", artifact.project.id)) {
    const current = initialState.projectsById.get(artifact.project.id);
    if (!current) {
      throw new PortabilityPreviewStaleError({
        message: `Project ${artifact.project.id} disappeared after the import preview.`,
      });
    }
    requireCasChange(
      db
        .update(projects)
        .set({
          name: artifact.project.name,
          reviewMode: artifact.project.reviewMode,
          version: current.version + 1,
          updatedAt: now,
        })
        .where(and(eq(projects.id, artifact.project.id), eq(projects.version, current.version)))
        .run(),
      "project",
      artifact.project.id,
    );
  }

  const profileRows = artifact.agentProfiles
    .filter((profile) => shouldCreate("agent_profile", profile.id))
    .map((profile) => ({
      id: profile.id,
      profileKey: profile.profileKey,
      displayName: profile.displayName,
      capabilitiesJson: stablePortabilityJson(profile.capabilities),
      createdAt: profile.createdAt,
      updatedAt: profile.updatedAt,
    }));
  insertBatches(profileRows, (batch) => db.insert(agentProfiles).values(batch).run());

  const runRows = artifact.agentRuns
    .filter((run) => shouldCreate("agent_run", run.id))
    .map((run) => ({
      id: run.id,
      profileId: run.profileId,
      mcpSessionId: `portable-import:${operationId}:${sha256(run.id).slice(0, 16)}`,
      status: "closed" as const,
      clientName: run.clientName,
      clientVersion: run.clientVersion,
      createdAt: run.createdAt,
      lastSeenAt: run.lastSeenAt,
      endedAt: run.sourceStatus === "active" ? now : run.endedAt,
    }));
  insertBatches(runRows, (batch) => db.insert(agentRuns).values(batch).run());

  const tagRows = artifact.tags
    .filter((tag) => shouldCreate("tag", tag.id))
    .map((tag) => ({
      id: tag.id,
      projectId: tag.projectId,
      name: tag.name,
      description: tag.description,
      color: tag.color,
      exclusiveGroup: tag.exclusiveGroup,
      reviewModeOverride: tag.reviewModeOverride,
      createdAt: tag.createdAt,
      updatedAt: tag.updatedAt,
    }));
  insertBatches(tagRows, (batch) => db.insert(tags).values(batch).run());

  const customRows = artifact.customFieldDefinitions
    .filter((definition) => shouldCreate("custom_field_definition", definition.id))
    .map((definition) => ({
      id: definition.id,
      projectId: definition.projectId,
      fieldKey: definition.key,
      type: definition.type,
      validationJson: stablePortabilityJson(definition.validation),
      defaultValueJson:
        definition.defaultValue === null ? null : stablePortabilityJson(definition.defaultValue),
      displayLabel: definition.display.label,
      description: definition.display.description,
      position: definition.position,
      retiredAt: definition.retiredAt,
      createdAt: definition.createdAt,
      updatedAt: definition.updatedAt,
    }));
  insertBatches(customRows, (batch) => db.insert(customFieldDefinitions).values(batch).run());

  const savedViewRows = artifact.savedViews
    .filter((view) => shouldCreate("saved_view", view.id))
    .map((view) => ({
      id: view.id,
      projectId: view.projectId,
      sequence: view.sequence,
      name: view.name,
      definitionVersion: view.definition.schemaVersion,
      definitionJson: stablePortabilityJson(view.definition),
      version: view.version,
      archivedAt: view.archivedAt,
      createdAt: view.createdAt,
      updatedAt: view.updatedAt,
    }));
  insertBatches(savedViewRows, (batch) => db.insert(savedViews).values(batch).run());

  for (const view of artifact.savedViews.filter(({ id }) => shouldUpdate("saved_view", id))) {
    const current = initialState.savedViewsById.get(view.id);
    if (!current) {
      throw new PortabilityPreviewStaleError({
        message: `Saved view ${view.id} disappeared after the import preview.`,
      });
    }
    requireCasChange(
      db
        .update(savedViews)
        .set({
          name: view.name,
          definitionVersion: view.definition.schemaVersion,
          definitionJson: stablePortabilityJson(view.definition),
          version: current.version + 1,
          archivedAt: view.archivedAt,
          updatedAt: now,
        })
        .where(and(eq(savedViews.id, view.id), eq(savedViews.version, current.version)))
        .run(),
      "saved_view",
      view.id,
    );
  }

  const explicitUpdatedTasks = artifact.tasks.filter((task) => {
    if (!shouldUpdate("task", task.id)) return false;
    const current = initialState.tasksById.get(task.id);
    return (
      current !== undefined &&
      stablePortabilityJson(portableTask(initialState, current)) !== stablePortabilityJson(task)
    );
  });
  for (const task of explicitUpdatedTasks) {
    const current = initialState.tasksById.get(task.id);
    if (!current) {
      throw new PortabilityPreviewStaleError({
        message: `Task ${task.id} disappeared after the import preview.`,
      });
    }
    const description = richTextDocumentSchema.parse(task.description);
    const resetExecution = resetsSourceExecution(task);
    requireCasChange(
      db
        .update(tasks)
        .set({
          title: task.title,
          lifecycle: resetExecution ? "ready" : task.lifecycle,
          priority: task.priority,
          position: task.position,
          notBefore: task.notBefore,
          dueAt: task.dueAt,
          size: task.size,
          descriptionJson: stablePortabilityJson(description),
          descriptionText: richTextToPlainText(description),
          expectedOutcome: task.expectedOutcome,
          acceptanceCriteria: task.acceptanceCriteria,
          agentContext: task.agentContext,
          checklistJson: stablePortabilityJson(task.checklist),
          reviewModeOverride: task.reviewModeOverride,
          reviewAttemptId: task.reviewAttemptId,
          cancelledFromLifecycle: task.cancelledFromLifecycle,
          version: current.version + 1,
          archivedAt: task.archivedAt,
          updatedAt: now,
        })
        .where(and(eq(tasks.id, task.id), eq(tasks.version, current.version)))
        .run(),
      "task",
      task.id,
    );
  }

  const createdTasks = artifact.tasks.filter((task) => shouldCreate("task", task.id));
  const createdTaskIds = new Set(createdTasks.map(({ id }) => id));
  const childrenByParent = groupBy(
    createdTasks.filter(
      (task): task is typeof task & { readonly parentTaskId: string } =>
        task.parentTaskId !== null && createdTaskIds.has(task.parentTaskId),
    ),
    ({ parentTaskId }) => parentTaskId,
  );
  let taskFrontier = createdTasks.filter(
    ({ parentTaskId }) => parentTaskId === null || !createdTaskIds.has(parentTaskId),
  );
  const taskInsertionLevels: Array<typeof createdTasks> = [];
  let orderedTaskCount = 0;
  while (taskFrontier.length > 0) {
    taskInsertionLevels.push(taskFrontier);
    orderedTaskCount += taskFrontier.length;
    taskFrontier = taskFrontier.flatMap(({ id }) => childrenByParent.get(id) ?? []);
  }
  if (orderedTaskCount !== createdTasks.length) {
    throw new InvalidPortabilityInputError({
      message: "The imported task hierarchy cannot be inserted parent-first.",
    });
  }
  for (const level of taskInsertionLevels) {
    const taskRows = level.map((task) => {
      const description = richTextDocumentSchema.parse(task.description);
      const resetInProgress = resetsSourceExecution(task);
      return {
        id: task.id,
        projectId: task.projectId,
        sequence: task.sequence,
        parentTaskId: task.parentTaskId,
        title: task.title,
        lifecycle: resetInProgress ? ("ready" as const) : task.lifecycle,
        priority: task.priority,
        position: task.position,
        notBefore: task.notBefore,
        dueAt: task.dueAt,
        size: task.size,
        descriptionJson: stablePortabilityJson(description),
        descriptionText: richTextToPlainText(description),
        expectedOutcome: task.expectedOutcome,
        acceptanceCriteria: task.acceptanceCriteria,
        agentContext: task.agentContext,
        checklistJson: stablePortabilityJson(task.checklist),
        reviewModeOverride: task.reviewModeOverride,
        reviewAttemptId: task.reviewAttemptId,
        cancelledFromLifecycle: task.cancelledFromLifecycle,
        version: resetInProgress ? task.version + 1 : task.version,
        archivedAt: task.archivedAt,
        createdAt: task.createdAt,
        updatedAt: resetInProgress ? now : task.updatedAt,
      };
    });
    insertBatches(taskRows, (batch) => db.insert(tasks).values(batch).run());
  }

  const newTaskIds = new Set(
    artifact.tasks.filter((task) => shouldCreate("task", task.id)).map(({ id }) => id),
  );
  const updatedTaskIds = new Set(explicitUpdatedTasks.map(({ id }) => id));
  for (const taskId of updatedTaskIds) {
    db.delete(taskCustomFieldValues).where(eq(taskCustomFieldValues.taskId, taskId)).run();
    db.delete(taskTags).where(eq(taskTags.taskId, taskId)).run();
    db.delete(taskCapabilityRequirements)
      .where(eq(taskCapabilityRequirements.taskId, taskId))
      .run();
    db.delete(taskReferencedPaths).where(eq(taskReferencedPaths.taskId, taskId)).run();
  }
  const taskAssignmentIds = new Set([...newTaskIds, ...updatedTaskIds]);
  const customValueRows = artifact.tasks.flatMap((task) =>
    taskAssignmentIds.has(task.id)
      ? task.customFieldValues.map((value) => ({
          taskId: task.id,
          definitionId: value.fieldId,
          valueJson: stablePortabilityJson(value.value),
          updatedAt: updatedTaskIds.has(task.id) ? now : value.updatedAt,
        }))
      : [],
  );
  insertBatches(customValueRows, (batch) => db.insert(taskCustomFieldValues).values(batch).run());
  const taskTagRows = artifact.tasks.flatMap((task) =>
    taskAssignmentIds.has(task.id) ? task.tagIds.map((tagId) => ({ taskId: task.id, tagId })) : [],
  );
  insertBatches(taskTagRows, (batch) => db.insert(taskTags).values(batch).run());
  const capabilityRows = artifact.tasks.flatMap((task) =>
    taskAssignmentIds.has(task.id)
      ? task.requiredCapabilities.map((capability) => ({
          taskId: task.id,
          capability,
        }))
      : [],
  );
  insertBatches(capabilityRows, (batch) =>
    db.insert(taskCapabilityRequirements).values(batch).run(),
  );
  const referencedPathRows = artifact.tasks.flatMap((task) =>
    taskAssignmentIds.has(task.id)
      ? task.referencedPaths.map((path) => ({ taskId: task.id, path }))
      : [],
  );
  insertBatches(referencedPathRows, (batch) => db.insert(taskReferencedPaths).values(batch).run());

  const relationRows = artifact.relations.filter((relation) =>
    shouldCreate("task_relation", relation.id),
  );
  insertBatches(relationRows, (batch) => db.insert(taskRelations).values(batch).run());

  const attemptRows = artifact.attempts
    .filter((attempt) => shouldCreate("attempt", attempt.id))
    .map((attempt) => {
      const resetActive = attempt.status === "active";
      return {
        id: attempt.id,
        taskId: attempt.taskId,
        attemptNumber: attempt.attemptNumber,
        agentRunId: attempt.agentRunId,
        agentProfileId: attempt.agentProfileId,
        agentDisplayName: attempt.agentDisplayName,
        status: resetActive ? ("abandoned" as const) : attempt.status,
        summary: attempt.summary,
        changedAreasJson: stablePortabilityJson(attempt.changedAreas),
        verificationJson: stablePortabilityJson(attempt.verificationResults),
        referencesJson: stablePortabilityJson(attempt.references),
        risksJson: stablePortabilityJson(attempt.risks),
        followUpWorkJson: stablePortabilityJson(attempt.followUpWork),
        failureClassification: attempt.failureClassification,
        createdAt: attempt.createdAt,
        completedAt: resetActive ? now : attempt.completedAt,
      };
    });
  insertBatches(attemptRows, (batch) => db.insert(attempts).values(batch).run());

  const activityRows = artifact.activityEntries
    .filter((entry) => shouldCreate("activity_entry", entry.id))
    .map((entry) => ({
      id: entry.id,
      projectId: entry.projectId,
      taskId: entry.taskId,
      attemptId: entry.attemptId,
      kind: entry.kind,
      authorType: entry.author.type,
      authorId: entry.author.id,
      authorDisplayName: entry.authorDisplayName,
      agentProfileId: entry.agentProfileId,
      agentRunId: entry.agentRunId,
      contentJson: stablePortabilityJson(entry.content),
      contentText: entry.contentText,
      createdAt: entry.createdAt,
      withdrawnAt: entry.withdrawnAt,
      withdrawnByType: entry.withdrawnBy?.type ?? null,
      withdrawnById: entry.withdrawnBy?.id ?? null,
      withdrawalReason: entry.withdrawalReason,
    }));
  insertBatches(activityRows, (batch) => db.insert(activityEntries).values(batch).run());

  const blockerRows = artifact.manualBlockers
    .filter((blocker) => shouldCreate("manual_blocker", blocker.id))
    .map((blocker) => ({
      id: blocker.id,
      projectId: blocker.projectId,
      taskId: blocker.taskId,
      reason: blocker.reason,
      status: blocker.status,
      createdByType: blocker.createdBy.type,
      createdById: blocker.createdBy.id,
      createdAt: blocker.createdAt,
      resolvedByType: blocker.resolvedBy?.type ?? null,
      resolvedById: blocker.resolvedBy?.id ?? null,
      resolvedAt: blocker.resolvedAt,
      resolution: blocker.resolution,
    }));
  insertBatches(blockerRows, (batch) => db.insert(manualBlockers).values(batch).run());

  const aggregateTaskIds = preview.updates
    .filter(({ entityType, sourceId }) => entityType === "task" && !updatedTaskIds.has(sourceId))
    .map(({ sourceId }) => sourceId);
  for (const taskId of aggregateTaskIds) {
    const current = initialState.tasksById.get(taskId);
    if (!current) {
      throw new PortabilityPreviewStaleError({
        message: `Task ${taskId} disappeared after the import preview.`,
      });
    }
    requireCasChange(
      db
        .update(tasks)
        .set({ version: current.version + 1, updatedAt: now })
        .where(and(eq(tasks.id, taskId), eq(tasks.version, current.version)))
        .run(),
      "task",
      taskId,
    );
  }
}

function chunks<T>(values: readonly T[], size: number) {
  const result: T[][] = [];
  for (let offset = 0; offset < values.length; offset += size) {
    result.push(values.slice(offset, offset + size));
  }
  return result;
}

function sourceProvenance(artifact: HelmProjectExport) {
  const cursors = artifact.sourceEvents.map(({ sourceCursor }) => sourceCursor);
  return {
    projectId: artifact.project.id,
    eventCount: cursors.length,
    firstCursor: cursors[0] ?? null,
    lastCursor: cursors.at(-1) ?? null,
    eventDigest: sha256(stablePortabilityJson(artifact.sourceEvents)),
  };
}

type ImportOperationDetail = {
  readonly operation: "create" | "update";
  readonly entityType: ProjectImportEntityType;
  readonly sourceId: string;
  readonly targetId: string;
  readonly previousVersion: number | null;
  readonly newVersion: number | null;
  readonly changedFields: readonly string[];
};

function changedPortableFields(before: unknown, after: unknown) {
  if (
    typeof before !== "object" ||
    before === null ||
    typeof after !== "object" ||
    after === null
  ) {
    return stablePortabilityJson(before) === stablePortabilityJson(after) ? [] : ["value"];
  }
  const ignored = new Set(["version", "updatedAt"]);
  return [...new Set([...Object.keys(before), ...Object.keys(after)])]
    .filter((field) => !ignored.has(field))
    .filter(
      (field) =>
        stablePortabilityJson(Reflect.get(before, field)) !==
        stablePortabilityJson(Reflect.get(after, field)),
    )
    .toSorted();
}

function importOperationDetails(
  initialState: PortableState,
  artifact: HelmProjectExport,
  preview: ProjectImportPreview,
): ImportOperationDetail[] {
  const entities = importEntityMap(artifact);
  const tasksById = mapById(artifact.tasks);
  const created = createdSet(preview);
  const associatedFieldsByTask = new Map<string, Set<string>>();
  const associate = (taskId: string, field: string) => {
    const fields = associatedFieldsByTask.get(taskId);
    if (fields) fields.add(field);
    else associatedFieldsByTask.set(taskId, new Set([field]));
  };
  for (const relation of artifact.relations) {
    if (!created.has(importEntityKey("task_relation", relation.id))) continue;
    associate(relation.sourceTaskId, "relations");
    associate(relation.targetTaskId, "relations");
  }
  for (const blocker of artifact.manualBlockers) {
    if (created.has(importEntityKey("manual_blocker", blocker.id))) {
      associate(blocker.taskId, "manualBlockers");
    }
  }
  const createsCustomField = artifact.customFieldDefinitions.some(({ id }) =>
    created.has(importEntityKey("custom_field_definition", id)),
  );
  return [
    ...preview.creates.map((item) => ({ item, operation: "create" as const })),
    ...preview.updates.map((item) => ({ item, operation: "update" as const })),
  ].map(({ item, operation }) => {
    const entity = entities.get(importEntityKey(item.entityType, item.sourceId));
    const sourceVersion = entity?.version ?? null;
    const importedTask = entity?.entityType === "task" ? tasksById.get(entity.sourceId) : undefined;
    const createdTaskVersion =
      importedTask && resetsSourceExecution(importedTask)
        ? sourceVersion === null
          ? null
          : sourceVersion + 1
        : sourceVersion;
    const existing =
      operation === "update" && entity
        ? existingEntityValue(initialState, entity, artifact.exportedAt)
        : null;
    const changedFields =
      operation === "create" ? ["created"] : changedPortableFields(existing?.value, entity?.value);
    if (operation === "update" && entity?.entityType === "task") {
      changedFields.push(...(associatedFieldsByTask.get(entity.sourceId) ?? []));
    }
    if (operation === "update" && entity?.entityType === "project" && createsCustomField) {
      changedFields.push("customFieldDefinitions");
    }
    return {
      operation,
      entityType: item.entityType,
      sourceId: item.sourceId,
      targetId: item.targetId ?? item.sourceId,
      previousVersion: operation === "update" ? sourceVersion : null,
      newVersion:
        operation === "update"
          ? sourceVersion === null
            ? null
            : sourceVersion + 1
          : createdTaskVersion,
      changedFields:
        changedFields.length === 0 ? ["aggregateVersion"] : [...new Set(changedFields)].toSorted(),
    };
  });
}

function operationScopes(operations: readonly ImportOperationDetail[]) {
  const scopes = new Set<"projects" | "tasks" | "activity" | "agents" | "views">(["projects"]);
  for (const operation of operations) {
    if (operation.entityType === "task" || operation.entityType === "task_relation") {
      scopes.add("tasks");
    }
    if (operation.entityType === "activity_entry" || operation.entityType === "manual_blocker") {
      scopes.add("activity");
    }
    if (operation.entityType === "agent_profile" || operation.entityType === "agent_run") {
      scopes.add("agents");
    }
    if (operation.entityType === "saved_view") scopes.add("views");
  }
  return [...scopes];
}

function appendEvent(
  database: Database.Database,
  value: {
    readonly projectId: string;
    readonly kind: string;
    readonly entityType: string;
    readonly entityId: string;
    readonly payload: Record<string, unknown>;
    readonly changes: Parameters<typeof normalizeEventChangeHints>[0];
    readonly occurredAt: string;
    readonly actorId: string;
  },
) {
  const db = drizzle(database, { schema });
  const result = db
    .insert(events)
    .values({
      projectId: value.projectId,
      kind: value.kind,
      importance: "routine",
      actorType: "human",
      actorId: value.actorId,
      entityType: value.entityType,
      entityId: value.entityId,
      payloadJson: stablePortabilityJson(value.payload),
      changesJson: stablePortabilityJson(normalizeEventChangeHints(value.changes)),
      occurredAt: value.occurredAt,
    })
    .run();
  return Number(result.lastInsertRowid);
}

function appendImportEvents(
  database: Database.Database,
  initialState: PortableState,
  artifact: HelmProjectExport,
  preview: ProjectImportPreview,
  operationId: string,
  reason: string,
  now: string,
  actorId: string,
) {
  const eventCursors: number[] = [];
  const provenance = sourceProvenance(artifact);
  const created = createdSet(preview);
  const operations = importOperationDetails(initialState, artifact, preview);
  const operationsByEntity = new Map(
    operations.map((operation) => [
      importEntityKey(operation.entityType, operation.targetId),
      operation,
    ]),
  );
  const changedTaskIds = new Set(
    [...preview.creates, ...preview.updates]
      .filter(({ entityType }) => entityType === "task")
      .map(({ sourceId }) => sourceId),
  );
  for (const relation of artifact.relations) {
    if (!created.has(importEntityKey("task_relation", relation.id))) continue;
    changedTaskIds.add(relation.sourceTaskId);
    changedTaskIds.add(relation.targetTaskId);
  }
  for (const attempt of artifact.attempts) {
    if (created.has(importEntityKey("attempt", attempt.id))) changedTaskIds.add(attempt.taskId);
  }
  for (const entry of artifact.activityEntries) {
    if (created.has(importEntityKey("activity_entry", entry.id))) changedTaskIds.add(entry.taskId);
  }
  for (const blocker of artifact.manualBlockers) {
    if (created.has(importEntityKey("manual_blocker", blocker.id))) {
      changedTaskIds.add(blocker.taskId);
    }
  }
  const changedTasks = artifact.tasks.filter(({ id }) => changedTaskIds.has(id));
  const createdActivity = artifact.activityEntries.filter(({ id }) =>
    created.has(importEntityKey("activity_entry", id)),
  );
  const createsBlocker = artifact.manualBlockers.some(({ id }) =>
    created.has(importEntityKey("manual_blocker", id)),
  );
  const projectOperation = operations.find(
    ({ entityType, sourceId }) => entityType === "project" && sourceId === artifact.project.id,
  );
  const parentScopes = ["projects", "agents", "views", "preferences"] as Array<
    "projects" | "tasks" | "activity" | "agents" | "preferences" | "views"
  >;
  if (changedTaskIds.size > 0) parentScopes.push("tasks");
  if (createdActivity.length > 0 || createsBlocker) parentScopes.push("activity");
  eventCursors.push(
    appendEvent(database, {
      projectId: artifact.project.id,
      kind: "project.imported",
      entityType: "project",
      entityId: artifact.project.id,
      payload: {
        operationId,
        reason,
        sourceFormat: "json",
        sourceProvenance: provenance,
        operationSummary: {
          creates: preview.creates.length,
          updates: preview.updates.length,
          noOps: preview.noOps.length,
        },
        ...(projectOperation?.operation === "update" && projectOperation.newVersion !== null
          ? {
              previousProjectVersion: projectOperation.previousVersion,
              projectVersion: projectOperation.newVersion,
            }
          : {}),
      },
      changes: {
        projectIds: [artifact.project.id],
        taskIds: [...changedTaskIds].toSorted(),
        agentRunIds: artifact.agentRuns.map(({ id }) => id),
        savedViewIds: artifact.savedViews.map(({ id }) => id),
        scopes: parentScopes,
      },
      occurredAt: now,
      actorId,
    }),
  );

  const operationBatches = chunks(operations, IMPORT_EVENT_BATCH_SIZE);
  for (const [batchIndex, batch] of operationBatches.entries()) {
    eventCursors.push(
      appendEvent(database, {
        projectId: artifact.project.id,
        kind: "project.import.entities_batch",
        entityType: "project",
        entityId: artifact.project.id,
        payload: {
          operationId,
          batchIndex,
          batchCount: operationBatches.length,
          operations: batch,
          sourceProvenance: provenance,
        },
        changes: {
          projectIds: [artifact.project.id],
          taskIds: batch
            .filter(({ entityType }) => entityType === "task")
            .map(({ targetId }) => targetId),
          activityEntryIds: batch
            .filter(({ entityType }) => entityType === "activity_entry")
            .map(({ targetId }) => targetId),
          agentRunIds: batch
            .filter(({ entityType }) => entityType === "agent_run")
            .map(({ targetId }) => targetId),
          savedViewIds: batch
            .filter(({ entityType }) => entityType === "saved_view")
            .map(({ targetId }) => targetId),
          scopes: operationScopes(batch),
        },
        occurredAt: now,
        actorId,
      }),
    );
  }

  const sourceEventBatches = chunks(artifact.sourceEvents, IMPORT_EVENT_BATCH_SIZE);
  for (const [batchIndex, batch] of sourceEventBatches.entries()) {
    const sourceAgentRunIds = [
      ...new Set(
        batch.flatMap((event) => [
          ...(event.actor.type === "agent" ? [event.actor.id] : []),
          ...event.changes.agentRunIds,
        ]),
      ),
    ].toSorted();
    eventCursors.push(
      appendEvent(database, {
        projectId: artifact.project.id,
        kind: "project.import.source_events_batch",
        entityType: "project",
        entityId: artifact.project.id,
        payload: {
          operationId,
          batchIndex,
          batchCount: sourceEventBatches.length,
          sourceEvents: batch,
          sourceProvenance: provenance,
        },
        changes: {
          projectIds: [artifact.project.id],
          agentRunIds: sourceAgentRunIds,
          scopes: sourceAgentRunIds.length > 0 ? ["projects", "agents"] : ["projects"],
        },
        occurredAt: now,
        actorId,
      }),
    );
  }

  const taskBatches = chunks(changedTasks, IMPORT_EVENT_BATCH_SIZE);
  for (const [batchIndex, batch] of taskBatches.entries()) {
    eventCursors.push(
      appendEvent(database, {
        projectId: artifact.project.id,
        kind: "project.import.tasks_batch",
        entityType: "project",
        entityId: artifact.project.id,
        payload: {
          operationId,
          batchIndex,
          batchCount: taskBatches.length,
          operations: batch.flatMap(({ id }) => {
            const operation = operationsByEntity.get(importEntityKey("task", id));
            return operation ? [operation] : [];
          }),
          sourceProvenance: provenance,
        },
        changes: {
          projectIds: [artifact.project.id],
          taskIds: batch.map(({ id }) => id),
          scopes: ["tasks"],
        },
        occurredAt: now,
        actorId,
      }),
    );
  }

  const activityBatches = chunks(createdActivity, IMPORT_EVENT_BATCH_SIZE);
  for (const [batchIndex, batch] of activityBatches.entries()) {
    eventCursors.push(
      appendEvent(database, {
        projectId: artifact.project.id,
        kind: "project.import.activity_batch",
        entityType: "project",
        entityId: artifact.project.id,
        payload: {
          operationId,
          batchIndex,
          batchCount: activityBatches.length,
          operations: batch.flatMap(({ id }) => {
            const operation = operationsByEntity.get(importEntityKey("activity_entry", id));
            return operation ? [operation] : [];
          }),
          sourceProvenance: provenance,
        },
        changes: {
          projectIds: [artifact.project.id],
          taskIds: [...new Set(batch.map(({ taskId }) => taskId))],
          activityEntryIds: batch.map(({ id }) => id),
          scopes: ["activity"],
        },
        occurredAt: now,
        actorId,
      }),
    );
  }
  return eventCursors;
}

function selectImportedProject(database: Database.Database, projectId: string, now: string) {
  const db = drizzle(database, { schema });
  const preference = db
    .select()
    .from(preferences)
    .where(eq(preferences.id, PREFERENCES_ID))
    .limit(1)
    .get();
  if (preference) {
    db.update(preferences)
      .set({
        activeProjectId: projectId,
        activeProjectVersion: preference.activeProjectVersion + 1,
        updatedAt: now,
      })
      .where(eq(preferences.id, PREFERENCES_ID))
      .run();
  } else {
    db.insert(preferences)
      .values({
        id: PREFERENCES_ID,
        activeProjectId: projectId,
        activeProjectVersion: 1,
        theme: "system",
        updatedAt: now,
      })
      .run();
  }
}

function portabilityConflicts(conflicts: readonly ProjectImportConflict[]): PortabilityConflict[] {
  return conflicts.map((item) => ({
    code: portabilityConflictCode(item.code),
    entityType: item.entityType ?? "project",
    sourceId: item.sourceId ?? undefined,
    message: item.message,
  }));
}

function portabilityConflictCode(code: string): PortabilityConflict["code"] {
  switch (code) {
    case "active_execution_conflict":
    case "duplicate_identity":
    case "immutable_mismatch":
    case "invalid_path":
    case "missing_dependency":
    case "profile_key_conflict":
    case "repository_conflict":
    case "sequence_conflict":
    case "version_conflict":
      return code;
    default:
      return "duplicate_identity";
  }
}

function importCommandHash(input: ExecuteProjectImportInput, actorValue: Actor) {
  return sha256(
    stablePortabilityJson({
      command: PROJECT_IMPORT_COMMAND,
      source: input.source,
      targetProjectId: input.targetProjectId,
      ...(input.repositoryRoot === undefined ? {} : { repositoryRoot: input.repositoryRoot }),
      reason: input.reason,
      previewToken: input.previewToken,
      actor: actorValue,
    }),
  );
}

function existingIdempotentImport(
  database: Database.Database,
  input: ExecuteProjectImportInput,
  actorValue: Actor,
) {
  const db = drizzle(database, { schema });
  const existing = db
    .select()
    .from(idempotencyRecords)
    .where(eq(idempotencyRecords.key, input.idempotencyKey))
    .limit(1)
    .get();
  if (!existing) return null;
  if (
    existing.command !== PROJECT_IMPORT_COMMAND ||
    existing.inputHash !== importCommandHash(input, actorValue)
  ) {
    throw new PortabilityIdempotencyConflictError({
      key: input.idempotencyKey,
      message: "That idempotency key was already used for a different portability operation.",
    });
  }
  return projectImportExecutionResultSchema.parse(parseJson(existing.resultJson));
}

function recordIdempotentImport(
  database: Database.Database,
  input: ExecuteProjectImportInput,
  actorValue: Actor,
  result: ProjectImportExecutionResult,
  now: string,
) {
  drizzle(database, { schema })
    .insert(idempotencyRecords)
    .values({
      key: input.idempotencyKey,
      command: PROJECT_IMPORT_COMMAND,
      inputHash: importCommandHash(input, actorValue),
      resultJson: stablePortabilityJson(result),
      createdAt: now,
    })
    .run();
}

export function executeSqliteProjectImportInCurrentTransaction(
  database: Database.Database,
  input: ExecuteProjectImportInput,
  actorValue: Actor,
  context: PortabilityExportContext,
): ProjectImportExecutionResult {
  if (!database.inTransaction) {
    throw new InvalidPortabilityInputError({
      message: "Project import execution requires a caller-owned SQLite transaction.",
    });
  }
  assertLocalHuman(actorValue);
  const cached = existingIdempotentImport(database, input, actorValue);
  if (cached) return cached;

  const previewInput: PreviewProjectImportInput = {
    source: input.source,
    targetProjectId: input.targetProjectId,
    repositoryRoot: input.repositoryRoot,
    reason: input.reason,
  };
  const preview = previewInCurrentSnapshot(database, previewInput, actorValue);
  if (preview.previewToken !== input.previewToken) {
    throw new PortabilityPreviewStaleError({
      message: "The project import preview is stale. Preview the import again.",
    });
  }
  if (preview.conflicts.length > 0) {
    throw new PortabilityConflictError({
      conflicts: portabilityConflicts(preview.conflicts),
      message: "The project import conflicts with current Helm data.",
    });
  }
  if (preview.unsupported.length > 0 || input.source.format !== "json") {
    throw new InvalidPortabilityInputError({
      message: "The selected project import source is not executable.",
    });
  }

  const source = parseJsonImportSource(input.source.content);
  const initialState = loadPortableState(database);
  const repositorySnapshot = existingProjectRepositorySnapshot(
    initialState,
    previewInput.targetProjectId,
  );
  const desired = desiredImportArtifact(
    source.artifact,
    previewInput,
    initialState,
    repositorySnapshot,
  );
  const repositorySnapshotAfterValidation = existingProjectRepositorySnapshot(
    initialState,
    previewInput.targetProjectId,
  );
  const finalPreviewToken = createProjectImportPreviewToken(
    previewDescriptorHash(previewInput),
    targetStateHash(initialState, previewInput, source.artifact, repositorySnapshotAfterValidation),
  );
  if (finalPreviewToken !== input.previewToken) {
    throw new PortabilityPreviewStaleError({
      message: "The project repository changed during import validation. Preview the import again.",
    });
  }
  const finalConflicts = [...desired.repositoryRootConflicts, ...desired.referencedPathConflicts];
  if (finalConflicts.length > 0) {
    throw new PortabilityConflictError({
      conflicts: portabilityConflicts(finalConflicts),
      message: "The project import conflicts with the current repository.",
    });
  }
  const artifact = desired.artifact;
  const operationId = randomUUID();
  if (preview.creates.length > 0 || preview.updates.length > 0) {
    insertArtifact(database, initialState, artifact, preview, operationId, context.now);
  }
  selectImportedProject(database, artifact.project.id, context.now);
  const eventCursors = appendImportEvents(
    database,
    initialState,
    artifact,
    preview,
    operationId,
    input.reason,
    context.now,
    actorValue.id,
  );

  const result = projectImportExecutionResultSchema.parse({
    format: "helm-project-import-result",
    schemaVersion: 1,
    sourceFormat: "json",
    sourceProjectId: source.artifact.project.id,
    targetProjectId: artifact.project.id,
    creates: preview.creates,
    updates: preview.updates,
    noOps: preview.noOps,
    conflicts: [],
    unsupported: [],
    executed: true,
    operationId,
    eventCursors,
  });
  recordIdempotentImport(database, input, actorValue, result, context.now);
  return result;
}
