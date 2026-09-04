import { Effect } from "effect";

import {
  compiledArchiveTaskInputSchema,
  compiledClaimNextTaskInputSchema,
  compiledClaimTaskInputSchema,
  compiledCompleteTaskInputSchema,
  compiledCreateTaskInputSchema,
  compiledCreateTaskRelationInputSchema,
  compiledFindWorkInputSchema,
  compiledListTaskTagsInputSchema,
  compiledListTasksInputSchema,
  compiledInvalidateTaskClaimInputSchema,
  compiledReleaseTaskLeaseInputSchema,
  compiledRenewTaskLeaseInputSchema,
  compiledTaskContextInputSchema,
  compiledPrepareTaskInputSchema,
  compiledReopenTaskInputSchema,
  compiledUpdateTaskPlanningInputSchema,
  duplicateExclusiveTagGroups,
  missingReadyPreparation,
  type Actor,
  type ArchiveTaskInput,
  type ClaimNextTaskInput,
  type ClaimTaskInput,
  type CompleteTaskInput,
  type CreateTaskInput,
  type CreateTaskRelationInput,
  type FindWorkInput,
  type ListTaskTagsInput,
  type ListTasksInput,
  type InvalidateTaskClaimInput,
  type PrepareTaskInput,
  type ReopenTaskInput,
  type ReleaseTaskLeaseInput,
  type RenewTaskLeaseInput,
  type Task,
  type TaskContextInput,
  type TaskContextPackage,
  type TaskDiscoveryPage,
  type TaskEvaluationContext,
  type TaskLeaseGrant,
  type TaskLeaseMutationResult,
  type TaskRelation,
  type TaskTag,
  type UpdateTaskPlanningInput,
} from "../domain/tasks";
import type { RegisteredAgentRun } from "../domain/agents";
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
  claimTask(
    input: ClaimTaskInput,
    claimant: TaskClaimant,
    context: TaskEvaluationContext,
  ): Effect.Effect<TaskLeaseGrant, TaskCommandError>;
  claimNext(
    input: ClaimNextTaskInput,
    claimant: TaskClaimant,
    context: TaskEvaluationContext,
  ): Effect.Effect<TaskLeaseGrant, TaskCommandError>;
  renewLease(
    input: RenewTaskLeaseInput,
    claimant: TaskClaimant,
    context: TaskEvaluationContext,
  ): Effect.Effect<TaskLeaseGrant, TaskCommandError>;
  releaseLease(
    input: ReleaseTaskLeaseInput,
    claimant: TaskClaimant,
    context: TaskEvaluationContext,
  ): Effect.Effect<TaskLeaseMutationResult, TaskCommandError>;
  invalidateClaim(
    input: InvalidateTaskClaimInput,
    actor: Actor,
    context: TaskEvaluationContext,
  ): Effect.Effect<TaskLeaseMutationResult, TaskCommandError>;
  cancelLeasesForRun(
    agentRunId: string,
    context: TaskEvaluationContext,
  ): Effect.Effect<number, TaskCommandError>;
  reconcileLeases(context: TaskEvaluationContext): Effect.Effect<number, TaskCommandError>;
}

export type TaskClaimant = {
  readonly runId: string;
  readonly profileId: string;
  readonly displayName: string;
  readonly capabilities: readonly string[];
};

export type TaskClock = { today(): string; now?(): string };
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
  now() {
    return new Date().toISOString();
  },
};

function evaluationContext(
  services: TaskServices,
  agentCapabilities: readonly string[] = [],
): TaskEvaluationContext {
  return {
    today: services.clock.today(),
    now: services.clock.now?.() ?? new Date().toISOString(),
    agentCapabilities,
  };
}

function claimantFromRegistration(registration: RegisteredAgentRun): TaskClaimant {
  return {
    runId: registration.run.id,
    profileId: registration.profile.id,
    displayName: registration.profile.displayName,
    capabilities: registration.profile.capabilities,
  };
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

export function claimTask(
  input: unknown,
  registration: RegisteredAgentRun,
  services: TaskServices,
) {
  const claimant = claimantFromRegistration(registration);
  return Effect.flatMap(
    parseInput(() => compiledClaimTaskInputSchema.parse(input)),
    (parsed) =>
      services.store.claimTask(
        parsed,
        claimant,
        evaluationContext(services, claimant.capabilities),
      ),
  );
}

export function claimNextTask(
  input: unknown,
  registration: RegisteredAgentRun,
  services: TaskServices,
) {
  const claimant = claimantFromRegistration(registration);
  return Effect.flatMap(
    parseInput(() => compiledClaimNextTaskInputSchema.parse(input)),
    (parsed) =>
      services.store.claimNext(
        parsed,
        claimant,
        evaluationContext(services, claimant.capabilities),
      ),
  );
}

export function renewTaskLease(
  input: unknown,
  registration: RegisteredAgentRun,
  services: TaskServices,
) {
  const claimant = claimantFromRegistration(registration);
  return Effect.flatMap(
    parseInput(() => compiledRenewTaskLeaseInputSchema.parse(input)),
    (parsed) =>
      services.store.renewLease(
        parsed,
        claimant,
        evaluationContext(services, claimant.capabilities),
      ),
  );
}

export function releaseTaskLease(
  input: unknown,
  registration: RegisteredAgentRun,
  services: TaskServices,
) {
  const claimant = claimantFromRegistration(registration);
  return Effect.flatMap(
    parseInput(() => compiledReleaseTaskLeaseInputSchema.parse(input)),
    (parsed) =>
      services.store.releaseLease(
        parsed,
        claimant,
        evaluationContext(services, claimant.capabilities),
      ),
  );
}

export function invalidateTaskClaim(
  input: unknown,
  actor: Actor,
  services: TaskServices,
  agentCapabilities: readonly string[] = [],
) {
  return Effect.flatMap(
    parseInput(() => compiledInvalidateTaskClaimInputSchema.parse(input)),
    (parsed) =>
      services.store.invalidateClaim(parsed, actor, evaluationContext(services, agentCapabilities)),
  );
}

export function reconcileTaskLeases(services: TaskServices) {
  return services.store.reconcileLeases(evaluationContext(services));
}

export function cancelTaskLeasesForRun(agentRunId: string, services: TaskServices) {
  return services.store.cancelLeasesForRun(agentRunId, evaluationContext(services));
}
