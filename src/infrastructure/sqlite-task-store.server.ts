import { createHash, randomBytes, randomUUID } from "node:crypto";

import Database from "better-sqlite3";
import { and, asc, desc, eq, inArray, isNull, max } from "drizzle-orm";
import { drizzle } from "drizzle-orm/better-sqlite3";
import { Effect } from "effect";

import {
  TaskAlreadyArchivedError,
  TaskAuthorizationError,
  TaskClaimUnavailableError,
  TaskCustomFieldError,
  TaskDiscoveryCursorStaleError,
  TaskIdempotencyConflictError,
  TaskLifecycleError,
  TaskLeaseError,
  TaskNestingError,
  TaskNotFoundError,
  TaskPathError,
  TaskPersistenceError,
  TaskRelationError,
  TaskReviewError,
  TaskTagConstraintError,
  TaskTagDefinitionConflictError,
  TaskVersionConflictError,
  type TaskCommandError,
} from "../application/task-errors";
import type {
  TaskClaimant,
  TaskContextQuery,
  TaskDiscoveryQuery,
  TaskListQuery,
  TaskStore,
} from "../application/tasks";
import {
  agentProfiles,
  agentRuns,
  activityEntries,
  attempts,
  customFieldDefinitions,
  events,
  idempotencyRecords,
  leases,
  manualBlockers,
  projects,
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
  customFieldDefinitionSchema,
  customFieldValueSchema,
  resolveReviewPolicy,
  taskCustomFieldAssignmentSchema,
  validateCustomFieldValue,
  type CustomFieldDefinition,
  type SetTaskReviewModeOverrideInput,
} from "../domain/customization";
import {
  activityEntrySchema,
  importanceForEventKind,
  manualBlockerSchema,
  normalizeEventChangeHints,
  projectEventSchema,
  type ActivityEntry,
  type EventChangeHints,
  type ProjectEvent,
} from "../domain/activity";
import {
  taskAttemptSummarySchema,
  taskCompletionResultSchema,
  taskFailureResultSchema,
  taskTransitionResultSchema,
  compareTaskOrder,
  decodeTaskDiscoveryCursor,
  duplicateExclusiveTagGroups,
  encodeTaskDiscoveryCursor,
  evaluateTaskEligibility,
  findBlockingPath,
  isIncompleteBlockingDependency,
  normalizeCapabilities,
  richTextDocumentSchema,
  richTextToPlainText,
  tagSchema,
  taskRelationSchema,
  taskContextPackageSchema,
  taskLeaseGrantSchema,
  taskLeaseMutationResultSchema,
  taskSchema,
  taskParentViolation,
  type ApproveTaskReviewInput,
  type Actor,
  type ArchiveTaskInput,
  type CancelTaskInput,
  type ClaimNextTaskInput,
  type ClaimTaskInput,
  type CompleteTaskInput,
  type CreateTaskInput,
  type CreateTaskRelationInput,
  type FailTaskInput,
  type PrepareTaskInput,
  type ReopenTaskInput,
  type RequestTaskChangesInput,
  type RestoreCancelledTaskInput,
  type TagInput,
  type Task,
  type TaskCandidate,
  type TaskCandidateField,
  type TaskContextPackage,
  type TaskDiscoveryPage,
  type TaskEvaluationContext,
  type TaskClaim,
  type TaskLeaseGrant,
  type TaskLeaseMutationResult,
  type TaskRelation,
  type TaskCustomFieldValueInput,
  type UpdateTaskPlanningInput,
} from "../domain/tasks";
import type { JsonValue } from "../domain/rich-text";
import { projectReviewModeSchema } from "../domain/projects";
import {
  ProjectContextLimitError,
  ProjectInstructionTooLargeError,
  ProjectPathEscapeError,
  ProjectPathValidationError,
  readProjectContext,
  validateProjectReferencedPaths,
} from "./project-instructions.server";

type DrizzleDatabase = ReturnType<typeof drizzle<typeof schema>>;
type DrizzleTransaction = Parameters<Parameters<DrizzleDatabase["transaction"]>[0]>[0];
type DatabaseSession = DrizzleDatabase | DrizzleTransaction;
type TaskRow = typeof tasks.$inferSelect;
type TaskRelationRow = typeof taskRelations.$inferSelect;
type LeaseRow = typeof leases.$inferSelect;
type AttemptRow = typeof attempts.$inferSelect;
const inMemoryLeaseTokenCaches = new WeakMap<Database.Database, Map<string, string>>();
const fileLeaseTokenCaches = new Map<string, Map<string, string>>();

function leaseTokenCacheFor(database: Database.Database) {
  if (database.name !== ":memory:") {
    let cache = fileLeaseTokenCaches.get(database.name);
    if (!cache) {
      cache = new Map();
      fileLeaseTokenCaches.set(database.name, cache);
    }
    return cache;
  }
  let cache = inMemoryLeaseTokenCaches.get(database);
  if (!cache) {
    cache = new Map();
    inMemoryLeaseTokenCaches.set(database, cache);
  }
  return cache;
}
type PlanningAssignment = {
  priority: Task["priority"];
  position: number;
  notBefore: string | null;
  dueAt: string | null;
  size: Task["size"];
  tags: readonly TagInput[];
  requiredCapabilities: readonly string[];
};

function inputHash(command: string, input: unknown) {
  return createHash("sha256")
    .update(`${command}:${JSON.stringify(input)}`)
    .digest("hex");
}

function persistenceError(error: unknown) {
  return new TaskPersistenceError({
    message: error instanceof Error ? error.message : "The task database operation failed.",
  });
}

function leaseTokenHash(token: string) {
  return createHash("sha256").update(token).digest("hex");
}

function leaseExpiration(now: string, durationSeconds: number) {
  return new Date(Date.parse(now) + durationSeconds * 1_000).toISOString();
}

function refreshEvaluationTime(context: TaskEvaluationContext): TaskEvaluationContext {
  const now = context.currentTime?.() ?? context.now;
  return now === context.now ? context : { ...context, now };
}

function attemptSummaryFromRow(db: DatabaseSession, row: AttemptRow) {
  const needsLegacyIdentity = !row.agentProfileId || !row.agentDisplayName;
  const run =
    needsLegacyIdentity && row.agentRunId
      ? db.select().from(agentRuns).where(eq(agentRuns.id, row.agentRunId)).limit(1).get()
      : null;
  const profileId = row.agentProfileId ?? run?.profileId ?? null;
  const profile =
    !row.agentDisplayName && profileId
      ? db.select().from(agentProfiles).where(eq(agentProfiles.id, profileId)).limit(1).get()
      : null;
  const legacyVerification = JSON.parse(row.verificationJson) as unknown;
  const verificationResults = Array.isArray(legacyVerification)
    ? legacyVerification.map((result) =>
        typeof result === "string"
          ? {
              name: result,
              status: "not_run" as const,
              details: "Imported from a legacy verification note.",
            }
          : result,
      )
    : [];
  return taskAttemptSummarySchema.parse({
    id: row.id,
    taskId: row.taskId,
    attemptNumber: row.attemptNumber,
    agentRunId: row.agentRunId,
    agentProfileId: profileId,
    agentDisplayName: row.agentDisplayName ?? profile?.displayName ?? null,
    status: row.status,
    summary: row.summary,
    changedAreas: JSON.parse(row.changedAreasJson),
    verificationResults,
    references: JSON.parse(row.referencesJson),
    risks: JSON.parse(row.risksJson),
    followUpWork: JSON.parse(row.followUpWorkJson),
    failureClassification: row.failureClassification,
    createdAt: row.createdAt,
    completedAt: row.completedAt,
  });
}

function claimFromLeaseRow(db: DatabaseSession, row: LeaseRow): TaskClaim {
  const run = db.select().from(agentRuns).where(eq(agentRuns.id, row.agentRunId)).limit(1).get();
  const profile = run
    ? db.select().from(agentProfiles).where(eq(agentProfiles.id, run.profileId)).limit(1).get()
    : null;
  if (!run || !profile) {
    throw new TaskLeaseError({
      taskId: row.taskId,
      leaseId: row.id,
      reason: "inactive_run",
      message: "The claim owner no longer exists.",
    });
  }
  return {
    id: row.id,
    taskId: row.taskId,
    attemptId: row.attemptId,
    agentRunId: row.agentRunId,
    agentProfileId: profile.id,
    agentDisplayName: profile.displayName,
    status: row.status,
    acquiredAt: row.acquiredAt,
    expiresAt: row.expiresAt,
    invalidatedAt: row.invalidatedAt,
    invalidationReason: row.invalidationReason,
  };
}

function activeClaimForTask(db: DatabaseSession, taskId: string, now: string) {
  const row = db
    .select()
    .from(leases)
    .where(and(eq(leases.taskId, taskId), eq(leases.status, "active")))
    .orderBy(asc(leases.acquiredAt))
    .limit(1)
    .get();
  if (!row || row.expiresAt <= now) return null;
  const run = db.select().from(agentRuns).where(eq(agentRuns.id, row.agentRunId)).limit(1).get();
  if (!run || run.status !== "active") return null;
  return claimFromLeaseRow(db, row);
}

function relationFromRow(db: DatabaseSession, row: TaskRelationRow): TaskRelation {
  const source = currentTask(db, row.sourceTaskId);
  const target = currentTask(db, row.targetTaskId);
  return {
    id: row.id,
    projectId: row.projectId,
    sourceTaskId: row.sourceTaskId,
    sourceSequence: source.sequence,
    sourceTitle: source.title,
    targetTaskId: row.targetTaskId,
    targetSequence: target.sequence,
    targetTitle: target.title,
    type: row.type,
    createdAt: row.createdAt,
  };
}

function relationsForTask(db: DatabaseSession, taskId: string) {
  const upstreamRelations = db
    .select()
    .from(taskRelations)
    .where(eq(taskRelations.targetTaskId, taskId))
    .orderBy(asc(taskRelations.createdAt))
    .all()
    .map((row) => relationFromRow(db, row));
  const downstreamRelations = db
    .select()
    .from(taskRelations)
    .where(eq(taskRelations.sourceTaskId, taskId))
    .orderBy(asc(taskRelations.createdAt))
    .all()
    .map((row) => relationFromRow(db, row));
  return { upstreamRelations, downstreamRelations };
}

function blockingRelationTargetIds(db: DatabaseSession, sourceTaskId: string) {
  return db
    .select({ id: taskRelations.targetTaskId })
    .from(taskRelations)
    .where(and(eq(taskRelations.sourceTaskId, sourceTaskId), eq(taskRelations.type, "blocks")))
    .orderBy(asc(taskRelations.targetTaskId))
    .all()
    .map((row) => row.id);
}

function childTaskIdsForTask(db: DatabaseSession, taskId: string) {
  return db
    .select({ id: tasks.id })
    .from(tasks)
    .where(eq(tasks.parentTaskId, taskId))
    .orderBy(asc(tasks.sequence))
    .all()
    .map((row) => row.id);
}

function incompleteBlockingDependencies(db: DatabaseSession, taskId: string) {
  return db
    .select({ task: tasks })
    .from(taskRelations)
    .innerJoin(tasks, eq(taskRelations.sourceTaskId, tasks.id))
    .where(and(eq(taskRelations.targetTaskId, taskId), eq(taskRelations.type, "blocks")))
    .all()
    .map((entry) => entry.task)
    .filter(isIncompleteBlockingDependency);
}

function discoverableTasks(db: DatabaseSession, input: TaskDiscoveryQuery): readonly Task[] {
  return db
    .select()
    .from(tasks)
    .where(and(eq(tasks.projectId, input.projectId), isNull(tasks.archivedAt)))
    .orderBy(asc(tasks.sequence))
    .all()
    .map((row) => taskFromRow(db, row, input))
    .filter((task) => task.eligibility?.claimable)
    .toSorted(compareTaskOrder);
}

function candidateFromTask(
  task: Task,
  fields: readonly TaskCandidateField[] = [],
  repositoryRoot?: string,
): TaskCandidate {
  const selectedFields = new Set(fields);
  if (!task.eligibility) throw new Error("A work candidate must include evaluated eligibility.");
  const includesReferencedPaths = selectedFields.has("referencedPaths");
  let referencedPaths: string[] | undefined;
  if (includesReferencedPaths && !repositoryRoot) {
    throw new Error("A repository root is required when selecting referenced paths.");
  }
  if (includesReferencedPaths && repositoryRoot) {
    referencedPaths = validateProjectReferencedPaths(repositoryRoot, task.referencedPaths);
  }
  return {
    id: task.id,
    projectId: task.projectId,
    sequence: task.sequence,
    parentTaskId: task.parentTaskId,
    title: task.title,
    lifecycle: task.lifecycle,
    priority: task.priority,
    position: task.position,
    dueAt: task.dueAt,
    size: task.size,
    tags: task.tags,
    requiredCapabilities: task.requiredCapabilities,
    claim: task.claim,
    eligibility: task.eligibility,
    version: task.version,
    ...(selectedFields.has("descriptionText") ? { descriptionText: task.descriptionText } : {}),
    ...(selectedFields.has("expectedOutcome") ? { expectedOutcome: task.expectedOutcome } : {}),
    ...(selectedFields.has("acceptanceCriteria")
      ? { acceptanceCriteria: task.acceptanceCriteria }
      : {}),
    ...(selectedFields.has("agentContext") ? { agentContext: task.agentContext } : {}),
    ...(selectedFields.has("checklist") ? { checklist: task.checklist } : {}),
    ...(selectedFields.has("relations")
      ? {
          upstreamRelations: task.upstreamRelations,
          downstreamRelations: task.downstreamRelations,
        }
      : {}),
    ...(selectedFields.has("customFields") ? { customFields: task.customFields } : {}),
    ...(selectedFields.has("reviewPolicy") && task.reviewPolicy
      ? { reviewPolicy: task.reviewPolicy }
      : {}),
    ...(referencedPaths ? { referencedPaths } : {}),
    ...(selectedFields.has("timestamps")
      ? { createdAt: task.createdAt, updatedAt: task.updatedAt }
      : {}),
  };
}

