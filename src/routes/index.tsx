import { createFileRoute, redirect } from "@tanstack/react-router";

import { RoutePendingState } from "../components/route-state";
import { loadWorkspacePage } from "../features/projects/workspace-loader";
import { WorkspacePageError } from "../features/projects/workspace-page-error";
import { WorkspacePage } from "../features/projects/workspace-page";
import { workspaceStateQueryOptions } from "../features/projects/workspace-state-query";

export const Route = createFileRoute("/")({
  ssr: false,
  codeSplitGroupings: [["loader"], ["component"], ["errorComponent"]],
  loader: async ({ context }) => {
    const { state } = await context.queryClient.fetchQuery({
      ...workspaceStateQueryOptions(),
      staleTime: 0,
    });
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
