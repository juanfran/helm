import { useCallback, useEffect, useMemo, useState } from "react";
import { createFileRoute, useRouter } from "@tanstack/react-router";
import { useLiveSuspenseQuery } from "@tanstack/react-db";
import { useQueryClient, useSuspenseQuery } from "@tanstack/react-query";

import {
  getActivityEntryCollection,
  getManualBlockerCollection,
  getProjectEventCollection,
} from "../features/activity/activity-collection";
import { applyProjectionDelta, projectEvent } from "../features/activity/project-event-projector";
import { subscribeToProjectEvents } from "../features/activity/project-event-subscription";
import {
  getProjectSyncCoordinator,
  waitForAllProjectSync,
} from "../features/activity/project-sync-coordinator";
import { reconcileOptimisticCommand } from "../features/activity/optimistic-reconciliation";
import { ProjectLanding } from "../features/projects/project-landing";
import { getTaskCollection } from "../features/tasks/task-collection";
import { TaskWorkspace } from "../features/tasks/task-workspace";
import {
  createHumanActivity,
  createHumanManualBlocker,
  readActivityEntries,
  readManualBlockers,
  readProjectEvents,
  resolveHumanManualBlocker,
  withdrawHumanActivity,
} from "../server/activity-functions";
import { changeTheme, createInitialProject } from "../server/project-functions";
import { readAppState } from "../server/project-functions";
import {
  archiveHumanTask,
  completeHumanTask,
  createHumanTask,
  createHumanTaskRelation,
  invalidateHumanTaskClaim,
  prepareHumanTask,
  readTaskTags,
  readTasks,
  reopenHumanTask,
  updateHumanTaskPlanning,
} from "../server/task-functions";
import { applyThemeToDocument } from "../styles/theme";
import { richTextToPlainText } from "../domain/rich-text";
import {
  activityEntrySchema,
  manualBlockerSchema,
  type ActivityEntry,
  type CreateHumanActivityEntryInput,
  type CreateManualBlockerInput,
  type ManualBlocker,
  type ResolveManualBlockerInput,
  type WithdrawActivityEntryInput,
} from "../domain/activity";
import type { Project, Theme } from "../domain/projects";

export const Route = createFileRoute("/")({
  ssr: false,
  loader: async ({ context }) => {
    const state = await readAppState();
    let eventCursor = 0;
    if (state.activeProject) {
      const projectId = state.activeProject.id;
      const eventPage = await readProjectEvents({
        data: {
          projectId,
          direction: "backward",
          afterCursor: 0,
          beforeCursor: null,
          limit: 1,
        },
      });
      eventCursor = eventPage.latestCursor;
      const syncCoordinator = getProjectSyncCoordinator(context.queryClient, projectId);
      const taskCollection = getTaskCollection(context.queryClient, projectId);
      const activityCollection = getActivityEntryCollection(context.queryClient, projectId);
      const blockerCollection = getManualBlockerCollection(context.queryClient, projectId);
      const eventCollection = getProjectEventCollection(context.queryClient, projectId);
      await syncCoordinator.run(() =>
        waitForAllProjectSync([
          taskCollection.isReady()
            ? taskCollection.utils.refetch({ throwOnError: true })
            : taskCollection.preload(),
          activityCollection.isReady()
            ? activityCollection.utils.refetch({ throwOnError: true })
            : activityCollection.preload(),
          blockerCollection.isReady()
            ? blockerCollection.utils.refetch({ throwOnError: true })
            : blockerCollection.preload(),
          eventCollection.isReady()
            ? eventCollection.utils.refetch({ throwOnError: true })
            : eventCollection.preload(),
          context.queryClient.ensureQueryData(taskTagsQueryOptions(projectId)),
        ]),
      );
    }
    return { ...state, eventCursor };
  },
  component: Home,
});

function taskTagsQueryOptions(projectId: string) {
  return {
    queryKey: ["task-tags", projectId] as const,
    queryFn: () => readTaskTags({ data: { projectId } }),
  };
}

