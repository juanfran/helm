// @vitest-environment jsdom
import { act, cleanup, renderHook } from "@testing-library/react";
import { afterEach, describe, expect, it, vi } from "vitest";
import { emptyRichTextDocument, taskSchema } from "../../domain/tasks";
import { reconcileChecklist, useTaskDraft } from "./task-draft";

const task = taskSchema.parse({
  id: "draft-task",
  projectId: "project",
  sequence: 1,
  parentTaskId: null,
  childTaskIds: [],
  title: "Original",
  lifecycle: "backlog",
  priority: "normal",
  position: 1,
  notBefore: null,
  dueAt: null,
  size: null,
  tags: [],
  customFields: [],
  requiredCapabilities: [],
  referencedPaths: [],
  claim: null,
  upstreamRelations: [],
  downstreamRelations: [],
  description: emptyRichTextDocument,
  descriptionText: "",
  expectedOutcome: "",
  acceptanceCriteria: "",
  agentContext: "",
  checklist: [],
  reviewAttemptId: null,
  cancelledFromLifecycle: null,
  version: 1,
  archivedAt: null,
  createdAt: "2026-09-05T10:00:00.000Z",
  updatedAt: "2026-09-05T10:00:00.000Z",
  reviewModeOverride: null,
  reviewPolicy: null,
});
afterEach(() => {
  cleanup();
  vi.restoreAllMocks();
  sessionStorage.clear();
});

describe("recoverable task drafts", () => {
  it("preserves checklist identities and completion when lines are unchanged or reordered", () => {
    const saved = [
      { id: "done", text: "Test", checked: true },
      { id: "todo", text: "Ship", checked: false },
    ];
    expect(reconcileChecklist("Ship\nTest", saved)).toEqual([saved[1], saved[0]]);
    const changed = reconcileChecklist("Test\nTest\nNew requirement", saved);
    expect(changed[0]).toEqual(saved[0]);
    expect(changed.slice(1).every((item) => !item.checked && item.id !== "done")).toBe(true);
    expect(new Set(changed.map((item) => item.id)).size).toBe(3);
    expect(reconcileChecklist("", saved)).toEqual([]);
  });
  it("preserves unfinished text across navigation and reloads", () => {
    const first = renderHook(() => useTaskDraft(task));
    act(() => first.result.current.field("expectedOutcome")[1]("Still thinking"));
    first.unmount();
    const next = renderHook(() => useTaskDraft(task));
    expect(next.result.current.field("expectedOutcome")[0]).toBe("Still thinking");
    expect(next.result.current.dirty).toBe(true);
  });
  it("preserves edits during agent updates and requires explicit reconciliation", () => {
    const hook = renderHook(({ current }) => useTaskDraft(current), {
      initialProps: { current: task },
    });
    act(() => hook.result.current.field("expectedOutcome")[1]("My edit"));
    hook.rerender({ current: { ...task, priority: "high", version: 2 } });
    expect(hook.result.current.conflict).toBe(true);
    expect(hook.result.current.baseVersion).toBe(1);
    expect(hook.result.current.field("expectedOutcome")[0]).toBe("My edit");
    act(() => hook.result.current.rebase());
    expect(hook.result.current.field("priority")[0]).toBe("high");
    expect(hook.result.current.field("expectedOutcome")[0]).toBe("My edit");
    expect(hook.result.current.baseVersion).toBe(2);
    expect(hook.result.current.conflict).toBe(false);
  });
  it("updates a clean form, preserves a dirty form when work becomes active, and clears only after save", () => {
    const hook = renderHook(({ current }) => useTaskDraft(current), {
      initialProps: { current: task },
    });
    hook.rerender({ current: { ...task, title: "Updated remotely", version: 2 } });
    expect(hook.result.current.field("title")[0]).toBe("Updated remotely");
    act(() => hook.result.current.field("title")[1]("Human draft"));
    hook.rerender({ current: { ...task, lifecycle: "in_progress", version: 3 } });
    expect(hook.result.current.field("title")[0]).toBe("Human draft");
    expect(hook.result.current.conflict).toBe(true);
    act(() => hook.result.current.accept({ ...task, title: "Human draft", version: 4 }));
    expect(hook.result.current.dirty).toBe(false);
    expect(hook.result.current.field("title")[0]).toBe("Human draft");
    expect(sessionStorage.length).toBe(0);
  });
  it("ignores corrupt browser drafts", () => {
    sessionStorage.setItem("helm.task-draft.v1.project.draft-task", "not json");
    const hook = renderHook(() => useTaskDraft(task));
    expect(hook.result.current.field("title")[0]).toBe("Original");
  });
  it("retains drafts during navigation when browser storage is unavailable", () => {
    vi.spyOn(Storage.prototype, "setItem").mockImplementation(() => {
      throw new Error("Storage full");
    });
    const first = renderHook(() => useTaskDraft(task));
    act(() => first.result.current.field("title")[1]("Keep this in memory"));
    expect(first.result.current.storageAvailable).toBe(false);
    first.unmount();
    const next = renderHook(() => useTaskDraft(task));
    expect(next.result.current.field("title")[0]).toBe("Keep this in memory");
    act(() => next.result.current.discard());
  });
});
