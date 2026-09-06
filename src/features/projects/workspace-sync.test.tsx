// @vitest-environment jsdom

import { act, cleanup, render } from "@testing-library/react";
import { afterEach, beforeEach, expect, it, vi } from "vitest";
import { WorkspaceSync } from "./workspace-sync";

const sync = vi.hoisted(() => ({
  captureCursor: vi.fn(),
  advanceCursor: vi.fn(),
  subscribe: vi.fn(),
  disconnect: vi.fn(),
  client: {},
  router: {},
}));
vi.mock("@tanstack/react-query", () => ({ useQueryClient: () => sync.client }));
vi.mock("@tanstack/react-router", () => ({ useRouter: () => sync.router }));
vi.mock("./workspace-sync-state", () => ({ getWorkspaceSyncState: () => sync }));
vi.mock("./project-customization-query", () => ({ refreshProjectCustomization: vi.fn() }));
vi.mock("../activity/project-event-subscription", () => ({
  subscribeToProjectEvents: sync.subscribe,
}));

beforeEach(() => {
  vi.useFakeTimers();
  vi.resetAllMocks();
  sync.captureCursor.mockResolvedValue(12);
  sync.subscribe.mockReturnValue(sync.disconnect);
});
afterEach(() => {
  cleanup();
  vi.useRealTimers();
});

it("retries initial cursor failures and keeps the connection across child rerenders", async () => {
  sync.captureCursor.mockRejectedValueOnce(new Error("Temporary network failure"));
  const report = vi.fn();
  const view = render(<WorkspaceSync projectId="project-1" reportConnection={report} />);
  await act(async () => {
    await Promise.resolve();
  });
  expect(report).toHaveBeenCalledWith("retrying");
  expect(sync.subscribe).not.toHaveBeenCalled();
  await act(async () => {
    await vi.advanceTimersByTimeAsync(1_000);
  });
  expect(sync.subscribe).toHaveBeenCalledWith(
    expect.objectContaining({ projectId: "project-1", afterCursor: 12 }),
  );
  view.rerender(<WorkspaceSync projectId="project-1" reportConnection={report} />);
  expect(sync.subscribe).toHaveBeenCalledOnce();
  view.unmount();
  expect(sync.disconnect).toHaveBeenCalledOnce();
});

it("cancels cursor retries when leaving the project", async () => {
  sync.captureCursor.mockRejectedValue(new Error("Offline"));
  const view = render(<WorkspaceSync projectId="project-1" reportConnection={vi.fn()} />);
  await act(async () => {
    await Promise.resolve();
  });
  view.unmount();
  await act(async () => {
    await vi.advanceTimersByTimeAsync(2_000);
  });
  expect(sync.captureCursor).toHaveBeenCalledOnce();
  expect(sync.subscribe).not.toHaveBeenCalled();
});
