import { createHash, randomUUID } from "node:crypto";

import Database from "better-sqlite3";
import { and, asc, eq, isNull, max } from "drizzle-orm";
import { drizzle } from "drizzle-orm/better-sqlite3";
import { Effect } from "effect";

import {
  TaskAlreadyArchivedError,
  TaskIdempotencyConflictError,
  TaskLifecycleError,
  TaskNestingError,
  TaskNotFoundError,
  TaskPersistenceError,
  TaskRelationError,
  TaskVersionConflictError,
  type TaskCommandError,
} from "../application/task-errors";
import type { TaskStore } from "../application/tasks";
import {
  events,
  idempotencyRecords,
  schema,
  tags,
  taskCapabilityRequirements,
  taskRelations,
  tasks,
  taskTags,
} from "../db/schema";
import {
  richTextToPlainText,
  taskRelationSchema,
  taskSchema,
  taskPriorityRank,
  todayIsoDate,
  type Actor,
  type ArchiveTaskInput,
  type CompleteTaskInput,
  type CreateTaskInput,
  type CreateTaskRelationInput,
  type DiscoverTasksInput,
  type ListTasksInput,
  type PrepareTaskInput,
  type ReopenTaskInput,
  type TagInput,
  type Task,
  type TaskEligibility,
  type TaskRelation,
  type UpdateTaskPlanningInput,
} from "../domain/tasks";

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
type EligibilityContext = Pick<ListTasksInput, "agentCapabilities" | "now">;

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

function normalizeCapabilities(capabilities: readonly string[] = []) {
  return [...new Set(capabilities.map((capability) => capability.trim()).filter(Boolean))].toSorted(
    (left, right) => left.localeCompare(right),
  );
}

function defaultEligibilityContext(input: Partial<EligibilityContext> = {}): EligibilityContext {
  return { agentCapabilities: input.agentCapabilities ?? [], now: input.now };
}

function taskOrderingExplanation(task: Pick<Task, "priority" | "position" | "dueAt" | "sequence">) {
  return [
    `${task.priority} lane`,
    `position ${task.position}`,
    task.dueAt ? `due ${task.dueAt}` : "no due date",
    `stable tie-breaker #${task.sequence}`,
  ].join(", ");
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
    .filter((row) => row.lifecycle !== "done");
}

function taskEligibility(
  task: Task,
  context: EligibilityContext,
  blockingTaskIds: readonly string[],
): TaskEligibility {
  const now = context.now ?? todayIsoDate();
  const agentCapabilities = new Set(normalizeCapabilities(context.agentCapabilities));
  const missingCapabilities = task.requiredCapabilities.filter(
    (capability) => !agentCapabilities.has(capability),
  );
  const orderingExplanation = taskOrderingExplanation(task);

  if (task.archivedAt) {
    return {
      claimable: false,
      status: "archived",
      reasons: ["Task is archived."],
      orderingExplanation,
      missingCapabilities,
      blockingTaskIds: [...blockingTaskIds],
    };
  }
  if (task.lifecycle === "done") {
    return {
      claimable: false,
      status: "complete",
      reasons: ["Task is complete."],
      orderingExplanation,
      missingCapabilities,
      blockingTaskIds: [...blockingTaskIds],
    };
  }
  if (task.lifecycle !== "ready") {
    return {
      claimable: false,
      status: "not_ready",
      reasons: ["Task is not ready."],
      orderingExplanation,
      missingCapabilities,
      blockingTaskIds: [...blockingTaskIds],
    };
  }
  if (task.notBefore && task.notBefore > now) {
    return {
      claimable: false,
      status: "scheduled",
      reasons: [`Task starts on ${task.notBefore}.`],
      orderingExplanation,
      missingCapabilities,
      blockingTaskIds: [...blockingTaskIds],
    };
  }
  if (blockingTaskIds.length > 0) {
    return {
      claimable: false,
      status: "blocked",
      reasons: [`Blocked by: ${blockingTaskIds.join(", ")}.`],
      orderingExplanation,
      missingCapabilities,
      blockingTaskIds: [...blockingTaskIds],
    };
  }
  if (missingCapabilities.length > 0) {
    return {
      claimable: false,
      status: "capability_mismatch",
      reasons: [`Missing capabilities: ${missingCapabilities.join(", ")}.`],
      orderingExplanation,
      missingCapabilities,
      blockingTaskIds: [...blockingTaskIds],
    };
  }
  return {
    claimable: true,
    status: "claimable",
    reasons: ["Ready, unscheduled, and capability-compatible."],
    orderingExplanation,
    missingCapabilities,
    blockingTaskIds: [...blockingTaskIds],
  };
}

function compareTasks(left: Task, right: Task) {
  const priority = taskPriorityRank[left.priority] - taskPriorityRank[right.priority];
  if (priority !== 0) return priority;
  const position = left.position - right.position;
  if (position !== 0) return position;
  if (left.dueAt !== right.dueAt) {
    if (!left.dueAt) return 1;
    if (!right.dueAt) return -1;
    return left.dueAt.localeCompare(right.dueAt);
  }
  return left.sequence - right.sequence;
}

