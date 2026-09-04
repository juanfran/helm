// @vitest-environment jsdom

import { cleanup, render, screen, waitFor } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { afterEach, describe, expect, it, vi } from "vitest";

import type { AppState } from "../../domain/projects";
import { ProjectLanding } from "./project-landing";

const emptyState: AppState = {
  activeProject: null,
  activeProjectVersion: 0,
  theme: "system",
};

afterEach(() => {
  cleanup();
  document.documentElement.className = "";
  delete document.documentElement.dataset.theme;
});

describe("project setup UI", () => {
  it("keeps JSON restore reachable before a project exists", () => {
    render(
      <ProjectLanding
        state={emptyState}
        portabilityControl={<section aria-label="Restore project export">Restore controls</section>}
        onCreateProject={vi.fn()}
        onChangeTheme={vi.fn()}
      />,
    );

    expect(screen.getByRole("form", { name: "Create local project" })).toBeTruthy();
    expect(screen.getByRole("region", { name: "Restore project export" })).toBeTruthy();
  });

  it("submits the repository root and displays a typed validation error", async () => {
    const user = userEvent.setup();
    const onCreateProject = vi.fn().mockResolvedValue({
      ok: false,
      error: {
        type: "InvalidRepositoryRootError",
        reason: "missing",
        path: "/missing",
        message: "That repository path does not exist.",
      },
    });

    render(
      <ProjectLanding
        state={emptyState}
        onCreateProject={onCreateProject}
        onChangeTheme={vi.fn().mockResolvedValue({ ok: true, state: emptyState })}
      />,
    );
    await user.type(screen.getByLabelText("Repository root"), "/missing");
    await user.click(screen.getByRole("button", { name: "Create project" }));

    expect(onCreateProject).toHaveBeenCalledWith({
      repositoryRoot: "/missing",
      idempotencyKey: expect.any(String),
    });
    expect(screen.getByRole("alert").textContent).toContain("That repository path does not exist.");
  });

  it("renders selected project metadata instead of the first-run form", () => {
    render(
      <ProjectLanding
        state={{
          theme: "dark",
          activeProjectVersion: 1,
          activeProject: {
            id: "project-1",
            sequence: 1,
            name: "helm",
            repositoryRoot: "/projects/helm",
            reviewMode: "required",
            version: 1,
            createdAt: "2026-09-03T10:00:00.000Z",
            updatedAt: "2026-09-03T10:00:00.000Z",
          },
        }}
        onCreateProject={vi.fn()}
        onChangeTheme={vi.fn()}
      />,
    );

    expect(screen.queryByRole("form")).toBeNull();
    expect(screen.getByText("/projects/helm")).toBeTruthy();
    expect(screen.getByRole("heading", { level: 2, name: "helm" })).toBeTruthy();
  });

  it("applies and persists explicit theme selection", async () => {
    const user = userEvent.setup();
    const darkState: AppState = { ...emptyState, theme: "dark" };
    const onChangeTheme = vi.fn().mockResolvedValue({ ok: true, state: darkState });
    render(
      <ProjectLanding state={emptyState} onCreateProject={vi.fn()} onChangeTheme={onChangeTheme} />,
    );

    await user.click(screen.getByRole("button", { name: "Dark theme" }));

    expect(document.documentElement.dataset.theme).toBe("dark");
    expect(onChangeTheme).toHaveBeenCalledWith({
      theme: "dark",
      idempotencyKey: expect.any(String),
    });
    expect(screen.getByRole("button", { name: "Dark theme" }).getAttribute("aria-pressed")).toBe(
      "true",
    );
  });

  it("restores the first-run theme when persistence is unavailable", async () => {
    const user = userEvent.setup();
    render(
      <ProjectLanding
        state={emptyState}
        onCreateProject={vi.fn()}
        onChangeTheme={vi.fn().mockRejectedValue(new Error("Theme service unavailable."))}
      />,
    );

    await user.click(screen.getByRole("button", { name: "Dark theme" }));

    await waitFor(() =>
      expect(
        screen.getByRole("button", { name: "System theme" }).getAttribute("aria-pressed"),
      ).toBe("true"),
    );
    expect(document.documentElement.dataset.theme).toBe("system");
    expect(screen.getByRole("alert").textContent).toContain("Theme service unavailable");
  });
});
