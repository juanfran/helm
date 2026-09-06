import { describe, expect, it } from "vitest";
import { createMemoryHistory, createRouter } from "@tanstack/react-router";
import { QueryClient } from "@tanstack/react-query";
import { routeTree } from "../../routeTree.gen";
import {
  emptyTaskSearchParams,
  parseTaskSearchRouteParams,
} from "../tasks/task-search-route-params";
import { workspaceSearchSchema } from "./workspace-search";

function getRouter() {
  return createRouter({
    routeTree,
    history: createMemoryHistory({ initialEntries: ["/"] }),
    context: { queryClient: new QueryClient() },
  });
}

describe("project-scoped file routes", () => {
  it("keeps the same project layout around all project page routes", () => {
    const router = getRouter();
    for (const id of [
      "/$projectId/tasks/",
      "/$projectId/tasks/$taskId",
      "/$projectId/dashboard",
      "/$projectId/activity",
      "/$projectId/settings",
      "/$projectId/search",
      "/$projectId/views/$viewId",
    ] as const) {
      expect(router.routesById[id].parentRoute.id).toBe("/$projectId");
    }
  });
  it("builds concrete workspace and task URLs without identity query parameters", () => {
    const router = getRouter();
    for (const to of [
      "/$projectId/tasks",
      "/$projectId/dashboard",
      "/$projectId/activity",
      "/$projectId/settings",
    ] as const) {
      const location = router.buildLocation({
        to,
        params: { projectId: "project-one" },
        search: {},
      });
      expect(location.href).toBe(to.replace("$projectId", "project-one"));
    }
    expect(
      router.buildLocation({
        to: "/$projectId/tasks/$taskId",
        params: { projectId: "project-two", taskId: "task-1" },
        search: {},
      }).href,
    ).toBe("/project-two/tasks/task-1");
  });

  it("strips search defaults but preserves actual filters and pagination", () => {
    const router = getRouter();
    expect(
      router.buildLocation({
        to: "/$projectId/search",
        params: { projectId: "project-one" },
        search: emptyTaskSearchParams,
      }).href,
    ).toBe("/project-one/search");
    const filtered = router.buildLocation({
      to: "/$projectId/search",
      params: { projectId: "project-two" },
      search: { ...emptyTaskSearchParams, q: "review", priority: "high" },
    });
    expect(filtered.pathname).toBe("/project-two/search");
    expect(new URL(filtered.href, "http://localhost").searchParams.size).toBe(2);
    expect(
      router.buildLocation({
        to: "/$projectId/views/$viewId",
        params: { projectId: "project-one", viewId: "view-one" },
        search: { cursor: null },
      }).href,
    ).toBe("/project-one/views/view-one");
    expect(
      router.buildLocation({
        to: "/$projectId/views/$viewId",
        params: { projectId: "project-one", viewId: "view-one" },
        search: { cursor: "next-page" },
      }).href,
    ).toContain("cursor=next-page");
  });

  it("does not derive page or project identity from legacy search values", () => {
    expect(
      workspaceSearchSchema.parse({ project: "other", view: "settings", filter: "ready" }),
    ).toEqual({ filter: "ready" });
    expect(parseTaskSearchRouteParams({ project: "other" })).toEqual(emptyTaskSearchParams);
    const routes = getRouter().routesById;
    expect(routes).not.toHaveProperty("/search");
    expect(routes).not.toHaveProperty("/views/$viewId");
    expect(routes).not.toHaveProperty("/projects/$projectId/tasks/$taskId");
  });
});
