import { useEffect, useState, type FormEvent } from "react";
import { Link, createFileRoute, redirect, useRouter } from "@tanstack/react-router";
import { useLiveSuspenseQuery } from "@tanstack/react-db";
import { useQueryClient, useSuspenseQuery } from "@tanstack/react-query";
import * as stylex from "@stylexjs/stylex";
import { LayoutGrid, List, Save, Search as SearchIcon, ShipWheel } from "lucide-react";

import { Button } from "../components/ui/button";
import { RouteErrorState, RoutePendingState } from "../components/route-state";
import type { SavedViewVisibleField } from "../domain/saved-views";
import { canonicalizeTaskSearchOrder } from "../domain/task-filters";
import type { AppState, Theme } from "../domain/projects";
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
import {
  taskSearchInputFromParams,
  taskSearchParamsSchema,
} from "../features/tasks/task-search-params";
import { TaskSearchResults } from "../features/tasks/task-search-results";
import { readProjectEvents } from "../server/activity-functions";
import {
  createInitialProject,
  changeTheme,
  readAppState,
  readProjects,
  selectHumanProject,
} from "../server/project-functions";
import { readTaskTags } from "../server/task-functions";
import { createHumanSavedView, readSavedViews } from "../server/task-query-functions";
import { tokens } from "../styles/tokens.stylex";
import { applyThemeOptimistically } from "../styles/theme";

const visibleFields: SavedViewVisibleField[] = [
  "title",
  "lifecycle",
  "eligibility",
  "priority",
  "tags",
  "capabilities",
  "due_at",
];

function savedViewsQueryOptions(projectId: string) {
  return {
    queryKey: ["saved-views", projectId] as const,
    queryFn: () => readSavedViews({ data: { projectId, includeArchived: false } }),
  };
}

function taskTagsQueryOptions(projectId: string) {
  return {
    queryKey: ["task-tags", projectId] as const,
    queryFn: () => readTaskTags({ data: { projectId } }),
  };
}

function activeProjectFromState(state: AppState) {
  if (!state.activeProject) throw new Error("An active project is required for task search.");
  return state.activeProject;
}

function formString(data: FormData, name: string) {
  const value = data.get(name);
  return typeof value === "string" ? value : "";
}

export const Route = createFileRoute("/search")({
  ssr: false,
  validateSearch: taskSearchParamsSchema,
  loaderDeps: ({ search: { presentation: _presentation, ...query } }) => query,
  loader: async ({ context, deps }) => {
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
    const input = taskSearchInputFromParams(projectId, deps);
    const collection = getTaskSearchCollection(context.queryClient, input);
    const importantEventCollection = getImportantProjectEventCollection(
      context.queryClient,
      projectId,
    );
    await Promise.all([
      collection.isReady()
        ? collection.utils.refetch({ throwOnError: true })
        : collection.preload(),
      context.queryClient.ensureQueryData(savedViewsQueryOptions(projectId)),
      context.queryClient.ensureQueryData(taskTagsQueryOptions(projectId)),
      importantEventCollection.isReady()
        ? importantEventCollection.utils.refetch({ throwOnError: true })
        : importantEventCollection.preload(),
    ]);
    return {
      state,
      projects: [...projects],
      input,
      eventCursor: eventPage.latestCursor,
    };
  },
  pendingComponent: RoutePendingState,
  errorComponent: SearchRouteError,
  component: SearchPage,
});

function SearchRouteError({ error }: { error: Error }) {
  const router = useRouter();
  const navigate = Route.useNavigate();
  return (
    <RouteErrorState
      error={error}
      title="Search could not be loaded"
      onRetry={async () => {
        await navigate({ search: (previous) => ({ ...previous, cursor: null }) });
        await router.invalidate();
      }}
    />
  );
}

