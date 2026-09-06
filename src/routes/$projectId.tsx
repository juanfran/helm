import { useMemo, useState } from "react";
import { createFileRoute, Outlet, useRouterState } from "@tanstack/react-router";
import * as stylex from "@stylexjs/stylex";

import { AppHeader, ProjectNavigation } from "../components/app-header";
import { RoutePendingState } from "../components/route-state";
import { WorkspacePageError } from "../features/projects/workspace-page-error";
import {
  ProjectShellContext,
  type ProjectConnectionStatus,
} from "../features/projects/project-shell-context";
import { TaskRoutePageToolsLauncher } from "../features/tasks/task-route-page-tools-launcher";
import { TaskRouteUtilities } from "../features/tasks/task-route-utilities";
import { readAppState, readProjects } from "../server/project-functions";
import { tokens } from "../styles/tokens.stylex";

export const Route = createFileRoute("/$projectId")({
  ssr: false,
  codeSplitGroupings: [["loader"], ["component"], ["errorComponent"]],
  loader: async ({ params }) => {
    const [state, projects] = await Promise.all([readAppState(), readProjects()]);
    const project = projects.find((item) => item.id === params.projectId);
    if (!project) throw new Error("This project could not be found.");
    return { state, projects, project };
  },
  pendingComponent: RoutePendingState,
  errorComponent: WorkspacePageError,
  component: ProjectLayout,
});

function ProjectLayout() {
  const data = Route.useLoaderData();
  return <ProjectShell key={data.project.id} {...data} />;
}

function ProjectShell({ state, projects, project }: ReturnType<typeof Route.useLoaderData>) {
  const routeId = useRouterState({
    select: (routerState) => routerState.matches.at(-1)?.routeId ?? "",
  });
  const current = routeId.endsWith("/dashboard")
    ? "dashboard"
    : routeId.endsWith("/activity")
      ? "activity"
      : routeId.endsWith("/settings")
        ? "settings"
        : routeId.endsWith("/search") || routeId.includes("/views/")
          ? "search"
          : "tasks";
  const [liveStatus, reportConnection] = useState<ProjectConnectionStatus>("connecting");
  const context = useMemo(() => ({ reportConnection }), []);
  const tools = {
    projects,
    activeProject: project,
    activeProjectVersion: state.activeProjectVersion,
    theme: state.theme,
    tasks: [],
  };

  return (
    <ProjectShellContext.Provider value={context}>
      <AppHeader
        projectName={project.name}
        projectControl={<TaskRoutePageToolsLauncher {...tools} />}
        navigation={<ProjectNavigation projectId={project.id} current={current} />}
        utilities={
          <>
            <span aria-live="polite" {...stylex.props(styles.connection)}>
              {liveStatus === "live"
                ? "Live"
                : liveStatus === "retrying"
                  ? "Reconnecting"
                  : "Connecting"}
            </span>
            <TaskRouteUtilities {...tools} />
          </>
        }
      />
      <Outlet />
    </ProjectShellContext.Provider>
  );
}

const styles = stylex.create({
  connection: {
    color: tokens.foregroundMuted,
    fontSize: 12,
    textAlign: "end",
    width: 80,
  },
});
