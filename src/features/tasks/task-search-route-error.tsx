import { getRouteApi, useRouter } from "@tanstack/react-router";

import { RouteErrorState } from "../../components/route-state";

const routeApi = getRouteApi("/$projectId/search");

export function SearchRouteError({ error }: { error: Error }) {
  const router = useRouter();
  const navigate = routeApi.useNavigate();
  return (
    <RouteErrorState
      error={error}
      title="Search could not be loaded"
      onRetry={async () => {
        await navigate({ search: (previous) => ({ ...previous, cursor: null }) });
        await router.invalidate();
      }}
    />
  );
}
