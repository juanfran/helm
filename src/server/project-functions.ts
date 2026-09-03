import { createServerFn } from "@tanstack/react-start";
import { Effect } from "effect";

import { getAppState } from "../application/projects";
import { compiledCreateProjectInputSchema, compiledSetThemeInputSchema } from "../domain/projects";
import { executeChangeTheme, executeCreateProject } from "./project-adapter";
import { projectServices } from "./project-runtime.server";

export const readAppState = createServerFn({ method: "GET" }).handler(() =>
  Effect.runPromise(getAppState(projectServices)),
);

export const createInitialProject = createServerFn({ method: "POST" })
  .validator(compiledCreateProjectInputSchema)
  .handler(({ data }) => executeCreateProject(data, projectServices));

export const changeTheme = createServerFn({ method: "POST" })
  .validator(compiledSetThemeInputSchema)
  .handler(({ data }) => executeChangeTheme(data, projectServices));
