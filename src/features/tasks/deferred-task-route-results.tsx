import { useState, type ComponentType } from "react";
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
    const [selecting, setSelecting] = useState(false);

    return (
      <>
        {selecting && moduleState.state.status === "ready" ? (
          <moduleState.state.module.TaskRouteResults {...props} />
        ) : (
          <CoreTaskResults {...props} />
        )}
        <section aria-label="Bulk task actions" {...stylex.props(styles.activation)}>
          {status === "error" ? (
            <p role="alert" {...stylex.props(styles.message)}>
              Bulk actions could not load. Try again.
            </p>
          ) : (
            <p {...stylex.props(styles.message)}>
              {selecting
                ? "Select tasks to preview a bulk change."
                : "Update several tasks at once."}
            </p>
          )}
          <button
            type="button"
            disabled={status === "loading"}
            aria-expanded={selecting}
            onPointerEnter={moduleState.preload}
            onFocus={moduleState.preload}
            onClick={() => {
              if (status === "error") {
                moduleState.retry();
                setSelecting(true);
              } else {
                setSelecting(!selecting);
                if (status === "idle") moduleState.activate();
              }
            }}
            {...stylex.props(styles.button)}
          >
            {status === "loading"
              ? "Loading bulk actions"
              : status === "error"
                ? "Try bulk actions again"
                : selecting
                  ? "Finish selecting"
                  : "Select tasks"}
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
