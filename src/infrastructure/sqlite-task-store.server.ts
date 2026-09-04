import { createHash, randomBytes, randomUUID } from "node:crypto";

import Database from "better-sqlite3";
import { and, asc, eq, isNull, max } from "drizzle-orm";
import { drizzle } from "drizzle-orm/better-sqlite3";
import { Effect } from "effect";

import {
  TaskAlreadyArchivedError,
  TaskClaimUnavailableError,
  TaskDiscoveryCursorStaleError,
  TaskIdempotencyConflictError,
  TaskLifecycleError,
  TaskLeaseError,
  TaskNestingError,
  TaskNotFoundError,
  TaskPathError,
  TaskPersistenceError,
  TaskRelationError,
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
  attempts,
  events,
  idempotencyRecords,
  leases,
  projects,
  schema,
  tags,
  taskCapabilityRequirements,
  taskReferencedPaths,
  taskRelations,
  tasks,
  taskTags,
} from "../db/schema";
import {
  compareTaskOrder,
  decodeTaskDiscoveryCursor,
  duplicateExclusiveTagGroups,
  encodeTaskDiscoveryCursor,
  evaluateTaskEligibility,
  findBlockingPath,
  isIncompleteBlockingDependency,
  normalizeCapabilities,
  richTextToPlainText,
  tagSchema,
  taskRelationSchema,
  taskContextPackageSchema,
  taskLeaseGrantSchema,
  taskLeaseMutationResultSchema,
  taskSchema,
  taskParentViolation,
  type Actor,
  type ArchiveTaskInput,
  type ClaimNextTaskInput,
  type ClaimTaskInput,
  type CompleteTaskInput,
  type CreateTaskInput,
  type CreateTaskRelationInput,
  type PrepareTaskInput,
  type ReopenTaskInput,
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
  type UpdateTaskPlanningInput,
} from "../domain/tasks";
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

