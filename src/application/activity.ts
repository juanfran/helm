import { Effect } from "effect";

import type { RegisteredAgentRun } from "../domain/agents";
import {
  compiledCreateAgentActivityEntryInputSchema,
  compiledCreateAgentManualBlockerInputSchema,
  compiledCreateHumanActivityEntryInputSchema,
  compiledCreateManualBlockerInputSchema,
  compiledCreateSystemActivityEntryInputSchema,
  compiledListActivityEntriesInputSchema,
  compiledListManualBlockersInputSchema,
  compiledReadActivityEventsInputSchema,
  compiledResolveManualBlockerInputSchema,
  compiledWithdrawActivityEntryInputSchema,
  type ActivityActor,
  type ActivityEntry,
  type ActivityEntryMutationResult,
  type ActivityEventPage,
  type CreateAgentActivityEntryInput,
  type CreateAgentManualBlockerInput,
  type CreateHumanActivityEntryInput,
  type CreateManualBlockerInput,
  type CreateSystemActivityEntryInput,
  type ListActivityEntriesInput,
  type ListManualBlockersInput,
  type ManualBlocker,
  type ManualBlockerMutationResult,
  type ReadActivityEventsInput,
  type ResolveManualBlockerInput,
  type WithdrawActivityEntryInput,
} from "../domain/activity";
import type { Actor } from "../domain/tasks";
import {
  ActivityAttributionError,
  InvalidActivityInputError,
  type ActivityCommandError,
} from "./activity-errors";

export type ActivityAuthor = {
  readonly actor: ActivityActor;
  readonly agentProfileId: string | null;
  readonly agentRunId: string | null;
};

export interface ActivityStore {
  createEntry(
    input:
      | CreateHumanActivityEntryInput
      | CreateAgentActivityEntryInput
      | CreateSystemActivityEntryInput,
    author: ActivityAuthor,
    now: string,
  ): Effect.Effect<ActivityEntryMutationResult, ActivityCommandError>;
  withdrawEntry(
    input: WithdrawActivityEntryInput,
    actor: ActivityActor,
    now: string,
  ): Effect.Effect<ActivityEntryMutationResult, ActivityCommandError>;
  listEntries(
    input: ListActivityEntriesInput,
  ): Effect.Effect<readonly ActivityEntry[], ActivityCommandError>;
  listManualBlockers(
    input: ListManualBlockersInput,
  ): Effect.Effect<readonly ManualBlocker[], ActivityCommandError>;
  readEvents(
    input: ReadActivityEventsInput,
  ): Effect.Effect<ActivityEventPage, ActivityCommandError>;
  createManualBlocker(
    input: CreateManualBlockerInput | CreateAgentManualBlockerInput,
    author: ActivityAuthor,
    now: string,
  ): Effect.Effect<ManualBlockerMutationResult, ActivityCommandError>;
  resolveManualBlocker(
    input: ResolveManualBlockerInput,
    actor: ActivityActor,
    now: string,
  ): Effect.Effect<ManualBlockerMutationResult, ActivityCommandError>;
}

export type ActivityClock = { now(): string };
export type ActivityServices = { store: ActivityStore; clock: ActivityClock };

export const systemActivityClock: ActivityClock = {
  now: () => new Date().toISOString(),
};

function parseInput<A>(parse: () => A): Effect.Effect<A, InvalidActivityInputError> {
  return Effect.try({
    try: parse,
    catch: () =>
      new InvalidActivityInputError({
        message: "The activity command input is invalid.",
      }),
  });
}

function requireHuman(actor: Actor): Effect.Effect<ActivityActor, ActivityAttributionError> {
  return actor.type === "human"
    ? Effect.succeed(actor)
    : Effect.fail(
        new ActivityAttributionError({
          message: "Human activity commands require the local human actor.",
        }),
      );
}

function authorFromRegistration(registration: RegisteredAgentRun): ActivityAuthor {
  return {
    actor: { type: "agent", id: registration.run.id },
    agentProfileId: registration.profile.id,
    agentRunId: registration.run.id,
  };
}

export function createHumanActivityEntry(input: unknown, actor: Actor, services: ActivityServices) {
  return Effect.flatMap(requireHuman(actor), (human) =>
    Effect.flatMap(
      parseInput(() => compiledCreateHumanActivityEntryInputSchema.parse(input)),
      (parsed) =>
        services.store.createEntry(
          parsed,
          { actor: human, agentProfileId: null, agentRunId: null },
          services.clock.now(),
        ),
    ),
  );
}

export function createAgentActivityEntry(
  input: unknown,
  registration: RegisteredAgentRun,
  services: ActivityServices,
) {
  return Effect.flatMap(
    parseInput(() => compiledCreateAgentActivityEntryInputSchema.parse(input)),
    (parsed) =>
      services.store.createEntry(
        parsed,
        authorFromRegistration(registration),
        services.clock.now(),
      ),
  );
}

export function createSystemActivityEntry(input: unknown, services: ActivityServices) {
  return Effect.flatMap(
    parseInput(() => compiledCreateSystemActivityEntryInputSchema.parse(input)),
    (parsed) =>
      services.store.createEntry(
        parsed,
        {
          actor: { type: "system", id: "helm" },
          agentProfileId: null,
          agentRunId: null,
        },
        services.clock.now(),
      ),
  );
}

export function withdrawActivityEntry(input: unknown, actor: Actor, services: ActivityServices) {
  return Effect.flatMap(requireHuman(actor), (human) =>
    Effect.flatMap(
      parseInput(() => compiledWithdrawActivityEntryInputSchema.parse(input)),
      (parsed) => services.store.withdrawEntry(parsed, human, services.clock.now()),
    ),
  );
}

export function listActivityEntries(input: unknown, services: ActivityServices) {
  return Effect.flatMap(
    parseInput(() => compiledListActivityEntriesInputSchema.parse(input)),
    (parsed) => services.store.listEntries(parsed),
  );
}

export function listManualBlockers(input: unknown, services: ActivityServices) {
  return Effect.flatMap(
    parseInput(() => compiledListManualBlockersInputSchema.parse(input)),
    (parsed) => services.store.listManualBlockers(parsed),
  );
}

export function readActivityEvents(input: unknown, services: ActivityServices) {
  return Effect.flatMap(
    parseInput(() => compiledReadActivityEventsInputSchema.parse(input)),
    (parsed) => services.store.readEvents(parsed),
  );
}

export function createManualBlocker(input: unknown, actor: Actor, services: ActivityServices) {
  return Effect.flatMap(requireHuman(actor), (human) =>
    Effect.flatMap(
      parseInput(() => compiledCreateManualBlockerInputSchema.parse(input)),
      (parsed) =>
        services.store.createManualBlocker(
          parsed,
          { actor: human, agentProfileId: null, agentRunId: null },
          services.clock.now(),
        ),
    ),
  );
}

export function createAgentManualBlocker(
  input: unknown,
  registration: RegisteredAgentRun,
  services: ActivityServices,
) {
  return Effect.flatMap(
    parseInput(() => compiledCreateAgentManualBlockerInputSchema.parse(input)),
    (parsed) =>
      services.store.createManualBlocker(
        parsed,
        authorFromRegistration(registration),
        services.clock.now(),
      ),
  );
}

export function resolveManualBlocker(input: unknown, actor: Actor, services: ActivityServices) {
  return Effect.flatMap(requireHuman(actor), (human) =>
    Effect.flatMap(
      parseInput(() => compiledResolveManualBlockerInputSchema.parse(input)),
      (parsed) => services.store.resolveManualBlocker(parsed, human, services.clock.now()),
    ),
  );
}
