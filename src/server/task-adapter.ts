import { Effect, Either } from "effect";

import {
  executeBulkTasks as executeBulkTasksApplication,
  previewBulkTasks,
  type BulkTaskServices,
} from "../application/bulk-tasks";
import {
  toBulkTaskErrorDto,
  type BulkTaskCommandError,
  type BulkTaskErrorDto,
} from "../application/bulk-task-errors";
import {
  approveTaskReview,
  archiveTask,
  cancelTask,
  completeTask,
  createTask,
  createTaskRelation,
  failTask,
  invalidateTaskClaim,
  prepareTask,
  reopenTask,
  requestTaskChanges,
  restoreCancelledTask,
  updateTaskPlanning,
  type TaskServices,
} from "../application/tasks";
import {
  toTaskErrorDto,
  type TaskCommandError,
  type TaskErrorDto,
} from "../application/task-errors";
import type { RegisteredAgentRun } from "../domain/agents";
import type { BulkTaskExecutionResult, BulkTaskPreview } from "../domain/bulk-tasks";
import type {
  Actor,
  Task,
  TaskCompletionResult,
  TaskFailureResult,
  TaskLeaseMutationResult,
  TaskRelation,
  TaskTransitionResult,
} from "../domain/tasks";

export type TaskCommandResponse = { ok: true; task: Task } | { ok: false; error: TaskErrorDto };
export type TaskRelationCommandResponse =
  | { ok: true; relation: TaskRelation }
  | { ok: false; error: TaskErrorDto };
export type TaskLeaseCommandResponse =
  | { ok: true; result: TaskLeaseMutationResult }
  | { ok: false; error: TaskErrorDto };
export type TaskCompletionCommandResponse =
  | { ok: true; result: TaskCompletionResult }
  | { ok: false; error: TaskErrorDto };
export type TaskFailureCommandResponse =
  | { ok: true; result: TaskFailureResult }
  | { ok: false; error: TaskErrorDto };
export type TaskTransitionCommandResponse =
  | { ok: true; result: TaskTransitionResult }
  | { ok: false; error: TaskErrorDto };
export type BulkTaskPreviewCommandResponse =
  | { ok: true; preview: BulkTaskPreview }
  | { ok: false; error: BulkTaskErrorDto };
export type BulkTaskExecutionCommandResponse =
  | { ok: true; result: BulkTaskExecutionResult }
  | { ok: false; error: BulkTaskErrorDto };

async function execute(
  operation: Effect.Effect<Task, TaskCommandError>,
): Promise<TaskCommandResponse> {
  const result = await Effect.runPromise(Effect.either(operation));
  return Either.isRight(result)
    ? { ok: true, task: result.right }
    : { ok: false, error: toTaskErrorDto(result.left) };
}

async function executeRelation(
  operation: Effect.Effect<TaskRelation, TaskCommandError>,
): Promise<TaskRelationCommandResponse> {
  const result = await Effect.runPromise(Effect.either(operation));
  return Either.isRight(result)
    ? { ok: true, relation: result.right }
    : { ok: false, error: toTaskErrorDto(result.left) };
}

async function executeLeaseMutation(
  operation: Effect.Effect<TaskLeaseMutationResult, TaskCommandError>,
): Promise<TaskLeaseCommandResponse> {
  const result = await Effect.runPromise(Effect.either(operation));
  return Either.isRight(result)
    ? { ok: true, result: result.right }
    : { ok: false, error: toTaskErrorDto(result.left) };
}

async function executeResult<A>(
  operation: Effect.Effect<A, TaskCommandError>,
): Promise<{ ok: true; result: A } | { ok: false; error: TaskErrorDto }> {
  const result = await Effect.runPromise(Effect.either(operation));
  return Either.isRight(result)
    ? { ok: true, result: result.right }
    : { ok: false, error: toTaskErrorDto(result.left) };
}

async function executeBulkResult<A>(
  operation: Effect.Effect<A, BulkTaskCommandError>,
): Promise<{ ok: true; result: A } | { ok: false; error: BulkTaskErrorDto }> {
  const result = await Effect.runPromise(Effect.either(operation));
  return Either.isRight(result)
    ? { ok: true, result: result.right }
    : { ok: false, error: toBulkTaskErrorDto(result.left) };
}

export async function executeBulkTaskPreview(
  data: unknown,
  actor: Actor,
  services: BulkTaskServices,
  agentCapabilities: readonly string[] = [],
): Promise<BulkTaskPreviewCommandResponse> {
  const response = await executeBulkResult(
    previewBulkTasks(data, actor, services, agentCapabilities),
  );
  return response.ok
    ? { ok: true, preview: response.result }
    : { ok: false, error: response.error };
}

export function executeBulkTaskOperation(
  data: unknown,
  actor: Actor,
  services: BulkTaskServices,
  agentCapabilities: readonly string[] = [],
): Promise<BulkTaskExecutionCommandResponse> {
  return executeBulkResult(executeBulkTasksApplication(data, actor, services, agentCapabilities));
}

export function executeCreateTask(
  data: unknown,
  actor: Actor,
  services: TaskServices,
  agentCapabilities: readonly string[] = [],
) {
  return execute(createTask(data, actor, services, agentCapabilities));
}

export function executePrepareTask(data: unknown, actor: Actor, services: TaskServices) {
  return execute(prepareTask(data, actor, services));
}

export function executeUpdateTaskPlanning(data: unknown, actor: Actor, services: TaskServices) {
  return execute(updateTaskPlanning(data, actor, services));
}

export function executeCompleteTask(
  data: unknown,
  registration: RegisteredAgentRun,
  services: TaskServices,
): Promise<TaskCompletionCommandResponse> {
  return executeResult(completeTask(data, registration, services));
}

export function executeFailTask(
  data: unknown,
  registration: RegisteredAgentRun,
  services: TaskServices,
): Promise<TaskFailureCommandResponse> {
  return executeResult(failTask(data, registration, services));
}

export function executeApproveTaskReview(data: unknown, actor: Actor, services: TaskServices) {
  return executeResult(approveTaskReview(data, actor, services));
}

export function executeRequestTaskChanges(data: unknown, actor: Actor, services: TaskServices) {
  return executeResult(requestTaskChanges(data, actor, services));
}

export function executeCancelTask(data: unknown, actor: Actor, services: TaskServices) {
  return executeResult(cancelTask(data, actor, services));
}

export function executeRestoreCancelledTask(data: unknown, actor: Actor, services: TaskServices) {
  return executeResult(restoreCancelledTask(data, actor, services));
}

export function executeReopenTask(
  data: unknown,
  actor: Actor,
  services: TaskServices,
  agentCapabilities: readonly string[] = [],
): Promise<TaskTransitionCommandResponse> {
  return executeResult(reopenTask(data, actor, services, agentCapabilities));
}

export function executeCreateTaskRelation(data: unknown, actor: Actor, services: TaskServices) {
  return executeRelation(createTaskRelation(data, actor, services));
}

export function executeArchiveTask(data: unknown, actor: Actor, services: TaskServices) {
  return execute(archiveTask(data, actor, services));
}

export function executeInvalidateTaskClaim(data: unknown, actor: Actor, services: TaskServices) {
  return executeLeaseMutation(invalidateTaskClaim(data, actor, services));
}
