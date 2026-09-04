// @vitest-environment jsdom

import { cleanup, fireEvent, render, screen, waitFor, within } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { useState } from "react";
import { afterEach, describe, expect, it, vi } from "vitest";

import type {
  BulkTaskExecutionResult,
  BulkTaskPreview,
  BulkTaskValidationFailure,
} from "../../domain/bulk-tasks";
import type { TaskTag } from "../../domain/tasks";
import { BulkTaskControls, type BulkTaskControlsProps } from "./bulk-task-controls";
import { useVisibleTaskSelection } from "./visible-task-selection";

const previewToken = `btp1:${"a".repeat(64)}:${"b".repeat(64)}`;
const tags: readonly TaskTag[] = [
  {
    id: "tag-frontend",
    name: "Frontend",
    description: "Browser work",
    color: "#2563eb",
    exclusiveGroup: "area",
    reviewModeOverride: null,
  },
];

function preview(overrides: Partial<BulkTaskPreview> = {}): BulkTaskPreview {
  return {
    schemaVersion: 1,
    mode: "atomic",
    kind: "update",
    projectId: "project-1",
    matchedCount: 2,
    affectedCount: 2,
    executable: true,
    targets: [
      {
        targetKey: "task-1",
        clientId: null,
        taskId: "task-1",
        sequence: 1,
        title: "First task",
        expectedVersion: 1,
        projectedVersion: 2,
        changed: true,
        changes: [{ field: "priority", before: "normal", after: "high" }],
        failures: [],
      },
      {
        targetKey: "task-2",
        clientId: null,
        taskId: "task-2",
        sequence: 2,
        title: "Second task",
        expectedVersion: 3,
        projectedVersion: 4,
        changed: true,
        changes: [{ field: "priority", before: "low", after: "high" }],
        failures: [],
      },
    ],
    failures: [],
    previewToken,
    ...overrides,
  };
}

function executionResult(): BulkTaskExecutionResult {
  return {
    schemaVersion: 1,
    mode: "atomic",
    kind: "update",
    operationId: "operation-1",
    projectId: "project-1",
    matchedCount: 2,
    affectedCount: 2,
    parentEventCursor: 42,
    items: [
      { targetKey: "task-1", clientId: null, taskId: "task-1", version: 2, changed: true },
      { targetKey: "task-2", clientId: null, taskId: "task-2", version: 4, changed: true },
    ],
  };
}

function renderControls({
  onPreview,
  onExecute,
  exposeSelectionControls = false,
}: Pick<BulkTaskControlsProps, "onPreview" | "onExecute"> & {
  exposeSelectionControls?: boolean;
}) {
  function ControlledHarness() {
    const [selectedTaskIds, setSelectedTaskIds] = useState<ReadonlySet<string>>(
      new Set(["task-1", "task-2"]),
    );
    const selection = useVisibleTaskSelection({
      visibleTaskIds: ["task-1", "task-2"],
      selectedTaskIds,
      onSelectedTaskIdsChange: setSelectedTaskIds,
    });
    return (
      <>
        <BulkTaskControls
          projectId="project-1"
          tagDefinitions={tags}
          selection={selection}
          onPreview={onPreview}
          onExecute={onExecute}
        />
        {exposeSelectionControls ? (
          <>
            <button type="button" onClick={() => selection.setTaskSelected("task-2", false)}>
              Deselect second test task
            </button>
            <button type="button" onClick={() => selection.setTaskSelected("task-2", true)}>
              Select second test task
            </button>
          </>
        ) : null}
      </>
    );
  }

  return render(<ControlledHarness />);
}

async function requestPriorityPreview(user: ReturnType<typeof userEvent.setup>) {
  await user.click(screen.getByRole("button", { name: "Bulk edit" }));
  await user.type(screen.getByLabelText("Bulk update reason"), "Align the visible queue.");
  await user.click(screen.getByRole("button", { name: "Preview changes" }));
  return screen.findByRole("region", { name: "Bulk update preview" });
}

afterEach(cleanup);

