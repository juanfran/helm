import { createFileRoute } from "@tanstack/react-router";
import { RoutePendingState } from "../components/route-state";
import { loadWorkspacePage } from "../features/projects/workspace-loader";
import { WorkspacePage } from "../features/projects/workspace-page";
import { WorkspacePageError } from "../features/projects/workspace-page-error";

export const Route = createFileRoute("/$projectId/activity")({
  ssr: false,
  codeSplitGroupings: [["loader"], ["component"], ["errorComponent"]],

  loader: async ({ context, params, parentMatchPromise }) => {
    await parentMatchPromise;
    return loadWorkspacePage(context.queryClient, params.projectId, undefined, "activity");
  },
  pendingComponent: RoutePendingState,
  errorComponent: WorkspacePageError,
  component: Page,
});

function Page() {
  return <WorkspacePage state={Route.useLoaderData()} view="activity" search={{}} />;
}
