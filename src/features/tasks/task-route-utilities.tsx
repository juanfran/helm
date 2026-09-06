import { useRouter } from "@tanstack/react-router";
import * as stylex from "@stylexjs/stylex";
import { Bell } from "lucide-react";
import { createRetryableLazyModuleLoader } from "../../components/retryable-lazy-module";
import { useExplicitLazyModule } from "../../components/use-explicit-lazy-module";
import { tokens } from "../../styles/tokens.stylex";
import { ThemeControl } from "../projects/theme-control";
import type { TaskRoutePageToolsProps } from "./task-route-page-tools-launcher";

const utilitiesModule = createRetryableLazyModuleLoader(() =>
  import("./task-route-page-tools").then(({ RouteNotificationCenter }) => ({
    default: RouteNotificationCenter,
  })),
);

export function TaskRouteUtilities(props: TaskRoutePageToolsProps) {
  const module = useExplicitLazyModule(utilitiesModule);
  const router = useRouter();
  return (
    <>
      {module.state.status === "ready" ? (
        <module.state.module.default
          projectId={props.activeProject.id}
          tasks={props.tasks}
          defaultOpen
        />
      ) : (
        <button
          type="button"
          aria-label="Notifications"
          aria-disabled={module.state.status === "loading"}
          onFocus={module.preload}
          onPointerEnter={module.preload}
          onClick={() => {
            if (module.state.status === "error") module.retry();
            else if (module.state.status === "idle") module.activate();
          }}
          {...stylex.props(styles.button)}
        >
          <Bell size={17} aria-hidden="true" />
        </button>
      )}
      <ThemeControl
        theme={props.theme}
        onChange={async (nextTheme) => {
          const { changeProjectTheme } = await import("../projects/change-project-theme");
          await changeProjectTheme(props.theme, nextTheme);
          await router.invalidate({ sync: true });
        }}
      />
      {module.state.status === "error" ? (
        <span role="alert">Could not load controls. Try again.</span>
      ) : null}
    </>
  );
}
const styles = stylex.create({
  button: {
    backgroundColor: tokens.surface,
    color: tokens.foreground,
    border: `1px solid ${tokens.border}`,
    borderRadius: tokens.radius2,
    height: 36,
    width: 36,
    display: "inline-flex",
    alignItems: "center",
    justifyContent: "center",
    fontSize: 13,
    cursor: "pointer",
    ":focus-visible": { outline: `2px solid ${tokens.accent}`, outlineOffset: 2 },
  },
});
