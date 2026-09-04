import { createHash, randomUUID } from "node:crypto";

import Database from "better-sqlite3";
import { and, asc, eq, isNull, max } from "drizzle-orm";
import { drizzle } from "drizzle-orm/better-sqlite3";
import { Effect } from "effect";

import {
  TaskAlreadyArchivedError,
  TaskDiscoveryCursorStaleError,
  TaskIdempotencyConflictError,
  TaskLifecycleError,
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
  TaskContextQuery,
  TaskDiscoveryQuery,
  TaskListQuery,
  TaskStore,
} from "../application/tasks";
import {
  attempts,
  events,
  idempotencyRecords,
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
  taskSchema,
  taskParentViolation,
  type Actor,
  type ArchiveTaskInput,
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
    .map((row) => ({
      id: row.id,
      taskId: row.taskId,
      agentRunId: row.agentRunId,
      status: row.status,
      summary: row.summary,
      verification: JSON.parse(row.verificationJson),
      createdAt: row.createdAt,
      completedAt: row.completedAt,
    }));
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
    error instanceof TaskDiscoveryCursorStaleError ||
    error instanceof TaskIdempotencyConflictError ||
    error instanceof TaskLifecycleError ||
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

export function createSqliteTaskStore(database: Database.Database): TaskStore {
  const db = drizzle(database, { schema });

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
        try: () =>
          db.transaction((tx) => {
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
              },
            });
            return task;
          }),
        catch: commandError,
      });
    },
  };
}
