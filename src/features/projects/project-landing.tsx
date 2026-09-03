import { useState, type FormEvent } from "react";
import * as stylex from "@stylexjs/stylex";
import { FolderGit2, MonitorCog, Moon, Sun } from "lucide-react";

import type { ProjectCommandResponse, ThemeCommandResponse } from "../../server/project-adapter";
import type { AppState, Theme } from "../../domain/projects";
import { applyThemeToDocument } from "../../styles/theme";
import { tokens } from "../../styles/tokens.stylex";
import { Button } from "../../components/ui/button";

type ProjectLandingProps = {
  state: AppState;
  onCreateProject: (input: {
    repositoryRoot: string;
    idempotencyKey: string;
  }) => Promise<ProjectCommandResponse>;
  onChangeTheme: (input: { theme: Theme; idempotencyKey: string }) => Promise<ThemeCommandResponse>;
};

export function ProjectLanding({ state, onCreateProject, onChangeTheme }: ProjectLandingProps) {
  const [repositoryRoot, setRepositoryRoot] = useState("");
  const [pending, setPending] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [theme, setTheme] = useState(state.theme);

  async function handleSubmit(event: FormEvent<HTMLFormElement>) {
    event.preventDefault();
    setPending(true);
    setError(null);
    try {
      const response = await onCreateProject({
        repositoryRoot,
        idempotencyKey: crypto.randomUUID(),
      });
      if (!response.ok) setError(response.error.message);
    } catch {
      setError("Helm could not create the project. Check that the local server is running.");
    } finally {
      setPending(false);
    }
  }

  async function handleTheme(nextTheme: Theme) {
    const previousTheme = theme;
    setTheme(nextTheme);
    applyThemeToDocument(nextTheme);
    const response = await onChangeTheme({
      theme: nextTheme,
      idempotencyKey: crypto.randomUUID(),
    });
    if (!response.ok) {
      setTheme(previousTheme);
      applyThemeToDocument(previousTheme);
      setError(response.error.message);
    }
  }

  return (
    <main {...stylex.props(styles.page)}>
      <header {...stylex.props(styles.brand)}>
        <span {...stylex.props(styles.mark)} aria-hidden="true">
          H
        </span>
        <span>Helm</span>
      </header>

      <section {...stylex.props(styles.layout)}>
        <div {...stylex.props(styles.intro)}>
          <p {...stylex.props(styles.eyebrow)}>Local agent work control plane</p>
          <h1 {...stylex.props(styles.title)}>
            {state.activeProject ? state.activeProject.name : "Bring your repository aboard."}
          </h1>
          <p {...stylex.props(styles.copy)}>
            {state.activeProject
              ? "This is the repository currently selected for human and agent work."
              : "Point Helm at one local Git repository. Your work and audit history stay on this machine."}
          </p>
        </div>

        <div {...stylex.props(styles.card)}>
          {state.activeProject ? (
            <div {...stylex.props(styles.projectSummary)}>
              <div {...stylex.props(styles.iconTile)}>
                <FolderGit2 size={22} aria-hidden="true" />
              </div>
              <div>
                <p {...stylex.props(styles.label)}>Active project</p>
                <h2 {...stylex.props(styles.projectName)}>{state.activeProject.name}</h2>
                <p {...stylex.props(styles.path)}>{state.activeProject.repositoryRoot}</p>
              </div>
              <dl {...stylex.props(styles.metadata)}>
                <div>
                  <dt {...stylex.props(styles.metadataTerm)}>Project</dt>
                  <dd {...stylex.props(styles.metadataValue)}>#{state.activeProject.sequence}</dd>
                </div>
                <div>
                  <dt {...stylex.props(styles.metadataTerm)}>Version</dt>
                  <dd {...stylex.props(styles.metadataValue)}>{state.activeProject.version}</dd>
                </div>
              </dl>
            </div>
          ) : (
            <form onSubmit={handleSubmit} aria-label="Create local project">
              <div {...stylex.props(styles.formHeader)}>
                <div {...stylex.props(styles.iconTile)}>
                  <FolderGit2 size={22} aria-hidden="true" />
                </div>
                <div>
                  <h2 {...stylex.props(styles.cardTitle)}>Select a repository</h2>
                  <p {...stylex.props(styles.cardCopy)}>
                    Enter the absolute path to its root folder.
                  </p>
                </div>
              </div>
              <label htmlFor="repository-root" {...stylex.props(styles.inputLabel)}>
                Repository root
              </label>
              <input
                id="repository-root"
                name="repositoryRoot"
                value={repositoryRoot}
                onChange={(event) => setRepositoryRoot(event.target.value)}
                placeholder="/Users/you/projects/example"
                autoComplete="off"
                spellCheck={false}
                required
                {...stylex.props(styles.input)}
              />
              <p {...stylex.props(styles.hint)}>
                Helm verifies the folder and its .git entry before writing.
              </p>
              {error ? (
                <p role="alert" {...stylex.props(styles.error)}>
                  {error}
                </p>
              ) : null}
              <Button type="submit" disabled={pending || repositoryRoot.trim().length === 0}>
                {pending ? "Creating…" : "Create project"}
              </Button>
            </form>
          )}
        </div>
      </section>

      <footer {...stylex.props(styles.footer)}>
        <div {...stylex.props(styles.themeLabel)}>
          <MonitorCog size={16} aria-hidden="true" />
          <span>Appearance</span>
        </div>
        <fieldset aria-label="Theme" {...stylex.props(styles.themeGroup)}>
          <ThemeButton
            label="Light"
            selected={theme === "light"}
            onClick={() => handleTheme("light")}
          >
            <Sun size={15} aria-hidden="true" />
          </ThemeButton>
          <ThemeButton label="Dark" selected={theme === "dark"} onClick={() => handleTheme("dark")}>
            <Moon size={15} aria-hidden="true" />
          </ThemeButton>
          <ThemeButton
            label="System"
            selected={theme === "system"}
            onClick={() => handleTheme("system")}
          >
            <MonitorCog size={15} aria-hidden="true" />
          </ThemeButton>
        </fieldset>
      </footer>
    </main>
  );
}

