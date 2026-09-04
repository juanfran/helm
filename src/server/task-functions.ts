import { createServerFn } from "@tanstack/react-start";
import { Effect } from "effect";

import { listTaskAttempts, listTaskTags, listTasks } from "../application/tasks";
import { compiledSetTaskReviewModeOverrideInputSchema } from "../domain/customization";
import {
  compiledBulkTaskIntentSchema,
  compiledExecuteBulkTasksInputSchema,
} from "../domain/bulk-tasks";
import {
  compiledApproveTaskReviewInputSchema,
  compiledArchiveTaskInputSchema,
  compiledCancelTaskInputSchema,
  compiledCreateTaskInputSchema,
  compiledCreateTaskRelationInputSchema,
  compiledListTaskTagsInputSchema,
  compiledListTaskAttemptsInputSchema,
  compiledListTasksInputSchema,
  compiledInvalidateTaskClaimInputSchema,
  compiledPrepareTaskInputSchema,
  compiledReopenTaskInputSchema,
  compiledRequestTaskChangesInputSchema,
  compiledRestoreCancelledTaskInputSchema,
  compiledUpdateTaskPlanningInputSchema,
  type Actor,
} from "../domain/tasks";
import { bulkTaskServices, taskServices } from "./project-runtime.server";
import {
  executeApproveTaskReview,
  executeArchiveTask,
  executeBulkTaskOperation,
  executeBulkTaskPreview,
  executeCancelTask,
  executeCreateTask,
  executeCreateTaskRelation,
  executeInvalidateTaskClaim,
  executePrepareTask,
  executeReopenTask,
  executeRequestTaskChanges,
  executeRestoreCancelledTask,
  executeSetTaskReviewModeOverride,
  executeUpdateTaskPlanning,
} from "./task-adapter";

const LOCAL_HUMAN: Actor = { type: "human", id: "local-human" };

export const previewHumanBulkTasks = createServerFn({ method: "POST" })
  .validator(compiledBulkTaskIntentSchema)
  .handler(({ data }) => executeBulkTaskPreview(data, LOCAL_HUMAN, bulkTaskServices));

export const executeHumanBulkTasks = createServerFn({ method: "POST" })
  .validator(compiledExecuteBulkTasksInputSchema)
  .handler(({ data }) => executeBulkTaskOperation(data, LOCAL_HUMAN, bulkTaskServices));

export const readTasks = createServerFn({ method: "GET" })
  .validator(compiledListTasksInputSchema)
  .handler(({ data }) => Effect.runPromise(listTasks(data, taskServices)));

export const readTaskTags = createServerFn({ method: "GET" })
  .validator(compiledListTaskTagsInputSchema)
  .handler(({ data }) => Effect.runPromise(listTaskTags(data, taskServices)));

export const readTaskAttempts = createServerFn({ method: "GET" })
  .validator(compiledListTaskAttemptsInputSchema)
  .handler(({ data }) => Effect.runPromise(listTaskAttempts(data, taskServices)));

export const createHumanTask = createServerFn({ method: "POST" })
  .validator(compiledCreateTaskInputSchema)
  .handler(({ data }) => executeCreateTask(data, LOCAL_HUMAN, taskServices));

export const prepareHumanTask = createServerFn({ method: "POST" })
  .validator(compiledPrepareTaskInputSchema)
  .handler(({ data }) => executePrepareTask(data, LOCAL_HUMAN, taskServices));

export const updateHumanTaskPlanning = createServerFn({ method: "POST" })
  .validator(compiledUpdateTaskPlanningInputSchema)
  .handler(({ data }) => executeUpdateTaskPlanning(data, LOCAL_HUMAN, taskServices));

export const setHumanTaskReviewModeOverride = createServerFn({ method: "POST" })
  .validator(compiledSetTaskReviewModeOverrideInputSchema)
  .handler(({ data }) => executeSetTaskReviewModeOverride(data, LOCAL_HUMAN, taskServices));

export const approveHumanTaskReview = createServerFn({ method: "POST" })
  .validator(compiledApproveTaskReviewInputSchema)
  .handler(({ data }) => executeApproveTaskReview(data, LOCAL_HUMAN, taskServices));

export const requestHumanTaskChanges = createServerFn({ method: "POST" })
  .validator(compiledRequestTaskChangesInputSchema)
  .handler(({ data }) => executeRequestTaskChanges(data, LOCAL_HUMAN, taskServices));

export const cancelHumanTask = createServerFn({ method: "POST" })
  .validator(compiledCancelTaskInputSchema)
  .handler(({ data }) => executeCancelTask(data, LOCAL_HUMAN, taskServices));

export const restoreCancelledHumanTask = createServerFn({ method: "POST" })
  .validator(compiledRestoreCancelledTaskInputSchema)
  .handler(({ data }) => executeRestoreCancelledTask(data, LOCAL_HUMAN, taskServices));

export const reopenHumanTask = createServerFn({ method: "POST" })
  .validator(compiledReopenTaskInputSchema)
  .handler(({ data }) => executeReopenTask(data, LOCAL_HUMAN, taskServices));

export const createHumanTaskRelation = createServerFn({ method: "POST" })
  .validator(compiledCreateTaskRelationInputSchema)
  .handler(({ data }) => executeCreateTaskRelation(data, LOCAL_HUMAN, taskServices));

export const archiveHumanTask = createServerFn({ method: "POST" })
  .validator(compiledArchiveTaskInputSchema)
  .handler(({ data }) => executeArchiveTask(data, LOCAL_HUMAN, taskServices));

export const invalidateHumanTaskClaim = createServerFn({ method: "POST" })
  .validator(compiledInvalidateTaskClaimInputSchema)
  .handler(({ data }) => executeInvalidateTaskClaim(data, LOCAL_HUMAN, taskServices));
