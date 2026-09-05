import { useState, type ReactNode } from "react";
import { Popover } from "@base-ui/react/popover";
import * as stylex from "@stylexjs/stylex";
import { ChevronDown, X } from "lucide-react";
import { tokens } from "../styles/tokens.stylex";

export function ProjectMenuPopover({
  name,
  preload,
  children,
}: {
  name: string;
  preload: () => void;
  children: ReactNode;
}) {
  const [open, setOpen] = useState(true);
  return (
    <Popover.Root open={open} onOpenChange={setOpen}>
      <Popover.Trigger
        onFocus={preload}
        onPointerEnter={preload}
        aria-label="Switch project"
        {...stylex.props(styles.trigger)}
      >
        <span {...stylex.props(styles.name)}>{name}</span>
        <ChevronDown size={14} aria-hidden="true" />
      </Popover.Trigger>
      <Popover.Portal>
        <Popover.Positioner
          side="bottom"
          align="start"
          sideOffset={8}
          {...stylex.props(styles.positioner)}
        >
          <Popover.Popup {...stylex.props(styles.popup)}>
            <div {...stylex.props(styles.heading)}>
              <Popover.Title {...stylex.props(styles.title)}>Projects</Popover.Title>
              <Popover.Close aria-label="Close project switcher" {...stylex.props(styles.close)}>
                <X size={16} />
              </Popover.Close>
            </div>
            {open ? children : null}
          </Popover.Popup>
        </Popover.Positioner>
      </Popover.Portal>
    </Popover.Root>
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
  positioner: { zIndex: 50 },
  popup: {
    width: "min(480px, calc(100vw - 24px))",
    maxHeight: "min(600px, calc(100vh - 100px))",
    overflowY: "auto",
    backgroundColor: tokens.surface,
    color: tokens.foreground,
    border: `1px solid ${tokens.border}`,
    borderRadius: tokens.radius3,
    boxShadow: tokens.shadow,
    padding: tokens.space4,
  },
  heading: {
    display: "flex",
    justifyContent: "space-between",
    alignItems: "center",
    marginBlockEnd: tokens.space3,
  },
  title: { fontSize: 14, margin: 0 },
  close: {
    display: "inline-flex",
    alignItems: "center",
    justifyContent: "center",
    width: 32,
    height: 32,
    border: "none",
    borderRadius: tokens.radius2,
    backgroundColor: "transparent",
    color: tokens.foreground,
    cursor: "pointer",
    ":focus-visible": { outline: `2px solid ${tokens.accent}` },
  },
});