function discoveryPageFromTasks(
  sortedTasks: readonly Task[],
  input: TaskDiscoveryQuery,
  revision: number,
  repositoryRoot?: string,
): TaskDiscoveryPage {
  const cursor = input.cursor ? decodeTaskDiscoveryCursor(input.cursor) : null;
  const evaluationKey = discoveryEvaluationKey(input);
  if (cursor && (cursor.revision !== revision || cursor.evaluationKey !== evaluationKey)) {
    const staleBecause =
      cursor.revision !== revision ? "queue_changed" : "evaluation_context_changed";
    throw new TaskDiscoveryCursorStaleError({
      cursorRevision: cursor.revision,
      currentRevision: revision,
      staleBecause,
      message:
        staleBecause === "queue_changed"
          ? "The work queue changed during pagination; restart discovery without a cursor."
          : "The discovery date or agent capabilities changed during pagination; restart discovery without a cursor.",
    });
  }
  const remaining = cursor
    ? sortedTasks.filter((task) => compareTaskOrder(task, cursor) > 0)
    : sortedTasks;
  const page = remaining.slice(0, input.limit);
  return {
    candidates: page.map((task) => candidateFromTask(task, input.fields, repositoryRoot)),
    nextCursor:
      page.length > 0 && page.length < remaining.length
        ? encodeTaskDiscoveryCursor(page[page.length - 1]!, revision, evaluationKey)
        : null,
  };
}

function discoveryEvaluationKey(input: TaskDiscoveryQuery) {
  return createHash("sha256")
    .update(
      JSON.stringify({
        projectId: input.projectId,
        today: input.today,
        agentCapabilities: normalizeCapabilities(input.agentCapabilities),
      }),
    )
    .digest("hex");
}

function discoveryRevision(db: DatabaseSession, projectId: string) {
  return (
    db
      .select({ value: max(events.cursor) })
      .from(events)
      .where(eq(events.projectId, projectId))
      .get()?.value ?? 0
  );
}

function referencedPathsForTask(db: DatabaseSession, taskId: string) {
  return db
    .select({ path: taskReferencedPaths.path })
    .from(taskReferencedPaths)
    .where(eq(taskReferencedPaths.taskId, taskId))
    .orderBy(asc(taskReferencedPaths.path))
    .all()
    .map((entry) => entry.path);
}

function activeManualBlockersForTask(db: DatabaseSession, taskId: string) {
  return db
    .select()
    .from(manualBlockers)
    .where(and(eq(manualBlockers.taskId, taskId), eq(manualBlockers.status, "active")))
    .orderBy(asc(manualBlockers.createdAt), asc(manualBlockers.id))
    .all()
    .map((row) =>
      manualBlockerSchema.parse({
        id: row.id,
        projectId: row.projectId,
        taskId: row.taskId,
        reason: row.reason,
        status: row.status,
        createdBy: { type: row.createdByType, id: row.createdById },
        createdAt: row.createdAt,
        resolvedBy: null,
        resolvedAt: null,
        resolution: null,
      }),
    );
}

function activityEntriesForTask(db: DatabaseSession, taskId: string) {
  return db
    .select()
    .from(activityEntries)
    .where(eq(activityEntries.taskId, taskId))
    .orderBy(asc(activityEntries.createdAt), asc(activityEntries.id))
    .all()
    .map((row) =>
      activityEntrySchema.parse({
        id: row.id,
        projectId: row.projectId,
        taskId: row.taskId,
        attemptId: row.attemptId,
        kind: row.kind,
        author: { type: row.authorType, id: row.authorId },
        authorDisplayName: row.authorDisplayName,
        agentProfileId: row.agentProfileId,
        content: row.withdrawnAt ? null : JSON.parse(row.contentJson),
        contentText: row.withdrawnAt ? "" : row.contentText,
        createdAt: row.createdAt,
        withdrawnAt: row.withdrawnAt,
        withdrawnBy:
          row.withdrawnByType && row.withdrawnById
            ? { type: row.withdrawnByType, id: row.withdrawnById }
            : null,
        withdrawalReason: row.withdrawalReason,
      }),
    );
}

function customFieldDefinitionFromRow(
  row: typeof customFieldDefinitions.$inferSelect,
): CustomFieldDefinition {
  return customFieldDefinitionSchema.parse({
    id: row.id,
    projectId: row.projectId,
    key: row.fieldKey,
    type: row.type,
    validation: JSON.parse(row.validationJson),
    defaultValue: row.defaultValueJson === null ? null : JSON.parse(row.defaultValueJson),
    display: {
      label: row.displayLabel,
      description: row.description,
    },
    position: row.position,
    retiredAt: row.retiredAt,
    createdAt: row.createdAt,
    updatedAt: row.updatedAt,
  });
}

function customFieldAssignmentsForTask(db: DatabaseSession, row: TaskRow) {
  const definitions = db
    .select()
    .from(customFieldDefinitions)
    .where(eq(customFieldDefinitions.projectId, row.projectId))
    .orderBy(asc(customFieldDefinitions.position), asc(customFieldDefinitions.id))
    .all()
    .map(customFieldDefinitionFromRow);
  const explicitValues = new Map(
    db
      .select()
      .from(taskCustomFieldValues)
      .where(eq(taskCustomFieldValues.taskId, row.id))
      .all()
      .map((entry) => [
        entry.definitionId,
        customFieldValueSchema.parse(JSON.parse(entry.valueJson)),
      ]),
  );

  return definitions
    .filter(
      (definition) =>
        definition.retiredAt === null ||
        explicitValues.has(definition.id) ||
        Date.parse(row.createdAt) <= Date.parse(definition.retiredAt),
    )
    .map((definition) => {
      const explicit = explicitValues.get(definition.id);
      const value = explicit ?? definition.defaultValue;
      return taskCustomFieldAssignmentSchema.parse({
        definition,
        value,
        source: explicit ? "explicit" : value === null ? "unset" : "default",
      });
    });
}

function reviewPolicyForTask(
  db: DatabaseSession,
  row: TaskRow,
  assignedTags: readonly (typeof tags.$inferSelect)[],
) {
  const project = db
    .select({ reviewMode: projects.reviewMode })
    .from(projects)
    .where(eq(projects.id, row.projectId))
    .limit(1)
    .get();
  if (!project) throw new Error("The task project does not exist.");
  return resolveReviewPolicy({
    projectId: row.projectId,
    projectMode: projectReviewModeSchema.parse(project.reviewMode),
    taskId: row.id,
    taskOverride: row.reviewModeOverride,
    tags: assignedTags.map((tag) => ({
      id: tag.id,
      name: tag.name,
      reviewModeOverride: tag.reviewModeOverride,
    })),
  });
}

function replaceCustomFieldValues(
  db: DatabaseSession,
  taskId: string,
  projectId: string,
  values: readonly TaskCustomFieldValueInput[],
  now: string,
) {
  for (const entry of values) {
    const row = db
      .select()
      .from(customFieldDefinitions)
      .where(eq(customFieldDefinitions.id, entry.fieldId))
      .limit(1)
      .get();
    if (!row) {
      throw new TaskCustomFieldError({
        taskId,
        fieldId: entry.fieldId,
        reason: "not_found",
        issues: [],
        message: `Custom field ${entry.fieldId} does not exist.`,
      });
    }
    if (row.projectId !== projectId) {
      throw new TaskCustomFieldError({
        taskId,
        fieldId: entry.fieldId,
        reason: "wrong_project",
        issues: [],
        message: `Custom field ${entry.fieldId} does not belong to this task's project.`,
      });
    }
    const definition = customFieldDefinitionFromRow(row);
    if (definition.retiredAt !== null) {
      throw new TaskCustomFieldError({
        taskId,
        fieldId: entry.fieldId,
        reason: "retired",
        issues: [],
        message: `Custom field ${definition.display.label} is retired and read-only.`,
      });
    }
    if (entry.value === null) {
      db.delete(taskCustomFieldValues)
        .where(
          and(
            eq(taskCustomFieldValues.taskId, taskId),
            eq(taskCustomFieldValues.definitionId, entry.fieldId),
          ),
        )
        .run();
      continue;
    }
    const issues = validateCustomFieldValue(definition, entry.value);
    if (issues.length > 0) {
      throw new TaskCustomFieldError({
        taskId,
        fieldId: entry.fieldId,
        reason: "invalid_value",
        issues: issues.map((issue) => issue.message),
        message: issues.map((issue) => issue.message).join(" "),
      });
    }
    db.insert(taskCustomFieldValues)
      .values({
        taskId,
        definitionId: entry.fieldId,
        valueJson: JSON.stringify(entry.value),
        updatedAt: now,
      })
      .onConflictDoUpdate({
        target: [taskCustomFieldValues.taskId, taskCustomFieldValues.definitionId],
        set: { valueJson: JSON.stringify(entry.value), updatedAt: now },
      })
      .run();
  }
}

function taskFromRow(db: DatabaseSession, row: TaskRow, context?: TaskEvaluationContext): Task {
  const { upstreamRelations, downstreamRelations } = relationsForTask(db, row.id);
  const blockingTaskIds = incompleteBlockingDependencies(db, row.id).map((task) => task.id);
  const assignedTags = db
    .select({ tag: tags })
    .from(taskTags)
    .innerJoin(tags, eq(taskTags.tagId, tags.id))
    .where(eq(taskTags.taskId, row.id))
    .orderBy(asc(tags.name))
    .all()
    .map((entry) => entry.tag);
  const parsedTags = assignedTags.map((tag) => tagSchema.parse(tag));
  const reviewPolicy = reviewPolicyForTask(db, row, assignedTags);
  const requiredCapabilities = db
    .select()
    .from(taskCapabilityRequirements)
    .where(eq(taskCapabilityRequirements.taskId, row.id))
    .orderBy(asc(taskCapabilityRequirements.capability))
    .all()
    .map((entry) => entry.capability);
  const activeManualBlockers = activeManualBlockersForTask(db, row.id);
  const task = taskSchema.parse({
    id: row.id,
    projectId: row.projectId,
    sequence: row.sequence,
    parentTaskId: row.parentTaskId,
    childTaskIds: childTaskIdsForTask(db, row.id),
    title: row.title,
    lifecycle: row.lifecycle,
    priority: row.priority,
    position: row.position,
    notBefore: row.notBefore,
    dueAt: row.dueAt,
    size: row.size,
    tags: parsedTags,
    customFields: customFieldAssignmentsForTask(db, row),
    reviewModeOverride: row.reviewModeOverride,
    reviewPolicy,
    requiredCapabilities,
    referencedPaths: referencedPathsForTask(db, row.id),
    claim: context ? activeClaimForTask(db, row.id, context.now) : null,
    upstreamRelations,
    downstreamRelations,
    manualBlockers: activeManualBlockers,
    description: JSON.parse(row.descriptionJson),
    descriptionText: row.descriptionText,
    expectedOutcome: row.expectedOutcome,
    acceptanceCriteria: row.acceptanceCriteria,
    agentContext: row.agentContext,
    checklist: JSON.parse(row.checklistJson),
    reviewAttemptId: row.reviewAttemptId,
    cancelledFromLifecycle: row.cancelledFromLifecycle,
    version: row.version,
    archivedAt: row.archivedAt,
    createdAt: row.createdAt,
    updatedAt: row.updatedAt,
  });
  return context
    ? {
        ...task,
        eligibility: evaluateTaskEligibility(task, context, blockingTaskIds, activeManualBlockers),
      }
    : task;
}

function taskPlanningForCreate(input: CreateTaskInput, sequence: number): PlanningAssignment {
  return {
    priority: input.priority ?? "normal",
    position: input.position ?? sequence,
    notBefore: input.notBefore ?? null,
    dueAt: input.dueAt ?? null,
    size: input.size ?? null,
    tags: input.tags ?? [],
    requiredCapabilities: normalizeCapabilities(input.requiredCapabilities),
  };
}

function replaceTagAssignments(
  db: DatabaseSession,
  taskId: string,
  projectId: string,
  assignedTags: readonly TagInput[],
  now: string,
) {
  const resolvedTags: Array<typeof tags.$inferSelect> = [];
  for (const tag of assignedTags) {
    const [existing] = db
      .select()
      .from(tags)
      .where(and(eq(tags.projectId, projectId), eq(tags.name, tag.name)))
      .limit(1)
      .all();
    if (existing) {
      if (
        existing.description !== tag.description ||
        existing.color.toLocaleLowerCase("en-US") !== tag.color.toLocaleLowerCase("en-US") ||
        existing.exclusiveGroup !== (tag.exclusiveGroup ?? null)
      ) {
        throw new TaskTagDefinitionConflictError({
          tagName: tag.name,
          message: `Tag ${tag.name} already exists with different project metadata.`,
        });
      }
      resolvedTags.push(existing);
      continue;
    }

    const created = {
      id: randomUUID(),
      projectId,
      name: tag.name,
      description: tag.description,
      color: tag.color.toLocaleLowerCase("en-US"),
      exclusiveGroup: tag.exclusiveGroup ?? null,
      reviewModeOverride: null,
      createdAt: now,
      updatedAt: now,
    };
    db.insert(tags).values(created).run();
    resolvedTags.push(created);
  }

  const [exclusiveGroupConflict] = duplicateExclusiveTagGroups(resolvedTags);
  if (exclusiveGroupConflict) {
    throw new TaskTagConstraintError({
      group: exclusiveGroupConflict.group,
      tagNames: exclusiveGroupConflict.tagNames,
      message: `Tags in the ${exclusiveGroupConflict.group} group are mutually exclusive: ${exclusiveGroupConflict.tagNames.join(", ")}.`,
    });
  }

  db.delete(taskTags).where(eq(taskTags.taskId, taskId)).run();
  for (const tag of resolvedTags) {
    db.insert(taskTags).values({ taskId, tagId: tag.id }).run();
  }
}

function replaceRequiredCapabilities(
  db: DatabaseSession,
  taskId: string,
  requiredCapabilities: readonly string[],
) {
  db.delete(taskCapabilityRequirements).where(eq(taskCapabilityRequirements.taskId, taskId)).run();
  for (const capability of normalizeCapabilities(requiredCapabilities)) {
    db.insert(taskCapabilityRequirements).values({ taskId, capability }).run();
  }
}

function replaceReferencedPaths(
  db: DatabaseSession,
  taskId: string,
  referencedPaths: readonly string[],
) {
  db.delete(taskReferencedPaths).where(eq(taskReferencedPaths.taskId, taskId)).run();
  for (const path of [...new Set(referencedPaths)].toSorted()) {
    db.insert(taskReferencedPaths).values({ taskId, path }).run();
  }
}

function hasInputField(input: object, key: string) {
  return Object.prototype.hasOwnProperty.call(input, key);
}