function attemptSummaryFromRow(row: AttemptRow) {
  return {
    id: row.id,
    taskId: row.taskId,
    agentRunId: row.agentRunId,
    status: row.status,
    summary: row.summary,
    verification: JSON.parse(row.verificationJson),
    createdAt: row.createdAt,
    completedAt: row.completedAt,
  };
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
  const requiredCapabilities = db
    .select()
    .from(taskCapabilityRequirements)
    .where(eq(taskCapabilityRequirements.taskId, row.id))
    .orderBy(asc(taskCapabilityRequirements.capability))
    .all()
    .map((entry) => entry.capability);
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
    tags: assignedTags,
    requiredCapabilities,
    referencedPaths: referencedPathsForTask(db, row.id),
    claim: context ? activeClaimForTask(db, row.id, context.now) : null,
    upstreamRelations,
    downstreamRelations,
    description: JSON.parse(row.descriptionJson),
    descriptionText: row.descriptionText,
    expectedOutcome: row.expectedOutcome,
    acceptanceCriteria: row.acceptanceCriteria,
    agentContext: row.agentContext,
    checklist: JSON.parse(row.checklistJson),
    version: row.version,
    archivedAt: row.archivedAt,
    createdAt: row.createdAt,
    updatedAt: row.updatedAt,
  });
  return context
    ? { ...task, eligibility: evaluateTaskEligibility(task, context, blockingTaskIds) }
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
  return {
    ...durableTask,
    eligibility: evaluateTaskEligibility(durableTask, context, blockingTaskIds),
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
      actorType: actor.type,
      actorId: actor.id,
      entityType: "task",
      entityId: result.task.id,
      payloadJson: JSON.stringify(event.payload),
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

function recordMutation(
  db: DatabaseSession,
  input: { idempotencyKey: string },
  command: string,
  hash: string,
  result: Task,
  actor: Actor,
  event: { kind: string; payload: unknown },
) {
  db.insert(events)
    .values({
      projectId: result.projectId,
      kind: event.kind,
      actorType: actor.type,
      actorId: actor.id,
      entityType: "task",
      entityId: result.id,
      payloadJson: JSON.stringify(event.payload),
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
      actorType: actor.type,
      actorId: actor.id,
      entityType: "task_relation",
      entityId: result.id,
      payloadJson: JSON.stringify({
        sourceTaskId: result.sourceTaskId,
        targetTaskId: result.targetTaskId,
        type: result.type,
      }),
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
    throw new TaskNotFoundError({ taskId, message: "That task does not exist." });
  }
  return row;
}

function projectRepositoryRoot(db: DatabaseSession, projectId: string) {
  const [project] = db.select().from(projects).where(eq(projects.id, projectId)).limit(1).all();
  if (!project) {
    throw new TaskNotFoundError({ taskId: projectId, message: "That project does not exist." });
  }
  return project.repositoryRoot;
}

function attemptSummariesForTask(db: DatabaseSession, taskId: string) {
  return db
    .select()
    .from(attempts)
    .where(eq(attempts.taskId, taskId))
    .orderBy(asc(attempts.createdAt))
    .all()
    .map(attemptSummaryFromRow);
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
    relations: {
      upstream: task.upstreamRelations,
      downstream: task.downstreamRelations,
    },
    paths: {
      repositoryRoot,
      referencedPaths: projectContext.referencedPaths,
    },
    priorAttempts: attemptSummariesForTask(db, task.id),
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
    error instanceof TaskClaimUnavailableError ||
    error instanceof TaskDiscoveryCursorStaleError ||
    error instanceof TaskIdempotencyConflictError ||
    error instanceof TaskLifecycleError ||
    error instanceof TaskLeaseError ||
    error instanceof TaskNestingError ||
    error instanceof TaskNotFoundError ||
    error instanceof TaskPathError ||
    error instanceof TaskRelationError ||
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

function closeLeaseAttempt(
  db: DatabaseSession,
  row: LeaseRow,
  status: "released" | "expired" | "cancelled" | "reassigned",
  reason: string,
  now: string,
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
      status: "abandoned",
      summary: attempt?.summary.trim() ? attempt.summary : reason,
      completedAt: now,
    })
    .where(and(eq(attempts.id, row.attemptId), eq(attempts.status, "active")))
    .run();
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
  db.insert(events)
    .values({
      projectId: task.projectId,
      kind: status === "expired" ? "task.lease.expired" : "task.lease.cancelled",
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
      }),
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
  const attempt = {
    id: randomUUID(),
    taskId: row.id,
    agentRunId: claimant.runId,
    status: "active" as const,
    summary: "",
    verificationJson: "[]",
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
    attempt: attemptSummaryFromRow(attempt),
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
    .set({ lifecycle: "ready", version: row.version + 1, updatedAt: context.now })
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
        try: () => {
          const where = input.includeArchived
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
        },
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
                attempt: attemptSummaryFromRow(attempt),
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
            const now = new Date().toISOString();
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
                version: task.version,
                archivedAt: task.archivedAt,
                createdAt: task.createdAt,
                updatedAt: task.updatedAt,
              })
              .run();
            replaceTagAssignments(tx, task.id, task.projectId, planning.tags, now);
            replaceRequiredCapabilities(tx, task.id, planning.requiredCapabilities);
            replaceReferencedPaths(tx, task.id, referencedPaths);
            const created = taskFromRow(tx, currentTask(tx, task.id), context);
            recordMutation(tx, input, command, hash, created, actor, {
              kind: "task.created",
              payload: {
                sequence: created.sequence,
                title: created.title,
                lifecycle: created.lifecycle,
                priority: created.priority,
                parentTaskId: created.parentTaskId,
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
            const referencedPaths = validateProjectReferencedPaths(
              projectRepositoryRoot(tx, row.projectId),
              input.referencedPaths,
            );

            const now = new Date().toISOString();
            tx.update(tasks)
              .set({
                title: input.title,
                lifecycle: "ready",
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
            replaceReferencedPaths(tx, row.id, referencedPaths);
            const task = taskFromRow(tx, currentTask(tx, row.id), context);
            recordMutation(tx, input, command, hash, task, actor, {
              kind: "task.prepared",
              payload: {
                previousVersion: row.version,
                version: task.version,
                lifecycle: task.lifecycle,
                priority: task.priority,
                referencedPaths: task.referencedPaths,
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

            const now = new Date().toISOString();
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
              },
            });
            return task;
          }),
        catch: commandError,
      });
    },
    complete(input: CompleteTaskInput, actor: Actor, context: TaskEvaluationContext) {
      return Effect.try({
        try: () =>
          db.transaction((tx) => {
            const command = "task.complete";
            const hash = inputHash(command, withoutIdempotencyKey(input));
            const existing = findIdempotentResult(tx, command, input.idempotencyKey, hash, context);
            if (existing) return existing;
            const row = currentTask(tx, input.taskId);
            assertExpectedVersion(row, input.expectedVersion);
            if (actor.type === "agent") {
              throw new TaskLeaseError({
                taskId: row.id,
                reason: "required",
                message: "Agent completion requires an active lease and structured attempt report.",
              });
            }
            if (row.archivedAt) {
              throw new TaskAlreadyArchivedError({
                taskId: row.id,
                message: "Archived tasks cannot be completed.",
              });
            }
            if (row.lifecycle !== "ready") {
              throw new TaskLifecycleError({
                taskId: row.id,
                lifecycle: row.lifecycle,
                message: "Only ready tasks can be completed by this pre-claim lifecycle command.",
              });
            }

            const now = new Date().toISOString();
            tx.update(tasks)
              .set({ lifecycle: "done", version: row.version + 1, updatedAt: now })
              .where(and(eq(tasks.id, row.id), eq(tasks.version, row.version)))
              .run();
            const task = taskFromRow(tx, currentTask(tx, row.id), context);
            recordMutation(tx, input, command, hash, task, actor, {
              kind: "task.completed",
              payload: { previousVersion: row.version, version: task.version },
            });
            return task;
          }),
        catch: commandError,
      });
    },
    reopen(input: ReopenTaskInput, actor: Actor, context: TaskEvaluationContext) {
      return Effect.try({
        try: () =>
          db.transaction((tx) => {
            const command = "task.reopen";
            const hash = inputHash(command, withoutIdempotencyKey(input));
            const existing = findIdempotentResult(tx, command, input.idempotencyKey, hash, context);
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

            const now = new Date().toISOString();
            tx.update(tasks)
              .set({ lifecycle: "ready", version: row.version + 1, updatedAt: now })
              .where(and(eq(tasks.id, row.id), eq(tasks.version, row.version)))
              .run();
            const task = taskFromRow(tx, currentTask(tx, row.id), context);
            recordMutation(tx, input, command, hash, task, actor, {
              kind: "task.reopened",
              payload: {
                previousVersion: row.version,
                version: task.version,
                reason: input.reason,
              },
            });
            return task;
          }),
        catch: commandError,
      });
    },
    createRelation(input: CreateTaskRelationInput, actor: Actor) {
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

            const now = new Date().toISOString();
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

            const now = new Date().toISOString();
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
              .set({ archivedAt: now, version: row.version + 1, updatedAt: now })
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
