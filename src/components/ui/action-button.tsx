import type { ComponentPropsWithRef } from "react";
import * as stylex from "@stylexjs/stylex";
import { buttonStyles } from "./button.styles";

// Native form actions need no composite-widget runtime. They share the same tokens and variants
// as the Base UI button used by dialogs, popovers, and other composed controls.
export function ActionButton({
  variant = "primary",
  type = "button",
  ...props
}: Omit<ComponentPropsWithRef<"button">, "className" | "style"> & {
  variant?: "primary" | "quiet" | "danger";
}) {
  return (
    <button type={type} {...stylex.props(buttonStyles.root, buttonStyles[variant])} {...props} />
  );
}
