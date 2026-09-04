// @vitest-environment jsdom

import { act, renderHook, waitFor } from "@testing-library/react";
import { useState } from "react";
import { describe, expect, it, vi } from "vitest";

import { pruneSelectionToVisibleTaskIds, useVisibleTaskSelection } from "./visible-task-selection";

describe("visible task selection", () => {
  it("prunes hidden IDs and preserves visible ordering", () => {
    expect([
      ...pruneSelectionToVisibleTaskIds(new Set(["task-3", "hidden", "task-1"]), [
        "task-1",
        "task-2",
        "task-3",
        "task-1",
      ]),
    ]).toEqual(["task-1", "task-3"]);
  });

  it("controls individual, indeterminate, select-all, and clear states", () => {
    const { result } = renderHook(() => {
      const [selectedTaskIds, setSelectedTaskIds] = useState<ReadonlySet<string>>(new Set());
      return useVisibleTaskSelection({
        visibleTaskIds: ["task-1", "task-2"],
        selectedTaskIds,
        onSelectedTaskIdsChange: setSelectedTaskIds,
      });
    });

    expect(result.current).toMatchObject({
      checked: false,
      indeterminate: false,
      revision: 0,
      selectedCount: 0,
      visibleCount: 2,
    });

    act(() => result.current.setTaskSelected("task-2", true));
    expect([...result.current.selectedTaskIds]).toEqual(["task-2"]);
    expect(result.current.checked).toBe(false);
    expect(result.current.indeterminate).toBe(true);
    expect(result.current.revision).toBe(1);

    act(() => result.current.setAllVisibleSelected(true));
    expect([...result.current.selectedTaskIds]).toEqual(["task-1", "task-2"]);
    expect(result.current.checked).toBe(true);
    expect(result.current.indeterminate).toBe(false);
    expect(result.current.revision).toBe(2);

    act(() => result.current.clear());
    expect(result.current.selectedCount).toBe(0);
    expect(result.current.checked).toBe(false);
    expect(result.current.indeterminate).toBe(false);
    expect(result.current.revision).toBe(3);
  });

  it("immediately excludes tasks that stop being visible and updates controlled state", async () => {
    const changes = vi.fn();
    const { result, rerender } = renderHook(
      ({ visibleTaskIds }: { visibleTaskIds: readonly string[] }) => {
        const [selectedTaskIds, setSelectedTaskIds] = useState<ReadonlySet<string>>(
          new Set(["task-1", "task-2"]),
        );
        return useVisibleTaskSelection({
          visibleTaskIds,
          selectedTaskIds,
          onSelectedTaskIdsChange: (nextTaskIds) => {
            changes(nextTaskIds);
            setSelectedTaskIds(nextTaskIds);
          },
        });
      },
      { initialProps: { visibleTaskIds: ["task-1", "task-2"] } },
    );

    rerender({ visibleTaskIds: ["task-2", "task-3"] });
    expect([...result.current.selectedTaskIds]).toEqual(["task-2"]);

    await waitFor(() => expect(changes).toHaveBeenCalledTimes(1));
    expect([...changes.mock.calls[0]![0]]).toEqual(["task-2"]);

    act(() => result.current.setTaskSelected("task-1", true));
    expect([...result.current.selectedTaskIds]).toEqual(["task-2"]);
  });
});
