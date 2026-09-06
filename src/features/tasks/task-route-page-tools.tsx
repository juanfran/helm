import { useQuery, useQueryClient } from "@tanstack/react-query";
import { useLiveQuery } from "@tanstack/react-db";
import { useNavigate, useRouter } from "@tanstack/react-router";
import * as stylex from "@stylexjs/stylex";
import { Bell } from "lucide-react";

import { NotificationCenter } from "../activity/notification-center";
import { importantProjectEventQueryKey } from "../activity/important-project-event-query";
import { executeProjectChange } from "../projects/project-navigation";
import { ProjectSwitcher } from "../projects/project-switcher";
import { createInitialProject, selectHumanProject } from "../../server/project-functions";
import { readImportantProjectEvents } from "../../server/important-project-event-functions";
import { readTasks } from "../../server/task-functions";
import { projectEventTaskId } from "../activity/project-event-presentation";
import { getImportantProjectEventCollection } from "../activity/important-project-event-collection";
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

export function RouteNotificationCenter({
  projectId,
  tasks,
  defaultOpen,
}: Pick<TaskRoutePageToolsProps, "tasks"> & {
  readonly projectId: string;
  readonly defaultOpen: boolean;
}) {
  const navigate = useNavigate();
  const queryClient = useQueryClient();
  const collection = getImportantProjectEventCollection(queryClient, projectId);
  const liveEvents = useLiveQuery({ query: (query) => query.from({ event: collection }) });
  const events = useQuery({
    queryKey: importantProjectEventQueryKey(projectId),
    queryFn: async () => (await readImportantProjectEvents({ data: { projectId } })).events,
  });
  const taskIds = [
    ...new Set(
      (liveEvents.data ?? []).map(projectEventTaskId).filter((id): id is string => id !== null),
    ),
  ].toSorted();
  const taskNames = useQuery({
    queryKey: ["notification-task-names", projectId, taskIds],
    queryFn: () => readTasks({ data: { projectId, taskIds, includeArchived: true } }),
    enabled: taskIds.length > 0,
  });

  if (!liveEvents.isReady && !events.isError) {
    return (
      <button
        type="button"
        aria-label="Loading notifications"
        disabled
        {...stylex.props(styles.notificationTrigger)}
      >
        <Bell size={17} aria-hidden="true" />
      </button>
    );
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
      events={liveEvents.data ?? []}
      tasks={taskNames.data ?? tasks}
      defaultOpen={defaultOpen}
      onSelectTask={(taskId) => {
        void navigate({ to: "/$projectId/tasks/$taskId", params: { projectId, taskId } });
      }}
    />
  );
}

const styles = stylex.create({
  notificationTrigger: {
    display: "inline-flex",
    alignItems: "center",
    justifyContent: "center",
    height: 36,
    width: 36,
    backgroundColor: tokens.surface,
    border: `1px solid ${tokens.border}`,
    borderRadius: tokens.radius2,
    color: tokens.foregroundMuted,
  },
  root: {
    alignItems: "start",
    display: "grid",
    gap: tokens.space3,
    gridTemplateColumns: "minmax(0, 620px) auto",
    "@media (max-width: 820px)": { gridTemplateColumns: "1fr" },
  },
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