function assertCanUseParent(db: DatabaseSession, projectId: string, parentTaskId: string | null) {
  if (!parentTaskId) return;
  const parent = currentTask(db, parentTaskId);
  const violation = taskParentViolation(parent, projectId);
  if (violation === "different_project") {
    throw new TaskNestingError({
      taskId: parentTaskId,
      parentTaskId,
      message: "Child tasks must belong to the same project as their parent.",
    });
  }
  if (violation === "nested") {
    throw new TaskNestingError({
      taskId: parentTaskId,
      parentTaskId: parent.parentTaskId ?? undefined,
      message: "Tasks may only be nested one level deep.",
    });
  }
  if (parent.lifecycle === "in_progress" || parent.lifecycle === "review") {
    throw new TaskLifecycleError({
      taskId: parentTaskId,
      lifecycle: parent.lifecycle,
      message: "A child cannot be added while its parent has active work.",
    });
  }
}

function sequencePath(db: DatabaseSession, taskIds: readonly string[]) {
  return taskIds.map((taskId) => `#${currentTask(db, taskId).sequence}`);
}

function withoutIdempotencyKey<T extends { idempotencyKey: string }>(input: T) {
  const { idempotencyKey: _idempotencyKey, ...commandInput } = input;
  // referencedPaths was added after create/prepare became durable commands. Keep
  // the empty value hash-compatible with records written by the earlier schema.
  if (
    "referencedPaths" in commandInput &&
    Array.isArray(commandInput.referencedPaths) &&
    commandInput.referencedPaths.length === 0
  ) {
    const { referencedPaths: _referencedPaths, ...legacyCompatibleInput } = commandInput;
    return legacyCompatibleInput;
  }
  return commandInput;
}

function taskWithoutEligibility(task: Task) {
  const { eligibility: _eligibility, ...durableTask } = task;
  return durableTask;
}

function findIdempotentResult(
  db: DatabaseSession,
  command: string,
  key: string,
  hash: string,
  context: TaskEvaluationContext,
) {
  const [existing] = db
    .select()
    .from(idempotencyRecords)
    .where(eq(idempotencyRecords.key, key))
    .limit(1)
    .all();
  if (!existing) return null;
  if (existing.command !== command || existing.inputHash !== hash) {
    throw new TaskIdempotencyConflictError({
      key,
      message: "That idempotency key was already used for a different command.",
    });
  }
  const cachedTask = taskSchema.parse(JSON.parse(existing.resultJson));
  const durableTask = taskWithoutEligibility(cachedTask);
  const blockingTaskIds = durableTask.upstreamRelations
    .filter((relation) => relation.type === "blocks")
    .map((relation) => currentTask(db, relation.sourceTaskId))
    .filter(isIncompleteBlockingDependency)
    .map((task) => task.id);
  const currentManualBlockers = activeManualBlockersForTask(db, durableTask.id);
  const refreshedTask = {
    ...durableTask,
    manualBlockers: currentManualBlockers,
  };
  return {
    ...refreshedTask,
    eligibility: evaluateTaskEligibility(
      refreshedTask,
      context,
      blockingTaskIds,
      currentManualBlockers,
    ),
  };
}

function findIdempotentRelationResult(
  db: DatabaseSession,
  command: string,
  key: string,
  hash: string,
) {
  const [existing] = db
    .select()
    .from(idempotencyRecords)
    .where(eq(idempotencyRecords.key, key))
    .limit(1)
    .all();
  if (!existing) return null;
  if (existing.command !== command || existing.inputHash !== hash) {
    throw new TaskIdempotencyConflictError({
      key,
      message: "That idempotency key was already used for a different command.",
    });
  }
  return taskRelationSchema.parse(JSON.parse(existing.resultJson));
}

function findIdempotentLeaseResult(
  db: DatabaseSession,
  command: string,
  key: string,
  hash: string,
  result: "grant" | "mutation",
  options: {
    tokenCache?: Map<string, string>;
    providedToken?: string;
    now?: string;
  } = {},
) {
  const existing = db
    .select()
    .from(idempotencyRecords)
    .where(eq(idempotencyRecords.key, key))
    .limit(1)
    .get();
  if (!existing) return null;
  if (existing.command !== command || existing.inputHash !== hash) {
    throw new TaskIdempotencyConflictError({
      key,
      message: "That idempotency key was already used for a different command.",
    });
  }
  const recorded = JSON.parse(existing.resultJson);
  if (result === "mutation") return taskLeaseMutationResultSchema.parse(recorded);
  const claimId = recorded?.claim?.id;
  const leaseToken = options.providedToken ?? options.tokenCache?.get(claimId);
  if (!leaseToken) {
    throw new TaskLeaseError({
      taskId: recorded?.task?.id,
      leaseId: claimId,
      reason: "inactive",
      message:
        "The original lease token is no longer available in this server process; claim the task again if it is eligible.",
    });
  }
  const lease = db.select().from(leases).where(eq(leases.id, claimId)).limit(1).get();
  if (!lease || lease.status !== "active" || lease.tokenHash !== leaseTokenHash(leaseToken)) {
    if (claimId) options.tokenCache?.delete(claimId);
    throw new TaskLeaseError({
      taskId: recorded?.task?.id,
      leaseId: claimId,
      reason: lease?.status === "expired" ? "expired" : "inactive",
      message: "The idempotent claim result no longer has a valid active lease.",
    });
  }
  if (options.now && lease.expiresAt <= options.now) {
    options.tokenCache?.delete(lease.id);
    throw new TaskLeaseError({
      taskId: lease.taskId,
      leaseId: lease.id,
      reason: "expired",
      message: "The idempotent claim result has expired.",
    });
  }
  return taskLeaseGrantSchema.parse({ ...recorded, leaseToken });
}

function recordLeaseMutation(
  db: DatabaseSession,
  input: { idempotencyKey: string },
  command: string,
  hash: string,
  result: TaskLeaseGrant | TaskLeaseMutationResult,
  actor: Actor,
  event: { kind: string; payload: unknown; occurredAt: string },
) {
  db.insert(events)
    .values({
      projectId: result.task.projectId,
      kind: event.kind,
      importance: importanceForEventKind(event.kind),
      actorType: actor.type,
      actorId: actor.id,
      entityType: "task",
      entityId: result.task.id,
      payloadJson: JSON.stringify(event.payload),
      changesJson: JSON.stringify(
        normalizeEventChangeHints({
          projectIds: [result.task.projectId],
          taskIds: [result.task.id],
          scopes: ["tasks"],
        }),
      ),
      occurredAt: event.occurredAt,
    })
    .run();
  const persistedResult =
    "leaseToken" in result
      ? (({ leaseToken: _leaseToken, ...withoutToken }) => withoutToken)(result)
      : result;
  db.insert(idempotencyRecords)
    .values({
      key: input.idempotencyKey,
      command,
      inputHash: hash,
      resultJson: JSON.stringify(persistedResult),
      createdAt: event.occurredAt,
    })
    .run();
}

function findIdempotentSnapshot<T>(
  db: DatabaseSession,
  command: string,
  key: string,
  hash: string,
  parse: (value: unknown) => T,
) {
  const existing = db
    .select()
    .from(idempotencyRecords)
    .where(eq(idempotencyRecords.key, key))
    .limit(1)
    .get();
  if (!existing) return null;
  if (existing.command !== command || existing.inputHash !== hash) {
    throw new TaskIdempotencyConflictError({
      key,
      message: "That idempotency key was already used for a different command.",
    });
  }
  return parse(JSON.parse(existing.resultJson));
}

function recordResultSnapshot(
  db: DatabaseSession,
  input: { idempotencyKey: string },
  command: string,
  hash: string,
  result: unknown,
  occurredAt: string,
) {
  db.insert(idempotencyRecords)
    .values({
      key: input.idempotencyKey,
      command,
      inputHash: hash,
      resultJson: JSON.stringify(result),
      createdAt: occurredAt,
    })
    .run();
}

function appendTaskEvent(
  db: DatabaseSession,
  task: Task,
  actor: Actor,
  kind: string,
  payload: Record<string, JsonValue>,
  changes: Partial<EventChangeHints> = {},
): ProjectEvent {
  const row = db
    .insert(events)
    .values({
      projectId: task.projectId,
      kind,
      importance: importanceForEventKind(kind),
      actorType: actor.type,
      actorId: actor.id,
      entityType: "task",
      entityId: task.id,
      payloadJson: JSON.stringify(payload),
      changesJson: JSON.stringify(
        normalizeEventChangeHints({
          ...changes,
          projectIds: [task.projectId, ...(changes.projectIds ?? [])],
          taskIds: [task.id, ...(changes.taskIds ?? [])],
          scopes: ["tasks", ...(changes.scopes ?? [])],
        }),
      ),
      occurredAt: task.updatedAt,
    })
    .returning()
    .get();
  return projectEventSchema.parse({
    id: String(row.cursor),
    cursor: row.cursor,
    projectId: row.projectId,
    kind: row.kind,
    importance: row.importance,
    actor: { type: row.actorType, id: row.actorId },
    entity: { type: row.entityType, id: row.entityId },
    payload: JSON.parse(row.payloadJson),
    changes: JSON.parse(row.changesJson),
    occurredAt: row.occurredAt,
  });
}

function recordMutation(
  db: DatabaseSession,
  input: { idempotencyKey: string },
  command: string,
  hash: string,
  result: Task,
  actor: Actor,
  event: { kind: string; payload: unknown },
) {
  const eligibilityChangedTaskIds = ["task.completed", "task.reopened", "task.archived"].includes(
    event.kind,
  )
    ? blockingRelationTargetIds(db, result.id)
    : [];
  db.insert(events)
    .values({
      projectId: result.projectId,
      kind: event.kind,
      importance: importanceForEventKind(event.kind),
      actorType: actor.type,
      actorId: actor.id,
      entityType: "task",
      entityId: result.id,
      payloadJson: JSON.stringify(event.payload),
      changesJson: JSON.stringify(
        normalizeEventChangeHints({
          projectIds: [result.projectId],
          taskIds: [result.id, ...eligibilityChangedTaskIds],
          scopes: ["tasks"],
        }),
      ),
      occurredAt: result.updatedAt,
    })
    .run();
  db.insert(idempotencyRecords)
    .values({
      key: input.idempotencyKey,
      command,
      inputHash: hash,
      resultJson: JSON.stringify(taskWithoutEligibility(result)),
      createdAt: result.updatedAt,
    })
    .run();
}

function recordRelationMutation(
  db: DatabaseSession,
  input: { idempotencyKey: string },
  command: string,
  hash: string,
  result: TaskRelation,
  actor: Actor,
  occurredAt: string,
) {
  db.insert(events)
    .values({
      projectId: result.projectId,
      kind: "task.relation.created",
      importance: importanceForEventKind("task.relation.created"),
      actorType: actor.type,
      actorId: actor.id,
      entityType: "task_relation",
      entityId: result.id,
      payloadJson: JSON.stringify({
        sourceTaskId: result.sourceTaskId,
        targetTaskId: result.targetTaskId,
        type: result.type,
      }),
      changesJson: JSON.stringify(
        normalizeEventChangeHints({
          projectIds: [result.projectId],
          taskIds: [result.sourceTaskId, result.targetTaskId],
          scopes: ["tasks"],
        }),
      ),
      occurredAt,
    })
    .run();
  db.insert(idempotencyRecords)
    .values({
      key: input.idempotencyKey,
      command,
      inputHash: hash,
      resultJson: JSON.stringify(result),
      createdAt: occurredAt,
    })
    .run();
}

function currentTask(db: DatabaseSession, taskId: string) {
  const [row] = db.select().from(tasks).where(eq(tasks.id, taskId)).limit(1).all();
  if (!row) {
    throw new TaskNotFoundError({
      taskId,
      message: "That task does not exist.",
    });
  }
  return row;
}

function projectRepositoryRoot(db: DatabaseSession, projectId: string) {
  const [project] = db.select().from(projects).where(eq(projects.id, projectId)).limit(1).all();
  if (!project) {
    throw new TaskNotFoundError({
      taskId: projectId,
      message: "That project does not exist.",
    });
  }
  return project.repositoryRoot;
}

function attemptSummariesForTask(db: DatabaseSession, taskId: string) {
  return db
    .select()
    .from(attempts)
    .where(eq(attempts.taskId, taskId))
    .orderBy(asc(attempts.attemptNumber), asc(attempts.id))
    .all()
    .map((row) => attemptSummaryFromRow(db, row));
}

function taskContextFromInput(db: DatabaseSession, input: TaskContextQuery): TaskContextPackage {
  const row = currentTask(db, input.taskId);
  if (row.projectId !== input.projectId) {
    throw new TaskNotFoundError({
      taskId: input.taskId,
      message: "That task does not belong to the requested project.",
    });
  }
  const task = taskFromRow(db, row, input);
  const repositoryRoot = projectRepositoryRoot(db, input.projectId);
  const projectContext = readProjectContext(repositoryRoot, task.referencedPaths);
  return taskContextPackageSchema.parse({
    projectId: input.projectId,
    task,
    acceptanceCriteria: task.acceptanceCriteria,
    agentContext: task.agentContext,
    checklist: task.checklist,
    customFields: task.customFields,
    reviewPolicy:
      task.reviewPolicy ??
      reviewPolicyForTask(
        db,
        row,
        db
          .select({ tag: tags })
          .from(taskTags)
          .innerJoin(tags, eq(taskTags.tagId, tags.id))
          .where(eq(taskTags.taskId, row.id))
          .all()
          .map(({ tag }) => tag),
      ),
    relations: {
      upstream: task.upstreamRelations,
      downstream: task.downstreamRelations,
    },
    paths: {
      repositoryRoot,
      referencedPaths: projectContext.referencedPaths,
    },
    priorAttempts: attemptSummariesForTask(db, task.id),
    entries: activityEntriesForTask(db, task.id),
    projectInstructions: projectContext.instructions,
  });
}

function assertExpectedVersion(row: TaskRow, expectedVersion: number) {
  if (row.version !== expectedVersion) {
    throw new TaskVersionConflictError({
      taskId: row.id,
      expectedVersion,
      currentVersion: row.version,
      changeSummary: `Task #${row.sequence} is now version ${row.version} (${row.lifecycle}${row.archivedAt ? ", archived" : ""}).`,
      message: `Task version conflict: expected ${expectedVersion}, current ${row.version}.`,
    });
  }
}