describe("BulkTaskControls", () => {
  it("previews only explicit visible IDs and clears and announces a successful execution", async () => {
    const user = userEvent.setup();
    const onPreview = vi.fn(async () => ({ ok: true as const, preview: preview() }));
    const onExecute = vi.fn(async () => ({ ok: true as const, result: executionResult() }));
    renderControls({ onPreview, onExecute });

    const master = screen.getByRole("checkbox", { name: "Select all 2 visible tasks" });
    expect(master.getAttribute("aria-checked")).toBe("true");
    await requestPriorityPreview(user);

    expect(onPreview).toHaveBeenCalledWith({
      schemaVersion: 1,
      kind: "update",
      projectId: "project-1",
      reason: "Align the visible queue.",
      selection: { type: "ids", taskIds: ["task-1", "task-2"] },
      patch: { priority: "high" },
    });
    expect(screen.getByText("normal →")).toBeTruthy();
    expect(document.body.textContent).not.toContain(previewToken);

    await user.click(screen.getByRole("button", { name: "Apply to 2" }));
    expect(onExecute).toHaveBeenCalledWith({
      intent: expect.objectContaining({
        selection: { type: "ids", taskIds: ["task-1", "task-2"] },
      }),
      previewToken,
      idempotencyKey: expect.any(String),
    });
    await waitFor(() => expect(screen.queryByRole("dialog")).toBeNull());
    expect(screen.getByText("0 of 2 visible selected")).toBeTruthy();
    expect(screen.getByRole("status").textContent).toBe("2 tasks updated successfully.");
  });

  it("renders exclusive-tag failures and disables execution", async () => {
    const user = userEvent.setup();
    const failure: BulkTaskValidationFailure = {
      code: "exclusive_tag_conflict",
      message: "Remove the existing area tag before adding Frontend.",
      targetKey: "task-1",
      taskId: "task-1",
      field: "tags",
    };
    const invalidPreview = preview({
      affectedCount: 0,
      executable: false,
      failures: [failure],
      targets: [
        {
          ...preview().targets[0]!,
          changed: false,
          projectedVersion: 1,
          changes: [],
          failures: [failure],
        },
      ],
    });
    const onPreview = vi.fn(async () => ({ ok: true as const, preview: invalidPreview }));
    const onExecute = vi.fn();
    renderControls({ onPreview, onExecute });

    await user.click(screen.getByRole("button", { name: "Bulk edit" }));
    await user.selectOptions(screen.getByLabelText("Bulk operation"), "add_tag");
    await user.type(screen.getByLabelText("Bulk update reason"), "Classify visible work.");
    await user.click(screen.getByRole("button", { name: "Preview changes" }));

    const previewRegion = await screen.findByRole("region", { name: "Bulk update preview" });
    expect(within(previewRegion).getByText(failure.message)).toBeTruthy();
    expect(screen.getByRole("button", { name: "Apply to 0" }).matches(":disabled")).toBe(true);
    expect(onExecute).not.toHaveBeenCalled();
  });

  it("preserves the draft and selection but requires a new preview after a stale response", async () => {
    const user = userEvent.setup();
    const onPreview = vi.fn(async () => ({ ok: true as const, preview: preview() }));
    const onExecute = vi.fn(async () => ({
      ok: false as const,
      error: {
        type: "BulkTaskPreviewStaleError" as const,
        reason: "target_version_changed" as const,
        taskIds: ["task-1"],
        message: "A selected task changed. Preview the update again.",
      },
    }));
    renderControls({ onPreview, onExecute });
    await requestPriorityPreview(user);

    await user.click(screen.getByRole("button", { name: "Apply to 2" }));
    expect((await screen.findByRole("alert")).textContent).toContain(
      "A selected task changed. Preview the update again.",
    );
    expect(screen.getByRole("form", { name: "Configure bulk task update" })).toBeTruthy();
    expect(screen.getByLabelText("Bulk update reason")).toHaveProperty(
      "value",
      "Align the visible queue.",
    );
    expect(screen.getByText("2 of 2 visible selected")).toBeTruthy();

    await user.click(screen.getByRole("button", { name: "Preview changes" }));
    await waitFor(() => expect(onPreview).toHaveBeenCalledTimes(2));
  });

  it("requires a new preview after the selection changes and is restored", async () => {
    const user = userEvent.setup();
    const onPreview = vi.fn(async () => ({ ok: true as const, preview: preview() }));
    renderControls({ onPreview, onExecute: vi.fn(), exposeSelectionControls: true });
    const deselectSecond = screen.getByRole("button", { name: "Deselect second test task" });
    const selectSecond = screen.getByRole("button", { name: "Select second test task" });
    await requestPriorityPreview(user);

    fireEvent.click(deselectSecond);
    expect(await screen.findByRole("form", { name: "Configure bulk task update" })).toBeTruthy();
    expect(screen.getByRole("alert").textContent).toContain("selection changed");

    fireEvent.click(selectSecond);
    expect(screen.getByRole("form", { name: "Configure bulk task update" })).toBeTruthy();
    expect(screen.queryByRole("button", { name: "Apply to 2" })).toBeNull();
    expect(screen.getByLabelText("Bulk update reason")).toHaveProperty(
      "value",
      "Align the visible queue.",
    );
  });

  it("reuses the execution idempotency key after an uncertain transport failure", async () => {
    const user = userEvent.setup();
    const onPreview = vi.fn(async () => ({ ok: true as const, preview: preview() }));
    const onExecute = vi
      .fn()
      .mockRejectedValueOnce(new Error("response lost"))
      .mockResolvedValueOnce({ ok: true as const, result: executionResult() });
    renderControls({ onPreview, onExecute });
    await requestPriorityPreview(user);

    await user.click(screen.getByRole("button", { name: "Apply to 2" }));
    expect((await screen.findByRole("alert")).textContent).toContain(
      "Retry to safely use the same request",
    );
    const firstKey = onExecute.mock.calls[0]![0].idempotencyKey;

    await user.click(screen.getByRole("button", { name: "Apply to 2" }));
    await waitFor(() => expect(onExecute).toHaveBeenCalledTimes(2));
    expect(onExecute.mock.calls[1]![0].idempotencyKey).toBe(firstKey);
  });
});
