import { useEffect, useState } from "react";
import { Link, getRouteApi, useRouter } from "@tanstack/react-router";
import { useLiveSuspenseQuery } from "@tanstack/react-db";
import { useQueryClient, useSuspenseQuery } from "@tanstack/react-query";
import * as stylex from "@stylexjs/stylex";
import { Archive, LayoutGrid, List, ShipWheel } from "lucide-react";

import { Button } from "../../components/ui/button";
import type { AppState } from "../../domain/projects";
import { importantProjectEventQueryKey } from "../activity/important-project-event-query";
import { subscribeToProjectEvents } from "../activity/project-event-subscription";
import { DeferredTaskRouteResults } from "./deferred-task-route-results";
import { getTaskSearchCollection, taskSearchPageQueryOptions } from "./task-search-collection";
import { emptyTaskSearchParams } from "./task-search-route-params";
import { TaskRoutePageToolsLauncher } from "./task-route-page-tools-launcher";
import { archiveHumanSavedView } from "../../server/task-query-functions";
import { tokens } from "../../styles/tokens.stylex";

const routeApi = getRouteApi("/views/$viewId");

function activeProjectFromState(state: AppState) {
  if (!state.activeProject) throw new Error("An active project is required for saved views.");
  return state.activeProject;
}

export function SavedViewPage() {
  const { state, projects, view, input, eventCursor } = routeApi.useLoaderData();
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
  const [archiving, setArchiving] = useState(false);
  const [archiveError, setArchiveError] = useState<string | null>(null);
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
    [collection, eventCursor, input.cursor, navigate, projectId, queryClient, router, view.id],
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
        </div>
      </header>

      <div {...stylex.props(styles.projectToolbar)}>
        <TaskRoutePageToolsLauncher
          projects={projects}
          activeProject={project}
          activeProjectVersion={state.activeProjectVersion}
          theme={state.theme}
          tasks={items.map(({ task }) => task)}
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
      <DeferredTaskRouteResults
        projectId={projectId}
        items={items}
        visibleFields={view.definition.visibleFields}
        presentation={view.definition.presentation}
        grouping={view.definition.grouping}
        onExecuted={async () => {
          await collection.utils.refetch({ throwOnError: true });
        }}
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
