import { useState } from "react";
import * as stylex from "@stylexjs/stylex";

import { themeSchema, type Theme } from "../../domain/projects";
import { tokens } from "../../styles/tokens.stylex";

export function ThemeControl({
  theme,
  onChange,
}: {
  theme: Theme;
  onChange: (theme: Theme) => Promise<void>;
}) {
  return <ThemeControlState key={theme} theme={theme} onChange={onChange} />;
}

function ThemeControlState({
  theme,
  onChange,
}: {
  theme: Theme;
  onChange: (theme: Theme) => Promise<void>;
}) {
  const [value, setValue] = useState(theme);
  const [pending, setPending] = useState(false);
  const [error, setError] = useState<string | null>(null);

  async function changeTheme(nextTheme: Theme) {
    if (nextTheme === value || pending) return;
    const previous = value;
    setValue(nextTheme);
    setPending(true);
    setError(null);
    try {
      await onChange(nextTheme);
    } catch {
      setValue(previous);
      setError("Helm could not save the appearance setting.");
    } finally {
      setPending(false);
    }
  }

  return (
    <div {...stylex.props(styles.root)}>
      <label {...stylex.props(styles.control)}>
        <span>Appearance</span>
        <select
          aria-label="Appearance"
          value={value}
          disabled={pending}
          onChange={(event) => void changeTheme(themeSchema.parse(event.target.value))}
          {...stylex.props(styles.select)}
        >
          <option value="system">System</option>
          <option value="light">Light</option>
          <option value="dark">Dark</option>
        </select>
      </label>
      <span aria-live="polite" {...stylex.props(styles.status)}>
        {pending ? "Saving appearance…" : null}
      </span>
      {error ? (
        <span role="alert" {...stylex.props(styles.error)}>
          {error}
        </span>
      ) : null}
    </div>
  );
}

const styles = stylex.create({
  root: {
    alignItems: "end",
    display: "grid",
    gap: tokens.space1,
  },
  control: {
    alignItems: "center",
    color: tokens.foregroundMuted,
    display: "flex",
    fontSize: 12,
    gap: tokens.space2,
  },
  select: {
    backgroundColor: tokens.surface,
    borderColor: tokens.border,
    borderRadius: 6,
    color: tokens.foreground,
    minHeight: 32,
    ":focus-visible": {
      outlineColor: tokens.accent,
      outlineOffset: 2,
      outlineStyle: "solid",
      outlineWidth: 2,
    },
  },
  status: {
    color: tokens.foregroundMuted,
    fontSize: 10,
    minHeight: 12,
    textAlign: "end",
  },
  error: {
    color: tokens.danger,
    fontSize: 11,
    maxWidth: 240,
  },
});
