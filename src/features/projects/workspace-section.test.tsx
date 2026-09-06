// @vitest-environment jsdom

import { act, cleanup, render, screen } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { afterEach, expect, it, vi } from "vitest";
import { getProjectSyncCoordinator } from "../activity/project-sync-coordinator";
import { createWorkspaceResource } from "./workspace-resource";
import { WorkspaceDataContext, WorkspaceSection } from "./workspace-section";

afterEach(() => {
  cleanup();
  vi.restoreAllMocks();
});

function section(snapshot: () => Promise<void>) {
  const resource = createWorkspaceResource(snapshot, getProjectSyncCoordinator({}, "project-1"));
  const data = {
    resources: {
      tasks: resource,
      attempts: resource,
      activity: resource,
      blockers: resource,
      events: resource,
      important: resource,
    },
  };
  render(
    // oxlint-disable-next-line react/jsx-no-constructed-context-values -- Created once per test, outside a React component.
    <WorkspaceDataContext.Provider value={data}>
      <input aria-label="Task title" defaultValue="Usable immediately" />
      <WorkspaceSection label="Execution history" resources={["attempts"]}>
        <button type="button">Approve</button>
      </WorkspaceSection>
    </WorkspaceDataContext.Provider>,
  );
  return resource;
}

it("suspends history without hiding task preparation or exposing premature review actions", async () => {
  let resolve!: () => void;
  const snapshot = new Promise<void>((done) => {
    resolve = done;
  });
  section(() => snapshot);
  expect(screen.getByText("Loading execution history…")).toBeTruthy();
  expect(screen.queryByRole("button", { name: "Approve" })).toBeNull();
  const user = userEvent.setup();
  await user.type(screen.getByLabelText("Task title"), " and editable");
  expect(screen.getByLabelText("Task title")).toHaveProperty(
    "value",
    "Usable immediately and editable",
  );
  await act(async () => {
    resolve();
    await snapshot;
  });
  expect(await screen.findByRole("button", { name: "Approve" })).toBeTruthy();
});

it("contains history failures and retries the section without discarding the task draft", async () => {
  vi.spyOn(console, "error").mockImplementation(() => undefined);
  const snapshot = vi
    .fn<() => Promise<void>>()
    .mockRejectedValueOnce(new Error("History is temporarily unavailable"))
    .mockResolvedValue(undefined);
  section(snapshot);
  expect(await screen.findByRole("alert")).toHaveProperty(
    "textContent",
    expect.stringContaining("Execution history could not be loaded"),
  );
  expect(screen.queryByRole("button", { name: "Approve" })).toBeNull();
  const user = userEvent.setup();
  await user.clear(screen.getByLabelText("Task title"));
  await user.type(screen.getByLabelText("Task title"), "Unsaved draft");
  await user.click(screen.getByRole("button", { name: "Try again" }));
  expect(await screen.findByRole("button", { name: "Approve" })).toBeTruthy();
  expect(screen.getByLabelText("Task title")).toHaveProperty("value", "Unsaved draft");
  expect(snapshot).toHaveBeenCalledTimes(2);
});
