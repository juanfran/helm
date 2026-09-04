import { createServerFn } from "@tanstack/react-start";
import { Effect } from "effect";

import { getSavedView, listSavedViews, searchTasks } from "../application/task-queries";
import {
  compiledArchiveSavedViewInputSchema,
  compiledCreateSavedViewInputSchema,
  compiledGetSavedViewInputSchema,
  compiledListSavedViewsInputSchema,
  compiledRestoreSavedViewInputSchema,
  compiledUpdateSavedViewInputSchema,
} from "../domain/saved-views";
import { compiledSearchTasksInputSchema } from "../domain/task-filters";
import { taskQueryServices } from "./project-runtime.server";
import {
  executeArchiveSavedView,
  executeCreateSavedView,
  executeRestoreSavedView,
  executeUpdateSavedView,
} from "./task-query-adapter";

const LOCAL_HUMAN = { type: "human", id: "local-human" } as const;

export const readTaskSearchPage = createServerFn({ method: "GET" })
  .validator(compiledSearchTasksInputSchema)
  .handler(({ data }) => Effect.runPromise(searchTasks(data, [], taskQueryServices)));

export const readSavedViews = createServerFn({ method: "GET" })
  .validator(compiledListSavedViewsInputSchema)
  .handler(({ data }) => Effect.runPromise(listSavedViews(data, taskQueryServices)));

export const readSavedView = createServerFn({ method: "GET" })
  .validator(compiledGetSavedViewInputSchema)
  .handler(({ data }) => Effect.runPromise(getSavedView(data, taskQueryServices)));

export const createHumanSavedView = createServerFn({ method: "POST" })
  .validator(compiledCreateSavedViewInputSchema)
  .handler(({ data }) => executeCreateSavedView(data, LOCAL_HUMAN, taskQueryServices));

export const updateHumanSavedView = createServerFn({ method: "POST" })
  .validator(compiledUpdateSavedViewInputSchema)
  .handler(({ data }) => executeUpdateSavedView(data, LOCAL_HUMAN, taskQueryServices));

export const archiveHumanSavedView = createServerFn({ method: "POST" })
  .validator(compiledArchiveSavedViewInputSchema)
  .handler(({ data }) => executeArchiveSavedView(data, LOCAL_HUMAN, taskQueryServices));

export const restoreHumanSavedView = createServerFn({ method: "POST" })
  .validator(compiledRestoreSavedViewInputSchema)
  .handler(({ data }) => executeRestoreSavedView(data, LOCAL_HUMAN, taskQueryServices));
