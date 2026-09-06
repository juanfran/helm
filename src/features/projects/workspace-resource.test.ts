import { describe, expect, it, vi } from "vitest";
import { getProjectSyncCoordinator } from "../activity/project-sync-coordinator";
import { createWorkspaceResource } from "./workspace-resource";

function deferred<T>() {
  let resolve!: (value: T | PromiseLike<T>) => void;
  const promise = new Promise<T>((accept) => {
    resolve = accept;
  });
  return { promise, resolve };
}

describe("deferred workspace snapshots", () => {
  it("shares an in-flight snapshot and reuses it after navigation", async () => {
    const snapshot = vi.fn(async () => undefined);
    const resource = createWorkspaceResource(snapshot, getProjectSyncCoordinator({}, "project"));
    const first = resource.ensure();
    expect(resource.ensure()).toBe(first);
    await first;
    await resource.ensure();
    expect(resource.ready).toBe(true);
    expect(snapshot).toHaveBeenCalledTimes(1);
    expect(() => resource.read()).not.toThrow();
  });

  it("does not hold the project sync queue while secondary data is loading", async () => {
    const gate = deferred<void>();
    const coordinator = getProjectSyncCoordinator({}, "project");
    const snapshot = vi.fn().mockReturnValueOnce(gate.promise).mockResolvedValue(undefined);
    const resource = createWorkspaceResource(snapshot, coordinator);
    const pending = resource.ensure();
    await coordinator.run(() => resource.markChanged());
    expect(resource.ready).toBe(false);
    gate.resolve();
    await pending;
    expect(snapshot).toHaveBeenCalledTimes(2);
    expect(resource.ready).toBe(true);
  });

  it("reconciles a snapshot before subsequent live projections can run", async () => {
    const initial = deferred<void>();
    const catchup = deferred<void>();
    const coordinator = getProjectSyncCoordinator({}, "project");
    const snapshot = vi
      .fn()
      .mockReturnValueOnce(initial.promise)
      .mockReturnValueOnce(catchup.promise);
    const resource = createWorkspaceResource(snapshot, coordinator);
    const pending = resource.ensure();
    resource.markChanged();
    initial.resolve();
    await vi.waitFor(() => expect(snapshot).toHaveBeenCalledTimes(2));
    const project = vi.fn();
    const projection = coordinator.run(project);
    expect(project).not.toHaveBeenCalled();
    expect(resource.ready).toBe(false);
    catchup.resolve();
    await Promise.all([pending, projection]);
    expect(resource.ready).toBe(true);
    expect(project).toHaveBeenCalledOnce();
  });

  it("keeps errors local and retries without an unhandled rejection", async () => {
    const snapshot = vi
      .fn()
      .mockRejectedValueOnce(new Error("History unavailable"))
      .mockResolvedValue(undefined);
    const resource = createWorkspaceResource(snapshot, getProjectSyncCoordinator({}, "project"));
    await expect(resource.ensure()).rejects.toThrow("History unavailable");
    expect(() => resource.read()).toThrow("History unavailable");
    expect(resource.ready).toBe(false);
    resource.retry();
    await resource.ensure();
    expect(resource.ready).toBe(true);
  });

  it("reloads a collection that was cleaned up while unused", async () => {
    let available = true;
    const snapshot = vi.fn(async () => {
      available = true;
    });
    const resource = createWorkspaceResource(
      snapshot,
      getProjectSyncCoordinator({}, "project"),
      () => available,
    );
    await resource.ensure();
    available = false;
    expect(resource.ready).toBe(false);
    await resource.ensure();
    expect(snapshot).toHaveBeenCalledTimes(2);
  });
});
