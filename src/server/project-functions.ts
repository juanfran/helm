import { createServerFn } from "@tanstack/react-start";
import { Effect } from "effect";

import { getAppState, listProjects } from "../application/projects";
import {
  compiledCreateProjectInputSchema,
  compiledSelectActiveProjectInputSchema,
  compiledSetProjectReviewModeInputSchema,
  compiledSetThemeInputSchema,
} from "../domain/projects";
import {
  executeChangeTheme,
  executeCreateProject,
  executeSelectActiveProject,
  executeSetProjectReviewMode,
} from "./project-adapter";
import { projectServices } from "./project-runtime.server";

export const readAppState = createServerFn({ method: "GET" }).handler(() =>
  Effect.runPromise(getAppState(projectServices)),
);

export const readProjects = createServerFn({ method: "GET" }).handler(() =>
  Effect.runPromise(listProjects(projectServices)),
);

export const createInitialProject = createServerFn({ method: "POST" })
  .validator(compiledCreateProjectInputSchema)
  .handler(({ data }) => executeCreateProject(data, projectServices));

export const selectHumanProject = createServerFn({ method: "POST" })
  .validator(compiledSelectActiveProjectInputSchema)
  .handler(({ data }) =>
    executeSelectActiveProject(data, { type: "human", id: "local-human" }, projectServices),
  );

export const changeTheme = createServerFn({ method: "POST" })
  .validator(compiledSetThemeInputSchema)
  .handler(({ data }) => executeChangeTheme(data, projectServices));

export const changeProjectReviewMode = createServerFn({ method: "POST" })
  .validator(compiledSetProjectReviewModeInputSchema)
  .handler(({ data }) =>
    executeSetProjectReviewMode(data, { type: "human", id: "local-human" }, projectServices),
  );
