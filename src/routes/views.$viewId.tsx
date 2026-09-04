import { useEffect, useMemo, useState } from "react";
import { Link, createFileRoute, redirect, useRouter } from "@tanstack/react-router";
import { useLiveSuspenseQuery } from "@tanstack/react-db";
import { useQueryClient, useSuspenseQuery } from "@tanstack/react-query";
import * as stylex from "@stylexjs/stylex";
import { Archive, LayoutGrid, List, ShipWheel } from "lucide-react";
import { z } from "zod";

import { Button } from "../components/ui/button";
import { RouteErrorState, RoutePendingState } from "../components/route-state";
import type { AppState, Theme } from "../domain/projects";
import { searchTasksInputSchema } from "../domain/task-filters";
import { subscribeToProjectEvents } from "../features/activity/project-event-subscription";
import { projectImportantEvent } from "../features/activity/project-event-projector";
import { getImportantProjectEventCollection } from "../features/activity/activity-collection";
import { NotificationCenter } from "../features/activity/notification-center";
import { executeProjectChange } from "../features/projects/project-navigation";
import { ProjectSwitcher } from "../features/projects/project-switcher";
import { ThemeControl } from "../features/projects/theme-control";
import {
  getTaskSearchCollection,
  taskSearchPageQueryOptions,
} from "../features/tasks/task-search-collection";
import { BulkTaskControls } from "../features/tasks/bulk-task-controls";
import {
  emptyTaskSearchParams,
  taskSearchCursorParamSchema,
  taskSearchResultFields,
} from "../features/tasks/task-search-params";
import { TaskSearchResults } from "../features/tasks/task-search-results";
import { taskTagsQueryOptions } from "../features/tasks/task-tags-query";
import { useVisibleTaskSelection } from "../features/tasks/visible-task-selection";
import { readProjectEvents } from "../server/activity-functions";
import {
  changeTheme,
  createInitialProject,
  readAppState,
  readProjects,
  selectHumanProject,
} from "../server/project-functions";
import { executeHumanBulkTasks, previewHumanBulkTasks } from "../server/task-functions";
import { archiveHumanSavedView, readSavedView } from "../server/task-query-functions";
import { tokens } from "../styles/tokens.stylex";
import { applyThemeOptimistically } from "../styles/theme";

const viewSearchSchema = z.object({
  cursor: taskSearchCursorParamSchema,
});

function activeProjectFromState(state: AppState) {
  if (!state.activeProject) throw new Error("An active project is required for saved views.");
  return state.activeProject;
}

export const Route = createFileRoute("/views/$viewId")({
  ssr: false,
  validateSearch: viewSearchSchema,
  loaderDeps: ({ search }) => search,
  loader: async ({ context, deps, params }) => {
    const [state, projects] = await Promise.all([readAppState(), readProjects()]);
    if (!state.activeProject) throw redirect({ to: "/" });
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
    const view = await readSavedView({ data: { projectId, savedViewId: params.viewId } });
    const input = searchTasksInputSchema.parse({
      filter: view.definition.filter,
      order: view.definition.order,
      fields: [...taskSearchResultFields],
      limit: 100,
      cursor: deps.cursor,
    });
    const collection = getTaskSearchCollection(context.queryClient, input);
    const importantEventCollection = getImportantProjectEventCollection(
      context.queryClient,
      projectId,
    );
    await Promise.all([
      collection.isReady()
        ? collection.utils.refetch({ throwOnError: true })
        : collection.preload(),
      importantEventCollection.isReady()
        ? importantEventCollection.utils.refetch({ throwOnError: true })
        : importantEventCollection.preload(),
      context.queryClient.ensureQueryData(taskTagsQueryOptions(projectId)),
    ]);
    return {
      state,
      projects: [...projects],
      view,
      input,
      eventCursor: eventPage.latestCursor,
    };
  },
  pendingComponent: RoutePendingState,
  errorComponent: ViewRouteError,
  component: SavedViewPage,
});