function taskFromRow(db: DatabaseSession, row: TaskRow, context?: EligibilityContext): Task {
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
  return context ? { ...task, eligibility: taskEligibility(task, context, blockingTaskIds) } : task;
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
  db.delete(taskTags).where(eq(taskTags.taskId, taskId)).run();
  for (const tag of assignedTags) {
    const [existing] = db
      .select()
      .from(tags)
      .where(and(eq(tags.projectId, projectId), eq(tags.name, tag.name)))
      .limit(1)
      .all();
    const tagId = existing?.id ?? randomUUID();
    if (existing) {
      db.update(tags)
        .set({
          description: tag.description,
          color: tag.color,
          exclusiveGroup: tag.exclusiveGroup ?? null,
          updatedAt: now,
        })
        .where(eq(tags.id, existing.id))
        .run();
    } else {
      db.insert(tags)
        .values({
          id: tagId,
          projectId,
          name: tag.name,
          description: tag.description,
          color: tag.color,
          exclusiveGroup: tag.exclusiveGroup ?? null,
          createdAt: now,
          updatedAt: now,
        })
        .run();
    }
    db.insert(taskTags).values({ taskId, tagId }).onConflictDoNothing().run();
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

function hasInputField(input: object, key: string) {
  return Object.prototype.hasOwnProperty.call(input, key);
}

function assertCanUseParent(db: DatabaseSession, projectId: string, parentTaskId: string | null) {
  if (!parentTaskId) return;
  const parent = currentTask(db, parentTaskId);
  if (parent.projectId !== projectId) {
    throw new TaskNestingError({
      taskId: parentTaskId,
      parentTaskId,
      message: "Child tasks must belong to the same project as their parent.",
    });
  }
  if (parent.parentTaskId) {
    throw new TaskNestingError({
      taskId: parentTaskId,
      parentTaskId: parent.parentTaskId,
      message: "Tasks may only be nested one level deep.",
    });
  }
}

function blockingPath(db: DatabaseSession, startTaskId: string, goalTaskId: string) {
  const edges = db.select().from(taskRelations).where(eq(taskRelations.type, "blocks")).all();
  const outgoing = new Map<string, string[]>();
  for (const edge of edges) {
    outgoing.set(edge.sourceTaskId, [
      ...(outgoing.get(edge.sourceTaskId) ?? []),
      edge.targetTaskId,
    ]);
  }
  const queue: Array<readonly string[]> = [[startTaskId]];
  const visited = new Set<string>();
  for (const path of queue) {
    const current = path[path.length - 1];
    if (!current || visited.has(current)) continue;
    if (current === goalTaskId) return path;
    visited.add(current);
    for (const next of outgoing.get(current) ?? []) {
      queue.push([...path, next]);
    }
  }
  return null;
}

function sequencePath(db: DatabaseSession, taskIds: readonly string[]) {
  return taskIds.map((taskId) => `#${currentTask(db, taskId).sequence}`);
}

function withoutIdempotencyKey<T extends { idempotencyKey: string }>(input: T) {
  const { idempotencyKey: _idempotencyKey, ...commandInput } = input;
  return commandInput;
}

function findIdempotentResult(db: DatabaseSession, command: string, key: string, hash: string) {
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
  return taskSchema.parse(JSON.parse(existing.resultJson));
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
      resultJson: JSON.stringify(result),
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
    error instanceof TaskAlreadyArchivedError ||
    error instanceof TaskIdempotencyConflictError ||
    error instanceof TaskLifecycleError ||
    error instanceof TaskNestingError ||
    error instanceof TaskNotFoundError ||
    error instanceof TaskRelationError ||
    error instanceof TaskVersionConflictError
  ) {
    return error;
  }
  return persistenceError(error);
}

export function createSqliteTaskStore(database: Database.Database): TaskStore {
  const db = drizzle(database, { schema });

  return {
    list(input: ListTasksInput) {
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
            .map((row) => taskFromRow(db, row, defaultEligibilityContext(input)))
            .toSorted(compareTasks);
        },
        catch: persistenceError,
      });
    },
    discover(input: DiscoverTasksInput) {
      return Effect.try({
        try: () =>
          db
            .select()
            .from(tasks)
            .where(and(eq(tasks.projectId, input.projectId), isNull(tasks.archivedAt)))
            .orderBy(asc(tasks.sequence))
            .all()
            .map((row) => taskFromRow(db, row, defaultEligibilityContext(input)))
            .filter((task) => task.eligibility?.claimable)
            .toSorted(compareTasks)
            .slice(0, input.limit),
        catch: persistenceError,
      });
    },
    create(input: CreateTaskInput, actor: Actor) {
      return Effect.try({
        try: () =>
          db.transaction((tx) => {
            const command = "task.create";
            const hash = inputHash(command, withoutIdempotencyKey(input));
            const existing = findIdempotentResult(tx, command, input.idempotencyKey, hash);
            if (existing) return existing;
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
            const created = taskFromRow(tx, currentTask(tx, task.id), defaultEligibilityContext());
            recordMutation(tx, input, command, hash, created, actor, {
              kind: "task.created",
              payload: {
                sequence: created.sequence,
                title: created.title,
                lifecycle: created.lifecycle,
                priority: created.priority,
                parentTaskId: created.parentTaskId,
              },
            });
            return created;
          }),
        catch: commandError,
      });
    },
    prepare(input: PrepareTaskInput, actor: Actor) {
      return Effect.try({
        try: () =>
          db.transaction((tx) => {
            const command = "task.prepare";
            const hash = inputHash(command, withoutIdempotencyKey(input));
            const existing = findIdempotentResult(tx, command, input.idempotencyKey, hash);
            if (existing) return existing;
            const row = currentTask(tx, input.taskId);
            assertExpectedVersion(row, input.expectedVersion);
            if (row.archivedAt) {
              throw new TaskAlreadyArchivedError({
                taskId: row.id,
                message: "Archived tasks cannot be prepared.",
              });
            }

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
            const task = taskFromRow(tx, currentTask(tx, row.id), defaultEligibilityContext());
            recordMutation(tx, input, command, hash, task, actor, {
              kind: "task.prepared",
              payload: {
                previousVersion: row.version,
                version: task.version,
                lifecycle: task.lifecycle,
                priority: task.priority,
              },
            });
            return task;
          }),
        catch: commandError,
      });
    },
    updatePlanning(input: UpdateTaskPlanningInput, actor: Actor) {
      return Effect.try({
        try: () =>
          db.transaction((tx) => {
            const command = "task.planning.update";
            const hash = inputHash(command, withoutIdempotencyKey(input));
            const existing = findIdempotentResult(tx, command, input.idempotencyKey, hash);
            if (existing) return existing;
            const row = currentTask(tx, input.taskId);
            assertExpectedVersion(row, input.expectedVersion);
            if (row.archivedAt) {
              throw new TaskAlreadyArchivedError({
                taskId: row.id,
                message: "Archived tasks cannot be reprioritized or routed.",
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
            const task = taskFromRow(tx, currentTask(tx, row.id), defaultEligibilityContext());
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
                tags: task.tags.map((tag) => tag.name),
                requiredCapabilities: task.requiredCapabilities,
              },
            });
            return task;
          }),
        catch: commandError,
      });
    },
    complete(input: CompleteTaskInput, actor: Actor) {
      return Effect.try({
        try: () =>
          db.transaction((tx) => {
            const command = "task.complete";
            const hash = inputHash(command, withoutIdempotencyKey(input));
            const existing = findIdempotentResult(tx, command, input.idempotencyKey, hash);
            if (existing) return existing;
            const row = currentTask(tx, input.taskId);
            assertExpectedVersion(row, input.expectedVersion);
            if (row.archivedAt) {
              throw new TaskAlreadyArchivedError({
                taskId: row.id,
                message: "Archived tasks cannot be completed.",
              });
            }
            if (row.lifecycle === "done") {
              throw new TaskLifecycleError({
                taskId: row.id,
                lifecycle: row.lifecycle,
                message: "That task is already complete.",
              });
            }

            const now = new Date().toISOString();
            tx.update(tasks)
              .set({ lifecycle: "done", version: row.version + 1, updatedAt: now })
              .where(and(eq(tasks.id, row.id), eq(tasks.version, row.version)))
              .run();
            const task = taskFromRow(tx, currentTask(tx, row.id), defaultEligibilityContext());
            recordMutation(tx, input, command, hash, task, actor, {
              kind: "task.completed",
              payload: { previousVersion: row.version, version: task.version },
            });
            return task;
          }),
        catch: commandError,
      });
    },
    reopen(input: ReopenTaskInput, actor: Actor) {
      return Effect.try({
        try: () =>
          db.transaction((tx) => {
            const command = "task.reopen";
            const hash = inputHash(command, withoutIdempotencyKey(input));
            const existing = findIdempotentResult(tx, command, input.idempotencyKey, hash);
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
            const task = taskFromRow(tx, currentTask(tx, row.id), defaultEligibilityContext());
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
            if (input.type === "blocks") {
              const path = blockingPath(tx, target.id, source.id);
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
    archive(input: ArchiveTaskInput, actor: Actor) {
      return Effect.try({
        try: () =>
          db.transaction((tx) => {
            const command = "task.archive";
            const hash = inputHash(command, withoutIdempotencyKey(input));
            const existing = findIdempotentResult(tx, command, input.idempotencyKey, hash);
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
            const task = taskFromRow(tx, currentTask(tx, row.id), defaultEligibilityContext());
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
