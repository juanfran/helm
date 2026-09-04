// @vitest-environment jsdom

import { act, renderHook, waitFor } from "@testing-library/react";
import { describe, expect, it, vi } from "vitest";

import { createRetryableLazyModuleLoader } from "./retryable-lazy-module";
import { useRetryableModule } from "./use-retryable-module";

describe("useRetryableModule", () => {
  it("exposes a contained loading error and retries the reset module loader", async () => {
    const loadModule = vi
      .fn<() => Promise<{ readonly label: string }>>()
      .mockRejectedValueOnce(new Error("chunk unavailable"))
      .mockResolvedValueOnce({ label: "controls" });
    const loader = createRetryableLazyModuleLoader(loadModule);
    const { result } = renderHook(() => useRetryableModule(loader));

    await waitFor(() => expect(result.current.state.status).toBe("error"));
    act(() => result.current.retry());
    await waitFor(() => expect(result.current.state.status).toBe("ready"));

    expect(loadModule).toHaveBeenCalledTimes(2);
    expect(result.current.state).toEqual({ status: "ready", module: { label: "controls" } });
  });

  it("ignores completion after its consumer unmounts", async () => {
    let resolveModule: ((module: { readonly label: string }) => void) | undefined;
    const loader = {
      load: () =>
        new Promise<{ readonly label: string }>((resolve) => {
          resolveModule = resolve;
        }),
    };
    const { result, unmount } = renderHook(() => useRetryableModule(loader));
    const stateBeforeUnmount = result.current.state;

    unmount();
    resolveModule?.({ label: "late" });
    await Promise.resolve();

    expect(stateBeforeUnmount).toEqual({ status: "loading" });
  });
});
