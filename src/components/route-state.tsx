import * as stylex from "@stylexjs/stylex";

import { tokens } from "../styles/tokens.stylex";
import { ActionButton as Button } from "./ui/action-button";

export type RoutePendingStateProps = {
  label?: string;
};

export function RoutePendingState({ label = "Loading this view…" }: RoutePendingStateProps) {
  return (
    <output aria-busy="true" aria-live="polite" {...stylex.props(styles.root)}>
      <span aria-hidden="true" {...stylex.props(styles.indicator)} />
      <span {...stylex.props(styles.message)}>{label}</span>
    </output>
  );
}

export type RouteErrorStateProps = {
  error: unknown;
  onRetry: () => void | Promise<void>;
  title?: string;
};

export function RouteErrorState({
  error,
  onRetry,
  title = "This view could not be loaded",
}: RouteErrorStateProps) {
  return (
    <section role="alert" {...stylex.props(styles.root, styles.error)}>
      <div {...stylex.props(styles.copy)}>
        <h2 {...stylex.props(styles.title)}>{title}</h2>
        <p {...stylex.props(styles.message)}>{errorMessage(error)}</p>
      </div>
      <Button type="button" variant="quiet" onClick={() => void onRetry()}>
        Try again
      </Button>
    </section>
  );
}

function errorMessage(error: unknown) {
  if (error instanceof Error && error.message.trim()) return error.message;
  if (typeof error === "string" && error.trim()) return error;
  return "An unexpected error interrupted this view.";
}

const styles = stylex.create({
  root: {
    alignItems: "center",
    backgroundColor: tokens.surface,
    borderColor: tokens.border,
    borderRadius: tokens.radius3,
    borderStyle: "solid",
    borderWidth: 1,
    color: tokens.foreground,
    display: "flex",
    gap: tokens.space3,
    justifyContent: "center",
    margin: tokens.space6,
    minHeight: 96,
    padding: tokens.space5,
  },
  error: {
    borderColor: tokens.danger,
    flexWrap: "wrap",
    justifyContent: "space-between",
  },
  indicator: {
    backgroundColor: tokens.accent,
    borderRadius: "50%",
    flex: "0 0 auto",
    height: 8,
    width: 8,
  },
  copy: {
    display: "grid",
    gap: tokens.space1,
  },
  title: {
    fontSize: 15,
    margin: 0,
  },
  message: {
    color: tokens.foregroundMuted,
    fontSize: 13,
    margin: 0,
  },
});