function commandError(error: unknown): TaskCommandError {
  if (
    error instanceof ProjectPathEscapeError ||
    error instanceof ProjectPathValidationError ||
    error instanceof ProjectInstructionTooLargeError ||
    error instanceof ProjectContextLimitError
  ) {
    return new TaskPathError({ path: error.path, message: error.message });
  }
  if (
    error instanceof TaskAlreadyArchivedError ||
    error instanceof TaskAuthorizationError ||
    error instanceof TaskClaimUnavailableError ||
    error instanceof TaskCustomFieldError ||
    error instanceof TaskDiscoveryCursorStaleError ||
    error instanceof TaskIdempotencyConflictError ||
    error instanceof TaskLifecycleError ||
    error instanceof TaskLeaseError ||
    error instanceof TaskNestingError ||
    error instanceof TaskNotFoundError ||
    error instanceof TaskPathError ||
    error instanceof TaskRelationError ||
    error instanceof TaskReviewError ||
    error instanceof TaskTagConstraintError ||
    error instanceof TaskTagDefinitionConflictError ||
    error instanceof TaskVersionConflictError
  ) {
    return error;
  }
  return persistenceError(error);
}

function assertActiveClaimant(db: DatabaseSession, claimant: TaskClaimant) {
  const run = db.select().from(agentRuns).where(eq(agentRuns.id, claimant.runId)).limit(1).get();
  const profile = run
    ? db.select().from(agentProfiles).where(eq(agentProfiles.id, run.profileId)).limit(1).get()
    : null;
  if (!run || run.status !== "active" || !profile || profile.id !== claimant.profileId) {
    throw new TaskLeaseError({
      reason: "inactive_run",
      message: "The registered agent run is no longer active.",
    });
  }
}

function activeLeaseForToken(db: DatabaseSession, token: string, now: string) {
  const row = db
    .select()
    .from(leases)
    .where(eq(leases.tokenHash, leaseTokenHash(token)))
    .limit(1)
    .get();
  if (!row) {
    throw new TaskLeaseError({
      reason: "not_found",
      message: "That lease token is not recognized.",
    });
  }
  if (row.status !== "active") {
    throw new TaskLeaseError({
      taskId: row.taskId,
      leaseId: row.id,
      reason: row.status === "expired" ? "expired" : "inactive",
      leaseStatus: row.status,
      invalidationReason: row.invalidationReason ?? undefined,
      message:
        row.status === "expired"
          ? "That lease has expired."
          : `That lease was ${row.status} and is no longer valid.`,
    });
  }
  if (row.expiresAt <= now) {
    throw new TaskLeaseError({
      taskId: row.taskId,
      leaseId: row.id,
      reason: "expired",
      message: "That lease has expired.",
    });
  }
  return row;
}

function assertLeaseOwner(db: DatabaseSession, row: LeaseRow, claimant: TaskClaimant) {
  assertActiveClaimant(db, claimant);
  if (row.agentRunId !== claimant.runId) {
    throw new TaskLeaseError({
      taskId: row.taskId,
      leaseId: row.id,
      reason: "owner_mismatch",
      message: "That lease belongs to a different agent run.",
    });
  }
}

function activeAttemptForReport(
  db: DatabaseSession,
  input: CompleteTaskInput | FailTaskInput,
  claimant: TaskClaimant,
  context: TaskEvaluationContext,
) {
  const lease = activeLeaseForToken(db, input.leaseToken, context.now);
  assertLeaseOwner(db, lease, claimant);
  if (lease.taskId !== input.taskId) {
    throw new TaskLeaseError({
      taskId: input.taskId,
      leaseId: lease.id,
      reason: "owner_mismatch",
      message: "That lease belongs to a different task.",
    });
  }
  const task = currentTask(db, input.taskId);
  if (task.projectId !== input.projectId) {
    throw new TaskNotFoundError({
      taskId: input.taskId,
      message: "That task does not belong to the requested project.",
    });
  }
  assertExpectedVersion(task, input.expectedVersion);
  if (task.archivedAt || task.lifecycle !== "in_progress") {
    throw new TaskLeaseError({
      taskId: task.id,
      leaseId: lease.id,
      reason: "inactive",
      message: "Only the active in-progress attempt can report a result.",
    });
  }
  const attempt = db.select().from(attempts).where(eq(attempts.id, lease.attemptId)).limit(1).get();
  if (
    !attempt ||
    attempt.taskId !== task.id ||
    attempt.agentRunId !== claimant.runId ||
    attempt.status !== "active"
  ) {
    throw new TaskLeaseError({
      taskId: task.id,
      leaseId: lease.id,
      reason: "inactive",
      message: "The lease no longer has an active execution attempt.",
    });
  }
  return { attempt, lease, task };
}

function closeLeaseAttempt(
  db: DatabaseSession,
  row: LeaseRow,
  status: "released" | "expired" | "cancelled" | "reassigned",
  reason: string,
  now: string,
  attemptStatus: "abandoned" | "cancelled" = "abandoned",
) {
  const attempt = db
    .select({ summary: attempts.summary })
    .from(attempts)
    .where(eq(attempts.id, row.attemptId))
    .limit(1)
    .get();
  db.update(leases)
    .set({ status, invalidatedAt: now, invalidationReason: reason })
    .where(and(eq(leases.id, row.id), eq(leases.status, "active")))
    .run();
  db.update(attempts)
    .set({
      status: attemptStatus,
      summary: attempt?.summary.trim() ? attempt.summary : reason,
      completedAt: now,
    })
    .where(and(eq(attempts.id, row.attemptId), eq(attempts.status, "active")))
    .run();
}

function insertSystemLeaseActivity(
  db: DatabaseSession,
  task: TaskRow,
  lease: LeaseRow,
  status: "expired" | "cancelled",
  reason: string,
  now: string,
) {
  const entryId = `system-lease-${status}-${lease.id}`;
  const content = richTextDocumentSchema.parse({
    version: 1,
    doc: {
      type: "doc",
      content: [{ type: "paragraph", content: [{ type: "text", text: reason }] }],
    },
  });
  db.insert(activityEntries)
    .values({
      id: entryId,
      projectId: task.projectId,
      taskId: task.id,
      attemptId: lease.attemptId,
      kind: "system",
      authorType: "system",
      authorId: "helm",
      authorDisplayName: "Helm",
      agentProfileId: null,
      agentRunId: null,
      contentJson: JSON.stringify(content),
      contentText: reason,
      createdAt: now,
      withdrawnAt: null,
      withdrawnByType: null,
      withdrawnById: null,
      withdrawalReason: null,
    })
    .run();
  return entryId;
}

function invalidateLeaseAsSystem(
  db: DatabaseSession,
  lease: LeaseRow,
  status: "expired" | "cancelled",
  reason: string,
  now: string,
) {
  const task = currentTask(db, lease.taskId);
  closeLeaseAttempt(db, lease, status, reason, now);
  const returnsToReady = task.lifecycle === "in_progress" && !task.archivedAt;
  if (returnsToReady) {
    db.update(tasks)
      .set({ lifecycle: "ready", version: task.version + 1, updatedAt: now })
      .where(and(eq(tasks.id, task.id), eq(tasks.version, task.version)))
      .run();
  }
  const activityEntryId = insertSystemLeaseActivity(db, task, lease, status, reason, now);
  const kind = status === "expired" ? "task.lease.expired" : "task.lease.cancelled";
  db.insert(events)
    .values({
      projectId: task.projectId,
      kind,
      importance: importanceForEventKind(kind),
      actorType: "system",
      actorId: "helm",
      entityType: "task",
      entityId: task.id,
      payloadJson: JSON.stringify({
        leaseId: lease.id,
        attemptId: lease.attemptId,
        agentRunId: lease.agentRunId,
        previousVersion: task.version,
        version: returnsToReady ? task.version + 1 : task.version,
        reason,
        activityEntryId,
      }),
      changesJson: JSON.stringify(
        normalizeEventChangeHints({
          projectIds: [task.projectId],
          taskIds: [task.id],
          activityEntryIds: [activityEntryId],
          agentRunIds: [lease.agentRunId],
          scopes: ["activity", "tasks", "agents"],
        }),
      ),
      occurredAt: now,
    })
    .run();
}

function reconcileLeaseRows(db: DatabaseSession, context: TaskEvaluationContext) {
  const activeLeases = db.select().from(leases).where(eq(leases.status, "active")).all();
  const reconciledLeaseIds: string[] = [];
  for (const lease of activeLeases) {
    const run = db
      .select()
      .from(agentRuns)
      .where(eq(agentRuns.id, lease.agentRunId))
      .limit(1)
      .get();
    const expired = lease.expiresAt <= context.now;
    if (!expired && run?.status === "active") continue;
    const status = expired ? "expired" : "cancelled";
    const reason = expired ? "Lease expired." : "Agent run closed.";
    invalidateLeaseAsSystem(db, lease, status, reason, context.now);
    reconciledLeaseIds.push(lease.id);
  }
  return reconciledLeaseIds;
}

function cancelLeaseRowsForRun(
  db: DatabaseSession,
  agentRunId: string,
  context: TaskEvaluationContext,
) {
  const run = db
    .select({ status: agentRuns.status })
    .from(agentRuns)
    .where(eq(agentRuns.id, agentRunId))
    .limit(1)
    .get();
  if (run?.status !== "closed") return [];

  const activeLeases = db
    .select()
    .from(leases)
    .where(and(eq(leases.agentRunId, agentRunId), eq(leases.status, "active")))
    .all();
  for (const lease of activeLeases) {
    const expired = lease.expiresAt <= context.now;
    invalidateLeaseAsSystem(
      db,
      lease,
      expired ? "expired" : "cancelled",
      expired ? "Lease expired." : "Agent session closed.",
      context.now,
    );
  }
  return activeLeases.map((lease) => lease.id);
}

function reconcileLeasesImmediately(db: DrizzleDatabase, context: TaskEvaluationContext) {
  return db.transaction((tx) => reconcileLeaseRows(tx, context), {
    behavior: "immediate",
  });
}

function createClaimGrant(
  db: DatabaseSession,
  row: TaskRow,
  input: ClaimTaskInput | ClaimNextTaskInput,
  claimant: TaskClaimant,
  context: TaskEvaluationContext,
  command: "task.claim" | "task.claim_next",
  hash: string,
) {
  assertActiveClaimant(db, claimant);
  const evaluated = taskFromRow(db, row, context);
  if (!evaluated.eligibility?.claimable) {
    throw new TaskClaimUnavailableError({
      taskId: row.id,
      eligibilityStatus: evaluated.eligibility?.status,
      reasons: evaluated.eligibility?.reasons ?? ["Task is not claimable."],
      message: `Task #${row.sequence} is not claimable.`,
    });
  }

  const now = context.now;
  const previousAttemptNumber =
    db
      .select({ value: max(attempts.attemptNumber) })
      .from(attempts)
      .where(eq(attempts.taskId, row.id))
      .get()?.value ?? 0;
  const attempt = {
    id: randomUUID(),
    taskId: row.id,
    attemptNumber: previousAttemptNumber + 1,
    agentRunId: claimant.runId,
    agentProfileId: claimant.profileId,
    agentDisplayName: claimant.displayName,
    status: "active" as const,
    summary: "",
    changedAreasJson: "[]",
    verificationJson: "[]",
    referencesJson: "[]",
    risksJson: "[]",
    followUpWorkJson: "[]",
    failureClassification: null,
    createdAt: now,
    completedAt: null,
  };
  const token = randomBytes(32).toString("base64url");
  const lease = {
    id: randomUUID(),
    taskId: row.id,
    attemptId: attempt.id,
    agentRunId: claimant.runId,
    tokenHash: leaseTokenHash(token),
    status: "active" as const,
    acquiredAt: now,
    expiresAt: leaseExpiration(now, input.leaseDurationSeconds),
    invalidatedAt: null,
    invalidationReason: null,
  };
  db.insert(attempts).values(attempt).run();
  db.insert(leases).values(lease).run();
  db.update(tasks)
    .set({ lifecycle: "in_progress", version: row.version + 1, updatedAt: now })
    .where(and(eq(tasks.id, row.id), eq(tasks.version, row.version)))
    .run();
  const task = taskFromRow(db, currentTask(db, row.id), context);
  const grant = taskLeaseGrantSchema.parse({
    task,
    attempt: attemptSummaryFromRow(db, attempt),
    claim: claimFromLeaseRow(db, lease),
    leaseToken: token,
  });
  recordLeaseMutation(
    db,
    input,
    command,
    hash,
    grant,
    { type: "agent", id: claimant.runId },
    {
      kind: "task.claimed",
      occurredAt: now,
      payload: {
        leaseId: lease.id,
        attemptId: attempt.id,
        agentRunId: claimant.runId,
        previousVersion: row.version,
        version: task.version,
        expiresAt: lease.expiresAt,
        selection: command === "task.claim_next" ? "next" : "chosen",
      },
    },
  );
  return grant;
}

function invalidateLease(
  db: DatabaseSession,
  lease: LeaseRow,
  status: "released" | "cancelled" | "reassigned",
  reason: string,
  context: TaskEvaluationContext,
) {
  const row = currentTask(db, lease.taskId);
  if (row.lifecycle !== "in_progress") {
    throw new TaskLeaseError({
      taskId: row.id,
      leaseId: lease.id,
      reason: "inactive",
      message: "The claimed task is no longer in progress.",
    });
  }
  closeLeaseAttempt(db, lease, status, reason, context.now);
  db.update(tasks)
    .set({
      lifecycle: "ready",
      version: row.version + 1,
      updatedAt: context.now,
    })
    .where(and(eq(tasks.id, row.id), eq(tasks.version, row.version)))
    .run();
  return taskLeaseMutationResultSchema.parse({
    task: taskFromRow(db, currentTask(db, row.id), context),
    claim: claimFromLeaseRow(db, {
      ...lease,
      status,
      invalidatedAt: context.now,
      invalidationReason: reason,
    }),
  });
}

function assertHumanTaskActor(actor: Actor) {
  if (actor.type === "human") return;
  throw new TaskAuthorizationError({
    message: "Only the local human can perform this task transition.",
  });
}

