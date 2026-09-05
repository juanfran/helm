import { type ComponentType } from "react";
import { ProjectMenu } from "../../components/project-menu";
import * as stylex from "@stylexjs/stylex";

import type { Project, Theme } from "../../domain/projects";
import { createRetryableLazyModuleLoader } from "../../components/retryable-lazy-module";
import { useExplicitLazyModule } from "../../components/use-explicit-lazy-module";
import { tokens } from "../../styles/tokens.stylex";

export type TaskRoutePageToolsProps = {
  readonly projects: readonly Project[];
  readonly activeProject: Project;
  readonly activeProjectVersion: number;
  readonly theme: Theme;
  readonly tasks: readonly {
    readonly id: string;
    readonly sequence: number;
    readonly title: string;
  }[];
};

type TaskRoutePageToolsModule = {
  readonly TaskRoutePageTools: ComponentType<TaskRoutePageToolsProps>;
};

export function createTaskRoutePageToolsLauncher(
  loadModule: () => Promise<TaskRoutePageToolsModule>,
) {
  const toolsModule = createRetryableLazyModuleLoader(loadModule);

  return function TaskRoutePageToolsLauncher(props: TaskRoutePageToolsProps) {
    const moduleState = useExplicitLazyModule(toolsModule);
    const status = moduleState.state.status;
    return (
      <ProjectMenu
        name={props.activeProject.name}
        preload={moduleState.preload}
        onActivate={() => {
          if (status === "idle") moduleState.activate();
        }}
      >
        {status === "loading" || status === "idle" ? <output>Loading project tools…</output> : null}
        {status === "error" ? (
          <div role="alert">
            Project tools could not be loaded.{" "}
            <button type="button" onClick={moduleState.retry} {...stylex.props(styles.button)}>
              Try project tools again
            </button>
          </div>
        ) : null}
        {moduleState.state.status === "ready" ? (
          <moduleState.state.module.TaskRoutePageTools {...props} />
        ) : null}
      </ProjectMenu>
    );
  };
}

export const TaskRoutePageToolsLauncher = createTaskRoutePageToolsLauncher(
  () => import("./task-route-page-tools"),
);

const styles = stylex.create({
  button: {
    backgroundColor: tokens.surface,
    borderColor: tokens.border,
    borderRadius: tokens.radius2,
    borderStyle: "solid",
    borderWidth: 1,
    color: tokens.foreground,
    cursor: "pointer",
    font: "inherit",
    fontSize: 12,
    fontWeight: 700,
    gridColumn: 2,
    gridRow: "1 / span 2",
    minHeight: 36,
    paddingInline: tokens.space3,
    ":focus-visible": {
      outlineColor: tokens.accent,
      outlineOffset: 2,
      outlineStyle: "solid",
      outlineWidth: 2,
    },
    "@media (max-width: 600px)": { gridColumn: 1, gridRow: "auto" },
  },
});
