import { getRouteApi, useRouter } from "@tanstack/react-router";

import { RouteErrorState } from "../../components/route-state";

const routeApi = getRouteApi("/views/$viewId");

export function ViewRouteError({ error }: { error: Error }) {
  const router = useRouter();
  const navigate = routeApi.useNavigate();
  return (
    <RouteErrorState
      error={error}
      title="Saved view could not be loaded"
      onRetry={async () => {
        await navigate({ search: { cursor: null } });
        await router.invalidate();
      }}
    />
  );
}
