import { Effect } from "effect";

import {
  compiledArchiveTaskInputSchema,
  compiledCreateTaskInputSchema,
  compiledListTasksInputSchema,
  compiledPrepareTaskInputSchema,
  missingReadyPreparation,
  type Actor,
  type ArchiveTaskInput,
  type CreateTaskInput,
  type ListTasksInput,
  type PrepareTaskInput,
  type Task,
} from "../domain/tasks";
import {
  InvalidTaskInputError,
  TaskPreparationError,
  type TaskCommandError,
  type TaskPersistenceError,
} from "./task-errors";

export interface TaskStore {
  list(input: ListTasksInput): Effect.Effect<readonly Task[], TaskPersistenceError>;
  create(input: CreateTaskInput, actor: Actor): Effect.Effect<Task, TaskCommandError>;
  prepare(input: PrepareTaskInput, actor: Actor): Effect.Effect<Task, TaskCommandError>;
  archive(input: ArchiveTaskInput, actor: Actor): Effect.Effect<Task, TaskCommandError>;
}

export type TaskServices = { store: TaskStore };

function parseInput<A>(parse: () => A): Effect.Effect<A, InvalidTaskInputError> {
  return Effect.try({
    try: parse,
    catch: () => new InvalidTaskInputError({ message: "The task command input is invalid." }),
  });
}

function validateReady(input: {
  expectedOutcome: string;
  acceptanceCriteria: string;
  checklist: CreateTaskInput["checklist"];
}): Effect.Effect<void, TaskPreparationError> {
  const missingFields = missingReadyPreparation(input);
  return missingFields.length === 0
    ? Effect.void
    : Effect.fail(
        new TaskPreparationError({
          missingFields,
          message: `Ready tasks require: ${missingFields.join(", ")}.`,
        }),
      );
}

export function createTask(input: unknown, actor: Actor, services: TaskServices) {
  return Effect.flatMap(
    parseInput(() => compiledCreateTaskInputSchema.parse(input)),
    (parsed) =>
      Effect.flatMap(parsed.lifecycle === "ready" ? validateReady(parsed) : Effect.void, () =>
        services.store.create(parsed, actor),
      ),
  );
}

export function prepareTask(input: unknown, actor: Actor, services: TaskServices) {
  return Effect.flatMap(
    parseInput(() => compiledPrepareTaskInputSchema.parse(input)),
    (parsed) => Effect.flatMap(validateReady(parsed), () => services.store.prepare(parsed, actor)),
  );
}

export function archiveTask(input: unknown, actor: Actor, services: TaskServices) {
  return Effect.flatMap(
    parseInput(() => compiledArchiveTaskInputSchema.parse(input)),
    (parsed) => services.store.archive(parsed, actor),
  );
}

export function listTasks(input: unknown, services: TaskServices) {
  return Effect.flatMap(
    parseInput(() => compiledListTasksInputSchema.parse(input)),
    (parsed) => services.store.list(parsed),
  );
}
