import { createServerFn } from "@tanstack/react-start";
import { Effect } from "effect";

import { listTasks } from "../application/tasks";
import {
  compiledArchiveTaskInputSchema,
  compiledCreateTaskInputSchema,
  compiledListTasksInputSchema,
  compiledPrepareTaskInputSchema,
  type Actor,
} from "../domain/tasks";
import { taskServices } from "./project-runtime.server";
import { executeArchiveTask, executeCreateTask, executePrepareTask } from "./task-adapter";

const LOCAL_HUMAN: Actor = { type: "human", id: "local-human" };

export const readTasks = createServerFn({ method: "GET" })
  .validator(compiledListTasksInputSchema)
  .handler(({ data }) => Effect.runPromise(listTasks(data, taskServices)));

export const createHumanTask = createServerFn({ method: "POST" })
  .validator(compiledCreateTaskInputSchema)
  .handler(({ data }) => executeCreateTask(data, LOCAL_HUMAN, taskServices));

export const prepareHumanTask = createServerFn({ method: "POST" })
  .validator(compiledPrepareTaskInputSchema)
  .handler(({ data }) => executePrepareTask(data, LOCAL_HUMAN, taskServices));

export const archiveHumanTask = createServerFn({ method: "POST" })
  .validator(compiledArchiveTaskInputSchema)
  .handler(({ data }) => executeArchiveTask(data, LOCAL_HUMAN, taskServices));
