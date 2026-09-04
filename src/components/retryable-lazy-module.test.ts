import { describe, expect, it, vi } from "vitest";

import { createRetryableLazyModuleLoader } from "./retryable-lazy-module";

describe("retryable lazy module loader", () => {
  it("contains a rejected intent preload and retries the next load", async () => {
    const preloadFailure = new Error("transient chunk failure");
    const loadModule = vi
      .fn<() => Promise<string>>()
      .mockRejectedValueOnce(preloadFailure)
      .mockResolvedValueOnce("dashboard module");
    const moduleLoader = createRetryableLazyModuleLoader(loadModule);

    moduleLoader.preload();
    await vi.waitFor(() => expect(loadModule).toHaveBeenCalledTimes(1));
    await new Promise<void>((resolve) => setTimeout(resolve, 0));

    await expect(moduleLoader.load()).resolves.toBe("dashboard module");
    expect(loadModule).toHaveBeenCalledTimes(2);
  });
});
