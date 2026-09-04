import { Effect, Either } from "effect";

import {
  createAgentActivityEntry,
  createAgentManualBlocker,
  createHumanActivityEntry,
  createManualBlocker,
  resolveManualBlocker,
  withdrawActivityEntry,
  type ActivityServices,
} from "../application/activity";
import {
  toActivityErrorDto,
  type ActivityCommandError,
  type ActivityErrorDto,
} from "../application/activity-errors";
import type { RegisteredAgentRun } from "../domain/agents";
import type { ActivityEntryMutationResult, ManualBlockerMutationResult } from "../domain/activity";
import type { Actor } from "../domain/tasks";

export type ActivityEntryCommandResponse =
  | { ok: true; result: ActivityEntryMutationResult }
  | { ok: false; error: ActivityErrorDto };

export type ManualBlockerCommandResponse =
  | { ok: true; result: ManualBlockerMutationResult }
  | { ok: false; error: ActivityErrorDto };

async function executeEntry(
  operation: Effect.Effect<ActivityEntryMutationResult, ActivityCommandError>,
): Promise<ActivityEntryCommandResponse> {
  const result = await Effect.runPromise(Effect.either(operation));
  return Either.isRight(result)
    ? { ok: true, result: result.right }
    : { ok: false, error: toActivityErrorDto(result.left) };
}

async function executeBlocker(
  operation: Effect.Effect<ManualBlockerMutationResult, ActivityCommandError>,
): Promise<ManualBlockerCommandResponse> {
  const result = await Effect.runPromise(Effect.either(operation));
  return Either.isRight(result)
    ? { ok: true, result: result.right }
    : { ok: false, error: toActivityErrorDto(result.left) };
}

export function executeCreateHumanActivityEntry(
  data: unknown,
  actor: Actor,
  services: ActivityServices,
) {
  return executeEntry(createHumanActivityEntry(data, actor, services));
}

export function executeCreateAgentActivityEntry(
  data: unknown,
  registration: RegisteredAgentRun,
  services: ActivityServices,
) {
  return executeEntry(createAgentActivityEntry(data, registration, services));
}

export function executeWithdrawActivityEntry(
  data: unknown,
  actor: Actor,
  services: ActivityServices,
) {
  return executeEntry(withdrawActivityEntry(data, actor, services));
}

export function executeCreateManualBlocker(
  data: unknown,
  actor: Actor,
  services: ActivityServices,
) {
  return executeBlocker(createManualBlocker(data, actor, services));
}

export function executeCreateAgentManualBlocker(
  data: unknown,
  registration: RegisteredAgentRun,
  services: ActivityServices,
) {
  return executeBlocker(createAgentManualBlocker(data, registration, services));
}

export function executeResolveManualBlocker(
  data: unknown,
  actor: Actor,
  services: ActivityServices,
) {
  return executeBlocker(resolveManualBlocker(data, actor, services));
}
