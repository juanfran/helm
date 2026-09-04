import { createFileRoute, useRouter } from "@tanstack/react-router";
import { useLiveSuspenseQuery } from "@tanstack/react-db";
import { useQueryClient, useSuspenseQuery } from "@tanstack/react-query";

import { ProjectLanding } from "../features/projects/project-landing";
import { getTaskCollection } from "../features/tasks/task-collection";
import { TaskWorkspace } from "../features/tasks/task-workspace";
import { changeTheme, createInitialProject } from "../server/project-functions";
import { readAppState } from "../server/project-functions";
import {
  archiveHumanTask,
  completeHumanTask,
  createHumanTask,
  createHumanTaskRelation,
  prepareHumanTask,
  readTaskTags,
  reopenHumanTask,
  updateHumanTaskPlanning,
} from "../server/task-functions";
import { applyThemeToDocument } from "../styles/theme";
import type { Project, Theme } from "../domain/projects";

export const Route = createFileRoute("/")({
  ssr: false,
  loader: async ({ context }) => {
    const state = await readAppState();
    if (state.activeProject) {
      await Promise.all([
        getTaskCollection(context.queryClient, state.activeProject.id).preload(),
        context.queryClient.ensureQueryData(taskTagsQueryOptions(state.activeProject.id)),
      ]);
    }
    return state;
  },
  component: Home,
});

function taskTagsQueryOptions(projectId: string) {
  return {
    queryKey: ["task-tags", projectId] as const,
    queryFn: () => readTaskTags({ data: { projectId } }),
  };
}

function Home() {
  const state = Route.useLoaderData();
  const router = useRouter();

  if (state.activeProject) {
    return <ActiveProjectHome project={state.activeProject} theme={state.theme} />;
  }

  return (
    <ProjectLanding
      state={state}
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

function ActiveProjectHome({ project, theme }: { project: Project; theme: Theme }) {
  const router = useRouter();
  const queryClient = useQueryClient();
  const collection = getTaskCollection(queryClient, project.id);
  const { data: tasks } = useLiveSuspenseQuery({
    query: (query) => query.from({ task: collection }),
  });
  const { data: tagDefinitions } = useSuspenseQuery(taskTagsQueryOptions(project.id));

  async function refresh(response: Awaited<ReturnType<typeof createHumanTask>>) {
    if (response.ok) {
      await Promise.all([
        collection.utils.refetch({ throwOnError: true }),
        queryClient.invalidateQueries({ queryKey: ["task-tags", project.id] }),
      ]);
    }
    return response;
  }

  return (
    <TaskWorkspace
      project={project}
      theme={theme}
      tasks={tasks}
      tagDefinitions={tagDefinitions}
      onCreateTask={(input) => createHumanTask({ data: input }).then(refresh)}
      onPrepareTask={(input) => prepareHumanTask({ data: input }).then(refresh)}
      onUpdateTaskPlanning={(input) => updateHumanTaskPlanning({ data: input }).then(refresh)}
      onCompleteTask={(input) => completeHumanTask({ data: input }).then(refresh)}
      onReopenTask={(input) => reopenHumanTask({ data: input }).then(refresh)}
      onCreateTaskRelation={(input) =>
        createHumanTaskRelation({ data: input }).then(async (response) => {
          if (response.ok) await collection.utils.refetch({ throwOnError: true });
          return response;
        })
      }
      onArchiveTask={(input) => archiveHumanTask({ data: input }).then(refresh)}
      onChangeTheme={async (nextTheme) => {
        const previous = theme;
        applyThemeToDocument(nextTheme);
        const response = await changeTheme({
          data: { theme: nextTheme, idempotencyKey: crypto.randomUUID() },
        });
        if (!response.ok) {
          applyThemeToDocument(previous);
          throw new Error(response.error.message);
        }
        await router.invalidate({ sync: true });
      }}
    />
  );
}
