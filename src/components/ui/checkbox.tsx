import { Checkbox as CheckboxPrimitive } from "@base-ui/react/checkbox";
import * as stylex from "@stylexjs/stylex";
import { Check, Minus } from "lucide-react";

import { tokens } from "../../styles/tokens.stylex";

export type CheckboxProps = Omit<
  CheckboxPrimitive.Root.Props,
  "aria-label" | "checked" | "className" | "children" | "indeterminate" | "nativeButton" | "render"
> & {
  "aria-label": string;
  checked: boolean;
  indeterminate?: boolean;
};

export function Checkbox({
  "aria-label": ariaLabel,
  checked,
  disabled = false,
  indeterminate = false,
  ...props
}: CheckboxProps) {
  return (
    <CheckboxPrimitive.Root
      aria-label={ariaLabel}
      checked={checked}
      disabled={disabled}
      indeterminate={indeterminate}
      nativeButton
      render={<button type="button" aria-label={ariaLabel} />}
      {...stylex.props(
        styles.root,
        (checked || indeterminate) && styles.selected,
        disabled && styles.disabled,
      )}
      {...props}
    >
      <CheckboxPrimitive.Indicator keepMounted {...stylex.props(styles.indicator)}>
        {indeterminate ? (
          <Minus size={13} strokeWidth={2.5} aria-hidden="true" />
        ) : checked ? (
          <Check size={13} strokeWidth={2.5} aria-hidden="true" />
        ) : null}
      </CheckboxPrimitive.Indicator>
    </CheckboxPrimitive.Root>
  );
}

const styles = stylex.create({
  root: {
    alignItems: "center",
    backgroundColor: tokens.surface,
    borderColor: tokens.border,
    borderRadius: 5,
    borderStyle: "solid",
    borderWidth: 1,
    color: tokens.background,
    cursor: "pointer",
    display: "inline-flex",
    flexShrink: 0,
    height: 18,
    justifyContent: "center",
    padding: 0,
    width: 18,
    ":hover": { borderColor: tokens.accent },
    ":focus-visible": {
      outlineColor: tokens.accent,
      outlineOffset: 2,
      outlineStyle: "solid",
      outlineWidth: 2,
    },
  },
  selected: {
    backgroundColor: tokens.accent,
    borderColor: tokens.accent,
  },
  disabled: {
    cursor: "not-allowed",
    opacity: 0.45,
  },
  indicator: {
    alignItems: "center",
    display: "inline-flex",
    justifyContent: "center",
  },
});
