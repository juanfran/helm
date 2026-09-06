// @vitest-environment jsdom

import { act, cleanup, render, screen } from "@testing-library/react";
import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import { afterEach, expect, it, vi } from "vitest";

import type { ProjectEvent } from "../../domain/activity";
import { getImportantProjectEventCollection } from "../activity/important-project-event-collection";
import { RouteNotificationCenter } from "./task-route-page-tools";

vi.mock("@tanstack/react-router", async (importOriginal) => ({
  ...(await importOriginal<typeof import("@tanstack/react-router")>()),
  useNavigate: () => vi.fn(),
}));
vi.mock("../../server/important-project-event-functions", () => ({
  readImportantProjectEvents: async () => ({ events: [] }),
}));
vi.mock("../../server/task-functions", () => ({ readTasks: async () => [] }));

afterEach(cleanup);

it("updates the mounted header from the shared event collection without remounting or refetching", async () => {
  const queryClient = new QueryClient({ defaultOptions: { queries: { retry: false } } });
  const collection = getImportantProjectEventCollection(queryClient, "project-1");
  await collection.preload();
  render(
    <QueryClientProvider client={queryClient}>
      <RouteNotificationCenter projectId="project-1" tasks={[]} defaultOpen />
    </QueryClientProvider>,
  );
  expect(await screen.findByText("Nothing needs attention.")).toBeTruthy();
  const originalTrigger = screen.getByRole("button", { name: /Notifications,/ });
  const event: ProjectEvent = {
    id: "event-1",
    cursor: 1,
    projectId: "project-1",
    kind: "task.attempt.failed",
    importance: "critical",
    actor: { type: "agent", id: "run-1" },
    entity: { type: "task", id: "task-1" },
    payload: { summary: "Verification failed" },
    changes: {
      projectIds: ["project-1"],
      taskIds: ["task-1"],
      activityEntryIds: [],
      agentRunIds: ["run-1"],
      scopes: ["tasks"],
    },
    occurredAt: "2026-09-06T08:00:00.000Z",
  };
  await act(async () => collection.utils.writeUpsert(event));
  expect(await screen.findByText("task · attempt · failed")).toBeTruthy();
  expect(screen.getByRole("button", { name: /Notifications,/ })).toBe(originalTrigger);
  cleanup();
  await collection.cleanup();
  queryClient.clear();
});
