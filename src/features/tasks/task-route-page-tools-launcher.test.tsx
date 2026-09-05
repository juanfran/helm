// @vitest-environment jsdom

import { StrictMode } from "react";
import { act, cleanup, fireEvent, render, screen, waitFor } from "@testing-library/react";
import { afterEach, describe, expect, it, vi } from "vitest";

import type { Project } from "../../domain/projects";
import {
  createTaskRoutePageToolsLauncher,
  type TaskRoutePageToolsProps,
} from "./task-route-page-tools-launcher";

afterEach(cleanup);

const activeProject: Project = {
  id: "project-1",
  sequence: 1,
  name: "Atlas",
  repositoryRoot: "/projects/atlas",
  reviewMode: "required",
  version: 2,
  createdAt: "2026-09-04T10:00:00.000Z",
  updatedAt: "2026-09-04T10:00:00.000Z",
};

const props: TaskRoutePageToolsProps = {
  projects: [activeProject],
  activeProject,
  activeProjectVersion: 3,
  theme: "system",
  tasks: [],
};

function LoadedTools({ activeProject: project }: TaskRoutePageToolsProps) {
  return <p>{project.name} project tools ready</p>;
}

describe("TaskRoutePageToolsLauncher", () => {
  it("does not import on mount, preloads on intent, and activates only on click", async () => {
    let resolveModule: ((module: { TaskRoutePageTools: typeof LoadedTools }) => void) | undefined;
    const loadModule = vi.fn(
      () =>
        new Promise<{ TaskRoutePageTools: typeof LoadedTools }>((resolve) => {
          resolveModule = resolve;
        }),
    );
    const Launcher = createTaskRoutePageToolsLauncher(loadModule);
    render(<Launcher {...props} />);

    expect(loadModule).not.toHaveBeenCalled();
    expect(screen.getByText("Atlas")).toBeTruthy();
    const activate = screen.getByRole("button", { name: "Switch project" });

    activate.focus();
    await waitFor(() => expect(loadModule).toHaveBeenCalledTimes(1));
    expect(screen.queryByText("Loading project tools…")).toBeNull();
    fireEvent.click(activate);
    expect(await screen.findByText("Loading project tools…")).toBeTruthy();
    expect(
      screen.getByRole("button", { name: "Switch project" }).getAttribute("aria-expanded"),
    ).toBe("true");

    await act(async () => resolveModule?.({ TaskRoutePageTools: LoadedTools }));
    expect(await screen.findByText("Atlas project tools ready")).toBeTruthy();
    expect(
      screen.getByRole("button", { name: "Switch project" }).getAttribute("aria-expanded"),
    ).toBe("true");
  });

  it("contains an activated failure and retries with a fresh import", async () => {
    const loadModule = vi
      .fn<() => Promise<{ TaskRoutePageTools: typeof LoadedTools }>>()
      .mockRejectedValueOnce(new Error("chunk unavailable"))
      .mockResolvedValueOnce({ TaskRoutePageTools: LoadedTools });
    const Launcher = createTaskRoutePageToolsLauncher(loadModule);
    render(<Launcher {...props} />);

    const trigger = screen.getByRole("button", { name: "Switch project" });
    trigger.focus();
    fireEvent.click(trigger);
    expect(await screen.findByRole("alert")).toHaveProperty(
      "textContent",
      expect.stringContaining("could not be loaded"),
    );
    expect(screen.getByText("Atlas")).toBeTruthy();
    expect(
      screen.getByRole("button", { name: "Switch project" }).getAttribute("aria-expanded"),
    ).toBe("true");

    fireEvent.click(screen.getByRole("button", { name: "Try project tools again" }));
    expect(await screen.findByText("Atlas project tools ready")).toBeTruthy();
    expect(loadModule).toHaveBeenCalledTimes(2);
    fireEvent.click(screen.getByRole("button", { name: "Close project switcher" }));
    await waitFor(() =>
      expect(
        screen.getByRole("button", { name: "Switch project" }).getAttribute("aria-expanded"),
      ).toBe("false"),
    );
    await waitFor(() =>
      expect(document.activeElement).toBe(screen.getByRole("button", { name: "Switch project" })),
    );
  });

  it("remains activatable after the StrictMode effect cleanup cycle", async () => {
    const loadModule = vi
      .fn<() => Promise<{ TaskRoutePageTools: typeof LoadedTools }>>()
      .mockResolvedValue({ TaskRoutePageTools: LoadedTools });
    const Launcher = createTaskRoutePageToolsLauncher(loadModule);
    render(
      <StrictMode>
        <Launcher {...props} />
      </StrictMode>,
    );

    expect(loadModule).not.toHaveBeenCalled();
    fireEvent.click(screen.getByRole("button", { name: "Switch project" }));

    expect(await screen.findByText("Atlas project tools ready")).toBeTruthy();
    expect(loadModule).toHaveBeenCalledTimes(1);
  });
});
