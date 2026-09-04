import { Effect } from "effect";

import {
  compiledSetTaskReviewModeOverrideInputSchema,
  type SetTaskReviewModeOverrideInput,
} from "../domain/customization";
import {
  compiledApproveTaskReviewInputSchema,
  compiledArchiveTaskInputSchema,
  compiledCancelTaskInputSchema,
  compiledClaimNextTaskInputSchema,
  compiledClaimTaskInputSchema,
  compiledCompleteTaskInputSchema,
  compiledCreateTaskInputSchema,
  compiledCreateTaskRelationInputSchema,
  compiledFindWorkInputSchema,
  compiledFailTaskInputSchema,
  compiledListTaskTagsInputSchema,
  compiledListTaskAttemptsInputSchema,
  compiledListTasksInputSchema,
  compiledInvalidateTaskClaimInputSchema,
  compiledReleaseTaskLeaseInputSchema,
  compiledRenewTaskLeaseInputSchema,
  compiledTaskContextInputSchema,
  compiledPrepareTaskInputSchema,
  compiledReopenTaskInputSchema,
  compiledRequestTaskChangesInputSchema,
  compiledRestoreCancelledTaskInputSchema,
  compiledUpdateTaskPlanningInputSchema,
  duplicateExclusiveTagGroups,
  missingReadyPreparation,
  type ApproveTaskReviewInput,
  type Actor,
  type ArchiveTaskInput,
  type CancelTaskInput,
  type ClaimNextTaskInput,
  type ClaimTaskInput,
  type CompleteTaskInput,
  type CreateTaskInput,
  type CreateTaskRelationInput,
  type FindWorkInput,
  type FailTaskInput,
  type ListTaskTagsInput,
  type ListTaskAttemptsInput,
  type ListTasksInput,
  type InvalidateTaskClaimInput,
  type PrepareTaskInput,
  type ReopenTaskInput,
  type RequestTaskChangesInput,
  type RestoreCancelledTaskInput,
  type ReleaseTaskLeaseInput,
  type RenewTaskLeaseInput,
  type Task,
  type TaskAttemptSummary,
  type TaskContextInput,
  type TaskContextPackage,
  type TaskCompletionResult,
  type TaskDiscoveryPage,
  type TaskEvaluationContext,
  type TaskLeaseGrant,
  type TaskLeaseMutationResult,
  type TaskFailureResult,
  type TaskRelation,
  type TaskTag,
  type TaskTransitionResult,
  type UpdateTaskPlanningInput,
} from "../domain/tasks";
import type { RegisteredAgentRun } from "../domain/agents";
import {
  InvalidTaskInputError,
  TaskAuthorizationError,
  TaskTagConstraintError,
  TaskPreparationError,
  type TaskCommandError,
  type TaskPersistenceError,
} from "./task-errors";

