import { createFileRoute } from "@tanstack/react-router";
import { RoutePendingState } from "../components/route-state";
import { loadWorkspacePage } from "../features/projects/workspace-loader";
import { WorkspacePage } from "../features/projects/workspace-page";
import { WorkspacePageError } from "../features/projects/workspace-page-error";
import { workspaceSearchSchema } from "../features/projects/workspace-search";

export const Route = createFileRoute("/$projectId/tasks/")({
  ssr: false,
  codeSplitGroupings: [["loader"], ["component"], ["errorComponent"]],
  validateSearch: workspaceSearchSchema,
  loader: ({ context, params }) => loadWorkspacePage(context.queryClient, params.projectId),
  pendingComponent: RoutePendingState,
  errorComponent: WorkspacePageError,
  component: Page,
});

function Page() {
  return <WorkspacePage state={Route.useLoaderData()} view="tasks" search={Route.useSearch()} />;
}
