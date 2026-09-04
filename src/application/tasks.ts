import { Effect } from "effect";

import {
  compiledArchiveTaskInputSchema,
  compiledCompleteTaskInputSchema,
  compiledCreateTaskInputSchema,
  compiledCreateTaskRelationInputSchema,
  compiledFindWorkInputSchema,
  compiledListTaskTagsInputSchema,
  compiledListTasksInputSchema,
  compiledTaskContextInputSchema,
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
  type FindWorkInput,
  type ListTaskTagsInput,
  type ListTasksInput,
  type PrepareTaskInput,
  type ReopenTaskInput,
  type Task,
  type TaskContextInput,
  type TaskContextPackage,
  type TaskDiscoveryPage,
  type TaskEvaluationContext,
  type TaskRelation,
  type TaskTag,
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
  list(input: TaskListQuery): Effect.Effect<readonly Task[], TaskPersistenceError>;
  listTags(input: ListTaskTagsInput): Effect.Effect<readonly TaskTag[], TaskPersistenceError>;
  discoverPage(input: TaskDiscoveryQuery): Effect.Effect<TaskDiscoveryPage, TaskCommandError>;
  getContext(input: TaskContextQuery): Effect.Effect<TaskContextPackage, TaskCommandError>;
  create(
    input: CreateTaskInput,
    actor: Actor,
    context: TaskEvaluationContext,
  ): Effect.Effect<Task, TaskCommandError>;
  prepare(
    input: PrepareTaskInput,
    actor: Actor,
    context: TaskEvaluationContext,
  ): Effect.Effect<Task, TaskCommandError>;
  complete(
    input: CompleteTaskInput,
    actor: Actor,
    context: TaskEvaluationContext,
  ): Effect.Effect<Task, TaskCommandError>;
  reopen(
    input: ReopenTaskInput,
    actor: Actor,
    context: TaskEvaluationContext,
  ): Effect.Effect<Task, TaskCommandError>;
  updatePlanning(
    input: UpdateTaskPlanningInput,
    actor: Actor,
    context: TaskEvaluationContext,
  ): Effect.Effect<Task, TaskCommandError>;
  createRelation(
    input: CreateTaskRelationInput,
    actor: Actor,
  ): Effect.Effect<TaskRelation, TaskCommandError>;
  archive(
    input: ArchiveTaskInput,
    actor: Actor,
    context: TaskEvaluationContext,
  ): Effect.Effect<Task, TaskCommandError>;
}

export type TaskClock = { today(): string };
export type TaskServices = { store: TaskStore; clock: TaskClock };
export type TaskListQuery = ListTasksInput & TaskEvaluationContext;
export type TaskDiscoveryQuery = FindWorkInput & TaskEvaluationContext;
export type TaskContextQuery = TaskContextInput & TaskEvaluationContext;

export const systemTaskClock: TaskClock = {
  today() {
    const date = new Date();
    const year = String(date.getFullYear()).padStart(4, "0");
    const month = String(date.getMonth() + 1).padStart(2, "0");
    const day = String(date.getDate()).padStart(2, "0");
    return `${year}-${month}-${day}`;
  },
};

function evaluationContext(
  services: TaskServices,
  agentCapabilities: readonly string[] = [],
): TaskEvaluationContext {
  return { today: services.clock.today(), agentCapabilities };
}

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

export function createTask(
  input: unknown,
  actor: Actor,
  services: TaskServices,
  agentCapabilities: readonly string[] = [],
) {
  return Effect.flatMap(
    parseInput(() => compiledCreateTaskInputSchema.parse(input)),
    (parsed) =>
      Effect.flatMap(
        Effect.all([
          parsed.lifecycle === "ready" ? validateReady(parsed) : Effect.void,
          validateTagConstraints(parsed),
        ]),
        () => services.store.create(parsed, actor, evaluationContext(services, agentCapabilities)),
      ),
  );
}

export function prepareTask(
  input: unknown,
  actor: Actor,
  services: TaskServices,
  agentCapabilities: readonly string[] = [],
) {
  return Effect.flatMap(
    parseInput(() => compiledPrepareTaskInputSchema.parse(input)),
    (parsed) =>
      Effect.flatMap(Effect.all([validateReady(parsed), validateTagConstraints(parsed)]), () =>
        services.store.prepare(parsed, actor, evaluationContext(services, agentCapabilities)),
      ),
  );
}

export function updateTaskPlanning(
  input: unknown,
  actor: Actor,
  services: TaskServices,
  agentCapabilities: readonly string[] = [],
) {
  return Effect.flatMap(
    parseInput(() => compiledUpdateTaskPlanningInputSchema.parse(input)),
    (parsed) =>
      Effect.flatMap(validateTagConstraints(parsed), () =>
        services.store.updatePlanning(
          parsed,
          actor,
          evaluationContext(services, agentCapabilities),
        ),
      ),
  );
}

export function completeTask(
  input: unknown,
  actor: Actor,
  services: TaskServices,
  agentCapabilities: readonly string[] = [],
) {
  return Effect.flatMap(
    parseInput(() => compiledCompleteTaskInputSchema.parse(input)),
    (parsed) =>
      services.store.complete(parsed, actor, evaluationContext(services, agentCapabilities)),
  );
}

export function reopenTask(
  input: unknown,
  actor: Actor,
  services: TaskServices,
  agentCapabilities: readonly string[] = [],
) {
  return Effect.flatMap(
    parseInput(() => compiledReopenTaskInputSchema.parse(input)),
    (parsed) =>
      services.store.reopen(parsed, actor, evaluationContext(services, agentCapabilities)),
  );
}

export function createTaskRelation(input: unknown, actor: Actor, services: TaskServices) {
  return Effect.flatMap(
    parseInput(() => compiledCreateTaskRelationInputSchema.parse(input)),
    (parsed) => services.store.createRelation(parsed, actor),
  );
}

export function archiveTask(
  input: unknown,
  actor: Actor,
  services: TaskServices,
  agentCapabilities: readonly string[] = [],
) {
  return Effect.flatMap(
    parseInput(() => compiledArchiveTaskInputSchema.parse(input)),
    (parsed) =>
      services.store.archive(parsed, actor, evaluationContext(services, agentCapabilities)),
  );
}

export function listTasks(
  input: unknown,
  services: TaskServices,
  agentCapabilities: readonly string[] = [],
) {
  return Effect.flatMap(
    parseInput(() => compiledListTasksInputSchema.parse(input)),
    (parsed) =>
      services.store.list({ ...parsed, ...evaluationContext(services, agentCapabilities) }),
  );
}

export function listTaskTags(input: unknown, services: TaskServices) {
  return Effect.flatMap(
    parseInput(() => compiledListTaskTagsInputSchema.parse(input)),
    (parsed) => services.store.listTags(parsed),
  );
}

export function findWork(
  input: unknown,
  agentCapabilities: readonly string[],
  services: TaskServices,
) {
  return Effect.flatMap(
    parseInput(() => compiledFindWorkInputSchema.parse(input)),
    (parsed: FindWorkInput) =>
      services.store.discoverPage({
        ...parsed,
        ...evaluationContext(services, agentCapabilities),
      }),
  );
}

export function getTaskContext(
  input: unknown,
  agentCapabilities: readonly string[],
  services: TaskServices,
) {
  return Effect.flatMap(
    parseInput(() => compiledTaskContextInputSchema.parse(input)),
    (parsed) =>
      services.store.getContext({
        ...parsed,
        ...evaluationContext(services, agentCapabilities),
      }),
  );
}
