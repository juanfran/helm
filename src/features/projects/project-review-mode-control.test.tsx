// @vitest-environment jsdom

import { cleanup, render, screen, waitFor } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { afterEach, describe, expect, it, vi } from "vitest";

import type { Project } from "../../domain/projects";
import { ProjectReviewModeControl } from "./project-review-mode-control";

const project: Project = {
  id: "project-1",
  sequence: 1,
  name: "helm",
  repositoryRoot: "/projects/helm",
  reviewMode: "required",
  version: 4,
  createdAt: "2026-09-03T10:00:00.000Z",
  updatedAt: "2026-09-03T10:00:00.000Z",
};

afterEach(() => {
  cleanup();
  vi.restoreAllMocks();
});

describe("project review mode control", () => {
  it("saves the selected project-level completion route against its displayed version", async () => {
    const user = userEvent.setup();
    let resolveResponse: ((value: { ok: true; project: Project }) => void) | undefined;
    const onChange = vi.fn(
      () =>
        new Promise<{ ok: true; project: Project }>((resolve) => {
          resolveResponse = resolve;
        }),
    );
    render(<ProjectReviewModeControl project={project} onChange={onChange} />);

    await user.selectOptions(screen.getByLabelText("Agent completion"), "direct");

    expect(onChange).toHaveBeenCalledWith({
      projectId: project.id,
      reviewMode: "direct",
      expectedVersion: project.version,
      idempotencyKey: expect.any(String),
    });
    expect(screen.getByLabelText("Agent completion")).toHaveProperty("disabled", true);
    expect(screen.getByText("Saving review mode…")).toBeTruthy();

    resolveResponse?.({
      ok: true,
      project: { ...project, reviewMode: "direct", version: project.version + 1 },
    });
    await waitFor(() =>
      expect(screen.getByLabelText("Agent completion")).toHaveProperty("disabled", false),
    );
    expect(screen.getByLabelText("Agent completion")).toHaveProperty("value", "direct");
  });

  it("restores the previous selection and announces a version conflict", async () => {
    const user = userEvent.setup();
    const onChange = vi.fn().mockResolvedValue({
      ok: false,
      error: {
        type: "ProjectVersionConflictError",
        message: "Project version conflict: expected 4, current 5.",
      },
    });
    render(<ProjectReviewModeControl project={project} onChange={onChange} />);

    await user.selectOptions(screen.getByLabelText("Agent completion"), "direct");

    expect(await screen.findByRole("alert")).toHaveProperty(
      "textContent",
      "Project version conflict: expected 4, current 5.",
    );
    expect(screen.getByLabelText("Agent completion")).toHaveProperty("value", "required");
  });
});
