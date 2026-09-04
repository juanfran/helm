import type { ComponentType } from "react";
import * as stylex from "@stylexjs/stylex";

import { createRetryableLazyModuleLoader } from "../../components/retryable-lazy-module";
import { useExplicitLazyModule } from "../../components/use-explicit-lazy-module";
import { tokens } from "../../styles/tokens.stylex";
import type { TaskRouteResultsProps } from "./task-route-results";
import { TaskSearchResults } from "./task-search-results";

type TaskRouteResultsModule = {
  readonly TaskRouteResults: ComponentType<TaskRouteResultsProps>;
};

function CoreTaskResults(props: TaskRouteResultsProps) {
  return (
    <TaskSearchResults
      items={props.items}
      visibleFields={props.visibleFields}
      presentation={props.presentation}
      grouping={props.grouping}
    />
  );
}

export function createDeferredTaskRouteResults(loadModule: () => Promise<TaskRouteResultsModule>) {
  const taskRouteResultsModule = createRetryableLazyModuleLoader(loadModule);

  return function DeferredTaskRouteResults(props: TaskRouteResultsProps) {
    const moduleState = useExplicitLazyModule(taskRouteResultsModule);
    const status = moduleState.state.status;
    const actionable = status === "idle" || status === "error";
    const action = status === "error" ? moduleState.retry : moduleState.activate;
    const buttonLabel =
      status === "idle"
        ? "Select tasks"
        : status === "loading"
          ? "Loading bulk actions"
          : status === "error"
            ? "Try bulk actions again"
            : "Task selection enabled";

    return (
      <>
        {moduleState.state.status === "ready" ? (
          <moduleState.state.module.TaskRouteResults {...props} />
        ) : (
          <CoreTaskResults {...props} />
        )}
        <section aria-label="Bulk task actions" {...stylex.props(styles.activation)}>
          <div>
            {status === "idle" ? (
              <p {...stylex.props(styles.message)}>
                Need to update several results? Enable task selection and bulk actions.
              </p>
            ) : null}
            {status === "loading" ? (
              <output {...stylex.props(styles.message)}>Loading selection and bulk actions…</output>
            ) : null}
            {status === "error" ? (
              <p role="alert" {...stylex.props(styles.message)}>
                Selection and bulk actions could not be loaded. Your results remain available.
              </p>
            ) : null}
            {status === "ready" ? (
              <p {...stylex.props(styles.message)}>
                Select tasks in the results above to preview a bulk change.
              </p>
            ) : null}
          </div>
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
        </section>
      </>
    );
  };
}

export const DeferredTaskRouteResults = createDeferredTaskRouteResults(
  () => import("./task-route-results"),
);

const styles = stylex.create({
  activation: {
    alignItems: "center",
    backgroundColor: tokens.surface,
    borderColor: tokens.border,
    borderRadius: tokens.radius2,
    borderStyle: "solid",
    borderWidth: 1,
    display: "flex",
    gap: tokens.space3,
    justifyContent: "space-between",
    marginBlockStart: tokens.space3,
    minHeight: 54,
    padding: tokens.space3,
  },
  message: { color: tokens.foregroundMuted, fontSize: 13, margin: 0 },
  button: {
    backgroundColor: tokens.foreground,
    borderColor: tokens.foreground,
    borderRadius: tokens.radius2,
    borderStyle: "solid",
    borderWidth: 1,
    color: tokens.background,
    cursor: "pointer",
    font: "inherit",
    fontSize: 13,
    fontWeight: 700,
    minHeight: 36,
    paddingInline: tokens.space3,
    ":focus-visible": {
      outlineColor: tokens.accent,
      outlineOffset: 2,
      outlineStyle: "solid",
      outlineWidth: 2,
    },
  },
});
