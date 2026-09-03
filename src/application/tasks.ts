import { Effect } from "effect";

import {
  compiledArchiveTaskInputSchema,
  compiledCompleteTaskInputSchema,
  compiledCreateTaskInputSchema,
  compiledCreateTaskRelationInputSchema,
  compiledDiscoverTasksInputSchema,
  compiledListTasksInputSchema,
  compiledPrepareTaskInputSchema,
  compiledReopenTaskInputSchema,
  compiledUpdateTaskPlanningInputSchema,
  duplicateExclusiveTagGroups,
  missingReadyPreparation,
  type Actor,
  type ArchiveTaskInput,
  type CompleteTaskInput,
  type CreateTaskInput,
  type CreateTaskRelationInput,
  type DiscoverTasksInput,
  type ListTasksInput,
  type PrepareTaskInput,
  type ReopenTaskInput,
  type Task,
  type TaskRelation,
  type UpdateTaskPlanningInput,
} from "../domain/tasks";
import {
  InvalidTaskInputError,
  TaskTagConstraintError,
  TaskPreparationError,
  type TaskCommandError,
  type TaskPersistenceError,
} from "./task-errors";

export interface TaskStore {
  list(input: ListTasksInput): Effect.Effect<readonly Task[], TaskPersistenceError>;
  discover(input: DiscoverTasksInput): Effect.Effect<readonly Task[], TaskPersistenceError>;
  create(input: CreateTaskInput, actor: Actor): Effect.Effect<Task, TaskCommandError>;
  prepare(input: PrepareTaskInput, actor: Actor): Effect.Effect<Task, TaskCommandError>;
  complete(input: CompleteTaskInput, actor: Actor): Effect.Effect<Task, TaskCommandError>;
  reopen(input: ReopenTaskInput, actor: Actor): Effect.Effect<Task, TaskCommandError>;
  updatePlanning(
    input: UpdateTaskPlanningInput,
    actor: Actor,
  ): Effect.Effect<Task, TaskCommandError>;
  createRelation(
    input: CreateTaskRelationInput,
    actor: Actor,
  ): Effect.Effect<TaskRelation, TaskCommandError>;
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

function validateTagConstraints(input: {
  tags?: readonly { name: string; exclusiveGroup?: string | null }[];
}): Effect.Effect<void, TaskTagConstraintError> {
  const [duplicate] = duplicateExclusiveTagGroups(input.tags ?? []);
  return duplicate
    ? Effect.fail(
        new TaskTagConstraintError({
          group: duplicate.group,
          tagNames: duplicate.tagNames,
          message: `Tags in the ${duplicate.group} group are mutually exclusive: ${duplicate.tagNames.join(", ")}.`,
        }),
      )
    : Effect.void;
}

export function createTask(input: unknown, actor: Actor, services: TaskServices) {
  return Effect.flatMap(
    parseInput(() => compiledCreateTaskInputSchema.parse(input)),
    (parsed) =>
      Effect.flatMap(
        Effect.all([
          parsed.lifecycle === "ready" ? validateReady(parsed) : Effect.void,
          validateTagConstraints(parsed),
        ]),
        () => services.store.create(parsed, actor),
      ),
  );
}

export function prepareTask(input: unknown, actor: Actor, services: TaskServices) {
  return Effect.flatMap(
    parseInput(() => compiledPrepareTaskInputSchema.parse(input)),
    (parsed) =>
      Effect.flatMap(Effect.all([validateReady(parsed), validateTagConstraints(parsed)]), () =>
        services.store.prepare(parsed, actor),
      ),
  );
}

export function updateTaskPlanning(input: unknown, actor: Actor, services: TaskServices) {
  return Effect.flatMap(
    parseInput(() => compiledUpdateTaskPlanningInputSchema.parse(input)),
    (parsed) =>
      Effect.flatMap(validateTagConstraints(parsed), () =>
        services.store.updatePlanning(parsed, actor),
      ),
  );
}

export function completeTask(input: unknown, actor: Actor, services: TaskServices) {
  return Effect.flatMap(
    parseInput(() => compiledCompleteTaskInputSchema.parse(input)),
    (parsed) => services.store.complete(parsed, actor),
  );
}

export function reopenTask(input: unknown, actor: Actor, services: TaskServices) {
  return Effect.flatMap(
    parseInput(() => compiledReopenTaskInputSchema.parse(input)),
    (parsed) => services.store.reopen(parsed, actor),
  );
}

export function createTaskRelation(input: unknown, actor: Actor, services: TaskServices) {
  return Effect.flatMap(
    parseInput(() => compiledCreateTaskRelationInputSchema.parse(input)),
    (parsed) => services.store.createRelation(parsed, actor),
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

export function discoverTasks(input: unknown, services: TaskServices) {
  return Effect.flatMap(
    parseInput(() => compiledDiscoverTasksInputSchema.parse(input)),
    (parsed) => services.store.discover(parsed),
  );
}
