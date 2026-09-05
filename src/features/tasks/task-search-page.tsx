import { useEffect, useState, type FormEvent } from "react";
import { Link, getRouteApi, useRouter } from "@tanstack/react-router";
import { useLiveSuspenseQuery } from "@tanstack/react-db";
import { useQueryClient, useSuspenseQuery } from "@tanstack/react-query";
import * as stylex from "@stylexjs/stylex";
import { LayoutGrid, List } from "lucide-react";

import { AppHeader, ProjectNavigation } from "../../components/app-header";
import { ActionButton as Button } from "../../components/ui/action-button";
import type { AppState } from "../../domain/projects";
import type { SavedViewVisibleField } from "../../domain/saved-views";
import { canonicalizeTaskSearchOrder } from "../../domain/task-filters";
import { importantProjectEventQueryKey } from "../activity/important-project-event-query";
import { subscribeToProjectEvents } from "../activity/project-event-subscription";
import { DeferredTaskRouteResults } from "./deferred-task-route-results";
import { getTaskSearchCollection, taskSearchPageQueryOptions } from "./task-search-collection";
import { SearchFilterControls } from "./task-route-controls";
import { TaskRouteUtilities } from "./task-route-utilities";
import { TaskRoutePageToolsLauncher } from "./task-route-page-tools-launcher";
import { createHumanSavedView, readSavedViews } from "../../server/task-query-functions";
import { tokens } from "../../styles/tokens.stylex";

const routeApi = getRouteApi("/search");

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

function activeProjectFromState(state: AppState) {
  if (!state.activeProject) throw new Error("An active project is required for task search.");
  return state.activeProject;
}

export function SearchPage() {
  const { state, projects, input, eventCursor } = routeApi.useLoaderData();
  const search = routeApi.useSearch();
  const router = useRouter();
  const navigate = routeApi.useNavigate();
  const queryClient = useQueryClient();
  const project = activeProjectFromState(state);
  const projectId = project.id;
  const collection = getTaskSearchCollection(queryClient, input);
  const { data: items } = useLiveSuspenseQuery({
    query: (query) => query.from({ hit: collection }).orderBy(({ hit }) => hit.rank, "asc"),
  });
  const { data: page } = useSuspenseQuery(taskSearchPageQueryOptions(input));
  const { data: savedViews } = useSuspenseQuery(savedViewsQueryOptions(projectId));
  const [viewName, setViewName] = useState("");
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
          if (event.importance !== "routine") {
            void queryClient.invalidateQueries({
              queryKey: importantProjectEventQueryKey(projectId),
            });
          }
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
    [collection, eventCursor, input.cursor, navigate, projectId, queryClient, router],
  );

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
        search: { cursor: null, project: projectId },
      });
    } catch {
      setSaveError("Helm could not save this view.");
    } finally {
      setSaving(false);
    }
  }

  return (
    <main {...stylex.props(styles.page)}>
      <AppHeader
        projectName={project.name}
        navigation={<ProjectNavigation projectId={project.id} current="search" />}
        projectControl={
          <TaskRoutePageToolsLauncher
            projects={projects}
            activeProject={project}
            activeProjectVersion={state.activeProjectVersion}
            theme={state.theme}
            tasks={items.map(({ task }) => task)}
          />
        }
        utilities={
          <>
            <span aria-live="polite" {...stylex.props(styles.liveStatus)}>
              {liveStatus === "live"
                ? "Live"
                : liveStatus === "retrying"
                  ? "Reconnecting"
                  : "Connecting"}
            </span>
            <TaskRouteUtilities
              projects={projects}
              activeProject={project}
              activeProjectVersion={state.activeProjectVersion}
              theme={state.theme}
              tasks={items.map(({ task }) => task)}
            />
          </>
        }
      />

      <section {...stylex.props(styles.hero)}>
        <h1 {...stylex.props(styles.title)}>Search tasks</h1>
      </section>

      <div {...stylex.props(styles.layout)}>
        <section {...stylex.props(styles.resultsPanel)}>
          <SearchFilterControls
            projectId={projectId}
            search={search}
            onApply={(nextSearch) =>
              void navigate({ search: { ...nextSearch, project: projectId } })
            }
          />

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

          <DeferredTaskRouteResults
            projectId={projectId}
            items={items}
            visibleFields={visibleFields}
            presentation={search.presentation}
            onExecuted={async () => {
              await collection.utils.refetch({ throwOnError: true });
            }}
          />
        </section>

        <aside {...stylex.props(styles.sidebar)}>
          <section {...stylex.props(styles.sideCard)}>
            <h2 {...stylex.props(styles.sideTitle)}>Save this view</h2>
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
                    search={{ cursor: null, project: projectId }}
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
    padding: 0,
    width: "100%",
  },
  liveStatus: {
    color: tokens.foregroundMuted,
    fontSize: 12,
  },
  hero: { marginBlock: tokens.space5, paddingInline: tokens.space5, maxWidth: 760 },
  eyebrow: {
    color: tokens.accent,
    fontSize: 11,
    fontWeight: 800,
    letterSpacing: "0.12em",
    margin: 0,
    textTransform: "uppercase",
  },
  title: {
    fontSize: 28,
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
    paddingInline: tokens.space5,
    paddingBlockEnd: tokens.space5,
    alignItems: "start",
    display: "grid",
    gap: tokens.space6,
    gridTemplateColumns: "minmax(0, 1fr) 300px",
    "@media (max-width: 980px)": { gridTemplateColumns: "1fr" },
  },
  resultsPanel: { minWidth: 0 },
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
});
