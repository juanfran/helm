import { createServerFn } from "@tanstack/react-start";
import { Effect } from "effect";

import { readActivityEvents } from "../application/activity";
import { activityServices } from "./project-runtime.server";

/** Read only the durable cursor needed to open the application-wide event stream. */
export const readApplicationEventCursor = createServerFn({ method: "GET" }).handler(async () => {
  const page = await Effect.runPromise(
    readActivityEvents(
      {
        projectId: null,
        direction: "backward",
        afterCursor: 0,
        beforeCursor: null,
        limit: 1,
      },
      activityServices,
    ),
  );
  return page.latestCursor;
});