function ViewRouteError({ error }: { error: Error }) {
  const router = useRouter();
  const navigate = Route.useNavigate();
  return (
    <RouteErrorState
      error={error}
      title="Saved view could not be loaded"
      onRetry={async () => {
        await navigate({ search: { cursor: null } });
        await router.invalidate();
      }}
    />
  );
}

function SavedViewPage() {
  const { state, projects, view, input, eventCursor } = Route.useLoaderData();
  const router = useRouter();
  const navigate = Route.useNavigate();
  const queryClient = useQueryClient();
  const project = activeProjectFromState(state);
  const projectId = project.id;
  const collection = getTaskSearchCollection(queryClient, input);
  const importantEventCollection = getImportantProjectEventCollection(queryClient, projectId);
  const { data: items } = useLiveSuspenseQuery({
    query: (query) => query.from({ hit: collection }).orderBy(({ hit }) => hit.rank, "asc"),
  });
  const { data: importantEvents } = useLiveSuspenseQuery({
    query: (query) => query.from({ event: importantEventCollection }),
  });
  const { data: page } = useSuspenseQuery(taskSearchPageQueryOptions(input));
  const { data: tags } = useSuspenseQuery(taskTagsQueryOptions(projectId));
  const [selectedTaskIds, setSelectedTaskIds] = useState<ReadonlySet<string>>(() => new Set());
  const [archiving, setArchiving] = useState(false);
  const [archiveError, setArchiveError] = useState<string | null>(null);
  const [liveStatus, setLiveStatus] = useState<"connecting" | "live" | "retrying">("connecting");
  const visibleTaskIds = useMemo(() => items.map(({ task }) => task.id), [items]);
  const bulkSelection = useVisibleTaskSelection({
    visibleTaskIds,
    selectedTaskIds,
    onSelectedTaskIdsChange: setSelectedTaskIds,
  });

  useEffect(
    () =>
      subscribeToProjectEvents({
        projectId,
        afterCursor: eventCursor,
        onOpen: () => setLiveStatus("live"),
        onError: () => setLiveStatus("retrying"),
        onEvent: async (event) => {
          projectImportantEvent(event, importantEventCollection);
          if (input.cursor) {
            await navigate({ search: { cursor: null }, replace: true });
            return;
          }
          if (event.changes.scopes.includes("projects")) {
            await router.invalidate({ sync: true });
            return;
          }
          if (
            event.changes.taskIds.length > 0 ||
            event.changes.scopes.some((scope) => scope === "tasks" || scope === "activity")
          ) {
            await collection.utils.refetch({ throwOnError: true });
          }
          if (
            event.changes.scopes.includes("views") &&
            ((event.changes.savedViewIds?.length ?? 0) === 0 ||
              event.changes.savedViewIds?.includes(view.id))
          ) {
            await router.invalidate({ sync: true });
          }
          setLiveStatus("live");
        },
      }),
    [
      collection,
      eventCursor,
      importantEventCollection,
      input.cursor,
      navigate,
      projectId,
      router,
      view.id,
    ],
  );

  async function archiveView() {
    setArchiving(true);
    setArchiveError(null);
    try {
      const response = await archiveHumanSavedView({
        data: {
          projectId,
          savedViewId: view.id,
          expectedVersion: view.version,
          reason: "Archived from the saved view.",
          idempotencyKey: crypto.randomUUID(),
        },
      });
      if (!response.ok) {
        setArchiveError(response.error.message);
        return;
      }
      await queryClient.invalidateQueries({ queryKey: ["saved-views", projectId] });
      await navigate({ to: "/search", search: emptyTaskSearchParams });
    } catch {
      setArchiveError("Helm could not archive this view.");
    } finally {
      setArchiving(false);
    }
  }

  async function persistTheme(nextTheme: Theme) {
    await applyThemeOptimistically({
      previousTheme: state.theme,
      nextTheme,
      persist: async () => {
        const response = await changeTheme({
          data: { theme: nextTheme, idempotencyKey: crypto.randomUUID() },
        });
        if (!response.ok) throw new Error(response.error.message);
      },
    });
    await router.invalidate({ sync: true });
  }

  return (
    <main {...stylex.props(styles.page)}>
      <header {...stylex.props(styles.header)}>
        <Link to="/" {...stylex.props(styles.brand)}>
          <span {...stylex.props(styles.mark)} aria-hidden="true">
            <ShipWheel size={16} />
          </span>
          <span>Helm</span>
          <span {...stylex.props(styles.projectName)}>{project.name}</span>
        </Link>
        <nav aria-label="Project navigation" {...stylex.props(styles.navigation)}>
          <Link to="/" {...stylex.props(styles.navLink)}>
            Workspace
          </Link>
          <Link to="/search" search={emptyTaskSearchParams} {...stylex.props(styles.navLink)}>
            Search
          </Link>
          <span {...stylex.props(styles.navLink, styles.navLinkActive)}>Saved view</span>
        </nav>
        <div {...stylex.props(styles.headerUtilities)}>
          <span aria-live="polite" {...stylex.props(styles.liveStatus)}>
            {liveStatus === "live"
              ? "Live"
              : liveStatus === "retrying"
                ? "Retrying…"
                : "Connecting…"}
          </span>
          <NotificationCenter
            projectId={projectId}
            events={importantEvents}
            tasks={items.map(({ task }) => task)}
          />
          <ThemeControl theme={state.theme} onChange={persistTheme} />
        </div>
      </header>

      <div {...stylex.props(styles.projectToolbar)}>
        <ProjectSwitcher
          projects={projects}
          activeProject={project}
          activeProjectVersion={state.activeProjectVersion}
          onSelect={(selection) =>
            executeProjectChange(() => selectHumanProject({ data: selection }), {
              navigateToWorkspace: () => navigate({ to: "/", replace: true }),
              refreshRoutes: () => router.invalidate({ sync: true }),
            })
          }
          onCreate={(projectInput) =>
            executeProjectChange(() => createInitialProject({ data: projectInput }), {
              navigateToWorkspace: () => navigate({ to: "/", replace: true }),
              refreshRoutes: () => router.invalidate({ sync: true }),
            })
          }
        />
      </div>

      <section {...stylex.props(styles.hero)}>
        <div>
          <p {...stylex.props(styles.eyebrow)}>Saved view #{view.sequence}</p>
          <h1 {...stylex.props(styles.title)}>{view.name}</h1>
          <p {...stylex.props(styles.subtitle)}>
            {view.definition.presentation === "board" ? (
              <LayoutGrid size={15} aria-hidden="true" />
            ) : (
              <List size={15} aria-hidden="true" />
            )}
            {view.definition.presentation} · grouped by {view.definition.grouping.type} · version{" "}
            {view.version}
          </p>
        </div>
        <Button variant="quiet" type="button" disabled={archiving} onClick={archiveView}>
          <Archive size={15} aria-hidden="true" /> {archiving ? "Archiving…" : "Archive view"}
        </Button>
      </section>
      {archiveError ? (
        <p role="alert" {...stylex.props(styles.error)}>
          {archiveError}
        </p>
      ) : null}
      <div {...stylex.props(styles.resultMeta)}>
        <span>
          {page.total} result{page.total === 1 ? "" : "s"} · {items.length} on this page
        </span>
        <div aria-label="Pagination" {...stylex.props(styles.pagination)}>
          <Button
            variant="quiet"
            type="button"
            disabled={!input.cursor}
            onClick={() => navigate({ search: { cursor: null } })}
          >
            First page
          </Button>
          <Button
            variant="quiet"
            type="button"
            disabled={!page.nextCursor}
            onClick={() => navigate({ search: { cursor: page.nextCursor } })}
          >
            Next page
          </Button>
        </div>
      </div>
      <BulkTaskControls
        projectId={projectId}
        tagDefinitions={tags}
        selection={bulkSelection}
        onPreview={(intent) => previewHumanBulkTasks({ data: intent })}
        onExecute={async (command) => {
          const response = await executeHumanBulkTasks({ data: command });
          if (response.ok) await collection.utils.refetch({ throwOnError: true });
          return response;
        }}
      />
      <TaskSearchResults
        items={items}
        visibleFields={view.definition.visibleFields}
        presentation={view.definition.presentation}
        grouping={view.definition.grouping}
        selectedTaskIds={bulkSelection.selectedTaskIds}
        onTaskSelected={bulkSelection.setTaskSelected}
      />
    </main>
  );
}

