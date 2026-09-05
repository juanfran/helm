import { useQuery } from "@tanstack/react-query";
import { useNavigate, useRouter } from "@tanstack/react-router";
import * as stylex from "@stylexjs/stylex";

import { NotificationCenter } from "../activity/notification-center";
import { importantProjectEventQueryKey } from "../activity/important-project-event-query";
import { executeProjectChange } from "../projects/project-navigation";
import { ProjectSwitcher } from "../projects/project-switcher";
import { ThemeControl } from "../projects/theme-control";
import {
  changeTheme,
  createInitialProject,
  selectHumanProject,
} from "../../server/project-functions";
import { readImportantProjectEvents } from "../../server/important-project-event-functions";
import { applyThemeOptimistically } from "../../styles/theme";
import { tokens } from "../../styles/tokens.stylex";
import type { TaskRoutePageToolsProps } from "./task-route-page-tools-launcher";

export function TaskRoutePageTools({
  projects,
  activeProject,
  activeProjectVersion,
}: TaskRoutePageToolsProps) {
  const router = useRouter();
  const navigate = useNavigate();

  return (
    <section aria-label="Project tools" {...stylex.props(styles.root)}>
      <ProjectSwitcher
        projects={projects}
        activeProject={activeProject}
        activeProjectVersion={activeProjectVersion}
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
    </section>
  );
}

export function TaskRouteHeaderUtilities({
  activeProject,
  theme,
  tasks,
  initialPanel,
}: TaskRoutePageToolsProps & { initialPanel: "notifications" | "appearance" }) {
  const router = useRouter();
  async function persistTheme(nextTheme: TaskRoutePageToolsProps["theme"]) {
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
  }

  return (
    <>
      <RouteNotificationCenter
        projectId={activeProject.id}
        tasks={tasks}
        defaultOpen={initialPanel === "notifications"}
      />
      <ThemeControl theme={theme} onChange={persistTheme} />
    </>
  );
}

function RouteNotificationCenter({
  projectId,
  tasks,
  defaultOpen,
}: Pick<TaskRoutePageToolsProps, "tasks"> & {
  readonly projectId: string;
  readonly defaultOpen: boolean;
}) {
  const navigate = useNavigate();
  const events = useQuery({
    queryKey: importantProjectEventQueryKey(projectId),
    queryFn: async () => (await readImportantProjectEvents({ data: { projectId } })).events,
  });

  if (events.isPending) {
    return <output {...stylex.props(styles.notificationStatus)}>Loading notifications…</output>;
  }
  if (events.isError) {
    return (
      <div role="alert" {...stylex.props(styles.notificationFailure)}>
        <span>Notifications could not be loaded.</span>
        <button
          type="button"
          onClick={() => void events.refetch()}
          {...stylex.props(styles.retryButton)}
        >
          Retry
        </button>
      </div>
    );
  }
  return (
    <NotificationCenter
      projectId={projectId}
      events={events.data}
      tasks={tasks}
      defaultOpen={defaultOpen}
      onSelectTask={(taskId) => {
        void navigate({ to: "/$projectId/tasks/$taskId", params: { projectId, taskId } });
      }}
    />
  );
}

const styles = stylex.create({
  root: {
    alignItems: "start",
    display: "grid",
    gap: tokens.space3,
    gridTemplateColumns: "minmax(0, 620px) auto",
    "@media (max-width: 820px)": { gridTemplateColumns: "1fr" },
  },
  utilities: {
    alignItems: "center",
    display: "flex",
    gap: tokens.space3,
    gridColumn: 2,
    gridRow: 1,
    justifySelf: "end",
    "@media (max-width: 820px)": {
      gridColumn: 1,
      gridRow: 2,
      justifySelf: "start",
    },
  },
  notificationStatus: { color: tokens.foregroundMuted, fontSize: 12 },
  notificationFailure: {
    alignItems: "center",
    color: tokens.danger,
    display: "flex",
    fontSize: 12,
    gap: tokens.space2,
  },
  retryButton: {
    backgroundColor: tokens.surface,
    borderColor: tokens.border,
    borderRadius: tokens.radius2,
    borderStyle: "solid",
    borderWidth: 1,
    color: tokens.foreground,
    cursor: "pointer",
    font: "inherit",
    minHeight: 32,
    paddingInline: tokens.space2,
  },
});
