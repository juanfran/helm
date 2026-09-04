// @vitest-environment jsdom

import { cleanup, render, screen } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { afterEach, describe, expect, it, vi } from "vitest";

import { createRetryableLazyModuleLoader } from "./retryable-lazy-module";
import { RetryableLazySurface } from "./retryable-lazy-surface";

afterEach(cleanup);

describe("RetryableLazySurface", () => {
  it("shows a visible failure and creates a fresh lazy attempt on retry", async () => {
    const loadModule = vi
      .fn<() => Promise<{ default: React.ComponentType<{ label: string }> }>>()
      .mockRejectedValueOnce(new Error("chunk unavailable"))
      .mockResolvedValueOnce({ default: ({ label }) => <p>{label}</p> });
    const moduleLoader = createRetryableLazyModuleLoader(loadModule);

    render(
      <RetryableLazySurface
        moduleLoader={moduleLoader}
        fallback={<output aria-label="Loading test surface">Loading…</output>}
        render={(LoadedComponent) => <LoadedComponent label="Recovered surface" />}
        renderFailure={(retry) => (
          <div role="alert">
            <p>Test surface could not load.</p>
            <button type="button" onClick={retry}>
              Retry
            </button>
          </div>
        )}
      />,
    );

    expect(await screen.findByRole("alert")).toHaveProperty(
      "textContent",
      expect.stringContaining("could not load"),
    );
    await userEvent.click(screen.getByRole("button", { name: "Retry" }));

    expect(await screen.findByText("Recovered surface")).toBeTruthy();
    expect(loadModule).toHaveBeenCalledTimes(2);
  });
});
