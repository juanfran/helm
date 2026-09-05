import { createFileRoute, redirect } from "@tanstack/react-router";

import { RoutePendingState } from "../components/route-state";
import { loadWorkspacePage } from "../features/projects/workspace-loader";
import { WorkspacePageError } from "../features/projects/workspace-page-error";
import { WorkspacePage } from "../features/projects/workspace-page";
import { readAppState } from "../server/project-functions";

export const Route = createFileRoute("/")({
  ssr: false,
  codeSplitGroupings: [["loader"], ["component"], ["errorComponent"]],
  loader: async ({ context }) => {
    const state = await readAppState();
    if (state.activeProject)
      throw redirect({ to: "/$projectId/tasks", params: { projectId: state.activeProject.id } });
    return loadWorkspacePage(context.queryClient);
  },
  pendingComponent: RoutePendingState,
  errorComponent: WorkspacePageError,
  component: HomePage,
});

function HomePage() {
  return <WorkspacePage state={Route.useLoaderData()} search={{}} />;
}