export interface TaskStore {
  list(input: TaskListQuery): Effect.Effect<readonly Task[], TaskPersistenceError>;
  listTags(input: ListTaskTagsInput): Effect.Effect<readonly TaskTag[], TaskPersistenceError>;
  listAttempts(
    input: ListTaskAttemptsInput,
  ): Effect.Effect<readonly TaskAttemptSummary[], TaskPersistenceError>;
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
  setReviewModeOverride(
    input: SetTaskReviewModeOverrideInput,
    actor: Actor,
    context: TaskEvaluationContext,
  ): Effect.Effect<Task, TaskCommandError>;
  completeAttempt(
    input: CompleteTaskInput,
    claimant: TaskClaimant,
    context: TaskEvaluationContext,
  ): Effect.Effect<TaskCompletionResult, TaskCommandError>;
  failAttempt(
    input: FailTaskInput,
    claimant: TaskClaimant,
    context: TaskEvaluationContext,
  ): Effect.Effect<TaskFailureResult, TaskCommandError>;
  approveReview(
    input: ApproveTaskReviewInput,
    actor: Actor,
    context: TaskEvaluationContext,
  ): Effect.Effect<TaskTransitionResult, TaskCommandError>;
  requestChanges(
    input: RequestTaskChangesInput,
    actor: Actor,
    context: TaskEvaluationContext,
  ): Effect.Effect<TaskTransitionResult, TaskCommandError>;
  cancel(
    input: CancelTaskInput,
    actor: Actor,
    context: TaskEvaluationContext,
  ): Effect.Effect<TaskTransitionResult, TaskCommandError>;
  restore(
    input: RestoreCancelledTaskInput,
    actor: Actor,
    context: TaskEvaluationContext,
  ): Effect.Effect<TaskTransitionResult, TaskCommandError>;
  reopen(
    input: ReopenTaskInput,
    actor: Actor,
    context: TaskEvaluationContext,
  ): Effect.Effect<TaskTransitionResult, TaskCommandError>;
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
  const currentTime = () => services.clock.now?.() ?? new Date().toISOString();
  return {
    today: services.clock.today(),
    now: currentTime(),
    currentTime,
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
      Effect.flatMap(Effect.all([validateTagConstraints(parsed)]), () =>
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
  registration: RegisteredAgentRun,
  services: TaskServices,
) {
  const claimant = claimantFromRegistration(registration);
  return Effect.flatMap(
    parseInput(() => compiledCompleteTaskInputSchema.parse(input)),
    (parsed) =>
      services.store.completeAttempt(
        parsed,
        claimant,
        evaluationContext(services, claimant.capabilities),
      ),
  );
}

export function failTask(input: unknown, registration: RegisteredAgentRun, services: TaskServices) {
  const claimant = claimantFromRegistration(registration);
  return Effect.flatMap(
    parseInput(() => compiledFailTaskInputSchema.parse(input)),
    (parsed) =>
      services.store.failAttempt(
        parsed,
        claimant,
        evaluationContext(services, claimant.capabilities),
      ),
  );
}

function requireHuman(actor: Actor) {
  return actor.type === "human"
    ? Effect.void
    : Effect.fail(
        new TaskAuthorizationError({
          message: "Only the local human can perform this task transition.",
        }),
      );
}

function requireLocalHuman(actor: Actor) {
  return actor.type === "human" && actor.id === "local-human"
    ? Effect.void
    : Effect.fail(
        new TaskAuthorizationError({
          message: "Only the local human can change a task review policy override.",
        }),
      );
}

export function setTaskReviewModeOverride(
  input: unknown,
  actor: Actor,
  services: TaskServices,
  agentCapabilities: readonly string[] = [],
) {
  return Effect.flatMap(
    parseInput(() => compiledSetTaskReviewModeOverrideInputSchema.parse(input)),
    (parsed) =>
      Effect.flatMap(requireLocalHuman(actor), () =>
        services.store.setReviewModeOverride(
          parsed,
          actor,
          evaluationContext(services, agentCapabilities),
        ),
      ),
  );
}

export function approveTaskReview(
  input: unknown,
  actor: Actor,
  services: TaskServices,
  agentCapabilities: readonly string[] = [],
) {
  return Effect.flatMap(
    parseInput(() => compiledApproveTaskReviewInputSchema.parse(input)),
    (parsed) =>
      Effect.flatMap(requireHuman(actor), () =>
        services.store.approveReview(parsed, actor, evaluationContext(services, agentCapabilities)),
      ),
  );
}

export function requestTaskChanges(
  input: unknown,
  actor: Actor,
  services: TaskServices,
  agentCapabilities: readonly string[] = [],
) {
  return Effect.flatMap(
    parseInput(() => compiledRequestTaskChangesInputSchema.parse(input)),
    (parsed) =>
      Effect.flatMap(requireHuman(actor), () =>
        services.store.requestChanges(
          parsed,
          actor,
          evaluationContext(services, agentCapabilities),
        ),
      ),
  );
}

export function cancelTask(
  input: unknown,
  actor: Actor,
  services: TaskServices,
  agentCapabilities: readonly string[] = [],
) {
  return Effect.flatMap(
    parseInput(() => compiledCancelTaskInputSchema.parse(input)),
    (parsed) =>
      Effect.flatMap(requireHuman(actor), () =>
        services.store.cancel(parsed, actor, evaluationContext(services, agentCapabilities)),
      ),
  );
}

export function restoreCancelledTask(
  input: unknown,
  actor: Actor,
  services: TaskServices,
  agentCapabilities: readonly string[] = [],
) {
  return Effect.flatMap(
    parseInput(() => compiledRestoreCancelledTaskInputSchema.parse(input)),
    (parsed) =>
      Effect.flatMap(requireHuman(actor), () =>
        services.store.restore(parsed, actor, evaluationContext(services, agentCapabilities)),
      ),
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

export function listTaskAttempts(input: unknown, services: TaskServices) {
  return Effect.flatMap(
    parseInput(() => compiledListTaskAttemptsInputSchema.parse(input)),
    (parsed) => services.store.listAttempts(parsed),
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
