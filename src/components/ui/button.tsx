import { Button as ButtonPrimitive } from "@base-ui/react/button";
import * as stylex from "@stylexjs/stylex";

import { tokens } from "../../styles/tokens.stylex";

type ButtonProps = Omit<ButtonPrimitive.Props, "className"> & {
  variant?: "primary" | "quiet";
};

export function Button({ variant = "primary", ...props }: ButtonProps) {
  return <ButtonPrimitive {...stylex.props(styles.root, styles[variant])} {...props} />;
}

const styles = stylex.create({
  root: {
    alignItems: "center",
    borderRadius: tokens.radius2,
    borderStyle: "solid",
    borderWidth: 1,
    cursor: "pointer",
    display: "inline-flex",
    fontSize: 14,
    fontWeight: 650,
    justifyContent: "center",
    minHeight: 36,
    paddingInline: tokens.space4,
    transitionDuration: "120ms",
    transitionProperty: "background-color, border-color, color, opacity",
    ":disabled": {
      cursor: "not-allowed",
      opacity: 0.45,
    },
    ":focus-visible": {
      outlineColor: tokens.accent,
      outlineOffset: 2,
      outlineStyle: "solid",
      outlineWidth: 2,
    },
  },
  primary: {
    backgroundColor: tokens.accent,
    borderColor: tokens.accent,
    color: tokens.background,
    ":hover": {
      opacity: 0.88,
    },
  },
  quiet: {
    backgroundColor: tokens.surface,
    borderColor: tokens.border,
    color: tokens.foreground,
    ":hover": {
      borderColor: tokens.accent,
    },
  },
});
