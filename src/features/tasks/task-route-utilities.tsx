import { useState } from "react";
import * as stylex from "@stylexjs/stylex";
import { createRetryableLazyModuleLoader } from "../../components/retryable-lazy-module";
import { useExplicitLazyModule } from "../../components/use-explicit-lazy-module";
import { tokens } from "../../styles/tokens.stylex";
import type { TaskRoutePageToolsProps } from "./task-route-page-tools-launcher";

const utilitiesModule = createRetryableLazyModuleLoader(() =>
  import("./task-route-page-tools").then(({ TaskRouteHeaderUtilities }) => ({
    default: TaskRouteHeaderUtilities,
  })),
);

export function TaskRouteUtilities(props: TaskRoutePageToolsProps) {
  const module = useExplicitLazyModule(utilitiesModule);
  const [initialPanel, setInitialPanel] = useState<"notifications" | "appearance">("appearance");
  if (module.state.status === "ready")
    return <module.state.module.default {...props} initialPanel={initialPanel} />;
  return (
    <>
      {(["notifications", "appearance"] as const).map((panel) => (
        <button
          key={panel}
          type="button"
          disabled={module.state.status === "loading"}
          onFocus={module.preload}
          onPointerEnter={module.preload}
          onClick={() => {
            setInitialPanel(panel);
            if (module.state.status === "error") module.retry();
            else module.activate();
          }}
          {...stylex.props(styles.button)}
        >
          {panel === "notifications" ? "Notifications" : "Appearance"}
        </button>
      ))}
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
    minHeight: 36,
    paddingInline: tokens.space3,
    fontSize: 13,
    cursor: "pointer",
    ":focus-visible": { outline: `2px solid ${tokens.accent}`, outlineOffset: 2 },
  },
});
