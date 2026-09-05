import type { ReactNode } from "react";
import {
  createMemoryHistory,
  createRootRoute,
  createRouter,
  RouterContextProvider,
} from "@tanstack/react-router";

// Component tests exercise real links without mounting a second application route tree.
const router = createRouter({
  routeTree: createRootRoute(),
  history: createMemoryHistory({ initialEntries: ["/"] }),
});
export function TestRouter({ children }: { children: ReactNode }) {
  return <RouterContextProvider router={router}>{children}</RouterContextProvider>;
}
