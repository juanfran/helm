import { isValidElement } from "react";
import { beforeEach, describe, expect, it, vi } from "vitest";

import type { RouteErrorStateProps } from "../../components/route-state";

const routerMocks = vi.hoisted(() => {
  const navigate = vi.fn(
    async (_options: {
      readonly search:
        | { readonly cursor: null }
        | ((previous: Readonly<Record<string, unknown>>) => Readonly<Record<string, unknown>>);
    }) => undefined,
  );
  const invalidate = vi.fn(async () => undefined);
  return {
    navigate,
    invalidate,
    getRouteApi: vi.fn(() => ({ useNavigate: () => navigate })),
    useRouter: vi.fn(() => ({ invalidate })),
  };
});

vi.mock("@tanstack/react-router", () => ({
  getRouteApi: routerMocks.getRouteApi,
  useRouter: routerMocks.useRouter,
}));

import { ViewRouteError } from "./saved-view-route-error";
import { SearchRouteError } from "./task-search-route-error";

function retryFrom(element: ReturnType<typeof SearchRouteError>) {
  if (!isValidElement<RouteErrorStateProps>(element)) {
    throw new TypeError("Expected a route error element.");
  }
  return element.props.onRetry;
}

describe("split task route error recovery", () => {
  beforeEach(() => {
    routerMocks.navigate.mockClear();
    routerMocks.invalidate.mockClear();
  });

  it("resets search pagination before invalidating the failed route", async () => {
    await retryFrom(SearchRouteError({ error: new Error("offline") }))();

    expect(routerMocks.navigate).toHaveBeenCalledOnce();
    const navigation = routerMocks.navigate.mock.calls[0]?.[0];
    expect(navigation).toEqual({ search: expect.any(Function) });
    if (typeof navigation?.search !== "function") throw new TypeError("Expected search updater.");
    expect(navigation.search({ q: "work", cursor: "stale" })).toEqual({
      q: "work",
      cursor: null,
    });
    expect(routerMocks.invalidate).toHaveBeenCalledOnce();
    expect(routerMocks.navigate.mock.invocationCallOrder[0]).toBeLessThan(
      routerMocks.invalidate.mock.invocationCallOrder[0] ?? 0,
    );
  });

  it("resets saved-view pagination before invalidating the failed route", async () => {
    await retryFrom(ViewRouteError({ error: new Error("offline") }))();

    expect(routerMocks.navigate).toHaveBeenCalledWith({ search: { cursor: null } });
    expect(routerMocks.invalidate).toHaveBeenCalledOnce();
    expect(routerMocks.navigate.mock.invocationCallOrder[0]).toBeLessThan(
      routerMocks.invalidate.mock.invocationCallOrder[0] ?? 0,
    );
  });
});
