import type { ReactNode } from "react";
import { Link } from "@tanstack/react-router";
import * as stylex from "@stylexjs/stylex";
import { ShipWheel } from "lucide-react";
import { tokens } from "../styles/tokens.stylex";
import { emptyTaskSearchParams } from "../features/tasks/task-search-route-params";
import type { WorkspaceView } from "../features/projects/workspace-search";

const workspacePaths = {
  tasks: "/$projectId/tasks",
  dashboard: "/$projectId/dashboard",
  activity: "/$projectId/activity",
  settings: "/$projectId/settings",
  search: "/$projectId/search",
} as const;

export function ProjectNavigation({
  projectId,
  current,
}: {
  projectId: string;
  current: WorkspaceView | "search";
}) {
  return (
    <nav aria-label="Project navigation" {...stylex.props(styles.navigation)}>
      {(["dashboard", "tasks", "activity", "settings", "search"] as const).map((view) => (
        <Link
          key={view}
          to={workspacePaths[view]}
          params={{ projectId }}
          search={view === "search" ? emptyTaskSearchParams : {}}
          aria-current={current === view ? "page" : undefined}
          {...stylex.props(styles.navItem, current === view && styles.active)}
        >
          {view.charAt(0).toUpperCase() + view.slice(1)}
        </Link>
      ))}
    </nav>
  );
}

export function AppHeader({
  projectName,
  navigation,
  utilities,
  projectControl,
}: {
  projectName: string;
  navigation: ReactNode;
  utilities?: ReactNode;
  projectControl?: ReactNode;
}) {
  return (
    <header aria-label="Project header" {...stylex.props(styles.header)}>
      <div {...stylex.props(styles.brand)}>
        <span {...stylex.props(styles.mark)} aria-hidden="true">
          <ShipWheel size={16} />
        </span>
        <strong>Helm</strong>
        {projectControl ?? <span {...stylex.props(styles.projectName)}>{projectName}</span>}
      </div>
      {navigation}
      <div {...stylex.props(styles.utilities)}>{utilities}</div>
    </header>
  );
}

const styles = stylex.create({
  header: {
    display: "flex",
    alignItems: "center",
    justifyContent: "space-between",
    flexWrap: "wrap",
    gap: tokens.space3,
    padding: "12px 20px",
    borderBlockEnd: `1px solid ${tokens.border}`,
    backgroundColor: tokens.background,
    minHeight: 64,
  },
  brand: { display: "flex", alignItems: "center", gap: tokens.space2, minWidth: 0, fontSize: 15 },
  mark: {
    display: "inline-flex",
    alignItems: "center",
    justifyContent: "center",
    borderRadius: tokens.radius2,
    width: 28,
    height: 28,
    backgroundColor: tokens.foreground,
    color: tokens.background,
  },
  projectName: {
    color: tokens.foregroundMuted,
    fontSize: 13,
    maxWidth: 180,
    overflow: "hidden",
    textOverflow: "ellipsis",
    whiteSpace: "nowrap",
  },
  navigation: {
    display: "flex",
    alignItems: "center",
    flexWrap: "wrap",
    gap: tokens.space1,
    "@media (max-width: 760px)": { order: 3, width: "100%" },
  },
  navItem: {
    display: "inline-flex",
    alignItems: "center",
    justifyContent: "center",
    minHeight: 36,
    padding: "6px 6px",
    fontSize: 13,
    fontWeight: 650,
    lineHeight: "20px",
    textDecoration: "none",
    color: tokens.foregroundMuted,
    borderRadius: tokens.radius2,
    ":hover": { backgroundColor: tokens.surface },
    ":focus-visible": { outline: `2px solid ${tokens.accent}`, outlineOffset: 2 },
  },
  active: { backgroundColor: tokens.surface, color: tokens.foreground },
  utilities: { display: "flex", alignItems: "center", gap: tokens.space2, flexWrap: "wrap" },
});
