// @vitest-environment jsdom

import { QueryClient } from "@tanstack/react-query";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { taskSchema, emptyRichTextDocument } from "../../domain/tasks";
import { getWorkspaceData } from "./workspace-data";
import { loadWorkspacePage } from "./workspace-loader";

const api = vi.hoisted(() => ({
  readTasks: vi.fn(),
  readTaskAttempts: vi.fn(),
  readActivityEntries: vi.fn(),
  readManualBlockers: vi.fn(),
  readProjectEvents: vi.fn(),
  readImportantProjectEvents: vi.fn(),
  readAppState: vi.fn(),
  readProjects: vi.fn(),
  readProjectCustomization: vi.fn(),
  readTaskTags: vi.fn(),
  readSavedViews: vi.fn(),
}));
vi.mock("../../server/task-functions", () => api);
vi.mock("../../server/activity-functions", () => api);
vi.mock("../../server/important-project-event-functions", () => api);
vi.mock("../../server/project-functions", () => api);
vi.mock("../../server/customization-functions", () => api);
vi.mock("../../server/task-tag-functions", () => api);
vi.mock("../../server/task-query-functions", () => api);
vi.mock("./workspace-modules", () => ({
  workspaceModules: {
    taskDetail: { preload: vi.fn() },
    dashboard: { preload: vi.fn() },
    activity: { preload: vi.fn() },
    settings: { preload: vi.fn() },
  },
}));

const project = {
  id: "project-1",
  sequence: 1,
  name: "Sample",
  repositoryRoot: "/sample",
  reviewMode: "required",
  version: 1,
  createdAt: "2026-09-01T00:00:00Z",
  updatedAt: "2026-09-01T00:00:00Z",
};
const task = taskSchema.parse({
  id: "task-1",
  projectId: project.id,
  sequence: 1,
  parentTaskId: null,
  title: "Prepare work",
  lifecycle: "backlog",
  description: emptyRichTextDocument,
  descriptionText: "",
  expectedOutcome: "",
  acceptanceCriteria: "",
  agentContext: "",
  checklist: [],
  version: 1,
  archivedAt: null,
  createdAt: project.createdAt,
  updatedAt: project.updatedAt,
});
let client: QueryClient;

beforeEach(() => {
  vi.resetAllMocks();
  client = new QueryClient({ defaultOptions: { queries: { retry: false } } });
  for (const mock of Object.values(api)) mock.mockResolvedValue([]);
  api.readAppState.mockResolvedValue({
    activeProject: project,
    activeProjectVersion: 1,
    theme: "light",
  });
  api.readProjects.mockResolvedValue([project]);
  api.readTasks.mockResolvedValue([task]);
  api.readProjectEvents.mockResolvedValue({ events: [], latestCursor: 12 });
  api.readImportantProjectEvents.mockResolvedValue({ events: [] });
  api.readProjectCustomization.mockResolvedValue({
    schemaVersion: 1,
    projectId: project.id,
    projectVersion: 1,
    definitions: [],
    tagReviewRules: [],
  });
});
afterEach(() => client.clear());

function deferred<T>() {
  let resolve!: (value: T | PromiseLike<T>) => void;
  const promise = new Promise<T>((accept) => {
    resolve = accept;
  });
  return { promise, resolve };
}

