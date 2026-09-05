import { createFileRoute } from "@tanstack/react-router";
import { RoutePendingState } from "../components/route-state";
import { loadWorkspacePage } from "../features/projects/workspace-loader";
import { WorkspacePage } from "../features/projects/workspace-page";
import { WorkspacePageError } from "../features/projects/workspace-page-error";
import { workspaceSearchSchema } from "../features/projects/workspace-search";

export const Route = createFileRoute("/$projectId/tasks/$taskId")({
  ssr: false,
  codeSplitGroupings: [["loader"], ["component"], ["errorComponent"]],
  validateSearch: workspaceSearchSchema,
  loader: ({ context, params }) =>
    loadWorkspacePage(context.queryClient, params.projectId, params.taskId),
  pendingComponent: RoutePendingState,
  errorComponent: WorkspacePageError,
  component: TaskPage,
});

function TaskPage() {
  return (
    <WorkspacePage
      state={Route.useLoaderData()}
      search={Route.useSearch()}
      selectedTaskId={Route.useParams().taskId}
    />
  );
}