function SearchPage() {
  const { state, projects, input, eventCursor } = Route.useLoaderData();
  const search = Route.useSearch();
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
  const { data: savedViews } = useSuspenseQuery(savedViewsQueryOptions(projectId));
  const { data: tags } = useSuspenseQuery(taskTagsQueryOptions(projectId));
  const [viewName, setViewName] = useState("");
  const [selectedTaskId, setSelectedTaskId] = useState<string | null>(null);
  const [saving, setSaving] = useState(false);
  const [saveError, setSaveError] = useState<string | null>(null);
  const [liveStatus, setLiveStatus] = useState<"connecting" | "live" | "retrying">("connecting");

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
            await navigate({
              search: (previous) => ({ ...previous, cursor: null }),
              replace: true,
            });
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
          if (event.changes.scopes.includes("views")) {
            await queryClient.invalidateQueries({ queryKey: ["saved-views", projectId] });
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
      queryClient,
      router,
    ],
  );

  const searchFormKey = JSON.stringify({
    q: search.q,
    mode: search.mode,
    lifecycle: search.lifecycle,
    eligibility: search.eligibility,
    priority: search.priority,
    tag: search.tag,
    capability: search.capability,
  });

  function submitSearch(event: FormEvent<HTMLFormElement>) {
    event.preventDefault();
    const data = new FormData(event.currentTarget);
    const nextSearch = taskSearchParamsSchema.parse({
      ...search,
      q: formString(data, "q"),
      mode: formString(data, "mode"),
      lifecycle: formString(data, "lifecycle") || null,
      eligibility: formString(data, "eligibility") || null,
      priority: formString(data, "priority") || null,
      tag: formString(data, "tag") || null,
      capability: formString(data, "capability") || null,
      cursor: null,
    });
    void navigate({
      search: nextSearch,
    });
  }

  async function saveView(event: FormEvent<HTMLFormElement>) {
    event.preventDefault();
    if (!viewName.trim()) return;
    setSaving(true);
    setSaveError(null);
    try {
      const response = await createHumanSavedView({
        data: {
          projectId,
          name: viewName.trim(),
          definition: {
            schemaVersion: 1,
            filter: input.filter,
            order: canonicalizeTaskSearchOrder(input.order, input.filter),
            grouping:
              search.presentation === "board"
                ? { type: "lifecycle" as const }
                : { type: "none" as const },
            visibleFields,
            presentation: search.presentation,
          },
          idempotencyKey: crypto.randomUUID(),
        },
      });
      if (!response.ok) {
        setSaveError(response.error.message);
        return;
      }
      await queryClient.invalidateQueries({ queryKey: ["saved-views", projectId] });
      await navigate({
        to: "/views/$viewId",
        params: { viewId: response.view.id },
        search: { cursor: null },
      });
    } catch {
      setSaveError("Helm could not save this view.");
    } finally {
      setSaving(false);
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
          <span {...stylex.props(styles.navLink, styles.navLinkActive)}>Search</span>
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
        <p {...stylex.props(styles.eyebrow)}>Shared task query</p>
        <h1 {...stylex.props(styles.title)}>Find the work behind the work.</h1>
        <p {...stylex.props(styles.subtitle)}>
          Task text, acceptance criteria, comments, and execution reports share one durable index.
        </p>
      </section>

      <div {...stylex.props(styles.layout)}>
        <section {...stylex.props(styles.resultsPanel)}>
          <form
            key={searchFormKey}
            onSubmit={submitSearch}
            aria-label="Search and filter tasks"
            {...stylex.props(styles.searchForm)}
          >
            <label {...stylex.props(styles.searchField)}>
              <span {...stylex.props(styles.srOnly)}>Search text</span>
              <SearchIcon size={17} aria-hidden="true" />
              <input
                name="q"
                defaultValue={search.q}
                placeholder="Search work and history"
                maxLength={500}
                {...stylex.props(styles.input, styles.searchInput)}
              />
            </label>
            <select
              name="mode"
              defaultValue={search.mode}
              aria-label="Search mode"
              {...stylex.props(styles.select)}
            >
              <option value="all">All words</option>
              <option value="any">Any word</option>
              <option value="phrase">Exact phrase</option>
            </select>
            <select
              name="lifecycle"
              defaultValue={search.lifecycle ?? ""}
              aria-label="Lifecycle"
              {...stylex.props(styles.select)}
            >
              <option value="">All lifecycle states</option>
              <option value="backlog">Backlog</option>
              <option value="ready">Ready</option>
              <option value="in_progress">In progress</option>
              <option value="review">Review</option>
              <option value="done">Done</option>
              <option value="cancelled">Cancelled</option>
            </select>
            <select
              name="eligibility"
              defaultValue={search.eligibility ?? ""}
              aria-label="Eligibility"
              {...stylex.props(styles.select)}
            >
              <option value="">All eligibility</option>
              <option value="claimable">Claimable</option>
              <option value="claimed">Claimed</option>
              <option value="scheduled">Scheduled</option>
              <option value="blocked">Blocked</option>
              <option value="capability_mismatch">Capability mismatch</option>
              <option value="not_ready">Not ready</option>
              <option value="complete">Complete</option>
              <option value="archived">Archived</option>
            </select>
            <select
              name="priority"
              defaultValue={search.priority ?? ""}
              aria-label="Priority"
              {...stylex.props(styles.select)}
            >
              <option value="">All priorities</option>
              <option value="urgent">Urgent</option>
              <option value="high">High</option>
              <option value="normal">Normal</option>
              <option value="low">Low</option>
            </select>
            <select
              name="tag"
              defaultValue={search.tag ?? ""}
              aria-label="Tag"
              {...stylex.props(styles.select)}
            >
              <option value="">All tags</option>
              {tags.map((tag) => (
                <option key={tag.id} value={tag.id}>
                  {tag.name}
                </option>
              ))}
            </select>
            <input
              name="capability"
              defaultValue={search.capability ?? ""}
              placeholder="Required capability"
              aria-label="Required capability"
              maxLength={80}
              {...stylex.props(styles.input)}
            />
            <Button type="submit">Apply query</Button>
          </form>

          <div {...stylex.props(styles.resultToolbar)}>
            <p {...stylex.props(styles.resultCount)}>
              {page.total} result{page.total === 1 ? "" : "s"} · {items.length} on this page
            </p>
            <div {...stylex.props(styles.toolbarActions)}>
              <div aria-label="Pagination" {...stylex.props(styles.pagination)}>
                <Button
                  variant="quiet"
                  type="button"
                  disabled={!input.cursor}
                  onClick={() =>
                    navigate({ search: (previous) => ({ ...previous, cursor: null }) })
                  }
                >
                  First page
                </Button>
                <Button
                  variant="quiet"
                  type="button"
                  disabled={!page.nextCursor}
                  onClick={() =>
                    navigate({
                      search: (previous) => ({ ...previous, cursor: page.nextCursor }),
                    })
                  }
                >
                  Next page
                </Button>
              </div>
              <fieldset aria-label="Presentation" {...stylex.props(styles.presentationGroup)}>
                <button
                  type="button"
                  aria-pressed={search.presentation === "list"}
                  onClick={() =>
                    navigate({ search: (previous) => ({ ...previous, presentation: "list" }) })
                  }
                  {...stylex.props(
                    styles.iconButton,
                    search.presentation === "list" && styles.iconButtonActive,
                  )}
                >
                  <List size={15} aria-hidden="true" /> List
                </button>
                <button
                  type="button"
                  aria-pressed={search.presentation === "board"}
                  onClick={() =>
                    navigate({ search: (previous) => ({ ...previous, presentation: "board" }) })
                  }
                  {...stylex.props(
                    styles.iconButton,
                    search.presentation === "board" && styles.iconButtonActive,
                  )}
                >
                  <LayoutGrid size={15} aria-hidden="true" /> Board
                </button>
              </fieldset>
            </div>
          </div>

          <TaskSearchResults
            items={items}
            visibleFields={visibleFields}
            presentation={search.presentation}
            selectedTaskId={selectedTaskId}
            onSelect={setSelectedTaskId}
          />
        </section>

        <aside {...stylex.props(styles.sidebar)}>
          <section {...stylex.props(styles.sideCard)}>
            <div {...stylex.props(styles.cardHeading)}>
              <Save size={16} aria-hidden="true" />
              <h2>Save this view</h2>
            </div>
            <p {...stylex.props(styles.cardCopy)}>
              Keep the exact validated filter, order, fields, grouping, and presentation.
            </p>
            <form onSubmit={saveView} {...stylex.props(styles.saveForm)}>
              <input
                value={viewName}
                onChange={(event) => setViewName(event.target.value)}
                placeholder="View name"
                aria-label="Saved view name"
                maxLength={120}
                required
                {...stylex.props(styles.input)}
              />
              <Button type="submit" disabled={saving || !viewName.trim()}>
                {saving ? "Saving…" : "Save view"}
              </Button>
            </form>
            {saveError ? (
              <p role="alert" {...stylex.props(styles.error)}>
                {saveError}
              </p>
            ) : null}
          </section>

          <section {...stylex.props(styles.sideCard)}>
            <h2 {...stylex.props(styles.sideTitle)}>Saved views</h2>
            {savedViews.length === 0 ? (
              <p {...stylex.props(styles.cardCopy)}>No saved views yet.</p>
            ) : (
              <nav aria-label="Saved views" {...stylex.props(styles.viewList)}>
                {savedViews.map((view) => (
                  <Link
                    key={view.id}
                    to="/views/$viewId"
                    params={{ viewId: view.id }}
                    search={{ cursor: null }}
                    {...stylex.props(styles.viewLink)}
                  >
                    <span>{view.name}</span>
                    <small>{view.definition.presentation}</small>
                  </Link>
                ))}
              </nav>
            )}
          </section>
        </aside>
      </div>
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
    "@media (max-width: 700px)": { gridTemplateColumns: "minmax(0, 1fr)" },
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
    padding: 3,
    "@media (max-width: 700px)": {
      gridColumn: 1,
      gridRow: 2,
      justifySelf: "start",
      maxWidth: "100%",
      overflowX: "auto",
    },
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
    flexWrap: "wrap",
    gap: tokens.space3,
    justifySelf: "end",
    "@media (max-width: 700px)": { justifySelf: "start" },
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
  hero: { marginBlock: tokens.space8, maxWidth: 760 },
  eyebrow: {
    color: tokens.accent,
    fontSize: 11,
    fontWeight: 800,
    letterSpacing: "0.12em",
    margin: 0,
    textTransform: "uppercase",
  },
  title: {
    fontSize: "clamp(2.2rem, 6vw, 4.75rem)",
    letterSpacing: "-0.055em",
    lineHeight: 0.98,
    marginBlock: tokens.space3,
  },
  subtitle: {
    color: tokens.foregroundMuted,
    fontSize: 16,
    lineHeight: 1.6,
    margin: 0,
    maxWidth: 660,
  },
  layout: {
    alignItems: "start",
    display: "grid",
    gap: tokens.space6,
    gridTemplateColumns: "minmax(0, 1fr) 300px",
    "@media (max-width: 980px)": { gridTemplateColumns: "1fr" },
  },
  resultsPanel: { minWidth: 0 },
  searchForm: {
    backgroundColor: tokens.surface,
    borderColor: tokens.border,
    borderRadius: tokens.radius3,
    borderStyle: "solid",
    borderWidth: 1,
    boxShadow: tokens.shadow,
    display: "grid",
    gap: tokens.space2,
    gridTemplateColumns: "minmax(220px, 2fr) repeat(3, minmax(120px, 1fr))",
    padding: tokens.space3,
    "@media (max-width: 1050px)": { gridTemplateColumns: "repeat(2, minmax(0, 1fr))" },
    "@media (max-width: 560px)": { gridTemplateColumns: "1fr" },
  },
  searchField: {
    alignItems: "center",
    borderColor: tokens.border,
    borderRadius: tokens.radius2,
    borderStyle: "solid",
    borderWidth: 1,
    display: "flex",
    gap: tokens.space2,
    minWidth: 0,
    paddingInline: tokens.space3,
    ":focus-within": {
      borderColor: tokens.accent,
      outlineColor: tokens.accent,
      outlineOffset: 2,
      outlineStyle: "solid",
      outlineWidth: 2,
    },
  },
  input: {
    backgroundColor: tokens.surface,
    borderColor: tokens.border,
    borderRadius: tokens.radius2,
    borderStyle: "solid",
    borderWidth: 1,
    color: tokens.foreground,
    font: "inherit",
    minHeight: 38,
    minWidth: 0,
    paddingInline: tokens.space3,
    ":focus": { borderColor: tokens.accent, outline: "none" },
  },
  searchInput: { borderStyle: "none", paddingInline: 0, width: "100%" },
  select: {
    backgroundColor: tokens.surface,
    borderColor: tokens.border,
    borderRadius: tokens.radius2,
    color: tokens.foreground,
    font: "inherit",
    minHeight: 38,
    minWidth: 0,
    paddingInline: tokens.space2,
  },
  resultToolbar: {
    alignItems: "center",
    display: "flex",
    justifyContent: "space-between",
    marginBlock: tokens.space4,
    gap: tokens.space3,
  },
  resultCount: { color: tokens.foregroundMuted, fontSize: 13, margin: 0 },
  toolbarActions: { alignItems: "center", display: "flex", gap: tokens.space2 },
  pagination: { display: "flex", gap: tokens.space1 },
  presentationGroup: { borderWidth: 0, display: "flex", gap: tokens.space1, margin: 0, padding: 0 },
  iconButton: {
    alignItems: "center",
    backgroundColor: "transparent",
    borderColor: tokens.border,
    borderRadius: tokens.radius2,
    borderStyle: "solid",
    borderWidth: 1,
    color: tokens.foregroundMuted,
    cursor: "pointer",
    display: "flex",
    font: "inherit",
    fontSize: 12,
    fontWeight: 650,
    gap: tokens.space1,
    minHeight: 32,
    paddingInline: tokens.space2,
  },
  iconButtonActive: {
    backgroundColor: tokens.surface,
    borderColor: tokens.accent,
    color: tokens.foreground,
  },
  sidebar: { display: "grid", gap: tokens.space4 },
  sideCard: {
    backgroundColor: tokens.surface,
    borderColor: tokens.border,
    borderRadius: tokens.radius3,
    borderStyle: "solid",
    borderWidth: 1,
    padding: tokens.space4,
  },
  cardHeading: { alignItems: "center", display: "flex", gap: tokens.space2 },
  sideTitle: { fontSize: 15, marginBlockStart: 0 },
  cardCopy: { color: tokens.foregroundMuted, fontSize: 13, lineHeight: 1.5 },
  saveForm: { display: "grid", gap: tokens.space2 },
  error: { color: tokens.danger, fontSize: 13 },
  viewList: { display: "grid", gap: tokens.space1 },
  viewLink: {
    alignItems: "center",
    borderRadius: tokens.radius2,
    color: tokens.foreground,
    display: "flex",
    fontSize: 13,
    justifyContent: "space-between",
    padding: tokens.space2,
    textDecoration: "none",
    ":hover": { backgroundColor: tokens.surfaceMuted },
  },
  srOnly: {
    clip: "rect(0, 0, 0, 0)",
    clipPath: "inset(50%)",
    height: 1,
    overflow: "hidden",
    position: "absolute",
    whiteSpace: "nowrap",
    width: 1,
  },
});
