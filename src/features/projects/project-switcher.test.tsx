// @vitest-environment jsdom

import { cleanup, render, screen, waitFor, within } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { afterEach, describe, expect, it, vi } from "vitest";

import type { Project } from "../../domain/projects";
import { ProjectSwitcher } from "./project-switcher";

const helm: Project = {
  id: "project-1",
  sequence: 1,
  name: "helm",
  repositoryRoot: "/projects/helm",
  reviewMode: "required",
  version: 4,
  createdAt: "2026-09-03T10:00:00.000Z",
  updatedAt: "2026-09-03T10:00:00.000Z",
};

const atlas: Project = {
  id: "project-2",
  sequence: 2,
  name: "atlas",
  repositoryRoot: "/projects/atlas",
  reviewMode: "direct",
  version: 2,
  createdAt: "2026-09-03T11:00:00.000Z",
  updatedAt: "2026-09-03T11:00:00.000Z",
};

afterEach(() => {
  cleanup();
  vi.restoreAllMocks();
});

function renderSwitcher(overrides: Partial<React.ComponentProps<typeof ProjectSwitcher>> = {}) {
  const props = {
    projects: [helm, atlas],
    activeProject: helm,
    activeProjectVersion: 7,
    onSelect: vi.fn().mockResolvedValue({ ok: true }),
    onCreate: vi.fn().mockResolvedValue({ ok: true }),
    ...overrides,
  };
  render(<ProjectSwitcher {...props} />);
  return props;
}

