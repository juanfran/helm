import { createFileRoute } from "@tanstack/react-router";
import { RoutePendingState } from "../components/route-state";
import { loadWorkspacePage } from "../features/projects/workspace-loader";
import { WorkspacePage } from "../features/projects/workspace-page";
import { WorkspacePageError } from "../features/projects/workspace-page-error";

export const Route = createFileRoute("/$projectId/dashboard")({
  ssr: false,
  codeSplitGroupings: [["loader"], ["component"], ["errorComponent"]],

  loader: ({ context, params }) => loadWorkspacePage(context.queryClient, params.projectId),
  pendingComponent: RoutePendingState,
  errorComponent: WorkspacePageError,
  component: Page,
});

function Page() {
  return <WorkspacePage state={Route.useLoaderData()} view="dashboard" search={{}} />;
}
