import { createFileRoute } from "@tanstack/react-router";

import { RoutePendingState } from "../components/route-state";
import { loadWorkspacePage } from "../features/projects/workspace-loader";
import { WorkspacePageError } from "../features/projects/workspace-page-error";
import { WorkspacePage } from "../features/projects/workspace-page";

export const Route = createFileRoute("/")({
  ssr: false,
  codeSplitGroupings: [["loader"], ["component"], ["errorComponent"]],
  loader: ({ context }) => loadWorkspacePage(context.queryClient),
  pendingComponent: RoutePendingState,
  errorComponent: WorkspacePageError,
  component: WorkspacePage,
});
