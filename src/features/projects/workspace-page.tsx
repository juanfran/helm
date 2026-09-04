import { useCallback, useEffect, useMemo, useState, type ComponentType } from "react";
import { useLiveSuspenseQuery } from "@tanstack/react-db";
import { useQueryClient, useSuspenseQuery } from "@tanstack/react-query";
import { Link, getRouteApi, useRouter } from "@tanstack/react-router";
import * as stylex from "@stylexjs/stylex";

import { RetryableLazySurface } from "../../components/retryable-lazy-surface";
import {
  createRetryableLazyModuleLoader,
  type RetryableLazyModuleLoader,
} from "../../components/retryable-lazy-module";
import {
  activityEntrySchema,
  manualBlockerSchema,
  type ActivityEntry,
  type CreateHumanActivityEntryInput,
  type CreateManualBlockerInput,
  type ManualBlocker,
  type ResolveManualBlockerInput,
  type WithdrawActivityEntryInput,
} from "../../domain/activity";
import type { Project, Theme } from "../../domain/projects";
import { richTextToPlainText } from "../../domain/rich-text";
import {
  createHumanActivity,
  createHumanManualBlocker,
  readActivityEntries,
  readManualBlockers,
  resolveHumanManualBlocker,
  withdrawHumanActivity,
} from "../../server/activity-functions";
import {
  addHumanCustomFieldDefinition,
  changeHumanTagReviewModeOverride,
  reorderHumanCustomFieldDefinitions,
  retireHumanCustomFieldDefinition,
} from "../../server/customization-functions";
import {
  changeProjectReviewMode,
  changeTheme,
  createInitialProject,
  selectHumanProject,
} from "../../server/project-functions";
import {
  executeHumanProjectImport,
  previewHumanProjectImport,
} from "../../server/portability-functions";
import {
  archiveHumanTask,
  approveHumanTaskReview,
  cancelHumanTask,
  createHumanTask,
  createHumanTaskRelation,
  executeHumanBulkTasks,
  invalidateHumanTaskClaim,
  prepareHumanTask,
  previewHumanBulkTasks,
  readTaskAttempts,
  readTasks,
  reopenHumanTask,
  requestHumanTaskChanges,
  restoreCancelledHumanTask,
  setHumanTaskReviewModeOverride,
  updateHumanTaskPlanning,
} from "../../server/task-functions";
import { applyThemeOptimistically } from "../../styles/theme";
import { tokens } from "../../styles/tokens.stylex";
import {
  getActivityEntryCollection,
  getManualBlockerCollection,
  getProjectEventCollection,
} from "../activity/activity-collection";
import { getImportantProjectEventCollection } from "../activity/important-project-event-collection";
import { reconcileOptimisticCommand } from "../activity/optimistic-reconciliation";
import { applyProjectionDelta, projectEvent } from "../activity/project-event-projector";
import { subscribeToProjectEvents } from "../activity/project-event-subscription";
import {
  getProjectSyncCoordinator,
  waitForAllProjectSync,
} from "../activity/project-sync-coordinator";
import { activeAgentRunsQueryOptions } from "../dashboard/agent-runs-query";
import { getTaskAttemptCollection } from "../tasks/task-attempt-collection";
import { getTaskCollection } from "../tasks/task-collection";
import { emptyTaskSearchParams } from "../tasks/task-search-params";
import { taskTagsQueryOptions } from "../tasks/task-tags-query";
import { TaskWorkspace } from "../tasks/task-workspace";
import type { ProjectDataManagementControlProps } from "./project-data-management-control";
import { ProjectLanding } from "./project-landing";
import {
  projectCustomizationQueryOptions,
  refreshProjectCustomization,
} from "./project-customization-query";
import { executeProjectChange } from "./project-navigation";

