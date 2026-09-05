import type { ReactNode } from "react";
import * as stylex from "@stylexjs/stylex";
import { ChevronDown } from "lucide-react";
import { tokens } from "../styles/tokens.stylex";
import { createRetryableLazyModuleLoader } from "./retryable-lazy-module";
import { useExplicitLazyModule } from "./use-explicit-lazy-module";

const popoverModule = createRetryableLazyModuleLoader(() =>
  import("./project-menu-popover").then(({ ProjectMenuPopover }) => ({
    default: ProjectMenuPopover,
  })),
);

export function ProjectMenu(props: {
  name: string;
  preload: () => void;
  onActivate?: () => void;
  children: ReactNode;
}) {
  const module = useExplicitLazyModule(popoverModule);
  function preload() {
    props.preload();
    module.preload();
  }
  if (module.state.status === "ready") return <module.state.module.default {...props} />;
  return (
    <div>
      <button
        type="button"
        aria-label="Switch project"
        aria-haspopup="dialog"
        aria-expanded={false}
        aria-busy={module.state.status === "loading"}
        onFocus={preload}
        onPointerEnter={preload}
        onClick={() => {
          props.onActivate?.();
          props.preload();
          if (module.state.status === "error") module.retry();
          else if (module.state.status === "idle") module.activate();
        }}
        {...stylex.props(styles.trigger)}
      >
        <span {...stylex.props(styles.name)}>{props.name}</span>
        <ChevronDown size={14} aria-hidden="true" />
      </button>
      {module.state.status === "error" ? (
        <span role="alert">Project menu could not load. Try again.</span>
      ) : null}
    </div>
  );
}
const styles = stylex.create({
  trigger: {
    display: "inline-flex",
    alignItems: "center",
    gap: tokens.space2,
    minHeight: 36,
    padding: "6px 10px",
    border: `1px solid ${tokens.border}`,
    borderRadius: tokens.radius2,
    color: tokens.foreground,
    backgroundColor: tokens.surface,
    cursor: "pointer",
    fontSize: 13,
    ":focus-visible": { outline: `2px solid ${tokens.accent}`, outlineOffset: 2 },
  },
  name: { maxWidth: 180, overflow: "hidden", textOverflow: "ellipsis", whiteSpace: "nowrap" },
});