function reviewedAttempt(db: DatabaseSession, row: TaskRow, attemptId: string): AttemptRow {
  if (row.lifecycle !== "review" || !row.reviewAttemptId) {
    throw new TaskReviewError({
      taskId: row.id,
      attemptId,
      reviewAttemptId: row.reviewAttemptId ?? undefined,
      reason: "not_in_review",
      message: "That task is not awaiting review.",
    });
  }
  if (row.reviewAttemptId !== attemptId) {
    throw new TaskReviewError({
      taskId: row.id,
      attemptId,
      reviewAttemptId: row.reviewAttemptId,
      reason: "attempt_mismatch",
      message: "That review decision targets a different attempt.",
    });
  }
  const attempt = db.select().from(attempts).where(eq(attempts.id, attemptId)).limit(1).get();
  if (!attempt || attempt.taskId !== row.id || attempt.status !== "completed") {
    throw new TaskReviewError({
      taskId: row.id,
      attemptId,
      reviewAttemptId: row.reviewAttemptId,
      reason: "attempt_mismatch",
      message: "The task review no longer points to a completed attempt.",
    });
  }
  return attempt;
}

function humanChangeRequestEntry(
  db: DatabaseSession,
  input: RequestTaskChangesInput,
  task: TaskRow,
  actor: Actor,
  now: string,
): ActivityEntry {
  const duplicate = db
    .select({ id: activityEntries.id })
    .from(activityEntries)
    .where(eq(activityEntries.id, input.entryId))
    .limit(1)
    .get();
  if (duplicate) {
    throw new TaskIdempotencyConflictError({
      key: input.idempotencyKey,
      message: "That change-request entry identifier already belongs to another command.",
    });
  }
  const content = richTextDocumentSchema.parse({
    version: 1,
    doc: {
      type: "doc",
      content: [
        {
          type: "paragraph",
          content: [{ type: "text", text: input.summary }],
        },
        {
          type: "bulletList",
          content: input.requestedChanges.map((change) => ({
            type: "listItem",
            content: [
              {
                type: "paragraph",
                content: [{ type: "text", text: change }],
              },
            ],
          })),
        },
      ],
    },
  });
  db.insert(activityEntries)
    .values({
      id: input.entryId,
      projectId: task.projectId,
      taskId: task.id,
      attemptId: input.attemptId,
      kind: "change_request",
      authorType: actor.type,
      authorId: actor.id,
      authorDisplayName: "You",
      agentProfileId: null,
      agentRunId: null,
      contentJson: JSON.stringify(content),
      contentText: richTextToPlainText(content),
      createdAt: now,
      withdrawnAt: null,
      withdrawnByType: null,
      withdrawnById: null,
      withdrawalReason: null,
    })
    .run();
  const inserted = db
    .select()
    .from(activityEntries)
    .where(eq(activityEntries.id, input.entryId))
    .limit(1)
    .get();
  if (!inserted) throw new Error("The review change request could not be reloaded.");
  return activityEntrySchema.parse({
    id: inserted.id,
    projectId: inserted.projectId,
    taskId: inserted.taskId,
    attemptId: inserted.attemptId,
    kind: inserted.kind,
    author: { type: inserted.authorType, id: inserted.authorId },
    authorDisplayName: inserted.authorDisplayName,
    agentProfileId: inserted.agentProfileId,
    content,
    contentText: inserted.contentText,
    createdAt: inserted.createdAt,
    withdrawnAt: null,
    withdrawnBy: null,
    withdrawalReason: null,
  });
}

function readTaskProjections(db: DatabaseSession, input: TaskListQuery) {
  const where = input.taskIds
    ? and(eq(tasks.projectId, input.projectId), inArray(tasks.id, input.taskIds))
    : input.includeArchived
      ? eq(tasks.projectId, input.projectId)
      : and(eq(tasks.projectId, input.projectId), isNull(tasks.archivedAt));
  return db
    .select()
    .from(tasks)
    .where(where)
    .orderBy(asc(tasks.sequence))
    .all()
    .map((row) => taskFromRow(db, row, input))
    .toSorted(compareTaskOrder);
}

/** Hydrates the canonical task read model for SQLite-backed query adapters. */
export function readSqliteTaskProjections(
  database: Database.Database,
  input: TaskListQuery,
): readonly Task[] {
  return readTaskProjections(drizzle(database, { schema }), input);
}

