import type { QueryClient } from "@tanstack/react-query";
import { readTasks } from "../../server/task-functions";
import { taskTagsQueryOptions } from "../tasks/task-tags-query";
import { projectCustomizationQueryOptions } from "./project-customization-query";
import { projectLandingModule } from "./project-landing-module";
import { getWorkspaceData } from "./workspace-data";
import { savedViewsQueryOptions, workspaceStateQueryOptions } from "./workspace-state-query";
import { workspaceModules } from "./workspace-modules";
import type { WorkspaceView } from "./workspace-search";

export async function loadWorkspacePage(
  queryClient: QueryClient,
  projectIdOverride?: string,
  taskId?: string,
  view: WorkspaceView = "tasks",
) {
  if (taskId) workspaceModules.taskDetail.preload();
  if (view !== "tasks") workspaceModules[view].preload();
  const snapshot = await queryClient.ensureQueryData(workspaceStateQueryOptions());
  const state = { ...snapshot.state };
  const projects = snapshot.projects;
  if (projectIdOverride) {
    const project = projects.find((item) => item.id === projectIdOverride);
    if (!project)
      throw new Error("This project could not be found. Choose another project from Tasks.");
    state.activeProject = project;
  }
  let eventCursor = 0;
  if (state.activeProject) {
    const projectId = state.activeProject.id;
    const data = getWorkspaceData(queryClient, projectId);
    eventCursor = await data.captureCursor();
    const required: Promise<unknown>[] = [];
    if (view !== "settings") required.push(data.resources.tasks.ensure());
    if (view === "settings" || view === "tasks") {
      required.push(queryClient.ensureQueryData(projectCustomizationQueryOptions(projectId)));
      required.push(queryClient.ensureQueryData(taskTagsQueryOptions(projectId)));
    }
    // Start secondary reads alongside critical data; their sections own waiting and failure.
    if (taskId || view === "dashboard" || view === "activity")
      void data.resources.attempts.ensure();
    if (taskId || view === "activity") {
      void data.resources.activity.ensure();
      void data.resources.blockers.ensure();
    }
    if (view === "dashboard" || view === "activity") void data.resources.events.ensure();
    if (view === "tasks" || view === "settings")
      void queryClient.prefetchQuery(savedViewsQueryOptions(projectId));
    await Promise.all(required);
    if (view !== "settings") await data.refreshTimeSensitiveTasks();
    if (taskId && !data.collections.tasks.has(taskId)) {
      const rows = await readTasks({
        data: { projectId, taskIds: [taskId], includeArchived: true },
      });
      if (!rows[0]) throw new Error("This task could not be found in this project.");
      data.collections.tasks.utils.writeUpsert(rows[0]);
    }
  } else await projectLandingModule.load();
  return { ...state, projects: [...projects], eventCursor };
}
