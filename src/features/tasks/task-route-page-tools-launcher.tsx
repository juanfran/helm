import type { ComponentType } from "react";
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
    const actionable = status === "idle" || status === "error";
    const action = status === "error" ? moduleState.retry : moduleState.activate;
    const buttonLabel =
      status === "idle"
        ? "Open project tools"
        : status === "loading"
          ? "Loading project tools"
          : status === "error"
            ? "Try project tools again"
            : "Project tools open";

    return (
      <section aria-label="Project tools" {...stylex.props(styles.root)}>
        <span {...stylex.props(styles.label)}>Active project</span>
        <strong {...stylex.props(styles.projectName)}>{props.activeProject.name}</strong>
        <button
          type="button"
          aria-disabled={!actionable}
          onPointerEnter={moduleState.preload}
          onFocus={moduleState.preload}
          onClick={actionable ? action : undefined}
          {...stylex.props(styles.button)}
        >
          {buttonLabel}
        </button>
        {status === "loading" ? (
          <output {...stylex.props(styles.status)}>Loading project tools…</output>
        ) : null}
        {status === "error" ? (
          <div role="alert" {...stylex.props(styles.failure)}>
            <span {...stylex.props(styles.status)}>Project tools could not be loaded.</span>
          </div>
        ) : null}
        {moduleState.state.status === "ready" ? (
          <div {...stylex.props(styles.loaded)}>
            <moduleState.state.module.TaskRoutePageTools {...props} />
          </div>
        ) : null}
      </section>
    );
  };
}

export const TaskRoutePageToolsLauncher = createTaskRoutePageToolsLauncher(
  () => import("./task-route-page-tools"),
);

const styles = stylex.create({
  root: {
    alignItems: "center",
    backgroundColor: tokens.surface,
    borderColor: tokens.border,
    borderRadius: tokens.radius2,
    borderStyle: "solid",
    borderWidth: 1,
    display: "grid",
    gap: tokens.space1,
    gridTemplateColumns: "minmax(0, 1fr) auto",
    minHeight: 72,
    paddingBlock: tokens.space2,
    paddingInline: tokens.space3,
    width: "min(100%, 620px)",
    "@media (max-width: 600px)": { gridTemplateColumns: "1fr" },
  },
  label: {
    color: tokens.foregroundMuted,
    fontSize: 11,
    fontWeight: 750,
    letterSpacing: "0.06em",
    textTransform: "uppercase",
  },
  projectName: {
    color: tokens.foreground,
    fontSize: 14,
    gridColumn: 1,
    overflow: "hidden",
    textOverflow: "ellipsis",
    whiteSpace: "nowrap",
  },
  status: { color: tokens.foregroundMuted, fontSize: 12 },
  failure: {
    alignItems: "center",
    display: "flex",
    gap: tokens.space2,
    gridColumn: "1 / -1",
    justifyContent: "space-between",
  },
  loaded: { gridColumn: "1 / -1" },
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
