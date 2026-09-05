// @vitest-environment jsdom

import {
  act,
  cleanup,
  fireEvent,
  render as renderComponent,
  screen,
  waitFor,
} from "@testing-library/react";
import { TestRouter } from "../../test-router-wrapper";
import { afterEach, describe, expect, it, vi } from "vitest";

import { taskSearchItemSchema } from "../../domain/task-filters";
import { createDeferredTaskRouteResults } from "./deferred-task-route-results";
import type { TaskRouteResultsProps } from "./task-route-results";

afterEach(cleanup);
const render = (ui: React.ReactNode) => renderComponent(ui, { wrapper: TestRouter });

const item = taskSearchItemSchema.parse({
  task: {
    id: "task-1",
    projectId: "project-1",
    sequence: 7,
    parentTaskId: null,
    title: "Verify route chunks",
    lifecycle: "ready",
    priority: "normal",
    position: 7,
    notBefore: null,
    dueAt: null,
    size: null,
    tags: [],
    requiredCapabilities: [],
    claim: null,
    eligibility: {
      claimable: true,
      status: "claimable",
      reasons: [],
      orderingExplanation: "Manual position 7.",
      missingCapabilities: [],
      blockingTaskIds: [],
    },
    descriptionText: "",
    expectedOutcome: "The route remains useful while controls load.",
    acceptanceCriteria: "The task title stays readable.",
    agentContext: "",
    checklist: [],
    version: 1,
    createdAt: "2026-09-04T10:00:00.000Z",
    updatedAt: "2026-09-04T10:00:00.000Z",
  },
  relevance: null,
  matchedSources: [],
});

function InteractiveResults({ items }: TaskRouteResultsProps) {
  return <button type="button">Interactive selection for #{items[0]?.task.sequence}</button>;
}

function renderResults(loadModule: () => Promise<{ TaskRouteResults: typeof InteractiveResults }>) {
  const DeferredResults = createDeferredTaskRouteResults(loadModule);
  render(
    <DeferredResults
      projectId="project-1"
      items={[item]}
      visibleFields={["title", "priority"]}
      onExecuted={() => Promise.resolve()}
    />,
  );
}

describe("DeferredTaskRouteResults", () => {
  it("keeps rich results readable and waits for explicit activation while an intent preload is slow", async () => {
    let resolveModule:
      | ((module: { TaskRouteResults: typeof InteractiveResults }) => void)
      | undefined;
    const loadModule = vi.fn(
      () =>
        new Promise<{ TaskRouteResults: typeof InteractiveResults }>((resolve) => {
          resolveModule = resolve;
        }),
    );
    renderResults(loadModule);

    expect(loadModule).not.toHaveBeenCalled();
    expect(screen.getByRole("region", { name: "Task search results" })).toBeTruthy();
    expect(screen.getByText("Verify route chunks")).toBeTruthy();
    expect(screen.getByText("normal")).toBeTruthy();
    const activate = screen.getByRole("button", { name: "Select tasks" });

    activate.focus();
    fireEvent.pointerEnter(activate);
    await waitFor(() => expect(loadModule).toHaveBeenCalledTimes(1));
    expect(screen.queryByText("Loading selection and bulk actions…")).toBeNull();

    fireEvent.click(activate);
    expect(screen.getByRole("button", { name: "Loading bulk actions" })).toHaveProperty(
      "disabled",
      true,
    );
    expect(screen.getByText("Verify route chunks")).toBeTruthy();
    expect(document.activeElement).toBe(activate);

    await act(async () => resolveModule?.({ TaskRouteResults: InteractiveResults }));
    expect(await screen.findByText("Interactive selection for #7")).toBeTruthy();
    expect(document.activeElement).toBe(activate);
  });

  it("contains a rejected intent preload and activates with a fresh import", async () => {
    const loadModule = vi
      .fn<() => Promise<{ TaskRouteResults: typeof InteractiveResults }>>()
      .mockRejectedValueOnce(new Error("preload failed"))
      .mockResolvedValueOnce({ TaskRouteResults: InteractiveResults });
    renderResults(loadModule);
    const activate = screen.getByRole("button", { name: "Select tasks" });

    fireEvent.focus(activate);
    await waitFor(() => expect(loadModule).toHaveBeenCalledTimes(1));
    await act(() => Promise.resolve());
    fireEvent.click(activate);

    expect(await screen.findByText("Interactive selection for #7")).toBeTruthy();
    expect(loadModule).toHaveBeenCalledTimes(2);
  });

  it("retains results after an activated import fails and retries explicitly", async () => {
    const loadModule = vi
      .fn<() => Promise<{ TaskRouteResults: typeof InteractiveResults }>>()
      .mockRejectedValueOnce(new Error("chunk unavailable"))
      .mockResolvedValueOnce({ TaskRouteResults: InteractiveResults });
    renderResults(loadModule);

    const trigger = screen.getByRole("button", { name: "Select tasks" });
    trigger.focus();
    fireEvent.click(trigger);
    expect(await screen.findByRole("alert")).toHaveProperty(
      "textContent",
      expect.stringContaining("Bulk actions could not load"),
    );
    expect(screen.getByText("Verify route chunks")).toBeTruthy();
    expect(document.activeElement).toBe(trigger);

    fireEvent.click(screen.getByRole("button", { name: "Try bulk actions again" }));

    expect(await screen.findByText("Interactive selection for #7")).toBeTruthy();
    expect(loadModule).toHaveBeenCalledTimes(2);
    expect(document.activeElement).toBe(trigger);
  });
});
