// @vitest-environment jsdom

import { cleanup, render, screen, within } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { afterEach, describe, expect, it, vi } from "vitest";

import { taskSearchItemSchema, type TaskSearchItem } from "../../domain/task-filters";
import { emptyRichTextDocument, type TaskLifecycle } from "../../domain/tasks";
import { TaskSearchResults } from "./task-search-results";

afterEach(cleanup);

function item(
  id: string,
  sequence: number,
  title: string,
  lifecycle: TaskLifecycle,
): TaskSearchItem {
  return taskSearchItemSchema.parse({
    task: {
      id,
      projectId: "project-1",
      sequence,
      title,
      lifecycle,
      priority: sequence === 1 ? "urgent" : "normal",
      description: emptyRichTextDocument,
      descriptionText: "",
      expectedOutcome: "The task is complete.",
      acceptanceCriteria: "The result is verified.",
      agentContext: "",
      checklist: [],
      version: 1,
      archivedAt: null,
      createdAt: "2026-09-04T10:00:00.000Z",
      updatedAt: "2026-09-04T10:00:00.000Z",
    },
    relevance: null,
    matchedSources: [],
  });
}

describe("TaskSearchResults", () => {
  it("defaults to an accessible list and selects a result", async () => {
    const user = userEvent.setup();
    const onSelect = vi.fn();
    const first = item("task-1", 1, "Design the search", "ready");
    const second = item("task-2", 2, "Verify pagination", "review");

    render(
      <TaskSearchResults
        items={[first, second]}
        visibleFields={["title", "priority"]}
        selectedTaskId="task-1"
        onSelect={onSelect}
      />,
    );

    expect(screen.getByRole("region", { name: "Task search results" })).toBeTruthy();
    expect(screen.getByRole("list", { name: "Tasks" })).toBeTruthy();
    expect(screen.getByText("urgent")).toBeTruthy();
    expect(screen.queryByText("Ready")).toBeNull();
    expect(
      screen
        .getByRole("button", { name: "Select task #1: Design the search" })
        .getAttribute("aria-current"),
    ).toBe("true");

    await user.click(screen.getByRole("button", { name: "Select task #2: Verify pagination" }));
    expect(onSelect).toHaveBeenCalledWith("task-2");
  });

  it("groups the same result items into all six lifecycle lanes", () => {
    const items = [
      item("task-1", 1, "Shape backlog", "backlog"),
      item("task-2", 2, "Ship search", "ready"),
      item("task-3", 3, "Review search", "review"),
    ];

    render(
      <TaskSearchResults
        items={items}
        presentation="board"
        visibleFields={["title", "lifecycle"]}
        selectedTaskId={null}
        onSelect={vi.fn()}
      />,
    );

    expect(screen.getByRole("region", { name: "Task board" })).toBeTruthy();
    for (const lane of ["Backlog", "Ready", "In progress", "Review", "Done", "Cancelled"]) {
      expect(screen.getByRole("region", { name: lane })).toBeTruthy();
    }
    expect(
      within(screen.getByRole("region", { name: "Ready" })).getByRole("button", {
        name: "Select task #2: Ship search",
      }),
    ).toBeTruthy();
    expect(screen.getAllByRole("button")).toHaveLength(items.length);
  });

  it("announces an empty result while preserving the board lanes", () => {
    render(
      <TaskSearchResults
        items={[]}
        presentation="board"
        visibleFields={["title"]}
        selectedTaskId={null}
        onSelect={vi.fn()}
      />,
    );

    expect(screen.getByRole("status").textContent).toBe("No tasks match this view.");
    expect(screen.getAllByRole("heading", { level: 2 })).toHaveLength(6);
    expect(screen.queryByRole("button")).toBeNull();
  });

  it("honors a saved priority grouping in list presentation", () => {
    render(
      <TaskSearchResults
        items={[
          item("task-1", 1, "Urgent task", "ready"),
          item("task-2", 2, "Normal task", "review"),
        ]}
        grouping={{ type: "priority" }}
        visibleFields={["title", "priority"]}
      />,
    );

    expect(screen.getByRole("region", { name: "Urgent" })).toBeTruthy();
    expect(screen.getByRole("region", { name: "Normal" })).toBeTruthy();
    expect(
      within(screen.getByRole("region", { name: "Urgent" })).getByText("Urgent task"),
    ).toBeTruthy();
  });
});