describe("workspace route loading", () => {
  it("loads settings without requesting task, attempt, collaboration, or notification collections", async () => {
    await loadWorkspacePage(client, project.id, undefined, "settings");
    expect(api.readProjectCustomization).toHaveBeenCalledOnce();
    expect(api.readTasks).not.toHaveBeenCalled();
    expect(api.readTaskAttempts).not.toHaveBeenCalled();
    expect(api.readActivityEntries).not.toHaveBeenCalled();
    expect(api.readManualBlockers).not.toHaveBeenCalled();
    expect(api.readImportantProjectEvents).not.toHaveBeenCalled();
    expect(api.readProjectEvents).toHaveBeenCalledOnce(); // durable cursor only
  });

  it("renders essential task data without waiting for history or collaboration", async () => {
    const history = deferred<never[]>();
    const collaboration = deferred<never[]>();
    api.readTaskAttempts.mockReturnValue(history.promise);
    api.readActivityEntries.mockReturnValue(collaboration.promise);
    await loadWorkspacePage(client, project.id, task.id);
    const data = getWorkspaceData(client, project.id);
    expect(data.resources.tasks.ready).toBe(true);
    expect(data.resources.attempts.ready).toBe(false);
    expect(data.resources.activity.ready).toBe(false);
    expect(data.collections.tasks.get(task.id)?.title).toBe(task.title);
    history.resolve([]);
    collaboration.resolve([]);
    await Promise.all([data.resources.attempts.ensure(), data.resources.activity.ensure()]);
  });

  it("does not refetch project collections or metadata when switching cached tasks", async () => {
    await loadWorkspacePage(client, project.id, task.id);
    await Promise.all(
      Object.values(getWorkspaceData(client, project.id).resources)
        .filter((item) => item.ready)
        .map((item) => item.ensure()),
    );
    const counts = Object.fromEntries(
      Object.entries(api).map(([name, mock]) => [name, mock.mock.calls.length]),
    );
    await loadWorkspacePage(client, project.id, task.id);
    expect(
      Object.fromEntries(Object.entries(api).map(([name, mock]) => [name, mock.mock.calls.length])),
    ).toEqual(counts);
  });

  it("captures the replay cursor before reading initial task state", async () => {
    await loadWorkspacePage(client, project.id);
    expect(api.readProjectEvents.mock.invocationCallOrder[0]).toBeLessThan(
      api.readTasks.mock.invocationCallOrder[0]!,
    );
    const data = getWorkspaceData(client, project.id);
    data.advanceCursor(20);
    expect(await data.captureCursor()).toBe(20);
    expect(api.readProjectEvents).toHaveBeenCalledOnce();
  });

  it("refreshes a passed start date without refetching the full task collection", async () => {
    const notBefore = new Date(Date.now() + 86_400_000).toISOString().slice(0, 10);
    const scheduled = taskSchema.parse({
      ...task,
      lifecycle: "ready",
      notBefore,
      eligibility: {
        status: "scheduled",
        claimable: false,
        reasons: [],
        orderingExplanation: "",
        missingCapabilities: [],
      },
    });
    api.readTasks.mockResolvedValue([scheduled]);
    await loadWorkspacePage(client, project.id);
    const data = getWorkspaceData(client, project.id);
    expect(api.readTasks).toHaveBeenCalledOnce();
    api.readTasks.mockResolvedValue([
      {
        ...scheduled,
        eligibility: { ...scheduled.eligibility, status: "claimable", claimable: true },
      },
    ]);
    await data.refreshTimeSensitiveTasks(Date.parse(notBefore));
    expect(api.readTasks).toHaveBeenLastCalledWith({
      data: { projectId: project.id, taskIds: [task.id], includeArchived: true },
    });
    expect(data.collections.tasks.get(task.id)?.eligibility?.status).toBe("claimable");
    await data.refreshTimeSensitiveTasks(Date.parse(notBefore) + 1);
    expect(api.readTasks).toHaveBeenCalledTimes(2);
  });

  it("keeps deferred failure out of the route and permits a section retry", async () => {
    api.readTaskAttempts.mockRejectedValueOnce(new Error("History unavailable"));
    await expect(loadWorkspacePage(client, project.id, task.id)).resolves.toMatchObject({
      activeProject: project,
    });
    const data = getWorkspaceData(client, project.id);
    await vi.waitFor(() =>
      expect(() => data.resources.attempts.read()).toThrow("History unavailable"),
    );
    api.readTaskAttempts.mockResolvedValue([]);
    data.resources.attempts.retry();
    await data.resources.attempts.ensure();
    expect(data.resources.attempts.ready).toBe(true);
  });

  it("rejects a missing direct task URL instead of showing another task", async () => {
    api.readTasks.mockImplementation(({ data }) => Promise.resolve(data.taskIds ? [] : [task]));
    await expect(loadWorkspacePage(client, project.id, "missing")).rejects.toThrow(
      "This task could not be found",
    );
  });
});
