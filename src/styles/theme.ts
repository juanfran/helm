import * as stylex from "@stylexjs/stylex";

import type { Theme } from "../domain/projects";
import { darkTheme, lightTheme } from "./tokens.stylex";

const schemes = stylex.create({
  light: { colorScheme: "light" },
  dark: { colorScheme: "dark" },
  system: { colorScheme: "light dark" },
});

export function getThemeProps(theme: Theme) {
  if (theme === "light") return stylex.props(lightTheme, schemes.light);
  if (theme === "dark") return stylex.props(darkTheme, schemes.dark);
  return stylex.props(schemes.system);
}

export function applyThemeToDocument(theme: Theme) {
  const root = document.documentElement;
  for (const candidate of ["light", "dark", "system"] as const) {
    const className = getThemeProps(candidate).className;
    if (className) root.classList.remove(...className.split(" "));
  }
  const className = getThemeProps(theme).className;
  if (className) root.classList.add(...className.split(" "));
  root.dataset.theme = theme;
}