function ThemeButton({
  children,
  label,
  selected,
  onClick,
}: {
  children: React.ReactNode;
  label: string;
  selected: boolean;
  onClick: () => void;
}) {
  return (
    <button
      type="button"
      aria-pressed={selected}
      aria-label={`${label} theme`}
      onClick={onClick}
      {...stylex.props(styles.themeButton, selected && styles.themeButtonSelected)}
    >
      {children}
      <span>{label}</span>
    </button>
  );
}

const styles = stylex.create({
  page: {
    display: "grid",
    gridTemplateRows: "auto 1fr auto",
    minHeight: "100vh",
    padding: tokens.space6,
    "@media (max-width: 600px)": { padding: tokens.space4 },
  },
  brand: {
    alignItems: "center",
    display: "flex",
    fontSize: 15,
    fontWeight: 700,
    gap: tokens.space2,
    letterSpacing: "-0.02em",
  },
  mark: {
    alignItems: "center",
    backgroundColor: tokens.foreground,
    borderRadius: 6,
    color: tokens.background,
    display: "inline-flex",
    fontSize: 12,
    height: 24,
    justifyContent: "center",
    width: 24,
  },
  layout: {
    alignItems: "center",
    display: "grid",
    gap: "clamp(32px, 8vw, 96px)",
    gridTemplateColumns: "minmax(0, 1fr) minmax(340px, 480px)",
    margin: "auto",
    maxWidth: 1080,
    paddingBlock: tokens.space8,
    width: "100%",
    "@media (max-width: 780px)": {
      alignItems: "stretch",
      gridTemplateColumns: "1fr",
      maxWidth: 560,
    },
  },
  intro: { maxWidth: 520 },
  eyebrow: {
    color: tokens.accent,
    fontSize: 12,
    fontWeight: 750,
    letterSpacing: "0.1em",
    margin: 0,
    textTransform: "uppercase",
  },
  title: {
    fontSize: "clamp(2.75rem, 7vw, 5.75rem)",
    fontWeight: 700,
    letterSpacing: "-0.065em",
    lineHeight: 0.94,
    marginBlock: tokens.space4,
  },
  copy: {
    color: tokens.foregroundMuted,
    fontSize: 17,
    lineHeight: 1.65,
    margin: 0,
    maxWidth: 500,
  },
  card: {
    backgroundColor: tokens.surface,
    borderColor: tokens.border,
    borderRadius: tokens.radius3,
    borderStyle: "solid",
    borderWidth: 1,
    boxShadow: tokens.shadow,
    padding: tokens.space7,
    "@media (max-width: 520px)": { padding: tokens.space5 },
  },
  formHeader: {
    alignItems: "center",
    display: "flex",
    gap: tokens.space3,
    marginBlockEnd: tokens.space7,
  },
  iconTile: {
    alignItems: "center",
    backgroundColor: tokens.surfaceMuted,
    borderRadius: tokens.radius2,
    color: tokens.accent,
    display: "flex",
    flexShrink: 0,
    height: 44,
    justifyContent: "center",
    width: 44,
  },
  cardTitle: { fontSize: 18, letterSpacing: "-0.025em", margin: 0 },
  cardCopy: { color: tokens.foregroundMuted, fontSize: 13, marginBlock: 3, marginInline: 0 },
  inputLabel: { display: "block", fontSize: 13, fontWeight: 700, marginBlockEnd: tokens.space2 },
  input: {
    backgroundColor: tokens.background,
    borderColor: tokens.border,
    borderRadius: tokens.radius2,
    borderStyle: "solid",
    borderWidth: 1,
    color: tokens.foreground,
    fontFamily: "ui-monospace, SFMono-Regular, Menlo, monospace",
    fontSize: 13,
    minHeight: 44,
    outline: "none",
    paddingInline: tokens.space3,
    width: "100%",
    ":focus": {
      borderColor: tokens.accent,
      boxShadow: "0 0 0 3px color-mix(in srgb, currentColor 10%, transparent)",
    },
  },
  hint: {
    color: tokens.foregroundMuted,
    fontSize: 12,
    lineHeight: 1.5,
    marginBlockEnd: tokens.space5,
    marginBlockStart: tokens.space2,
  },
  error: {
    color: tokens.danger,
    fontSize: 13,
    lineHeight: 1.45,
    marginBlockEnd: tokens.space4,
    marginBlockStart: 0,
  },
  projectSummary: { display: "grid", gap: tokens.space5 },
  label: {
    color: tokens.foregroundMuted,
    fontSize: 12,
    fontWeight: 700,
    letterSpacing: "0.08em",
    margin: 0,
    textTransform: "uppercase",
  },
  projectName: { fontSize: 28, letterSpacing: "-0.04em", marginBlock: tokens.space2 },
  path: {
    color: tokens.foregroundMuted,
    fontFamily: "ui-monospace, SFMono-Regular, Menlo, monospace",
    fontSize: 12,
    margin: 0,
    overflowWrap: "anywhere",
  },
  metadata: {
    borderBlockStartColor: tokens.border,
    borderBlockStartStyle: "solid",
    borderBlockStartWidth: 1,
    display: "flex",
    gap: tokens.space8,
    margin: 0,
    paddingBlockStart: tokens.space4,
  },
  metadataTerm: { color: tokens.foregroundMuted, fontSize: 11, textTransform: "uppercase" },
  metadataValue: { fontSize: 14, fontWeight: 700, margin: 0 },
  footer: {
    alignItems: "center",
    borderBlockStartColor: tokens.border,
    borderBlockStartStyle: "solid",
    borderBlockStartWidth: 1,
    display: "flex",
    justifyContent: "space-between",
    paddingBlockStart: tokens.space4,
    "@media (max-width: 520px)": {
      alignItems: "stretch",
      flexDirection: "column",
      gap: tokens.space3,
    },
  },
  themeLabel: {
    alignItems: "center",
    color: tokens.foregroundMuted,
    display: "flex",
    fontSize: 12,
    gap: tokens.space2,
  },
  themeGroup: { borderWidth: 0, display: "flex", gap: tokens.space1, margin: 0, padding: 0 },
  themeButton: {
    alignItems: "center",
    backgroundColor: "transparent",
    borderColor: "transparent",
    borderRadius: 6,
    borderStyle: "solid",
    borderWidth: 1,
    color: tokens.foregroundMuted,
    cursor: "pointer",
    display: "flex",
    fontSize: 12,
    gap: 6,
    minHeight: 32,
    paddingInline: tokens.space2,
    ":hover": { color: tokens.foreground },
    ":focus-visible": {
      outlineColor: tokens.accent,
      outlineOffset: 2,
      outlineStyle: "solid",
      outlineWidth: 2,
    },
  },
  themeButtonSelected: {
    backgroundColor: tokens.surfaceMuted,
    borderColor: tokens.border,
    color: tokens.foreground,
  },
});
