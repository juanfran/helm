import { createServerFn } from "@tanstack/react-start";
import { Effect } from "effect";

import {
  listActivityEntries,
  listManualBlockers,
  readActivityEvents,
} from "../application/activity";
import {
  compiledCreateHumanActivityEntryInputSchema,
  compiledCreateManualBlockerInputSchema,
  compiledListActivityEntriesInputSchema,
  compiledListManualBlockersInputSchema,
  compiledReadActivityEventsInputSchema,
  compiledResolveManualBlockerInputSchema,
  compiledWithdrawActivityEntryInputSchema,
} from "../domain/activity";
import type { Actor } from "../domain/tasks";
import {
  executeCreateHumanActivityEntry,
  executeCreateManualBlocker,
  executeResolveManualBlocker,
  executeWithdrawActivityEntry,
} from "./activity-adapter";
import { activityServices } from "./project-runtime.server";

const LOCAL_HUMAN: Actor = { type: "human", id: "local-human" };

export const readActivityEntries = createServerFn({ method: "GET" })
  .validator(compiledListActivityEntriesInputSchema)
  .handler(({ data }) => Effect.runPromise(listActivityEntries(data, activityServices)));

export const readProjectEvents = createServerFn({ method: "GET" })
  .validator(compiledReadActivityEventsInputSchema)
  .handler(({ data }) => Effect.runPromise(readActivityEvents(data, activityServices)));

export const readManualBlockers = createServerFn({ method: "GET" })
  .validator(compiledListManualBlockersInputSchema)
  .handler(({ data }) => Effect.runPromise(listManualBlockers(data, activityServices)));

export const createHumanActivity = createServerFn({ method: "POST" })
  .validator(compiledCreateHumanActivityEntryInputSchema)
  .handler(({ data }) => executeCreateHumanActivityEntry(data, LOCAL_HUMAN, activityServices));

export const withdrawHumanActivity = createServerFn({ method: "POST" })
  .validator(compiledWithdrawActivityEntryInputSchema)
  .handler(({ data }) => executeWithdrawActivityEntry(data, LOCAL_HUMAN, activityServices));

export const createHumanManualBlocker = createServerFn({ method: "POST" })
  .validator(compiledCreateManualBlockerInputSchema)
  .handler(({ data }) => executeCreateManualBlocker(data, LOCAL_HUMAN, activityServices));

export const resolveHumanManualBlocker = createServerFn({ method: "POST" })
  .validator(compiledResolveManualBlockerInputSchema)
  .handler(({ data }) => executeResolveManualBlocker(data, LOCAL_HUMAN, activityServices));