describe("project switcher", () => {
  it("shows the active project and exposes versioned project choices", async () => {
    const user = userEvent.setup();
    renderSwitcher();

    expect(screen.getByRole("combobox", { name: "Active project" })).toHaveProperty(
      "textContent",
      expect.stringContaining("helm"),
    );
    expect(screen.getByText("/projects/helm")).toBeTruthy();
    expect(screen.queryByText("Project v4")).toBeNull();
    expect(screen.queryByText("Selection v7")).toBeNull();

    await user.click(screen.getByRole("combobox", { name: "Active project" }));

    const listbox = await screen.findByRole("listbox");
    const options = within(listbox).getAllByRole("option");
    expect(options).toHaveLength(2);
    expect(options[0]?.getAttribute("aria-selected")).toBe("true");
    expect(within(options[0]!).getByText("Active")).toBeTruthy();
    expect(within(options[1]!).getByText("/projects/atlas")).toBeTruthy();
    expect(within(options[1]!).getByText("Project #2 · v2")).toBeTruthy();
  });

  it("switches against the displayed selection version and announces pending state", async () => {
    const user = userEvent.setup();
    let resolveSelection: ((value: { ok: true }) => void) | undefined;
    const onSelect = vi.fn(
      () =>
        new Promise<{ ok: true }>((resolve) => {
          resolveSelection = resolve;
        }),
    );
    renderSwitcher({ onSelect });

    await user.click(screen.getByRole("combobox", { name: "Active project" }));
    await user.click(await screen.findByRole("option", { name: /atlas/i }));

    expect(onSelect).toHaveBeenCalledWith({
      projectId: atlas.id,
      expectedVersion: 7,
      idempotencyKey: expect.any(String),
    });
    expect(screen.getByText("Switching project…")).toBeTruthy();
    expect(screen.getByRole("combobox", { name: "Active project" })).toHaveProperty(
      "disabled",
      true,
    );

    resolveSelection?.({ ok: true });
    await waitFor(() => expect(screen.queryByText("Switching project…")).toBeNull());
  });

  it("keeps the active project selected and reports a switching conflict", async () => {
    const user = userEvent.setup();
    const onSelect = vi.fn().mockResolvedValue({
      ok: false,
      error: { message: "Active project version conflict: expected 7, current 8." },
    });
    renderSwitcher({ onSelect });

    await user.click(screen.getByRole("combobox", { name: "Active project" }));
    await user.click(await screen.findByRole("option", { name: /atlas/i }));

    expect(await screen.findByRole("alert")).toHaveProperty(
      "textContent",
      "Active project version conflict: expected 7, current 8.",
    );
    expect(screen.getByRole("combobox", { name: "Active project" })).toHaveProperty(
      "textContent",
      expect.stringContaining("helm"),
    );
  });

  it("creates another project from an accessible dialog and keeps typed errors in context", async () => {
    const user = userEvent.setup();
    const onCreate = vi.fn().mockResolvedValue({
      ok: false,
      error: { message: "That repository is already connected to Helm." },
    });
    renderSwitcher({ onCreate });

    await user.click(screen.getByRole("button", { name: "Add project" }));
    const dialog = await screen.findByRole("dialog", { name: "Add local project" });
    const submit = within(dialog).getByRole("button", { name: "Create and switch" });
    expect(submit).toHaveProperty("disabled", true);

    await user.type(within(dialog).getByLabelText("Repository root"), "  /projects/atlas  ");
    await user.click(submit);

    expect(onCreate).toHaveBeenCalledWith({
      repositoryRoot: "/projects/atlas",
      idempotencyKey: expect.any(String),
    });
    expect(await within(dialog).findByRole("alert")).toHaveProperty(
      "textContent",
      "That repository is already connected to Helm.",
    );
    expect(screen.getByRole("dialog", { name: "Add local project" })).toBeTruthy();
  });

  it("closes and clears the add-project dialog after a successful creation", async () => {
    const user = userEvent.setup();
    const onCreate = vi.fn().mockResolvedValue({ ok: true });
    renderSwitcher({ onCreate });

    await user.click(screen.getByRole("button", { name: "Add project" }));
    await user.type(await screen.findByLabelText("Repository root"), "/projects/new-project");
    await user.click(screen.getByRole("button", { name: "Create and switch" }));

    await waitFor(() =>
      expect(screen.queryByRole("dialog", { name: "Add local project" })).toBeNull(),
    );
    await user.click(screen.getByRole("button", { name: "Add project" }));
    expect(await screen.findByLabelText("Repository root")).toHaveProperty("value", "");
  });

  it("reuses the idempotency key when retrying an unchanged intent after transport failure", async () => {
    const user = userEvent.setup();
    const onCreate = vi
      .fn()
      .mockRejectedValueOnce(new Error("response lost"))
      .mockResolvedValueOnce({ ok: true });
    renderSwitcher({ onCreate });

    await user.click(screen.getByRole("button", { name: "Add project" }));
    await user.type(await screen.findByLabelText("Repository root"), "/projects/retry");
    await user.click(screen.getByRole("button", { name: "Create and switch" }));
    expect(await screen.findByRole("alert")).toHaveProperty(
      "textContent",
      expect.stringContaining("could not create"),
    );
    expect(screen.getByLabelText("Repository root").getAttribute("aria-invalid")).toBe("true");

    await user.click(screen.getByRole("button", { name: "Create and switch" }));
    await waitFor(() => expect(onCreate).toHaveBeenCalledTimes(2));
    expect(onCreate.mock.calls[1]?.[0].idempotencyKey).toBe(
      onCreate.mock.calls[0]?.[0].idempotencyKey,
    );
  });

  it("reuses the selection idempotency key when its response is lost", async () => {
    const user = userEvent.setup();
    const onSelect = vi
      .fn()
      .mockRejectedValueOnce(new Error("response lost"))
      .mockResolvedValueOnce({ ok: true });
    renderSwitcher({ onSelect });

    await user.click(screen.getByRole("combobox", { name: "Active project" }));
    await user.click(await screen.findByRole("option", { name: /atlas/i }));
    expect(await screen.findByRole("alert")).toHaveProperty(
      "textContent",
      expect.stringContaining("could not switch"),
    );

    await user.click(screen.getByRole("combobox", { name: "Active project" }));
    await user.click(await screen.findByRole("option", { name: /atlas/i }));
    await waitFor(() => expect(onSelect).toHaveBeenCalledTimes(2));
    expect(onSelect.mock.calls[1]?.[0].idempotencyKey).toBe(
      onSelect.mock.calls[0]?.[0].idempotencyKey,
    );
  });
});
