import { useState } from "react";
import * as stylex from "@stylexjs/stylex";

import {
  projectReviewModeSchema,
  type Project,
  type SetProjectReviewModeInput,
} from "../../domain/projects";
import type { ProjectCommandResponse } from "../../server/project-adapter";
import { tokens } from "../../styles/tokens.stylex";

export function ProjectReviewModeControl({
  project,
  onChange,
}: {
  project: Project;
  onChange: (input: SetProjectReviewModeInput) => Promise<ProjectCommandResponse>;
}) {
  const [selectedMode, setSelectedMode] = useState(project.reviewMode);
  const [pending, setPending] = useState(false);
  const [error, setError] = useState<string | null>(null);

  async function changeReviewMode(value: string) {
    const reviewMode = projectReviewModeSchema.parse(value);
    const previousMode = selectedMode;
    setSelectedMode(reviewMode);
    setPending(true);
    setError(null);
    try {
      const response = await onChange({
        projectId: project.id,
        reviewMode,
        expectedVersion: project.version,
        idempotencyKey: crypto.randomUUID(),
      });
      if (response.ok) setSelectedMode(response.project.reviewMode);
      else {
        setSelectedMode(previousMode);
        setError(response.error.message);
      }
    } catch {
      setSelectedMode(previousMode);
      setError("Helm could not change the project review mode.");
    } finally {
      setPending(false);
    }
  }

  return (
    <section
      aria-label="Project completion policy"
      aria-busy={pending}
      {...stylex.props(styles.root)}
    >
      <label htmlFor={`review-mode-${project.id}`} {...stylex.props(styles.label)}>
        Agent completion
      </label>
      <select
        id={`review-mode-${project.id}`}
        aria-describedby={`review-mode-help-${project.id}`}
        value={selectedMode}
        disabled={pending}
        onChange={(event) => void changeReviewMode(event.target.value)}
        {...stylex.props(styles.select)}
      >
        <option value="required">Require human review</option>
        <option value="direct">Mark done after report</option>
      </select>
      <p id={`review-mode-help-${project.id}`} {...stylex.props(styles.hint)}>
        Agent reports either wait for approval or move directly to Done.
      </p>
      <span aria-live="polite" {...stylex.props(styles.status)}>
        {pending ? "Saving review mode…" : null}
      </span>
      {error ? (
        <p role="alert" {...stylex.props(styles.error)}>
          {error}
        </p>
      ) : null}
    </section>
  );
}

const styles = stylex.create({
  root: {
    backgroundColor: tokens.surfaceMuted,
    borderRadius: tokens.radius2,
    display: "grid",
    gap: tokens.space1,
    marginBlockEnd: tokens.space4,
    padding: tokens.space3,
  },
  label: { fontSize: 12, fontWeight: 700 },
  select: {
    backgroundColor: tokens.surface,
    borderColor: tokens.border,
    borderRadius: 6,
    borderStyle: "solid",
    borderWidth: 1,
    color: tokens.foreground,
    minHeight: 36,
    paddingInline: tokens.space2,
    width: "100%",
    ":focus-visible": {
      outlineColor: tokens.accent,
      outlineOffset: 1,
      outlineStyle: "solid",
      outlineWidth: 2,
    },
  },
  hint: { color: tokens.foregroundMuted, fontSize: 11, lineHeight: 1.45, margin: 0 },
  status: { color: tokens.foregroundMuted, fontSize: 11, minHeight: 16 },
  error: { color: tokens.danger, fontSize: 12, margin: 0 },
});
