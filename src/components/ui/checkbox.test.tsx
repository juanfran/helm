// @vitest-environment jsdom

import { cleanup, render, screen } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { afterEach, describe, expect, it, vi } from "vitest";

import { Checkbox } from "./checkbox";

afterEach(cleanup);

describe("Checkbox", () => {
  it("exposes controlled checked and indeterminate states", () => {
    const { rerender } = render(
      <Checkbox aria-label="Select visible tasks" checked={false} onCheckedChange={vi.fn()} />,
    );
    const checkbox = screen.getByRole("checkbox", { name: "Select visible tasks" });
    expect(checkbox.getAttribute("aria-checked")).toBe("false");

    rerender(
      <Checkbox
        aria-label="Select visible tasks"
        checked={false}
        indeterminate
        onCheckedChange={vi.fn()}
      />,
    );
    expect(checkbox.getAttribute("aria-checked")).toBe("mixed");

    rerender(<Checkbox aria-label="Select visible tasks" checked onCheckedChange={vi.fn()} />);
    expect(checkbox.getAttribute("aria-checked")).toBe("true");
  });

  it("reports user changes and ignores interaction while disabled", async () => {
    const user = userEvent.setup();
    const onCheckedChange = vi.fn();
    const { rerender } = render(
      <Checkbox aria-label="Select task #12" checked={false} onCheckedChange={onCheckedChange} />,
    );

    await user.click(screen.getByRole("checkbox", { name: "Select task #12" }));
    expect(onCheckedChange).toHaveBeenCalledWith(true, expect.any(Object));

    onCheckedChange.mockClear();
    rerender(
      <Checkbox
        aria-label="Select task #12"
        checked={false}
        disabled
        onCheckedChange={onCheckedChange}
      />,
    );
    await user.click(screen.getByRole("checkbox", { name: "Select task #12" }));
    expect(onCheckedChange).not.toHaveBeenCalled();
  });
});
