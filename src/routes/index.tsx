import { createFileRoute, getRouteApi, useRouter } from "@tanstack/react-router";

import { ProjectLanding } from "../features/projects/project-landing";
import { changeTheme, createInitialProject } from "../server/project-functions";

const rootRoute = getRouteApi("__root__");

export const Route = createFileRoute("/")({ component: Home });

function Home() {
  const state = rootRoute.useLoaderData();
  const router = useRouter();

  return (
    <ProjectLanding
      state={state}
      onCreateProject={async (input) => {
        const response = await createInitialProject({ data: input });
        if (response.ok) await router.invalidate({ sync: true });
        return response;
      }}
      onChangeTheme={async (input) => {
        const response = await changeTheme({ data: input });
        if (response.ok) await router.invalidate({ sync: true });
        return response;
      }}
    />
  );
}
