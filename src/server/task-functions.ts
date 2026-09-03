import { createServerFn } from "@tanstack/react-start";
import { Effect } from "effect";

import { listTasks } from "../application/tasks";
import {
  compiledArchiveTaskInputSchema,
  compiledCompleteTaskInputSchema,
  compiledCreateTaskInputSchema,
  compiledCreateTaskRelationInputSchema,
  compiledListTasksInputSchema,
  compiledPrepareTaskInputSchema,
  compiledReopenTaskInputSchema,
  compiledUpdateTaskPlanningInputSchema,
  type Actor,
} from "../domain/tasks";
import { taskServices } from "./project-runtime.server";
import {
  executeArchiveTask,
  executeCompleteTask,
  executeCreateTask,
  executeCreateTaskRelation,
  executePrepareTask,
  executeReopenTask,
  executeUpdateTaskPlanning,
} from "./task-adapter";

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

export const updateHumanTaskPlanning = createServerFn({ method: "POST" })
  .validator(compiledUpdateTaskPlanningInputSchema)
  .handler(({ data }) => executeUpdateTaskPlanning(data, LOCAL_HUMAN, taskServices));

export const completeHumanTask = createServerFn({ method: "POST" })
  .validator(compiledCompleteTaskInputSchema)
  .handler(({ data }) => executeCompleteTask(data, LOCAL_HUMAN, taskServices));

export const reopenHumanTask = createServerFn({ method: "POST" })
  .validator(compiledReopenTaskInputSchema)
  .handler(({ data }) => executeReopenTask(data, LOCAL_HUMAN, taskServices));

export const createHumanTaskRelation = createServerFn({ method: "POST" })
  .validator(compiledCreateTaskRelationInputSchema)
  .handler(({ data }) => executeCreateTaskRelation(data, LOCAL_HUMAN, taskServices));

export const archiveHumanTask = createServerFn({ method: "POST" })
  .validator(compiledArchiveTaskInputSchema)
  .handler(({ data }) => executeArchiveTask(data, LOCAL_HUMAN, taskServices));
