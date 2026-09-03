import { Effect, Either } from "effect";

import { archiveTask, createTask, prepareTask, type TaskServices } from "../application/tasks";
import {
  toTaskErrorDto,
  type TaskCommandError,
  type TaskErrorDto,
} from "../application/task-errors";
import type { Actor, Task } from "../domain/tasks";

export type TaskCommandResponse = { ok: true; task: Task } | { ok: false; error: TaskErrorDto };

async function execute(
  operation: Effect.Effect<Task, TaskCommandError>,
): Promise<TaskCommandResponse> {
  const result = await Effect.runPromise(Effect.either(operation));
  return Either.isRight(result)
    ? { ok: true, task: result.right }
    : { ok: false, error: toTaskErrorDto(result.left) };
}

export function executeCreateTask(data: unknown, actor: Actor, services: TaskServices) {
  return execute(createTask(data, actor, services));
}

export function executePrepareTask(data: unknown, actor: Actor, services: TaskServices) {
  return execute(prepareTask(data, actor, services));
}

export function executeArchiveTask(data: unknown, actor: Actor, services: TaskServices) {
  return execute(archiveTask(data, actor, services));
}
