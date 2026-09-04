// @vitest-environment jsdom

import { cleanup, render, screen, waitFor } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { afterEach, describe, expect, it, vi } from "vitest";

import { applyThemeOptimistically, applyThemeToDocument } from "../../styles/theme";
import { ThemeControl } from "./theme-control";

afterEach(() => {
  cleanup();
  document.documentElement.className = "";
  delete document.documentElement.dataset.theme;
});

describe("theme control", () => {
  it("offers every persisted theme and reports the selected value", async () => {
    const user = userEvent.setup();
    const onChange = vi.fn(async () => undefined);
    render(<ThemeControl theme="system" onChange={onChange} />);

    const select = screen.getByRole("combobox", { name: "Appearance" });
    expect(Array.from(select.querySelectorAll("option"), (option) => option.value)).toEqual([
      "system",
      "light",
      "dark",
    ]);

    await user.selectOptions(select, "dark");
    await waitFor(() => expect(onChange).toHaveBeenCalledWith("dark"));
  });

  it("rolls the selection back and exposes an accessible error when persistence fails", async () => {
    const user = userEvent.setup();
    applyThemeToDocument("light");
    const previousClassName = document.documentElement.className;
    render(
      <ThemeControl
        theme="light"
        onChange={(nextTheme) =>
          applyThemeOptimistically({
            previousTheme: "light",
            nextTheme,
            persist: async () => {
              throw new Error("offline");
            },
          })
        }
      />,
    );

    const select = screen.getByRole("combobox", { name: "Appearance" });
    await user.selectOptions(select, "dark");

    await waitFor(() => expect(select).toHaveProperty("value", "light"));
    expect(screen.getByRole("alert").textContent).toContain("could not save");
    expect(document.documentElement.dataset.theme).toBe("light");
    expect(document.documentElement.className).toBe(previousClassName);
  });
});