const styles = stylex.create({
  page: {
    margin: "0 auto",
    maxWidth: 1440,
    minHeight: "100vh",
    padding: tokens.space6,
    width: "100%",
    "@media (max-width: 700px)": { padding: tokens.space4 },
  },
  header: {
    alignItems: "center",
    display: "grid",
    gap: tokens.space4,
    gridTemplateColumns: "1fr auto 1fr",
    "@media (max-width: 760px)": { gridTemplateColumns: "1fr" },
  },
  brand: {
    alignItems: "center",
    color: tokens.foreground,
    display: "flex",
    fontWeight: 750,
    gap: tokens.space2,
    textDecoration: "none",
  },
  mark: {
    alignItems: "center",
    backgroundColor: tokens.foreground,
    borderRadius: 6,
    color: tokens.background,
    display: "inline-flex",
    height: 26,
    justifyContent: "center",
    width: 26,
  },
  projectName: { color: tokens.foregroundMuted, fontWeight: 500 },
  navigation: {
    backgroundColor: tokens.surface,
    borderColor: tokens.border,
    borderRadius: tokens.radius2,
    borderStyle: "solid",
    borderWidth: 1,
    display: "flex",
    justifySelf: "center",
    padding: 3,
    "@media (max-width: 760px)": { justifySelf: "start" },
  },
  navLink: {
    borderRadius: 6,
    color: tokens.foregroundMuted,
    fontSize: 13,
    fontWeight: 650,
    paddingBlock: 6,
    paddingInline: 10,
    textDecoration: "none",
  },
  navLinkActive: { backgroundColor: tokens.surfaceMuted, color: tokens.foreground },
  headerUtilities: {
    alignItems: "center",
    display: "flex",
    gap: tokens.space3,
    justifySelf: "end",
    "@media (max-width: 760px)": { justifySelf: "start" },
  },
  liveStatus: {
    color: tokens.foregroundMuted,
    fontSize: 12,
  },
  projectToolbar: {
    borderBlockEndColor: tokens.border,
    borderBlockEndStyle: "solid",
    borderBlockEndWidth: 1,
    marginBlockStart: tokens.space4,
    paddingBlockEnd: tokens.space4,
  },
  hero: {
    alignItems: "end",
    display: "flex",
    justifyContent: "space-between",
    gap: tokens.space5,
    marginBlock: tokens.space8,
    "@media (max-width: 600px)": { alignItems: "start", flexDirection: "column" },
  },
  eyebrow: {
    color: tokens.accent,
    fontSize: 11,
    fontWeight: 800,
    letterSpacing: "0.12em",
    margin: 0,
    textTransform: "uppercase",
  },
  title: {
    fontSize: "clamp(2.4rem, 6vw, 5rem)",
    letterSpacing: "-0.055em",
    lineHeight: 0.98,
    marginBlock: tokens.space2,
  },
  subtitle: {
    alignItems: "center",
    color: tokens.foregroundMuted,
    display: "flex",
    fontSize: 13,
    gap: tokens.space2,
    margin: 0,
    textTransform: "capitalize",
  },
  resultMeta: {
    alignItems: "center",
    color: tokens.foregroundMuted,
    display: "flex",
    fontSize: 13,
    justifyContent: "space-between",
    marginBlockEnd: tokens.space3,
  },
  pagination: { display: "flex", gap: tokens.space1 },
  error: { color: tokens.danger, fontSize: 13 },
});
