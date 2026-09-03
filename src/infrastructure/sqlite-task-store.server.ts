import { createHash, randomUUID } from "node:crypto";

import Database from "better-sqlite3";
import { and, asc, eq, isNull, max } from "drizzle-orm";
import { drizzle } from "drizzle-orm/better-sqlite3";
import { Effect } from "effect";

import {
  TaskAlreadyArchivedError,
  TaskIdempotencyConflictError,
  TaskNotFoundError,
  TaskPersistenceError,
  TaskVersionConflictError,
  type TaskCommandError,
} from "../application/task-errors";
import type { TaskStore } from "../application/tasks";
import { events, idempotencyRecords, schema, tasks } from "../db/schema";
import {
  richTextToPlainText,
  taskSchema,
  type Actor,
  type ArchiveTaskInput,
  type CreateTaskInput,
  type ListTasksInput,
  type PrepareTaskInput,
  type Task,
} from "../domain/tasks";

type DrizzleDatabase = ReturnType<typeof drizzle<typeof schema>>;
type DrizzleTransaction = Parameters<Parameters<DrizzleDatabase["transaction"]>[0]>[0];
type DatabaseSession = DrizzleDatabase | DrizzleTransaction;
type TaskRow = typeof tasks.$inferSelect;

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

function taskFromRow(row: TaskRow): Task {
  return taskSchema.parse({
    id: row.id,
    projectId: row.projectId,
    sequence: row.sequence,
    title: row.title,
    lifecycle: row.lifecycle,
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
    error instanceof TaskNotFoundError ||
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
            .map(taskFromRow);
        },
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

            const [sequenceResult] = tx
              .select({ value: max(tasks.sequence) })
              .from(tasks)
              .where(eq(tasks.projectId, input.projectId))
              .all();
            const now = new Date().toISOString();
            const task: Task = {
              id: randomUUID(),
              projectId: input.projectId,
              sequence: (sequenceResult?.value ?? 0) + 1,
              title: input.title,
              lifecycle: input.lifecycle,
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
                title: task.title,
                lifecycle: task.lifecycle,
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
            recordMutation(tx, input, command, hash, task, actor, {
              kind: "task.created",
              payload: { sequence: task.sequence, title: task.title, lifecycle: task.lifecycle },
            });
            return task;
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
            const task = taskFromRow(currentTask(tx, row.id));
            recordMutation(tx, input, command, hash, task, actor, {
              kind: "task.prepared",
              payload: {
                previousVersion: row.version,
                version: task.version,
                lifecycle: task.lifecycle,
              },
            });
            return task;
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
            const task = taskFromRow(currentTask(tx, row.id));
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
