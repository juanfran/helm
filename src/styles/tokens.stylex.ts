import * as stylex from "@stylexjs/stylex";

const DARK = "@media (prefers-color-scheme: dark)";

export const tokens = stylex.defineVars({
  accent: {
    default: "#386641",
    [DARK]: "#91c69a",
  },
  background: {
    default: "#f4f5f1",
    [DARK]: "#101310",
  },
  border: {
    default: "#d8ddd4",
    [DARK]: "#30372f",
  },
  foreground: {
    default: "#172019",
    [DARK]: "#edf2eb",
  },
  foregroundMuted: {
    default: "#59635a",
    [DARK]: "#aeb7ac",
  },
  danger: {
    default: "#9f2d24",
    [DARK]: "#ff9b91",
  },
  overlay: {
    default: "rgb(7 12 8 / 56%)",
    [DARK]: "rgb(0 0 0 / 68%)",
  },
  surfaceMuted: {
    default: "#eef0eb",
    [DARK]: "#222822",
  },
  surface: {
    default: "#ffffff",
    [DARK]: "#191d19",
  },
  radius2: "8px",
  radius3: "12px",
  shadow: {
    default: "0 16px 48px rgb(23 32 25 / 8%)",
    [DARK]: "0 16px 48px rgb(0 0 0 / 24%)",
  },
  space1: "4px",
  space2: "8px",
  space3: "12px",
  space4: "16px",
  space5: "20px",
  space6: "24px",
  space7: "32px",
  space8: "40px",
});

export const lightTheme = stylex.createTheme(tokens, {
  accent: "#386641",
  background: "#f4f5f1",
  border: "#d8ddd4",
  danger: "#9f2d24",
  foreground: "#172019",
  foregroundMuted: "#59635a",
  overlay: "rgb(7 12 8 / 56%)",
  surface: "#ffffff",
  surfaceMuted: "#eef0eb",
  shadow: "0 16px 48px rgb(23 32 25 / 8%)",
});

export const darkTheme = stylex.createTheme(tokens, {
  accent: "#91c69a",
  background: "#101310",
  border: "#30372f",
  danger: "#ff9b91",
  foreground: "#edf2eb",
  foregroundMuted: "#aeb7ac",
  overlay: "rgb(0 0 0 / 68%)",
  surface: "#191d19",
  surfaceMuted: "#222822",
  shadow: "0 16px 48px rgb(0 0 0 / 24%)",
});
