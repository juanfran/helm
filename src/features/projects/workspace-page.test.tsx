// @vitest-environment jsdom

import { cleanup, fireEvent, render, screen, waitFor } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { afterEach, describe, expect, it, vi } from "vitest";

import { createRetryableLazyModuleLoader } from "../../components/retryable-lazy-module";
import type { ProjectDataManagementControlProps } from "./project-data-management-control";
import { ProjectLandingDataManagementIntent } from "./workspace-page";

afterEach(cleanup);

function DataManagementControl(_props: ProjectDataManagementControlProps) {
  return <section aria-label="Project data management">Import controls</section>;
}

describe("first-run project data management intent", () => {
  it.each([
    ["keyboard focus", (button: HTMLElement) => fireEvent.focus(button)],
    ["pointer hover", (button: HTMLElement) => fireEvent.pointerEnter(button)],
  ])("stays idle until %s preloads without revealing the surface", async (_label, signalIntent) => {
    const loadModule = vi.fn(async () => ({ default: DataManagementControl }));
    const moduleLoader = createRetryableLazyModuleLoader(loadModule);
    render(<ProjectLandingDataManagementIntent moduleLoader={moduleLoader} onComplete={vi.fn()} />);

    const intent = screen.getByRole("button", { name: "Import project data" });
    expect(loadModule).not.toHaveBeenCalled();
    expect(screen.queryByRole("region", { name: "Project data management" })).toBeNull();

    signalIntent(intent);
    await waitFor(() => expect(loadModule).toHaveBeenCalledTimes(1));
    expect(screen.queryByRole("region", { name: "Project data management" })).toBeNull();

    intent.focus();
    fireEvent.click(intent);
    expect(intent.getAttribute("aria-disabled")).toBe("true");
    expect(intent.getAttribute("aria-expanded")).toBe("true");
    expect(document.activeElement).toBe(intent);
    expect(await screen.findByRole("region", { name: "Project data management" })).toBeTruthy();
    expect(document.activeElement).toBe(intent);
  });

  it("shows a failed activation and retries with a fresh import", async () => {
    const loadModule = vi
      .fn<() => Promise<{ default: typeof DataManagementControl }>>()
      .mockRejectedValueOnce(new Error("Data management chunk unavailable"))
      .mockResolvedValueOnce({ default: DataManagementControl });
    const moduleLoader = createRetryableLazyModuleLoader(loadModule);
    render(<ProjectLandingDataManagementIntent moduleLoader={moduleLoader} onComplete={vi.fn()} />);

    const intent = screen.getByRole("button", { name: "Import project data" });
    intent.focus();
    fireEvent.click(intent);
    expect(await screen.findByRole("alert", { name: "Data management unavailable" })).toBeTruthy();
    expect(document.activeElement).toBe(intent);

    await userEvent.click(screen.getByRole("button", { name: "Retry" }));
    expect(await screen.findByRole("region", { name: "Project data management" })).toBeTruthy();
    expect(loadModule).toHaveBeenCalledTimes(2);
  });
});
