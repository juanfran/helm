import { describe, expect, it, vi } from "vitest";

import { executeProjectChange } from "./project-navigation";

function navigation() {
  return {
    navigateToWorkspace: vi.fn().mockResolvedValue(undefined),
    refreshRoutes: vi.fn().mockResolvedValue(undefined),
  };
}

describe("project navigation", () => {
  it("leaves project-specific navigation and refreshes loaders after a commit", async () => {
    const route = navigation();
    const response = { ok: true as const, state: { activeProjectVersion: 3 } };

    await expect(executeProjectChange(() => Promise.resolve(response), route)).resolves.toBe(
      response,
    );
    expect(route.navigateToWorkspace).toHaveBeenCalledOnce();
    expect(route.refreshRoutes).toHaveBeenCalledOnce();
    expect(route.navigateToWorkspace.mock.invocationCallOrder[0]).toBeLessThan(
      route.refreshRoutes.mock.invocationCallOrder[0]!,
    );
  });

  it("resets navigation and refreshes when another caller won the selection race", async () => {
    const route = navigation();
    const response = {
      ok: false as const,
      error: {
        type: "ActiveProjectVersionConflictError",
        message: "The active project changed.",
      },
    };

    await expect(executeProjectChange(() => Promise.resolve(response), route)).resolves.toBe(
      response,
    );
    expect(route.navigateToWorkspace).toHaveBeenCalledOnce();
    expect(route.refreshRoutes).toHaveBeenCalledOnce();
  });

  it("keeps command failures in context", async () => {
    const route = navigation();
    const response = {
      ok: false as const,
      error: { type: "DuplicateRepositoryRootError", message: "Already registered." },
    };

    await expect(executeProjectChange(() => Promise.resolve(response), route)).resolves.toBe(
      response,
    );
    expect(route.navigateToWorkspace).not.toHaveBeenCalled();
    expect(route.refreshRoutes).not.toHaveBeenCalled();
  });
});