function Home() {
  const state = Route.useLoaderData();
  const router = useRouter();

  if (state.activeProject) {
    return <ActiveProjectHome project={state.activeProject} theme={state.theme} />;
  }

  return (
    <ProjectLanding
      state={state}
      onCreateProject={async (input) => {
        const response = await createInitialProject({ data: input });
        if (response.ok) await router.invalidate({ sync: true });
        return response;
      }}
      onChangeTheme={async (input) => {
        const response = await changeTheme({ data: input });
        if (response.ok) await router.invalidate({ sync: true });
        return response;
      }}
    />
  );
}

function ActiveProjectHome({ project, theme }: { project: Project; theme: Theme }) {
  const { eventCursor } = Route.useLoaderData();
  const router = useRouter();
  const queryClient = useQueryClient();
  const taskCollection = getTaskCollection(queryClient, project.id);
  const activityCollection = getActivityEntryCollection(queryClient, project.id);
  const blockerCollection = getManualBlockerCollection(queryClient, project.id);
  const eventCollection = getProjectEventCollection(queryClient, project.id);
  const syncCoordinator = getProjectSyncCoordinator(queryClient, project.id);
  const [liveStatus, setLiveStatus] = useState<"connecting" | "live" | "retrying">("connecting");
  const { data: tasks } = useLiveSuspenseQuery({
    query: (query) => query.from({ task: taskCollection }),
  });
  const { data: activityEntries } = useLiveSuspenseQuery({
    query: (query) => query.from({ entry: activityCollection }),
  });
  const { data: manualBlockers } = useLiveSuspenseQuery({
    query: (query) => query.from({ blocker: blockerCollection }),
  });
  const { data: projectEvents } = useLiveSuspenseQuery({
    query: (query) => query.from({ event: eventCollection }),
  });
  const { data: tagDefinitions } = useSuspenseQuery(taskTagsQueryOptions(project.id));

  const refetchProjectCollections = useCallback(
    () =>
      waitForAllProjectSync([
        taskCollection.utils.refetch({ throwOnError: true }),
        activityCollection.utils.refetch({ throwOnError: true }),
        blockerCollection.utils.refetch({ throwOnError: true }),
        eventCollection.utils.refetch({ throwOnError: true }),
      ]),
    [activityCollection, blockerCollection, eventCollection, taskCollection],
  );

  const readTaskDelta = useCallback(
    async (taskIds: readonly string[]) => {
      const rows = await readTasks({
        data: { projectId: project.id, taskIds: [...taskIds], includeArchived: true },
      });
      const byId = new Map(rows.map((task) => [task.id, task]));
      return {
        upserts: rows.filter((task) => task.archivedAt === null),
        deleteIds: taskIds.filter((taskId) => {
          const task = byId.get(taskId);
          return !task || task.archivedAt !== null;
        }),
      };
    },
    [project.id],
  );

  const eventProjector = useMemo(
    () => ({
      taskCollection,
      activityCollection,
      blockerCollection,
      eventCollection,
      readTaskDelta,
      async readActivityDelta(entryIds: readonly string[]) {
        const rows = await readActivityEntries({
          data: { projectId: project.id, entryIds: [...entryIds], limit: entryIds.length },
        });
        if (rows.length !== new Set(entryIds).size) {
          throw new Error("An activity event referenced an entry that could not be projected.");
        }
        return { upserts: rows, deleteIds: [] };
      },
      async readBlockerDelta(taskIds: readonly string[]) {
        const pages = await Promise.all(
          taskIds.map((taskId) =>
            readManualBlockers({
              data: {
                projectId: project.id,
                taskId,
                includeResolved: true,
                limit: 200,
              },
            }),
          ),
        );
        return { upserts: pages.flat(), deleteIds: [] };
      },
    }),
    [
      activityCollection,
      blockerCollection,
      eventCollection,
      project.id,
      readTaskDelta,
      taskCollection,
    ],
  );

  useEffect(
    () =>
      subscribeToProjectEvents({
        projectId: project.id,
        afterCursor: eventCursor,
        onOpen: () => setLiveStatus("live"),
        onError: () => setLiveStatus("retrying"),
        onEvent: (event) =>
          syncCoordinator.run(async () => {
            try {
              await projectEvent(event, eventProjector);
              setLiveStatus("live");
            } catch (error) {
              try {
                await refetchProjectCollections();
              } catch (refreshError) {
                throw new AggregateError(
                  [error, refreshError],
                  "Project event projection and recovery both failed.",
                  { cause: refreshError },
                );
              }
              throw error;
            }
          }),
      }),
    [eventCursor, eventProjector, project.id, refetchProjectCollections, syncCoordinator],
  );

  async function refreshTaskRows(taskIds: readonly string[]) {
    await syncCoordinator.run(async () => {
      const uniqueTaskIds = [...new Set(taskIds)];
      const delta = await readTaskDelta(uniqueTaskIds);
      applyProjectionDelta(taskCollection, delta);
    });
  }

  async function applyTaskResponse(response: Awaited<ReturnType<typeof createHumanTask>>) {
    if (response.ok) {
      await refreshTaskRows([response.task.id]);
      await queryClient.invalidateQueries({ queryKey: ["task-tags", project.id] });
    }
    return response;
  }

  async function projectCommittedEvent(event: Parameters<typeof projectEvent>[0]) {
    await syncCoordinator.run(async () => {
      eventCollection.utils.writeUpsert(event);
      try {
        await projectEvent(event, eventProjector);
      } catch {
        setLiveStatus("retrying");
        await refetchProjectCollections().catch(() => undefined);
      }
    });
  }

  async function createActivityEntry(input: CreateHumanActivityEntryInput) {
    const previous = activityCollection.get(input.entryId);
    const optimistic: ActivityEntry = {
      id: input.entryId,
      projectId: input.projectId,
      taskId: input.taskId,
      attemptId: null,
      kind: input.kind,
      author: { type: "human", id: "local-human" },
      authorDisplayName: "You",
      agentProfileId: null,
      content: input.content,
      contentText: richTextToPlainText(input.content),
      createdAt: new Date().toISOString(),
      withdrawnAt: null,
      withdrawnBy: null,
      withdrawalReason: null,
    };
    const response = await reconcileOptimisticCommand({
      collection: activityCollection,
      optimistic,
      previous: previous ? activityEntrySchema.parse(previous) : undefined,
      execute: () => createHumanActivity({ data: input }),
      outcome: (result) => (result.ok ? { ok: true, value: result.result.entry } : { ok: false }),
      applyAuthoritative: (apply) => syncCoordinator.run(apply),
    });
    if (response.ok) {
      await projectCommittedEvent(response.result.event);
    }
    return response;
  }

  async function withdrawActivity(input: WithdrawActivityEntryInput) {
    const current = activityCollection.get(input.entryId);
    const previous = current ? activityEntrySchema.parse(current) : undefined;
    if (previous) {
      const optimistic: ActivityEntry = {
        ...previous,
        withdrawnAt: new Date().toISOString(),
        withdrawnBy: { type: "human", id: "local-human" },
        withdrawalReason: input.reason,
      };
      const response = await reconcileOptimisticCommand({
        collection: activityCollection,
        optimistic,
        previous,
        execute: () => withdrawHumanActivity({ data: input }),
        outcome: (result) => (result.ok ? { ok: true, value: result.result.entry } : { ok: false }),
        applyAuthoritative: (apply) => syncCoordinator.run(apply),
      });
      if (response.ok) await projectCommittedEvent(response.result.event);
      return response;
    }
    const response = await withdrawHumanActivity({ data: input });
    if (response.ok) {
      await projectCommittedEvent(response.result.event);
    }
    return response;
  }

  async function createBlocker(input: CreateManualBlockerInput) {
    const previous = blockerCollection.get(input.blockerId);
    const optimistic: ManualBlocker = {
      id: input.blockerId,
      projectId: input.projectId,
      taskId: input.taskId,
      reason: input.reason,
      status: "active",
      createdBy: { type: "human", id: "local-human" },
      createdAt: new Date().toISOString(),
      resolvedBy: null,
      resolvedAt: null,
      resolution: null,
    };
    const response = await reconcileOptimisticCommand({
      collection: blockerCollection,
      optimistic,
      previous: previous ? manualBlockerSchema.parse(previous) : undefined,
      execute: () => createHumanManualBlocker({ data: input }),
      outcome: (result) => (result.ok ? { ok: true, value: result.result.blocker } : { ok: false }),
      applyAuthoritative: (apply) => syncCoordinator.run(apply),
    });
    if (response.ok) {
      await projectCommittedEvent(response.result.event);
    }
    return response;
  }

  async function resolveBlocker(input: ResolveManualBlockerInput) {
    const current = blockerCollection.get(input.blockerId);
    const previous = current ? manualBlockerSchema.parse(current) : undefined;
    if (previous) {
      const optimistic: ManualBlocker = {
        ...previous,
        status: "resolved",
        resolvedBy: { type: "human", id: "local-human" },
        resolvedAt: new Date().toISOString(),
        resolution: input.resolution,
      };
      const response = await reconcileOptimisticCommand({
        collection: blockerCollection,
        optimistic,
        previous,
        execute: () => resolveHumanManualBlocker({ data: input }),
        outcome: (result) =>
          result.ok ? { ok: true, value: result.result.blocker } : { ok: false },
        applyAuthoritative: (apply) => syncCoordinator.run(apply),
      });
      if (response.ok) await projectCommittedEvent(response.result.event);
      return response;
    }
    const response = await resolveHumanManualBlocker({ data: input });
    if (response.ok) {
      await projectCommittedEvent(response.result.event);
    }
    return response;
  }

  return (
    <TaskWorkspace
      project={project}
      theme={theme}
      tasks={tasks}
      tagDefinitions={tagDefinitions}
      activityEntries={activityEntries}
      manualBlockers={manualBlockers}
      projectEvents={projectEvents}
      liveStatus={liveStatus}
      onCreateTask={(input) => createHumanTask({ data: input }).then(applyTaskResponse)}
      onPrepareTask={(input) => prepareHumanTask({ data: input }).then(applyTaskResponse)}
      onUpdateTaskPlanning={(input) =>
        updateHumanTaskPlanning({ data: input }).then(applyTaskResponse)
      }
      onCompleteTask={(input) => completeHumanTask({ data: input }).then(applyTaskResponse)}
      onReopenTask={(input) => reopenHumanTask({ data: input }).then(applyTaskResponse)}
      onCreateTaskRelation={(input) =>
        createHumanTaskRelation({ data: input }).then(async (response) => {
          if (response.ok) {
            await refreshTaskRows([response.relation.sourceTaskId, response.relation.targetTaskId]);
          }
          return response;
        })
      }
      onArchiveTask={(input) => archiveHumanTask({ data: input }).then(applyTaskResponse)}
      onInvalidateClaim={(input) =>
        invalidateHumanTaskClaim({ data: input }).then(async (response) => {
          if (response.ok) {
            await refreshTaskRows([response.result.task.id]);
          }
          return response;
        })
      }
      onCreateActivityEntry={createActivityEntry}
      onWithdrawActivityEntry={withdrawActivity}
      onCreateManualBlocker={createBlocker}
      onResolveManualBlocker={resolveBlocker}
      onChangeTheme={async (nextTheme) => {
        const previous = theme;
        applyThemeToDocument(nextTheme);
        const response = await changeTheme({
          data: { theme: nextTheme, idempotencyKey: crypto.randomUUID() },
        });
        if (!response.ok) {
          applyThemeToDocument(previous);
          throw new Error(response.error.message);
        }
        await router.invalidate({ sync: true });
      }}
    />
  );
}
