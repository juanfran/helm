import { useRouter } from "@tanstack/react-router";

import { RouteErrorState } from "../../components/route-state";

export function WorkspacePageError({ error }: { error: Error }) {
  const router = useRouter();
  return (
    <RouteErrorState
      error={error}
      title="Workspace could not be loaded"
      onRetry={() => router.invalidate()}
    />
  );
}
