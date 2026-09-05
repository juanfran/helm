import { Button as ButtonPrimitive } from "@base-ui/react/button";
import * as stylex from "@stylexjs/stylex";

import { buttonStyles as styles } from "./button.styles";

type ButtonProps = Omit<ButtonPrimitive.Props, "className"> & {
  variant?: "primary" | "quiet" | "danger";
};

export function Button({ variant = "primary", ...props }: ButtonProps) {
  return <ButtonPrimitive {...stylex.props(styles.root, styles[variant])} {...props} />;
}