export function createSqliteTaskStore(database: Database.Database): TaskStore {
  const db = drizzle(database, { schema });
  const leaseTokenCache = leaseTokenCacheFor(database);

  function evictLeaseTokens(leaseIds: readonly string[]) {
    for (const leaseId of leaseIds) leaseTokenCache.delete(leaseId);
  }

  function reconcileAndEvict(context: TaskEvaluationContext) {
    const leaseIds = reconcileLeasesImmediately(db, context);
    evictLeaseTokens(leaseIds);
    return leaseIds.length;
  }

  return {
    list(input: TaskListQuery) {
      return Effect.try({
        try: () => readTaskProjections(db, input),
        catch: persistenceError,
      });
    },
    listTags(input) {
      return Effect.try({
        try: () =>
          db
            .select()
            .from(tags)
            .where(eq(tags.projectId, input.projectId))
            .orderBy(asc(tags.name), asc(tags.id))
            .all()
            .map((tag) => tagSchema.parse(tag)),
        catch: persistenceError,
      });
    },
    listAttempts(input) {
      return Effect.try({
        try: () => {
          const where = input.taskIds
            ? and(eq(tasks.projectId, input.projectId), inArray(attempts.taskId, input.taskIds))
            : eq(tasks.projectId, input.projectId);
          return db
            .select({ attempt: attempts })
            .from(attempts)
            .innerJoin(tasks, eq(attempts.taskId, tasks.id))
            .where(where)
            .orderBy(asc(attempts.attemptNumber), asc(attempts.id))
            .all()
            .map(({ attempt }) => attemptSummaryFromRow(db, attempt));
        },
        catch: persistenceError,
      });
    },
    discoverPage(input: TaskDiscoveryQuery) {
      return Effect.try({
        try: () =>
          discoveryPageFromTasks(
            discoverableTasks(db, input),
            input,
            discoveryRevision(db, input.projectId),
            input.fields.includes("referencedPaths")
              ? projectRepositoryRoot(db, input.projectId)
              : undefined,
          ),
        catch: commandError,
      });
    },
    getContext(input: TaskContextQuery) {
      return Effect.try({
        try: () => taskContextFromInput(db, input),
        catch: commandError,
      });
    },
    claimTask(input, claimant, context) {
      return Effect.try({
        try: () => {
          const command = "task.claim";
          assertActiveClaimant(db, claimant);
          const hash = inputHash(command, {
            ...withoutIdempotencyKey(input),
            claimantRunId: claimant.runId,
          });
          const cached = findIdempotentLeaseResult(
            db,
            command,
            input.idempotencyKey,
            hash,
            "grant",
            { tokenCache: leaseTokenCache, now: context.now },
          );
          if (cached) return taskLeaseGrantSchema.parse(cached);
          reconcileAndEvict(context);
          const grant = db.transaction(
            (tx) => {
              const existing = findIdempotentLeaseResult(
                tx,
                command,
                input.idempotencyKey,
                hash,
                "grant",
                { tokenCache: leaseTokenCache, now: context.now },
              );
              if (existing) return taskLeaseGrantSchema.parse(existing);
              const row = currentTask(tx, input.taskId);
              if (row.projectId !== input.projectId) {
                throw new TaskNotFoundError({
                  taskId: input.taskId,
                  message: "That task does not belong to the requested project.",
                });
              }
              assertExpectedVersion(row, input.expectedVersion);
              return createClaimGrant(tx, row, input, claimant, context, command, hash);
            },
            { behavior: "immediate" },
          );
          leaseTokenCache.set(grant.claim.id, grant.leaseToken);
          return grant;
        },
        catch: commandError,
      });
    },
    claimNext(input, claimant, context) {
      return Effect.try({
        try: () => {
          const command = "task.claim_next";
          assertActiveClaimant(db, claimant);
          const hash = inputHash(command, {
            ...withoutIdempotencyKey(input),
            claimantRunId: claimant.runId,
          });
          const cached = findIdempotentLeaseResult(
            db,
            command,
            input.idempotencyKey,
            hash,
            "grant",
            { tokenCache: leaseTokenCache, now: context.now },
          );
          if (cached) return taskLeaseGrantSchema.parse(cached);
          reconcileAndEvict(context);
          const grant = db.transaction(
            (tx) => {
              const existing = findIdempotentLeaseResult(
                tx,
                command,
                input.idempotencyKey,
                hash,
                "grant",
                { tokenCache: leaseTokenCache, now: context.now },
              );
              if (existing) return taskLeaseGrantSchema.parse(existing);
              assertActiveClaimant(tx, claimant);
              const next = discoverableTasks(tx, {
                ...input,
                limit: 1,
                cursor: null,
                fields: [],
                ...context,
              })[0];
              if (!next) {
                throw new TaskClaimUnavailableError({
                  reasons: ["No task is currently eligible for this agent."],
                  message: "No claimable task is available.",
                });
              }
              return createClaimGrant(
                tx,
                currentTask(tx, next.id),
                input,
                claimant,
                context,
                command,
                hash,
              );
            },
            { behavior: "immediate" },
          );
          leaseTokenCache.set(grant.claim.id, grant.leaseToken);
          return grant;
        },
        catch: commandError,
      });
    },
    renewLease(input, claimant, context) {
      return Effect.try({
        try: () => {
          const command = "task.lease.renew";
          assertActiveClaimant(db, claimant);
          const hash = inputHash(command, {
            ...withoutIdempotencyKey(input),
            claimantRunId: claimant.runId,
          });
          const cached = findIdempotentLeaseResult(
            db,
            command,
            input.idempotencyKey,
            hash,
            "grant",
            {
              providedToken: input.leaseToken,
              tokenCache: leaseTokenCache,
              now: context.now,
            },
          );
          if (cached) return taskLeaseGrantSchema.parse(cached);
          reconcileAndEvict(context);
          return db.transaction(
            (tx) => {
              const existing = findIdempotentLeaseResult(
                tx,
                command,
                input.idempotencyKey,
                hash,
                "grant",
                {
                  providedToken: input.leaseToken,
                  tokenCache: leaseTokenCache,
                  now: context.now,
                },
              );
              if (existing) return taskLeaseGrantSchema.parse(existing);
              const lease = activeLeaseForToken(tx, input.leaseToken, context.now);
              assertLeaseOwner(tx, lease, claimant);
              const row = currentTask(tx, lease.taskId);
              assertExpectedVersion(row, input.expectedVersion);
              if (row.lifecycle !== "in_progress") {
                throw new TaskLeaseError({
                  taskId: row.id,
                  leaseId: lease.id,
                  reason: "inactive",
                  message: "Only an in-progress claim can be renewed.",
                });
              }
              const expiresAt = leaseExpiration(context.now, input.leaseDurationSeconds);
              tx.update(leases)
                .set({ expiresAt })
                .where(and(eq(leases.id, lease.id), eq(leases.status, "active")))
                .run();
              tx.update(tasks)
                .set({ version: row.version + 1, updatedAt: context.now })
                .where(and(eq(tasks.id, row.id), eq(tasks.version, row.version)))
                .run();
              const updatedLease = { ...lease, expiresAt };
              const attempt = tx
                .select()
                .from(attempts)
                .where(eq(attempts.id, lease.attemptId))
                .limit(1)
                .get();
              if (!attempt) {
                throw new TaskLeaseError({
                  taskId: row.id,
                  leaseId: lease.id,
                  reason: "inactive",
                  message: "The lease attempt no longer exists.",
                });
              }
              const grant = taskLeaseGrantSchema.parse({
                task: taskFromRow(tx, currentTask(tx, row.id), context),
                attempt: attemptSummaryFromRow(tx, attempt),
                claim: claimFromLeaseRow(tx, updatedLease),
                leaseToken: input.leaseToken,
              });
              recordLeaseMutation(
                tx,
                input,
                command,
                hash,
                grant,
                { type: "agent", id: claimant.runId },
                {
                  kind: "task.lease.renewed",
                  occurredAt: context.now,
                  payload: {
                    leaseId: lease.id,
                    attemptId: lease.attemptId,
                    previousVersion: row.version,
                    version: grant.task.version,
                    expiresAt,
                  },
                },
              );
              return grant;
            },
            { behavior: "immediate" },
          );
        },
        catch: commandError,
      });
    },
    releaseLease(input, claimant, context) {
      return Effect.try({
        try: () => {
          const command = "task.lease.release";
          assertActiveClaimant(db, claimant);
          const hash = inputHash(command, {
            ...withoutIdempotencyKey(input),
            claimantRunId: claimant.runId,
          });
          const cached = findIdempotentLeaseResult(
            db,
            command,
            input.idempotencyKey,
            hash,
            "mutation",
          );
          if (cached) {
            const result = taskLeaseMutationResultSchema.parse(cached);
            leaseTokenCache.delete(result.claim.id);
            return result;
          }
          reconcileAndEvict(context);
          const mutation = db.transaction(
            (tx) => {
              const existing = findIdempotentLeaseResult(
                tx,
                command,
                input.idempotencyKey,
                hash,
                "mutation",
              );
              if (existing) return taskLeaseMutationResultSchema.parse(existing);
              const lease = activeLeaseForToken(tx, input.leaseToken, context.now);
              assertLeaseOwner(tx, lease, claimant);
              const row = currentTask(tx, lease.taskId);
              assertExpectedVersion(row, input.expectedVersion);
              const result = invalidateLease(tx, lease, "released", input.reason, context);
              recordLeaseMutation(
                tx,
                input,
                command,
                hash,
                result,
                { type: "agent", id: claimant.runId },
                {
                  kind: "task.lease.released",
                  occurredAt: context.now,
                  payload: {
                    leaseId: lease.id,
                    attemptId: lease.attemptId,
                    previousVersion: row.version,
                    version: result.task.version,
                    reason: input.reason,
                  },
                },
              );
              return result;
            },
            { behavior: "immediate" },
          );
          leaseTokenCache.delete(mutation.claim.id);
          return mutation;
        },
        catch: commandError,
      });
    },
    invalidateClaim(input, actor, context) {
      return Effect.try({
        try: () => {
          const command = "task.claim.invalidate";
          const hash = inputHash(command, withoutIdempotencyKey(input));
          const cached = findIdempotentLeaseResult(
            db,
            command,
            input.idempotencyKey,
            hash,
            "mutation",
          );
          if (cached) {
            const result = taskLeaseMutationResultSchema.parse(cached);
            leaseTokenCache.delete(result.claim.id);
            return result;
          }
          reconcileAndEvict(context);
          const mutation = db.transaction(
            (tx) => {
              const existing = findIdempotentLeaseResult(
                tx,
                command,
                input.idempotencyKey,
                hash,
                "mutation",
              );
              if (existing) return taskLeaseMutationResultSchema.parse(existing);
              const row = currentTask(tx, input.taskId);
              assertExpectedVersion(row, input.expectedVersion);
              const lease = tx
                .select()
                .from(leases)
                .where(and(eq(leases.taskId, row.id), eq(leases.status, "active")))
                .limit(1)
                .get();
              if (!lease) {
                throw new TaskLeaseError({
                  taskId: row.id,
                  reason: "required",
                  message: "That task has no active claim to invalidate.",
                });
              }
              const result = invalidateLease(tx, lease, input.disposition, input.reason, context);
              recordLeaseMutation(tx, input, command, hash, result, actor, {
                kind:
                  input.disposition === "reassigned"
                    ? "task.lease.reassigned"
                    : "task.lease.cancelled",
                occurredAt: context.now,
                payload: {
                  leaseId: lease.id,
                  attemptId: lease.attemptId,
                  agentRunId: lease.agentRunId,
                  previousVersion: row.version,
                  version: result.task.version,
                  reason: input.reason,
                },
              });
              return result;
            },
            { behavior: "immediate" },
          );
          leaseTokenCache.delete(mutation.claim.id);
          return mutation;
        },
        catch: commandError,
      });
    },
    cancelLeasesForRun(agentRunId, context) {
      return Effect.try({
        try: () => {
          const leaseIds = db.transaction((tx) => cancelLeaseRowsForRun(tx, agentRunId, context), {
            behavior: "immediate",
          });
          evictLeaseTokens(leaseIds);
          return leaseIds.length;
        },
        catch: commandError,
      });
    },
    reconcileLeases(context) {
      return Effect.try({
        try: () => reconcileAndEvict(context),
        catch: commandError,
      });
    },
    create(input: CreateTaskInput, actor: Actor, context: TaskEvaluationContext) {
      return Effect.try({
        try: () =>
          db.transaction((tx) => {
            const command = "task.create";
            const hash = inputHash(command, withoutIdempotencyKey(input));
            const existing = findIdempotentResult(tx, command, input.idempotencyKey, hash, context);
            if (existing) return existing;
            const referencedPaths = validateProjectReferencedPaths(
              projectRepositoryRoot(tx, input.projectId),
              input.referencedPaths,
            );
            assertCanUseParent(tx, input.projectId, input.parentTaskId);

            const [sequenceResult] = tx
              .select({ value: max(tasks.sequence) })
              .from(tasks)
              .where(eq(tasks.projectId, input.projectId))
              .all();
            const now = context.now;
            const sequence = (sequenceResult?.value ?? 0) + 1;
            const planning = taskPlanningForCreate(input, sequence);
            const task: Task = {
              id: randomUUID(),
              projectId: input.projectId,
              sequence,
              parentTaskId: input.parentTaskId,
              childTaskIds: [],
              title: input.title,
              lifecycle: input.lifecycle,
              priority: planning.priority,
              position: planning.position,
              notBefore: planning.notBefore,
              dueAt: planning.dueAt,
              size: planning.size,
              tags: [],
              customFields: [],
              reviewModeOverride: null,
              reviewPolicy: null,
              requiredCapabilities: [],
              referencedPaths: [],
              claim: null,
              upstreamRelations: [],
              downstreamRelations: [],
              description: input.description,
              descriptionText: richTextToPlainText(input.description),
              expectedOutcome: input.expectedOutcome,
              acceptanceCriteria: input.acceptanceCriteria,
              agentContext: input.agentContext,
              checklist: input.checklist,
              reviewAttemptId: null,
              cancelledFromLifecycle: null,
              version: 1,
              archivedAt: null,
              createdAt: now,
              updatedAt: now,
            };
            tx.insert(tasks)
              .values({
                id: task.id,
                projectId: task.projectId,
                sequence: task.sequence,
                parentTaskId: task.parentTaskId,
                title: task.title,
                lifecycle: task.lifecycle,
                priority: task.priority,
                position: task.position,
                notBefore: task.notBefore,
                dueAt: task.dueAt,
                size: task.size,
                descriptionJson: JSON.stringify(task.description),
                descriptionText: task.descriptionText,
                expectedOutcome: task.expectedOutcome,
                acceptanceCriteria: task.acceptanceCriteria,
                agentContext: task.agentContext,
                checklistJson: JSON.stringify(task.checklist),
                reviewModeOverride: null,
                version: task.version,
                archivedAt: task.archivedAt,
                createdAt: task.createdAt,
                updatedAt: task.updatedAt,
              })
              .run();
            replaceTagAssignments(tx, task.id, task.projectId, planning.tags, now);
            replaceRequiredCapabilities(tx, task.id, planning.requiredCapabilities);
            replaceReferencedPaths(tx, task.id, referencedPaths);
            replaceCustomFieldValues(tx, task.id, task.projectId, input.customFields ?? [], now);
            const created = taskFromRow(tx, currentTask(tx, task.id), context);
            recordMutation(tx, input, command, hash, created, actor, {
              kind: "task.created",
              payload: {
                sequence: created.sequence,
                title: created.title,
                lifecycle: created.lifecycle,
                priority: created.priority,
                parentTaskId: created.parentTaskId,
                tags: created.tags,
                requiredCapabilities: created.requiredCapabilities,
                customFields: created.customFields,
                reviewModeOverride: created.reviewModeOverride,
                reviewPolicy: created.reviewPolicy,
                referencedPaths: created.referencedPaths,
              },
            });
            return created;
          }),
        catch: commandError,
      });
    },
    prepare(input: PrepareTaskInput, actor: Actor, context: TaskEvaluationContext) {
      return Effect.try({
        try: () =>
          db.transaction((tx) => {
            const command = "task.prepare";
            const hash = inputHash(command, withoutIdempotencyKey(input));
            const existing = findIdempotentResult(tx, command, input.idempotencyKey, hash, context);
            if (existing) return existing;
            const row = currentTask(tx, input.taskId);
            assertExpectedVersion(row, input.expectedVersion);
            if (row.archivedAt) {
              throw new TaskAlreadyArchivedError({
                taskId: row.id,
                message: "Archived tasks cannot be prepared.",
              });
            }
            if (row.lifecycle !== "backlog" && row.lifecycle !== "ready") {
              throw new TaskLifecycleError({
                taskId: row.id,
                lifecycle: row.lifecycle,
                message: "Only backlog or ready tasks can have their preparation updated.",
              });
            }
            if (input.saveAsDraft && row.lifecycle !== "backlog") {
              throw new TaskLifecycleError({
                taskId: row.id,
                lifecycle: row.lifecycle,
                message:
                  "Only backlog tasks can be saved as incomplete drafts. Ready tasks must remain fully prepared.",
              });
            }
            const referencedPaths = validateProjectReferencedPaths(
              projectRepositoryRoot(tx, row.projectId),
              input.referencedPaths,
            );

            const now = context.now;
            tx.update(tasks)
              .set({
                title: input.title,
                lifecycle: input.saveAsDraft ? "backlog" : "ready",
                priority: input.priority ?? row.priority,
                position: input.position ?? row.position,
                notBefore: hasInputField(input, "notBefore")
                  ? (input.notBefore ?? null)
                  : row.notBefore,
                dueAt: hasInputField(input, "dueAt") ? (input.dueAt ?? null) : row.dueAt,
                size: hasInputField(input, "size") ? (input.size ?? null) : row.size,
                descriptionJson: JSON.stringify(input.description),
                descriptionText: richTextToPlainText(input.description),
                expectedOutcome: input.expectedOutcome,
                acceptanceCriteria: input.acceptanceCriteria,
                agentContext: input.agentContext,
                checklistJson: JSON.stringify(input.checklist),
                version: row.version + 1,
                updatedAt: now,
              })
              .where(and(eq(tasks.id, row.id), eq(tasks.version, row.version)))
              .run();
            if (input.tags) replaceTagAssignments(tx, row.id, row.projectId, input.tags, now);
            if (input.requiredCapabilities) {
              replaceRequiredCapabilities(tx, row.id, input.requiredCapabilities);
            }
            if (input.customFields) {
              replaceCustomFieldValues(tx, row.id, row.projectId, input.customFields, now);
            }
            replaceReferencedPaths(tx, row.id, referencedPaths);
            const task = taskFromRow(tx, currentTask(tx, row.id), context);
            recordMutation(tx, input, command, hash, task, actor, {
              kind: input.saveAsDraft ? "task.draft_saved" : "task.prepared",
              payload: {
                previousVersion: row.version,
                version: task.version,
                lifecycle: task.lifecycle,
                priority: task.priority,
                tags: task.tags,
                requiredCapabilities: task.requiredCapabilities,
                customFields: task.customFields,
                reviewModeOverride: task.reviewModeOverride,
                reviewPolicy: task.reviewPolicy,
                referencedPaths: task.referencedPaths,
              },
            });
            return task;
          }),
        catch: commandError,
      });
    },
    setReviewModeOverride(
      input: SetTaskReviewModeOverrideInput,
      actor: Actor,
      context: TaskEvaluationContext,
    ) {
      return Effect.try({
        try: () =>
          db.transaction((tx) => {
            const command = "task.review_policy.override.set";
            const hash = inputHash(command, withoutIdempotencyKey(input));
            const existing = findIdempotentResult(tx, command, input.idempotencyKey, hash, context);
            if (existing) return existing;
            const row = currentTask(tx, input.taskId);
            if (row.projectId !== input.projectId) {
              throw new TaskNotFoundError({
                taskId: input.taskId,
                message: "That task does not belong to the requested project.",
              });
            }
            assertExpectedVersion(row, input.expectedTaskVersion);
            if (row.archivedAt || (row.lifecycle !== "backlog" && row.lifecycle !== "ready")) {
              throw new TaskLifecycleError({
                taskId: row.id,
                lifecycle: row.lifecycle,
                message: "Only active backlog or ready tasks can change review policy.",
              });
            }

            const now = context.now;
            tx.update(tasks)
              .set({
                reviewModeOverride: input.reviewModeOverride,
                version: row.version + 1,
                updatedAt: now,
              })
              .where(and(eq(tasks.id, row.id), eq(tasks.version, row.version)))
              .run();
            const task = taskFromRow(tx, currentTask(tx, row.id), context);
            recordMutation(tx, input, command, hash, task, actor, {
              kind: "task.review_policy.override.changed",
              payload: {
                previousVersion: row.version,
                version: task.version,
                previousReviewModeOverride: row.reviewModeOverride,
                reviewModeOverride: task.reviewModeOverride,
                reviewPolicy: task.reviewPolicy,
                reason: input.reason,
              },
            });
            return task;
          }),
        catch: commandError,
      });
    },
    updatePlanning(input: UpdateTaskPlanningInput, actor: Actor, context: TaskEvaluationContext) {
      return Effect.try({
        try: () =>
          db.transaction((tx) => {
            const command = "task.planning.update";
            const hash = inputHash(command, withoutIdempotencyKey(input));
            const existing = findIdempotentResult(tx, command, input.idempotencyKey, hash, context);
            if (existing) return existing;
            const row = currentTask(tx, input.taskId);
            assertExpectedVersion(row, input.expectedVersion);
            if (row.archivedAt) {
              throw new TaskAlreadyArchivedError({
                taskId: row.id,
                message: "Archived tasks cannot be reprioritized or routed.",
              });
            }
            if (row.lifecycle !== "backlog" && row.lifecycle !== "ready") {
              throw new TaskLifecycleError({
                taskId: row.id,
                lifecycle: row.lifecycle,
                message: "Only backlog or ready tasks can be reprioritized or routed.",
              });
            }

            const now = context.now;
            tx.update(tasks)
              .set({
                priority: input.priority,
                position: input.position,
                notBefore: input.notBefore,
                dueAt: input.dueAt,
                size: input.size,
                version: row.version + 1,
                updatedAt: now,
              })
              .where(and(eq(tasks.id, row.id), eq(tasks.version, row.version)))
              .run();
            replaceTagAssignments(tx, row.id, row.projectId, input.tags, now);
            replaceRequiredCapabilities(tx, row.id, input.requiredCapabilities);
            if (input.customFields) {
              replaceCustomFieldValues(tx, row.id, row.projectId, input.customFields, now);
            }
            const task = taskFromRow(tx, currentTask(tx, row.id), context);
            recordMutation(tx, input, command, hash, task, actor, {
              kind: "task.planning.updated",
              payload: {
                previousVersion: row.version,
                version: task.version,
                priority: task.priority,
                position: task.position,
                notBefore: task.notBefore,
                dueAt: task.dueAt,
                size: task.size,
                tags: task.tags.map(({ name, description, color, exclusiveGroup }) => ({
                  name,
                  description,
                  color,
                  exclusiveGroup,
                })),
                requiredCapabilities: task.requiredCapabilities,
                customFields: task.customFields,
                reviewModeOverride: task.reviewModeOverride,
                reviewPolicy: task.reviewPolicy,
              },
            });
            return task;
          }),
        catch: commandError,
      });
    },
    completeAttempt(
      input: CompleteTaskInput,
      claimant: TaskClaimant,
      context: TaskEvaluationContext,
    ) {
      return Effect.try({
        try: () => {
          const command = "task.attempt.complete";
          assertActiveClaimant(db, claimant);
          const hash = inputHash(command, {
            ...withoutIdempotencyKey(input),
            claimantRunId: claimant.runId,
          });
          const cached = findIdempotentSnapshot(db, command, input.idempotencyKey, hash, (value) =>
            taskCompletionResultSchema.parse(value),
          );
          if (cached) {
            leaseTokenCache.delete(cached.claim.id);
            return cached;
          }
          reconcileAndEvict(context);
          const result = db.transaction(
            (tx) => {
              const existing = findIdempotentSnapshot(
                tx,
                command,
                input.idempotencyKey,
                hash,
                (value) => taskCompletionResultSchema.parse(value),
              );
              if (existing) return existing;
              const committedContext = refreshEvaluationTime(context);
              const {
                attempt,
                lease,
                task: row,
              } = activeAttemptForReport(tx, input, claimant, committedContext);
              const assignedTags = tx
                .select({ tag: tags })
                .from(taskTags)
                .innerJoin(tags, eq(taskTags.tagId, tags.id))
                .where(eq(taskTags.taskId, row.id))
                .all()
                .map(({ tag }) => tag);
              const policy = reviewPolicyForTask(tx, row, assignedTags);
              const reviewMode = policy.mode;
              const destination = policy.destination;
              const attemptUpdate = tx
                .update(attempts)
                .set({
                  status: "completed",
                  summary: input.report.resultSummary,
                  changedAreasJson: JSON.stringify(input.report.changedAreas),
                  verificationJson: JSON.stringify(input.report.verificationResults),
                  referencesJson: JSON.stringify(input.report.references),
                  risksJson: JSON.stringify(input.report.risks),
                  followUpWorkJson: JSON.stringify(input.report.followUpWork),
                  failureClassification: null,
                  completedAt: committedContext.now,
                })
                .where(and(eq(attempts.id, attempt.id), eq(attempts.status, "active")))
                .run();
              const leaseUpdate = tx
                .update(leases)
                .set({
                  status: "released",
                  invalidatedAt: committedContext.now,
                  invalidationReason: "Completion report accepted.",
                })
                .where(and(eq(leases.id, lease.id), eq(leases.status, "active")))
                .run();
              const taskUpdate = tx
                .update(tasks)
                .set({
                  lifecycle: destination,
                  reviewAttemptId: destination === "review" ? attempt.id : null,
                  cancelledFromLifecycle: null,
                  version: row.version + 1,
                  updatedAt: committedContext.now,
                })
                .where(and(eq(tasks.id, row.id), eq(tasks.version, row.version)))
                .run();
              if (
                attemptUpdate.changes !== 1 ||
                leaseUpdate.changes !== 1 ||
                taskUpdate.changes !== 1
              ) {
                throw new TaskLeaseError({
                  taskId: row.id,
                  leaseId: lease.id,
                  reason: "inactive",
                  message: "The execution attempt changed before completion could commit.",
                });
              }
              const task = taskFromRow(tx, currentTask(tx, row.id), committedContext);
              const completedAttempt = tx
                .select()
                .from(attempts)
                .where(eq(attempts.id, attempt.id))
                .limit(1)
                .get();
              if (!completedAttempt)
                throw new Error("The completed attempt could not be reloaded.");
              const claim = claimFromLeaseRow(tx, {
                ...lease,
                status: "released",
                invalidatedAt: committedContext.now,
                invalidationReason: "Completion report accepted.",
              });
              const kind = destination === "review" ? "task.review.requested" : "task.completed";
              const event = appendTaskEvent(
                tx,
                task,
                { type: "agent", id: claimant.runId },
                kind,
                {
                  attemptId: attempt.id,
                  leaseId: lease.id,
                  agentRunId: claimant.runId,
                  previousVersion: row.version,
                  version: task.version,
                  reviewModeApplied: reviewMode,
                  reviewPolicy: policy,
                  destination,
                  summary: input.report.resultSummary,
                  changedAreas: input.report.changedAreas,
                  verificationResults: input.report.verificationResults,
                  references: input.report.references,
                  risks: input.report.risks,
                  followUpWork: input.report.followUpWork,
                },
                {
                  taskIds: destination === "done" ? blockingRelationTargetIds(tx, row.id) : [],
                  agentRunIds: [claimant.runId],
                  scopes: ["agents"],
                },
              );
              const snapshot = taskCompletionResultSchema.parse({
                task,
                attempt: attemptSummaryFromRow(tx, completedAttempt),
                claim,
                event,
                routing: { reviewMode, destination, policy },
              });
              recordResultSnapshot(tx, input, command, hash, snapshot, committedContext.now);
              return snapshot;
            },
            { behavior: "immediate" },
          );
          leaseTokenCache.delete(result.claim.id);
          return result;
        },
        catch: commandError,
      });
    },
    failAttempt(input: FailTaskInput, claimant: TaskClaimant, context: TaskEvaluationContext) {
      return Effect.try({
        try: () => {
          const command = "task.attempt.fail";
          assertActiveClaimant(db, claimant);
          const hash = inputHash(command, {
            ...withoutIdempotencyKey(input),
            claimantRunId: claimant.runId,
          });
          const cached = findIdempotentSnapshot(db, command, input.idempotencyKey, hash, (value) =>
            taskFailureResultSchema.parse(value),
          );
          if (cached) {
            leaseTokenCache.delete(cached.claim.id);
            return cached;
          }
          reconcileAndEvict(context);
          const result = db.transaction(
            (tx) => {
              const existing = findIdempotentSnapshot(
                tx,
                command,
                input.idempotencyKey,
                hash,
                (value) => taskFailureResultSchema.parse(value),
              );
              if (existing) return existing;
              const committedContext = refreshEvaluationTime(context);
              const {
                attempt,
                lease,
                task: row,
              } = activeAttemptForReport(tx, input, claimant, committedContext);
              const attemptUpdate = tx
                .update(attempts)
                .set({
                  status: "failed",
                  summary: input.report.reason,
                  changedAreasJson: JSON.stringify(input.report.changedAreas),
                  verificationJson: JSON.stringify(input.report.verificationResults),
                  referencesJson: JSON.stringify(input.report.references),
                  risksJson: JSON.stringify(input.report.risks),
                  followUpWorkJson: JSON.stringify(input.report.followUpWork),
                  failureClassification: input.report.classification,
                  completedAt: committedContext.now,
                })
                .where(and(eq(attempts.id, attempt.id), eq(attempts.status, "active")))
                .run();
              const invalidationReason = `Attempt failed (${input.report.classification}).`;
              const leaseUpdate = tx
                .update(leases)
                .set({
                  status: "released",
                  invalidatedAt: committedContext.now,
                  invalidationReason,
                })
                .where(and(eq(leases.id, lease.id), eq(leases.status, "active")))
                .run();
              const taskUpdate = tx
                .update(tasks)
                .set({
                  lifecycle: "ready",
                  reviewAttemptId: null,
                  cancelledFromLifecycle: null,
                  version: row.version + 1,
                  updatedAt: committedContext.now,
                })
                .where(and(eq(tasks.id, row.id), eq(tasks.version, row.version)))
                .run();
              if (
                attemptUpdate.changes !== 1 ||
                leaseUpdate.changes !== 1 ||
                taskUpdate.changes !== 1
              ) {
                throw new TaskLeaseError({
                  taskId: row.id,
                  leaseId: lease.id,
                  reason: "inactive",
                  message: "The execution attempt changed before failure could commit.",
                });
              }
              const task = taskFromRow(tx, currentTask(tx, row.id), committedContext);
              const failedAttempt = tx
                .select()
                .from(attempts)
                .where(eq(attempts.id, attempt.id))
                .limit(1)
                .get();
              if (!failedAttempt) throw new Error("The failed attempt could not be reloaded.");
              const claim = claimFromLeaseRow(tx, {
                ...lease,
                status: "released",
                invalidatedAt: committedContext.now,
                invalidationReason,
              });
              const event = appendTaskEvent(
                tx,
                task,
                { type: "agent", id: claimant.runId },
                "task.attempt.failed",
                {
                  attemptId: attempt.id,
                  leaseId: lease.id,
                  agentRunId: claimant.runId,
                  previousVersion: row.version,
                  version: task.version,
                  classification: input.report.classification,
                  reason: input.report.reason,
                  changedAreas: input.report.changedAreas,
                  verificationResults: input.report.verificationResults,
                  references: input.report.references,
                  risks: input.report.risks,
                  followUpWork: input.report.followUpWork,
                },
                { agentRunIds: [claimant.runId], scopes: ["agents"] },
              );
              const snapshot = taskFailureResultSchema.parse({
                task,
                attempt: attemptSummaryFromRow(tx, failedAttempt),
                claim,
                event,
              });
              recordResultSnapshot(tx, input, command, hash, snapshot, committedContext.now);
              return snapshot;
            },
            { behavior: "immediate" },
          );
          leaseTokenCache.delete(result.claim.id);
          return result;
        },
        catch: commandError,
      });
    },
    approveReview(input: ApproveTaskReviewInput, actor: Actor, context: TaskEvaluationContext) {
      return Effect.try({
        try: () =>
          db.transaction(
            (tx) => {
              assertHumanTaskActor(actor);
              const command = "task.review.approve";
              const hash = inputHash(command, { ...withoutIdempotencyKey(input), actor });
              const existing = findIdempotentSnapshot(
                tx,
                command,
                input.idempotencyKey,
                hash,
                (value) => taskTransitionResultSchema.parse(value),
              );
              if (existing) return existing;
              const row = currentTask(tx, input.taskId);
              assertExpectedVersion(row, input.expectedVersion);
              if (row.archivedAt) {
                throw new TaskAlreadyArchivedError({
                  taskId: row.id,
                  message: "Archived tasks cannot be reviewed.",
                });
              }
              const attempt = reviewedAttempt(tx, row, input.attemptId);
              const taskUpdate = tx
                .update(tasks)
                .set({
                  lifecycle: "done",
                  reviewAttemptId: null,
                  version: row.version + 1,
                  updatedAt: context.now,
                })
                .where(and(eq(tasks.id, row.id), eq(tasks.version, row.version)))
                .run();
              if (taskUpdate.changes !== 1) {
                throw new TaskVersionConflictError({
                  taskId: row.id,
                  expectedVersion: row.version,
                  currentVersion: currentTask(tx, row.id).version,
                  changeSummary: "The task changed during review.",
                  message: "The task changed before approval could commit.",
                });
              }
              const task = taskFromRow(tx, currentTask(tx, row.id), context);
              const event = appendTaskEvent(
                tx,
                task,
                actor,
                "task.review.approved",
                {
                  attemptId: attempt.id,
                  previousVersion: row.version,
                  version: task.version,
                  summary: input.summary,
                },
                {
                  taskIds: blockingRelationTargetIds(tx, row.id),
                  agentRunIds: attempt.agentRunId ? [attempt.agentRunId] : [],
                  scopes: attempt.agentRunId ? ["agents"] : [],
                },
              );
              const snapshot = taskTransitionResultSchema.parse({
                task,
                attempt: attemptSummaryFromRow(tx, attempt),
                claim: null,
                entry: null,
                event,
              });
              recordResultSnapshot(tx, input, command, hash, snapshot, context.now);
              return snapshot;
            },
            { behavior: "immediate" },
          ),
        catch: commandError,
      });
    },
    requestChanges(input: RequestTaskChangesInput, actor: Actor, context: TaskEvaluationContext) {
      return Effect.try({
        try: () =>
          db.transaction(
            (tx) => {
              assertHumanTaskActor(actor);
              const command = "task.review.request_changes";
              const hash = inputHash(command, { ...withoutIdempotencyKey(input), actor });
              const existing = findIdempotentSnapshot(
                tx,
                command,
                input.idempotencyKey,
                hash,
                (value) => taskTransitionResultSchema.parse(value),
              );
              if (existing) return existing;
              const row = currentTask(tx, input.taskId);
              assertExpectedVersion(row, input.expectedVersion);
              if (row.archivedAt) {
                throw new TaskAlreadyArchivedError({
                  taskId: row.id,
                  message: "Archived tasks cannot receive review changes.",
                });
              }
              const attempt = reviewedAttempt(tx, row, input.attemptId);
              const entry = humanChangeRequestEntry(tx, input, row, actor, context.now);
              const taskUpdate = tx
                .update(tasks)
                .set({
                  lifecycle: "ready",
                  reviewAttemptId: null,
                  version: row.version + 1,
                  updatedAt: context.now,
                })
                .where(and(eq(tasks.id, row.id), eq(tasks.version, row.version)))
                .run();
              if (taskUpdate.changes !== 1)
                throw new Error("The review task could not be updated.");
              const task = taskFromRow(tx, currentTask(tx, row.id), context);
              const event = appendTaskEvent(
                tx,
                task,
                actor,
                "task.review.changes_requested",
                {
                  attemptId: attempt.id,
                  entryId: entry.id,
                  previousVersion: row.version,
                  version: task.version,
                  summary: input.summary,
                  requestedChanges: input.requestedChanges,
                },
                {
                  activityEntryIds: [entry.id],
                  agentRunIds: attempt.agentRunId ? [attempt.agentRunId] : [],
                  scopes: attempt.agentRunId ? ["activity", "agents"] : ["activity"],
                },
              );
              const result = taskTransitionResultSchema.parse({
                task,
                attempt: attemptSummaryFromRow(tx, attempt),
                claim: null,
                entry,
                event,
              });
              recordResultSnapshot(tx, input, command, hash, result, context.now);
              return result;
            },
            { behavior: "immediate" },
          ),
        catch: commandError,
      });
    },
    cancel(input: CancelTaskInput, actor: Actor, context: TaskEvaluationContext) {
      return Effect.try({
        try: () => {
          const command = "task.cancel";
          const hash = inputHash(command, { ...withoutIdempotencyKey(input), actor });
          const cached = findIdempotentSnapshot(db, command, input.idempotencyKey, hash, (value) =>
            taskTransitionResultSchema.parse(value),
          );
          if (cached) {
            if (cached.claim) leaseTokenCache.delete(cached.claim.id);
            return cached;
          }
          reconcileAndEvict(context);
          const result = db.transaction(
            (tx) => {
              assertHumanTaskActor(actor);
              const existing = findIdempotentSnapshot(
                tx,
                command,
                input.idempotencyKey,
                hash,
                (value) => taskTransitionResultSchema.parse(value),
              );
              if (existing) return existing;
              const row = currentTask(tx, input.taskId);
              assertExpectedVersion(row, input.expectedVersion);
              if (row.archivedAt) {
                throw new TaskAlreadyArchivedError({
                  taskId: row.id,
                  message: "Archived tasks cannot be cancelled.",
                });
              }
              if (row.lifecycle === "done" || row.lifecycle === "cancelled") {
                throw new TaskLifecycleError({
                  taskId: row.id,
                  lifecycle: row.lifecycle,
                  message:
                    row.lifecycle === "done"
                      ? "Reopen completed work before cancelling it."
                      : "That task is already cancelled.",
                });
              }
              const activeLease = tx
                .select()
                .from(leases)
                .where(and(eq(leases.taskId, row.id), eq(leases.status, "active")))
                .limit(1)
                .get();
              if (row.lifecycle === "in_progress" && !activeLease) {
                throw new TaskLeaseError({
                  taskId: row.id,
                  reason: "required",
                  message: "The in-progress task no longer has an active lease.",
                });
              }
              let cancelledAttempt: AttemptRow | null = null;
              let cancelledClaim: TaskClaim | null = null;
              if (activeLease) {
                closeLeaseAttempt(
                  tx,
                  activeLease,
                  "cancelled",
                  input.reason,
                  context.now,
                  "cancelled",
                );
                cancelledAttempt =
                  tx
                    .select()
                    .from(attempts)
                    .where(eq(attempts.id, activeLease.attemptId))
                    .limit(1)
                    .get() ?? null;
                cancelledClaim = claimFromLeaseRow(tx, {
                  ...activeLease,
                  status: "cancelled",
                  invalidatedAt: context.now,
                  invalidationReason: input.reason,
                });
              } else if (row.lifecycle === "review") {
                if (!row.reviewAttemptId) {
                  throw new TaskReviewError({
                    taskId: row.id,
                    reason: "attempt_mismatch",
                    message: "The review task no longer identifies its completed attempt.",
                  });
                }
                cancelledAttempt = reviewedAttempt(tx, row, row.reviewAttemptId);
              }
              const taskUpdate = tx
                .update(tasks)
                .set({
                  lifecycle: "cancelled",
                  cancelledFromLifecycle: row.lifecycle,
                  reviewAttemptId: row.lifecycle === "review" ? row.reviewAttemptId : null,
                  version: row.version + 1,
                  updatedAt: context.now,
                })
                .where(and(eq(tasks.id, row.id), eq(tasks.version, row.version)))
                .run();
              if (taskUpdate.changes !== 1) throw new Error("The task could not be cancelled.");
              const task = taskFromRow(tx, currentTask(tx, row.id), context);
              const event = appendTaskEvent(
                tx,
                task,
                actor,
                "task.cancelled",
                {
                  previousVersion: row.version,
                  version: task.version,
                  previousLifecycle: row.lifecycle,
                  reason: input.reason,
                  ...(activeLease
                    ? {
                        leaseId: activeLease.id,
                        attemptId: activeLease.attemptId,
                        agentRunId: activeLease.agentRunId,
                      }
                    : {}),
                },
                {
                  taskIds: blockingRelationTargetIds(tx, row.id),
                  agentRunIds: activeLease ? [activeLease.agentRunId] : [],
                  scopes: activeLease ? ["agents"] : [],
                },
              );
              const snapshot = taskTransitionResultSchema.parse({
                task,
                attempt: cancelledAttempt ? attemptSummaryFromRow(tx, cancelledAttempt) : null,
                claim: cancelledClaim,
                entry: null,
                event,
              });
              recordResultSnapshot(tx, input, command, hash, snapshot, context.now);
              return snapshot;
            },
            { behavior: "immediate" },
          );
          if (result.claim) leaseTokenCache.delete(result.claim.id);
          return result;
        },
        catch: commandError,
      });
    },
    restore(input: RestoreCancelledTaskInput, actor: Actor, context: TaskEvaluationContext) {
      return Effect.try({
        try: () =>
          db.transaction(
            (tx) => {
              assertHumanTaskActor(actor);
              const command = "task.cancel.restore";
              const hash = inputHash(command, { ...withoutIdempotencyKey(input), actor });
              const existing = findIdempotentSnapshot(
                tx,
                command,
                input.idempotencyKey,
                hash,
                (value) => taskTransitionResultSchema.parse(value),
              );
              if (existing) return existing;
              const row = currentTask(tx, input.taskId);
              assertExpectedVersion(row, input.expectedVersion);
              if (row.archivedAt) {
                throw new TaskAlreadyArchivedError({
                  taskId: row.id,
                  message: "Archived tasks cannot be restored.",
                });
              }
              if (row.lifecycle !== "cancelled" || !row.cancelledFromLifecycle) {
                throw new TaskLifecycleError({
                  taskId: row.id,
                  lifecycle: row.lifecycle,
                  message: "Only explicitly cancelled work can be restored.",
                });
              }
              const destination =
                row.cancelledFromLifecycle === "in_progress" ? "ready" : row.cancelledFromLifecycle;
              let reviewAttempt: AttemptRow | null = null;
              if (destination === "review") {
                if (!row.reviewAttemptId) {
                  throw new TaskReviewError({
                    taskId: row.id,
                    reason: "attempt_mismatch",
                    message: "The cancelled review no longer identifies its completed attempt.",
                  });
                }
                reviewAttempt =
                  tx
                    .select()
                    .from(attempts)
                    .where(eq(attempts.id, row.reviewAttemptId))
                    .limit(1)
                    .get() ?? null;
                if (
                  !reviewAttempt ||
                  reviewAttempt.taskId !== row.id ||
                  reviewAttempt.status !== "completed"
                ) {
                  throw new TaskReviewError({
                    taskId: row.id,
                    attemptId: row.reviewAttemptId,
                    reviewAttemptId: row.reviewAttemptId,
                    reason: "attempt_mismatch",
                    message: "The cancelled review attempt is no longer restorable.",
                  });
                }
              }
              const taskUpdate = tx
                .update(tasks)
                .set({
                  lifecycle: destination,
                  reviewAttemptId: destination === "review" ? row.reviewAttemptId : null,
                  cancelledFromLifecycle: null,
                  version: row.version + 1,
                  updatedAt: context.now,
                })
                .where(and(eq(tasks.id, row.id), eq(tasks.version, row.version)))
                .run();
              if (taskUpdate.changes !== 1) throw new Error("The task could not be restored.");
              const task = taskFromRow(tx, currentTask(tx, row.id), context);
              const event = appendTaskEvent(
                tx,
                task,
                actor,
                "task.restored",
                {
                  previousVersion: row.version,
                  version: task.version,
                  cancelledFromLifecycle: row.cancelledFromLifecycle,
                  destination,
                  reason: input.reason,
                  ...(row.reviewAttemptId ? { attemptId: row.reviewAttemptId } : {}),
                },
                { taskIds: blockingRelationTargetIds(tx, row.id) },
              );
              const result = taskTransitionResultSchema.parse({
                task,
                attempt: reviewAttempt ? attemptSummaryFromRow(tx, reviewAttempt) : null,
                claim: null,
                entry: null,
                event,
              });
              recordResultSnapshot(tx, input, command, hash, result, context.now);
              return result;
            },
            { behavior: "immediate" },
          ),
        catch: commandError,
      });
    },
    reopen(input: ReopenTaskInput, actor: Actor, context: TaskEvaluationContext) {
      return Effect.try({
        try: () =>
          db.transaction(
            (tx) => {
              const command = "task.reopen";
              const hash = inputHash(command, { ...withoutIdempotencyKey(input), actor });
              const existing = findIdempotentSnapshot(
                tx,
                command,
                input.idempotencyKey,
                hash,
                (value) => taskTransitionResultSchema.parse(value),
              );
              if (existing) return existing;
              const row = currentTask(tx, input.taskId);
              assertExpectedVersion(row, input.expectedVersion);
              if (row.archivedAt) {
                throw new TaskAlreadyArchivedError({
                  taskId: row.id,
                  message: "Archived tasks cannot be reopened.",
                });
              }
              if (row.lifecycle !== "done") {
                throw new TaskLifecycleError({
                  taskId: row.id,
                  lifecycle: row.lifecycle,
                  message: "Only complete tasks can be reopened.",
                });
              }

              const taskUpdate = tx
                .update(tasks)
                .set({
                  lifecycle: input.destination,
                  reviewAttemptId: null,
                  cancelledFromLifecycle: null,
                  version: row.version + 1,
                  updatedAt: context.now,
                })
                .where(and(eq(tasks.id, row.id), eq(tasks.version, row.version)))
                .run();
              if (taskUpdate.changes !== 1) throw new Error("The task could not be reopened.");
              const priorAttempt = tx
                .select()
                .from(attempts)
                .where(eq(attempts.taskId, row.id))
                .orderBy(desc(attempts.attemptNumber), desc(attempts.id))
                .limit(1)
                .get();
              const task = taskFromRow(tx, currentTask(tx, row.id), context);
              const event = appendTaskEvent(
                tx,
                task,
                actor,
                "task.reopened",
                {
                  previousVersion: row.version,
                  version: task.version,
                  destination: input.destination,
                  reason: input.reason,
                  ...(priorAttempt ? { priorAttemptId: priorAttempt.id } : {}),
                },
                { taskIds: blockingRelationTargetIds(tx, row.id) },
              );
              const result = taskTransitionResultSchema.parse({
                task,
                attempt: priorAttempt ? attemptSummaryFromRow(tx, priorAttempt) : null,
                claim: null,
                entry: null,
                event,
              });
              recordResultSnapshot(tx, input, command, hash, result, context.now);
              return result;
            },
            { behavior: "immediate" },
          ),
        catch: commandError,
      });
    },
    createRelation(input: CreateTaskRelationInput, actor: Actor, context: TaskEvaluationContext) {
      return Effect.try({
        try: () =>
          db.transaction((tx) => {
            const command = "task.relation.create";
            const hash = inputHash(command, withoutIdempotencyKey(input));
            const existing = findIdempotentRelationResult(tx, command, input.idempotencyKey, hash);
            if (existing) return existing;
            const source = currentTask(tx, input.sourceTaskId);
            const target = currentTask(tx, input.targetTaskId);
            assertExpectedVersion(source, input.expectedSourceVersion);
            assertExpectedVersion(target, input.expectedTargetVersion);
            const activeTask = [source, target].find((task) => task.lifecycle === "in_progress");
            if (activeTask) {
              throw new TaskLifecycleError({
                taskId: activeTask.id,
                lifecycle: activeTask.lifecycle,
                message: "Cancel the active claim before changing task relations.",
              });
            }
            if (source.projectId !== input.projectId || target.projectId !== input.projectId) {
              throw new TaskRelationError({
                sourceTaskId: input.sourceTaskId,
                targetTaskId: input.targetTaskId,
                relationPath: [],
                message: "Both tasks must belong to the requested project.",
              });
            }
            if (source.id === target.id) {
              throw new TaskRelationError({
                sourceTaskId: source.id,
                targetTaskId: target.id,
                relationPath: [`#${source.sequence}`],
                message: "A task cannot be related to itself.",
              });
            }
            const duplicate = tx
              .select({ id: taskRelations.id })
              .from(taskRelations)
              .where(
                and(
                  eq(taskRelations.sourceTaskId, source.id),
                  eq(taskRelations.targetTaskId, target.id),
                  eq(taskRelations.type, input.type),
                ),
              )
              .limit(1)
              .get();
            if (duplicate) {
              throw new TaskRelationError({
                sourceTaskId: source.id,
                targetTaskId: target.id,
                relationPath: sequencePath(tx, [source.id, target.id]),
                message: "That task relation already exists.",
              });
            }
            if (input.type === "blocks") {
              const edges = tx
                .select({
                  sourceTaskId: taskRelations.sourceTaskId,
                  targetTaskId: taskRelations.targetTaskId,
                })
                .from(taskRelations)
                .where(eq(taskRelations.type, "blocks"))
                .all();
              const path = findBlockingPath(edges, target.id, source.id);
              if (path) {
                throw new TaskRelationError({
                  sourceTaskId: source.id,
                  targetTaskId: target.id,
                  relationPath: sequencePath(tx, [source.id, target.id, ...path.slice(1)]),
                  message: "That blocking relation would create a dependency cycle.",
                });
              }
            }

            const now = context.now;
            const relationId = randomUUID();
            tx.insert(taskRelations)
              .values({
                id: relationId,
                projectId: input.projectId,
                sourceTaskId: source.id,
                targetTaskId: target.id,
                type: input.type,
                createdAt: now,
              })
              .run();
            tx.update(tasks)
              .set({ version: source.version + 1, updatedAt: now })
              .where(and(eq(tasks.id, source.id), eq(tasks.version, source.version)))
              .run();
            tx.update(tasks)
              .set({ version: target.version + 1, updatedAt: now })
              .where(and(eq(tasks.id, target.id), eq(tasks.version, target.version)))
              .run();
            const relation = relationFromRow(tx, {
              id: relationId,
              projectId: input.projectId,
              sourceTaskId: source.id,
              targetTaskId: target.id,
              type: input.type,
              createdAt: now,
            });
            recordRelationMutation(tx, input, command, hash, relation, actor, now);
            return relation;
          }),
        catch: commandError,
      });
    },
    archive(input: ArchiveTaskInput, actor: Actor, context: TaskEvaluationContext) {
      return Effect.try({
        try: () => {
          const archivedTask = db.transaction((tx) => {
            const command = "task.archive";
            const hash = inputHash(command, withoutIdempotencyKey(input));
            const existing = findIdempotentResult(tx, command, input.idempotencyKey, hash, context);
            if (existing) return existing;
            const row = currentTask(tx, input.taskId);
            assertExpectedVersion(row, input.expectedVersion);
            if (row.archivedAt) {
              throw new TaskAlreadyArchivedError({
                taskId: row.id,
                message: "That task is already archived.",
              });
            }

            const now = context.now;
            const activeLease = tx
              .select()
              .from(leases)
              .where(and(eq(leases.taskId, row.id), eq(leases.status, "active")))
              .limit(1)
              .get();
            if (activeLease) {
              closeLeaseAttempt(
                tx,
                activeLease,
                "cancelled",
                `Task archived: ${input.reason}`,
                now,
              );
            }
            tx.update(tasks)
              .set({
                archivedAt: now,
                version: row.version + 1,
                updatedAt: now,
              })
              .where(and(eq(tasks.id, row.id), eq(tasks.version, row.version)))
              .run();
            const task = taskFromRow(tx, currentTask(tx, row.id), context);
            recordMutation(tx, input, command, hash, task, actor, {
              kind: "task.archived",
              payload: {
                previousVersion: row.version,
                version: task.version,
                reason: input.reason,
                ...(activeLease
                  ? {
                      invalidatedLeaseId: activeLease.id,
                      abandonedAttemptId: activeLease.attemptId,
                    }
                  : {}),
              },
            });
            return task;
          });
          const leaseIds = db
            .select({ id: leases.id })
            .from(leases)
            .where(eq(leases.taskId, archivedTask.id))
            .all()
            .map((lease) => lease.id);
          evictLeaseTokens(leaseIds);
          return archivedTask;
        },
        catch: commandError,
      });
    },
  };
}
