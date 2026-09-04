import { describe, expect, it } from "vitest";

import { getProjectSyncCoordinator, waitForAllProjectSync } from "./project-sync-coordinator";

describe("project sync coordinator", () => {
  it("serializes authoritative work per owner and project", async () => {
    const owner = {};
    const coordinator = getProjectSyncCoordinator(owner, "project-1");
    const order: string[] = [];
    let release!: () => void;
    const gate = new Promise<void>((resolve) => {
      release = resolve;
    });

    const first = coordinator.run(async () => {
      order.push("first:start");
      await gate;
      order.push("first:end");
    });
    const second = coordinator.run(() => {
      order.push("second");
    });
    await Promise.resolve();
    expect(order).toEqual(["first:start"]);

    release();
    await Promise.all([first, second]);
    expect(order).toEqual(["first:start", "first:end", "second"]);
    expect(getProjectSyncCoordinator(owner, "project-1")).toBe(coordinator);
    expect(getProjectSyncCoordinator(owner, "project-2")).not.toBe(coordinator);
  });

  it("continues queued work after a rejected operation", async () => {
    const coordinator = getProjectSyncCoordinator({}, "project-1");
    const failed = coordinator.run(async () => {
      throw new Error("refresh failed");
    });
    const recovered = coordinator.run(() => "recovered");

    await expect(failed).rejects.toThrow("refresh failed");
    await expect(recovered).resolves.toBe("recovered");
  });

  it("does not let a late stale refresh overwrite a queued authoritative write", async () => {
    const coordinator = getProjectSyncCoordinator({}, "project-1");
    let visible = "initial";
    let releaseRefresh!: () => void;
    const refreshGate = new Promise<void>((resolve) => {
      releaseRefresh = resolve;
    });
    const refresh = coordinator.run(async () => {
      const captured = "stale snapshot";
      await refreshGate;
      visible = captured;
    });
    const authoritativeWrite = coordinator.run(() => {
      visible = "new event";
    });

    releaseRefresh();
    await Promise.all([refresh, authoritativeWrite]);
    expect(visible).toBe("new event");
  });

  it("waits for every sibling refresh before reporting failures", async () => {
    let slowFinished = false;
    const slow = Promise.resolve().then(() => {
      slowFinished = true;
    });

    await expect(
      waitForAllProjectSync([Promise.reject(new Error("failed")), slow]),
    ).rejects.toThrow("failed");
    expect(slowFinished).toBe(true);
  });
});