const homeRouteApi = getRouteApi("/");
const projectSwitcherModule = createRetryableLazyModuleLoader(() =>
  import("./project-switcher").then(({ ProjectSwitcher }) => ({ default: ProjectSwitcher })),
);
const projectCustomizationControlModule = createRetryableLazyModuleLoader(() =>
  import("./project-customization-control").then(({ ProjectCustomizationControl }) => ({
    default: ProjectCustomizationControl,
  })),
);
const projectDataManagementControlModule = createRetryableLazyModuleLoader(() =>
  import("./project-data-management-control").then(({ ProjectDataManagementControl }) => ({
    default: ProjectDataManagementControl,
  })),
);

type ProjectDataManagementControlModuleLoader = RetryableLazyModuleLoader<{
  default: ComponentType<ProjectDataManagementControlProps>;
}>;

export function WorkspacePage() {
  const state = homeRouteApi.useLoaderData();
  const router = useRouter();

  if (state.activeProject) {
    return (
      <ActiveProjectHome
        key={state.activeProject.id}
        project={state.activeProject}
        projects={state.projects}
        activeProjectVersion={state.activeProjectVersion}
        theme={state.theme}
      />
    );
  }

  return (
    <ProjectLanding
      state={state}
      portabilityControl={
        <ProjectLandingDataManagementIntent onComplete={() => router.invalidate({ sync: true })} />
      }
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

export function ProjectLandingDataManagementIntent({
  moduleLoader = projectDataManagementControlModule,
  onComplete,
}: {
  moduleLoader?: ProjectDataManagementControlModuleLoader;
  onComplete: ProjectDataManagementControlProps["onComplete"];
}) {
  const [requested, setRequested] = useState(false);

  return (
    <div {...stylex.props(styles.intentSurface)}>
      <button
        type="button"
        aria-disabled={requested}
        aria-expanded={requested}
        onFocus={moduleLoader.preload}
        onPointerEnter={moduleLoader.preload}
        onClick={() => {
          if (!requested) setRequested(true);
        }}
        {...stylex.props(styles.intentButton)}
      >
        Import project data
      </button>
      {requested ? (
        <RetryableLazySurface
          moduleLoader={moduleLoader}
          fallback={<WorkspaceModuleFallback label="Loading data management" />}
          render={(ProjectDataManagementControl) => (
            <ProjectDataManagementControl
              project={null}
              onPreview={(input) => previewHumanProjectImport({ data: input })}
              onExecute={(input) => executeHumanProjectImport({ data: input })}
              onComplete={onComplete}
            />
          )}
          renderFailure={(retry) => (
            <WorkspaceModuleFailure label="Data management" onRetry={retry} />
          )}
        />
      ) : null}
    </div>
  );
}

function ActiveProjectHome({
  project,
  projects,
  activeProjectVersion,
  theme,
}: {
  project: Project;
  projects: readonly Project[];
  activeProjectVersion: number;
  theme: Theme;
}) {
  const { eventCursor, savedViews } = homeRouteApi.useLoaderData();
  const router = useRouter();
  const queryClient = useQueryClient();
  const taskCollection = getTaskCollection(queryClient, project.id);
  const attemptCollection = getTaskAttemptCollection(queryClient, project.id);
  const activityCollection = getActivityEntryCollection(queryClient, project.id);
  const blockerCollection = getManualBlockerCollection(queryClient, project.id);
  const eventCollection = getProjectEventCollection(queryClient, project.id);
  const importantEventCollection = getImportantProjectEventCollection(queryClient, project.id);
  const syncCoordinator = getProjectSyncCoordinator(queryClient, project.id);
  const [liveStatus, setLiveStatus] = useState<"connecting" | "live" | "retrying">("connecting");
  const { data: tasks } = useLiveSuspenseQuery({
    query: (query) => query.from({ task: taskCollection }),
  });
  const { data: attempts } = useLiveSuspenseQuery({
    query: (query) => query.from({ attempt: attemptCollection }),
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
  const { data: importantEvents } = useLiveSuspenseQuery({
    query: (query) => query.from({ event: importantEventCollection }),
  });
  const { data: tagDefinitions } = useSuspenseQuery(taskTagsQueryOptions(project.id));
  const { data: customization } = useSuspenseQuery(projectCustomizationQueryOptions(project.id));
  const { data: activeAgentRuns } = useSuspenseQuery(activeAgentRunsQueryOptions());

  const refetchProjectCollections = useCallback(
    () =>
      waitForAllProjectSync([
        taskCollection.utils.refetch({ throwOnError: true }),
        attemptCollection.utils.refetch({ throwOnError: true }),
        activityCollection.utils.refetch({ throwOnError: true }),
        blockerCollection.utils.refetch({ throwOnError: true }),
        eventCollection.utils.refetch({ throwOnError: true }),
        importantEventCollection.utils.refetch({ throwOnError: true }),
      ]),
    [
      activityCollection,
      attemptCollection,
      blockerCollection,
      eventCollection,
      importantEventCollection,
      taskCollection,
    ],
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

  const readAttemptDelta = useCallback(
    async (taskIds: readonly string[]) => ({
      upserts: await readTaskAttempts({
        data: { projectId: project.id, taskIds: [...taskIds] },
      }),
      deleteIds: [],
    }),
    [project.id],
  );

  const eventProjector = useMemo(
    () => ({
      taskCollection,
      attemptCollection,
      activityCollection,
      blockerCollection,
      eventCollection,
      importantEventCollection,
      readTaskDelta,
      readAttemptDelta,
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
      attemptCollection,
      blockerCollection,
      eventCollection,
      importantEventCollection,
      project.id,
      readAttemptDelta,
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
        onEvent: async (event) => {
          await syncCoordinator.run(async () => {
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
          });
          if (event.changes.scopes.includes("projects")) {
            await refreshProjectCustomization(queryClient, project.id);
            await router.invalidate({ sync: true });
          }
        },
      }),
    [
      eventCursor,
      eventProjector,
      project.id,
      queryClient,
      refetchProjectCollections,
      router,
      syncCoordinator,
    ],
  );

  async function refreshTaskRows(taskIds: readonly string[]) {
    await syncCoordinator.run(async () => {
      const uniqueTaskIds = [...new Set(taskIds)];
      const [taskDelta, attemptDelta] = await Promise.all([
        readTaskDelta(uniqueTaskIds),
        readAttemptDelta(uniqueTaskIds),
      ]);
      applyProjectionDelta(taskCollection, taskDelta);
      applyProjectionDelta(attemptCollection, attemptDelta);
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

  async function applyCustomizationResponse<
    T extends Awaited<ReturnType<typeof addHumanCustomFieldDefinition>>,
  >(response: T) {
    if (response.ok) {
      queryClient.setQueryData(
        projectCustomizationQueryOptions(project.id).queryKey,
        response.customization,
      );
      await router.invalidate({ sync: true });
    }
    return response;
  }

  async function applyTransitionResponse(
    response: Awaited<ReturnType<typeof approveHumanTaskReview>>,
  ) {
    if (response.ok) await projectCommittedEvent(response.result.event);
    return response;
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
      attempts={attempts}
      tagDefinitions={tagDefinitions}
      activityEntries={activityEntries}
      manualBlockers={manualBlockers}
      projectEvents={projectEvents}
      importantEvents={importantEvents}
      activeAgentRuns={activeAgentRuns}
      liveStatus={liveStatus}
      projectSwitcher={{
        preload: projectSwitcherModule.preload,
        surface: (
          <RetryableLazySurface
            moduleLoader={projectSwitcherModule}
            fallback={<WorkspaceModuleFallback label="Loading project switcher" compact />}
            render={(ProjectSwitcher) => (
              <ProjectSwitcher
                projects={projects}
                activeProject={project}
                activeProjectVersion={activeProjectVersion}
                onSelect={(input) =>
                  executeProjectChange(() => selectHumanProject({ data: input }), {
                    navigateToWorkspace: () => router.navigate({ to: "/", replace: true }),
                    refreshRoutes: () => router.invalidate({ sync: true }),
                  })
                }
                onCreate={(input) =>
                  executeProjectChange(() => createInitialProject({ data: input }), {
                    navigateToWorkspace: () => router.navigate({ to: "/", replace: true }),
                    refreshRoutes: () => router.invalidate({ sync: true }),
                  })
                }
              />
            )}
            renderFailure={(retry) => (
              <WorkspaceModuleFailure label="Project switcher" onRetry={retry} compact />
            )}
          />
        ),
      }}
      customizationControl={
        <RetryableLazySurface
          moduleLoader={projectCustomizationControlModule}
          fallback={<WorkspaceModuleFallback label="Loading project customization" />}
          render={(ProjectCustomizationControl) => (
            <ProjectCustomizationControl
              customization={customization}
              tagDefinitions={tagDefinitions}
              onAddFieldDefinition={(input) =>
                addHumanCustomFieldDefinition({ data: input }).then(applyCustomizationResponse)
              }
              onRetireFieldDefinition={(input) =>
                retireHumanCustomFieldDefinition({ data: input }).then(applyCustomizationResponse)
              }
              onReorderFieldDefinitions={(input) =>
                reorderHumanCustomFieldDefinitions({ data: input }).then(applyCustomizationResponse)
              }
              onChangeTagReviewModeOverride={(input) =>
                changeHumanTagReviewModeOverride({ data: input }).then(applyCustomizationResponse)
              }
            />
          )}
          renderFailure={(retry) => (
            <WorkspaceModuleFailure label="Project customization" onRetry={retry} />
          )}
        />
      }
      portabilityControl={
        <RetryableLazySurface
          moduleLoader={projectDataManagementControlModule}
          fallback={<WorkspaceModuleFallback label="Loading data management" />}
          render={(ProjectDataManagementControl) => (
            <ProjectDataManagementControl
              project={project}
              savedViews={savedViews}
              onPreview={(input) => previewHumanProjectImport({ data: input })}
              onExecute={(input) => executeHumanProjectImport({ data: input })}
              onComplete={() => router.invalidate({ sync: true })}
            />
          )}
          renderFailure={(retry) => (
            <WorkspaceModuleFailure label="Data management" onRetry={retry} />
          )}
        />
      }
      renderSearchLink={(props) => (
        <Link to="/search" search={emptyTaskSearchParams} {...props}>
          Search
        </Link>
      )}
      onCreateTask={(input) => createHumanTask({ data: input }).then(applyTaskResponse)}
      onPrepareTask={(input) => prepareHumanTask({ data: input }).then(applyTaskResponse)}
      onUpdateTaskPlanning={(input) =>
        updateHumanTaskPlanning({ data: input }).then(applyTaskResponse)
      }
      onSetTaskReviewModeOverride={(input) =>
        setHumanTaskReviewModeOverride({ data: input }).then(applyTaskResponse)
      }
      onApproveTaskReview={(input) =>
        approveHumanTaskReview({ data: input }).then(applyTransitionResponse)
      }
      onRequestTaskChanges={(input) =>
        requestHumanTaskChanges({ data: input }).then(applyTransitionResponse)
      }
      onCancelTask={(input) => cancelHumanTask({ data: input }).then(applyTransitionResponse)}
      onRestoreCancelledTask={(input) =>
        restoreCancelledHumanTask({ data: input }).then(applyTransitionResponse)
      }
      onReopenTask={(input) => reopenHumanTask({ data: input }).then(applyTransitionResponse)}
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
      onPreviewBulkTasks={(intent) => previewHumanBulkTasks({ data: intent })}
      onExecuteBulkTasks={async (input) => {
        const response = await executeHumanBulkTasks({ data: input });
        if (response.ok) {
          await refreshTaskRows(response.result.items.map((item) => item.taskId));
        }
        return response;
      }}
      onChangeTheme={async (nextTheme) => {
        await applyThemeOptimistically({
          previousTheme: theme,
          nextTheme,
          persist: async () => {
            const response = await changeTheme({
              data: { theme: nextTheme, idempotencyKey: crypto.randomUUID() },
            });
            if (!response.ok) throw new Error(response.error.message);
          },
        });
        await router.invalidate({ sync: true });
      }}
      onChangeProjectReviewMode={async (input) => {
        const response = await changeProjectReviewMode({ data: input });
        if (response.ok) {
          await refreshProjectCustomization(queryClient, project.id);
          await router.invalidate({ sync: true });
        }
        return response;
      }}
    />
  );
}

function WorkspaceModuleFallback({ label, compact = false }: { label: string; compact?: boolean }) {
  return (
    <output
      aria-live="polite"
      aria-label={label}
      {...stylex.props(styles.moduleFallback, compact && styles.compactModuleFallback)}
    >
      {label}…
    </output>
  );
}

function WorkspaceModuleFailure({
  label,
  onRetry,
  compact = false,
  floating = false,
}: {
  label: string;
  onRetry: () => void;
  compact?: boolean;
  floating?: boolean;
}) {
  return (
    <section
      role="alert"
      aria-label={`${label} unavailable`}
      {...stylex.props(
        styles.moduleFallback,
        styles.moduleFailure,
        compact && styles.compactModuleFallback,
        floating && styles.floatingModuleFailure,
      )}
    >
      <span>{label} could not load.</span>
      <button type="button" onClick={onRetry} {...stylex.props(styles.retryButton)}>
        Retry
      </button>
    </section>
  );
}

const styles = stylex.create({
  intentSurface: { display: "grid", gap: tokens.space3 },
  moduleFallback: {
    alignItems: "center",
    backgroundColor: tokens.surface,
    borderColor: tokens.border,
    borderRadius: tokens.radius3,
    borderStyle: "solid",
    borderWidth: 1,
    color: tokens.foregroundMuted,
    display: "flex",
    fontSize: 13,
    minHeight: 176,
    padding: tokens.space5,
    width: "100%",
  },
  compactModuleFallback: {
    maxWidth: 560,
    minHeight: 72,
  },
  moduleFailure: {
    alignItems: "center",
    flexDirection: "row",
    gap: tokens.space3,
    justifyContent: "space-between",
  },
  floatingModuleFailure: {
    bottom: tokens.space5,
    boxShadow: tokens.shadow,
    left: "auto",
    minHeight: 0,
    position: "fixed",
    right: tokens.space5,
    width: "min(420px, calc(100vw - 32px))",
    zIndex: 20,
  },
  retryButton: {
    backgroundColor: tokens.foreground,
    borderColor: tokens.foreground,
    borderRadius: tokens.radius2,
    borderStyle: "solid",
    borderWidth: 1,
    color: tokens.background,
    cursor: "pointer",
    font: "inherit",
    fontWeight: 700,
    paddingBlock: tokens.space2,
    paddingInline: tokens.space3,
    ":focus-visible": {
      outlineColor: tokens.accent,
      outlineOffset: 2,
      outlineStyle: "solid",
      outlineWidth: 2,
    },
  },
  intentButton: {
    backgroundColor: tokens.surface,
    borderColor: tokens.border,
    borderRadius: tokens.radius2,
    borderStyle: "solid",
    borderWidth: 1,
    color: tokens.foreground,
    cursor: "pointer",
    font: "inherit",
    fontWeight: 700,
    minHeight: 44,
    paddingInline: tokens.space4,
    ":hover": { borderColor: tokens.accent },
    ":focus-visible": {
      outlineColor: tokens.accent,
      outlineOffset: 2,
      outlineStyle: "solid",
      outlineWidth: 2,
    },
  },
});
