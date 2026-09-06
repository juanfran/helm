import { useState, type ComponentProps, type ComponentType } from "react";
import { useLiveQuery, useLiveSuspenseQuery } from "@tanstack/react-db";
import { useQueryClient, useQuery } from "@tanstack/react-query";
import { Link, useRouter } from "@tanstack/react-router";
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
import type { Task } from "../../domain/tasks";
import type { Project, Theme } from "../../domain/projects";
import { richTextToPlainText } from "../../domain/rich-text";
import {
  createHumanActivity,
  createHumanManualBlocker,
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
import { reconcileOptimisticCommand } from "../activity/optimistic-reconciliation";
import { applyProjectionDelta, projectEvent } from "../activity/project-event-projector";
import { getWorkspaceData } from "./workspace-data";
import { WorkspaceDataContext } from "./workspace-section";
import { savedViewsQueryOptions } from "./workspace-state-query";
import { getProjectSyncCoordinator } from "../activity/project-sync-coordinator";
import { activeAgentRunsQueryOptions } from "../dashboard/agent-runs-query";
import { getTaskAttemptCollection } from "../tasks/task-attempt-collection";
import { getTaskCollection } from "../tasks/task-collection";
import { taskTagsQueryOptions } from "../tasks/task-tags-query";
import { TaskWorkspace } from "../tasks/task-workspace";
import type { ProjectDataManagementControlProps } from "./project-data-management-control";
import { projectLandingModule } from "./project-landing-module";
import {
  projectCustomizationQueryOptions,
  refreshProjectCustomization,
} from "./project-customization-query";
import { executeProjectChange } from "./project-navigation";

type WorkspacePageState = Awaited<
  ReturnType<typeof import("./workspace-loader").loadWorkspacePage>
>;
type WorkspaceSearch = import("./workspace-search").WorkspaceSearch;
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

export function WorkspacePage({
  state,
  search,
  view = "tasks",
  selectedTaskId = null,
}: {
  state: WorkspacePageState;
  search: WorkspaceSearch;
  view?: import("./workspace-search").WorkspaceView;
  selectedTaskId?: string | null;
}) {
  const router = useRouter();

  if (state.activeProject) {
    const Home = view === "settings" ? ActiveProjectHome : TaskDataHome;
    return (
      <Home
        key={state.activeProject.id}
        search={search}
        view={view}
        selectedTaskId={selectedTaskId}
        project={state.activeProject}
        projects={state.projects}
        activeProjectVersion={state.activeProjectVersion}
        theme={state.theme}
      />
    );
  }

  return (
    <RetryableLazySurface
      moduleLoader={projectLandingModule}
      fallback={<WorkspaceModuleFallback label="Loading project setup" />}
      renderFailure={(retry) => <WorkspaceModuleFailure label="Project setup" onRetry={retry} />}
      render={(ProjectLanding) => (
        <ProjectLanding
          state={state}
          portabilityControl={
            <ProjectLandingDataManagementIntent
              onComplete={() => router.invalidate({ sync: true })}
            />
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
      )}
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

function TaskDataHome(props: Omit<ComponentProps<typeof ActiveProjectHome>, "tasks">) {
  const queryClient = useQueryClient();
  const collection = getTaskCollection(queryClient, props.project.id);
  const { data: tasks } = useLiveSuspenseQuery({
    query: (query) => query.from({ task: collection }),
  });
  return <ActiveProjectHome {...props} tasks={tasks} />;
}

const noTasks: readonly Task[] = [];

function ActiveProjectHome({
  tasks = noTasks,
  search,
  view,
  selectedTaskId,
  project,
  projects,
  activeProjectVersion,
  theme,
}: {
  search: WorkspaceSearch;
  view: import("./workspace-search").WorkspaceView;
  selectedTaskId: string | null;
  project: Project;
  projects: readonly Project[];
  activeProjectVersion: number;
  theme: Theme;
  tasks?: readonly Task[];
}) {
  const router = useRouter();
  const queryClient = useQueryClient();
  const taskCollection = getTaskCollection(queryClient, project.id);
  const attemptCollection = getTaskAttemptCollection(queryClient, project.id);
  const activityCollection = getActivityEntryCollection(queryClient, project.id);
  const blockerCollection = getManualBlockerCollection(queryClient, project.id);
  const eventCollection = getProjectEventCollection(queryClient, project.id);
  const syncCoordinator = getProjectSyncCoordinator(queryClient, project.id);
  const liveStatus = "connecting";
  const { data: attempts = [] } = useLiveQuery({
    query: (query) =>
      selectedTaskId || view === "dashboard" || view === "activity"
        ? query.from({ attempt: attemptCollection })
        : undefined,
  });
  const { data: activityEntries = [] } = useLiveQuery({
    query: (query) =>
      selectedTaskId || view === "activity" ? query.from({ entry: activityCollection }) : undefined,
  });
  const { data: manualBlockers = [] } = useLiveQuery({
    query: (query) =>
      selectedTaskId || view === "activity"
        ? query.from({ blocker: blockerCollection })
        : undefined,
  });
  const { data: projectEvents = [] } = useLiveQuery({
    query: (query) =>
      view === "dashboard" || view === "activity"
        ? query.from({ event: eventCollection })
        : undefined,
  });
  const importantEvents = projectEvents;
  const { data: tagDefinitions = [] } = useQuery({
    ...taskTagsQueryOptions(project.id),
    enabled: view === "tasks" || view === "settings",
  });
  const { data: customization } = useQuery({
    ...projectCustomizationQueryOptions(project.id),
    enabled: view === "tasks" || view === "settings",
  });
  const { data: activeAgentRuns = [] } = useQuery({
    ...activeAgentRunsQueryOptions(),
    enabled: view === "dashboard",
  });

  const data = getWorkspaceData(queryClient, project.id);
  const readTaskDelta = data.readTaskDelta;
  const readAttemptDelta = data.readAttemptDelta;
  const { data: savedViews = [] } = useQuery({
    ...savedViewsQueryOptions(project.id),
    enabled: view === "tasks" || view === "settings",
  });

  async function refreshTaskRows(taskIds: readonly string[]) {
    await syncCoordinator.run(async () => {
      const uniqueTaskIds = [...new Set(taskIds)];
      const [taskDelta, attemptDelta] = await Promise.all([
        readTaskDelta(uniqueTaskIds),
        data.resources.attempts.ready
          ? readAttemptDelta(uniqueTaskIds)
          : Promise.resolve({ upserts: [], deleteIds: [] }),
      ]);
      applyProjectionDelta(taskCollection, taskDelta);
      if (data.resources.attempts.ready) applyProjectionDelta(attemptCollection, attemptDelta);
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
    await syncCoordinator.run(() => data.projectReady(event));
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
    <WorkspaceDataContext.Provider value={data}>
      <TaskWorkspace
        project={project}
        savedViews={savedViews}
        navigation={{
          view,
          selectedTaskId,
          filter: search.filter,
          renderTaskLink: (task, props, children) => (
            <Link
              to="/$projectId/tasks/$taskId"
              params={{ projectId: project.id, taskId: task.id }}
              search={{ filter: search.filter }}
              {...props}
            >
              {children}
            </Link>
          ),
          renderBackLink: (props) => (
            <Link
              to="/$projectId/tasks"
              params={{ projectId: project.id }}
              search={{ filter: search.filter }}
              {...props}
            >
              Back to tasks
            </Link>
          ),
          renderFilterLink: (filter, props, children) => (
            <Link
              to="/$projectId/tasks"
              params={{ projectId: project.id }}
              search={{ filter }}
              {...props}
            >
              {children}
            </Link>
          ),
          onTaskCreated: (taskId) => {
            void router.navigate({
              to: "/$projectId/tasks/$taskId",
              params: { projectId: project.id, taskId },
              search: { filter: search.filter },
            });
          },
        }}
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
          customization && (
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
                    retireHumanCustomFieldDefinition({ data: input }).then(
                      applyCustomizationResponse,
                    )
                  }
                  onReorderFieldDefinitions={(input) =>
                    reorderHumanCustomFieldDefinitions({ data: input }).then(
                      applyCustomizationResponse,
                    )
                  }
                  onChangeTagReviewModeOverride={(input) =>
                    changeHumanTagReviewModeOverride({ data: input }).then(
                      applyCustomizationResponse,
                    )
                  }
                />
              )}
              renderFailure={(retry) => (
                <WorkspaceModuleFailure label="Project customization" onRetry={retry} />
              )}
            />
          )
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
              await refreshTaskRows([
                response.relation.sourceTaskId,
                response.relation.targetTaskId,
              ]);
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
    </WorkspaceDataContext.Provider>
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
