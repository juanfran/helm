import { createFileRoute } from "@tanstack/react-router";
import * as stylex from "@stylexjs/stylex";

import { tokens } from "../styles/tokens.stylex";

export const Route = createFileRoute("/")({ component: Home });

function Home() {
  return (
    <main {...stylex.props(styles.page)}>
      <section {...stylex.props(styles.panel)}>
        <p {...stylex.props(styles.eyebrow)}>Local agent work control plane</p>
        <h1 {...stylex.props(styles.title)}>Helm foundation</h1>
        <p {...stylex.props(styles.copy)}>
          The technical foundation is configured. Product behavior will land as reviewed vertical
          slices.
        </p>
        <dl {...stylex.props(styles.stack)}>
          <StackItem label="Runtime" value="TanStack Start" />
          <StackItem label="Data" value="TanStack DB + SQLite" />
          <StackItem label="Backend" value="Effect + Drizzle" />
          <StackItem label="Interface" value="Base UI + StyleX" />
        </dl>
      </section>
    </main>
  );
}

function StackItem({ label, value }: { label: string; value: string }) {
  return (
    <div {...stylex.props(styles.stackItem)}>
      <dt {...stylex.props(styles.term)}>{label}</dt>
      <dd {...stylex.props(styles.value)}>{value}</dd>
    </div>
  );
}

const styles = stylex.create({
  page: {
    alignItems: "center",
    display: "flex",
    justifyContent: "center",
    minHeight: "100vh",
    padding: tokens.space6,
  },
  panel: {
    backgroundColor: tokens.surface,
    borderColor: tokens.border,
    borderRadius: tokens.radius3,
    borderStyle: "solid",
    borderWidth: 1,
    boxShadow: tokens.shadow,
    maxWidth: 680,
    padding: tokens.space8,
    width: "100%",
    "@media (max-width: 520px)": {
      padding: tokens.space5,
    },
  },
  eyebrow: {
    color: tokens.accent,
    fontSize: 12,
    fontWeight: 700,
    letterSpacing: "0.08em",
    marginBlock: 0,
    textTransform: "uppercase",
  },
  title: {
    fontSize: "clamp(2rem, 8vw, 3.5rem)",
    letterSpacing: "-0.045em",
    lineHeight: 1,
    marginBlockEnd: tokens.space4,
    marginBlockStart: tokens.space3,
  },
  copy: {
    color: tokens.foregroundMuted,
    fontSize: 17,
    lineHeight: 1.6,
    marginBlock: 0,
    maxWidth: 560,
  },
  stack: {
    borderBlockStartColor: tokens.border,
    borderBlockStartStyle: "solid",
    borderBlockStartWidth: 1,
    display: "grid",
    gap: tokens.space3,
    marginBlockEnd: 0,
    marginBlockStart: tokens.space7,
    paddingBlockStart: tokens.space5,
  },
  stackItem: {
    alignItems: "baseline",
    display: "grid",
    gap: tokens.space4,
    gridTemplateColumns: "minmax(84px, 0.35fr) 1fr",
  },
  term: {
    color: tokens.foregroundMuted,
    fontSize: 13,
  },
  value: {
    fontSize: 14,
    fontWeight: 600,
    margin: 0,
  },
});
