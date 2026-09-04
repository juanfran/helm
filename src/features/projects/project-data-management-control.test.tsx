// @vitest-environment jsdom

import { cleanup, fireEvent, render, screen, waitFor, within } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { afterEach, describe, expect, it, vi } from "vitest";

import type { ProjectImportExecutionResult, ProjectImportPreview } from "../../domain/portability";
import { ProjectDataManagementControl } from "./project-data-management-control";

const previewToken = `hip1:${"a".repeat(64)}:${"b".repeat(64)}`;
const project = { id: "project-1", name: "Helm" };

function preview(overrides: Partial<ProjectImportPreview> = {}): ProjectImportPreview {
  return {
    format: "helm-project-import-preview",
    schemaVersion: 1,
    sourceFormat: "json",
    sourceProjectId: "source-project",
    targetProjectId: project.id,
    creates: [
      {
        entityType: "task",
        sourceId: "source-task-2",
        targetId: "task-2",
        message: "Create task #2.",
      },
    ],
    updates: [
      {
        entityType: "project",
        sourceId: "source-project",
        targetId: project.id,
        message: "Update project settings.",
      },
    ],
    noOps: [
      {
        entityType: "task",
        sourceId: "source-task-1",
        targetId: "task-1",
        message: "Task #1 already matches.",
      },
    ],
    conflicts: [],
    unsupported: [],
    executable: true,
    previewToken,
    ...overrides,
  };
}

function executionResult(source: ProjectImportPreview = preview()): ProjectImportExecutionResult {
  return {
    format: "helm-project-import-result",
    schemaVersion: 1,
    sourceFormat: source.sourceFormat,
    sourceProjectId: source.sourceProjectId,
    targetProjectId: source.targetProjectId,
    creates: source.creates,
    updates: source.updates,
    noOps: source.noOps,
    conflicts: [],
    unsupported: [],
    executed: true,
    operationId: "import-operation-1",
    eventCursors: [41, 42],
  };
}

function importFile(name: string, content: string, type: string) {
  const file = new File([content], name, { type });
  Object.defineProperty(file, "text", {
    configurable: true,
    value: vi.fn().mockResolvedValue(content),
  });
  return file;
}

function oversizedImportFile(name: string, type: string, size: number) {
  const file = new File(["must not be read"], name, { type });
  const read = vi.fn().mockResolvedValue("must not be read");
  Object.defineProperty(file, "text", { configurable: true, value: read });
  Object.defineProperty(file, "size", { configurable: true, value: size });
  return { file, read };
}

afterEach(() => {
  cleanup();
  vi.restoreAllMocks();
  vi.unstubAllGlobals();
});

describe("ProjectDataManagementControl", () => {
  it("offers exact and portable downloads for the project or a saved view", async () => {
    const user = userEvent.setup();
    render(
      <ProjectDataManagementControl
        project={project}
        savedViews={[{ id: "view-ready", name: "Ready for agents" }]}
        onPreview={vi.fn()}
        onExecute={vi.fn()}
      />,
    );

    expect(screen.getByRole("link", { name: /SQLite backup/ }).getAttribute("href")).toBe(
      "/api/portability?format=sqlite",
    );
    expect(screen.getByRole("link", { name: /JSON export/ }).getAttribute("href")).toBe(
      "/api/portability?format=json&projectId=project-1",
    );
    expect(screen.getByRole("link", { name: /Markdown export/ }).getAttribute("href")).toBe(
      "/api/portability?format=markdown&projectId=project-1",
    );
    await user.selectOptions(screen.getByLabelText("Markdown scope"), "view-ready");
    expect(screen.getByRole("link", { name: /Markdown export/ }).getAttribute("href")).toBe(
      "/api/portability?format=markdown&projectId=project-1&savedViewId=view-ready",
    );
    expect(screen.getByRole("link", { name: /Markdown export/ }).textContent).toContain(
      "Ready for agents",
    );
  });

  it("leaves the unbounded SQLite backup to the browser's native download pipeline", () => {
    const fetchMock = vi.fn();
    const createObjectUrl = vi.spyOn(URL, "createObjectURL");
    vi.stubGlobal("fetch", fetchMock);
    render(
      <ProjectDataManagementControl project={project} onPreview={vi.fn()} onExecute={vi.fn()} />,
    );

    const link = screen.getByRole("link", { name: /SQLite backup/ });
    window.addEventListener("click", (event) => event.preventDefault(), {
      capture: true,
      once: true,
    });
    fireEvent.click(link);

    expect(link.getAttribute("href")).toBe("/api/portability?format=sqlite");
    expect(link.hasAttribute("download")).toBe(true);
    expect(fetchMock).not.toHaveBeenCalled();
    expect(createObjectUrl).not.toHaveBeenCalled();
  });

  it("downloads only successful bounded responses and surfaces safe download failures", async () => {
    const createObjectUrl = vi.spyOn(URL, "createObjectURL").mockReturnValue("blob:helm-export");
    const revokeObjectUrl = vi.spyOn(URL, "revokeObjectURL").mockImplementation(() => undefined);
    const anchorClick = vi
      .spyOn(HTMLAnchorElement.prototype, "click")
      .mockImplementation(() => undefined);
    const fetchMock = vi
      .fn()
      .mockResolvedValueOnce(
        new Response("json", {
          status: 200,
          headers: {
            "Content-Disposition":
              "attachment; filename=\"helm.json\"; filename*=UTF-8''helm-%C3%A9.json",
          },
        }),
      )
      .mockResolvedValueOnce(
        Response.json(
          { error: { message: "The requested project was not found." } },
          { status: 404 },
        ),
      );
    vi.stubGlobal("fetch", fetchMock);
    render(
      <ProjectDataManagementControl project={project} onPreview={vi.fn()} onExecute={vi.fn()} />,
    );

    fireEvent.click(screen.getByRole("link", { name: /JSON export/ }));
    await waitFor(() => expect(anchorClick).toHaveBeenCalledTimes(1));
    expect(fetchMock).toHaveBeenCalledWith("/api/portability?format=json&projectId=project-1");
    expect(createObjectUrl).toHaveBeenCalled();
    expect(revokeObjectUrl).toHaveBeenCalledWith("blob:helm-export");
    expect(screen.getByRole("status").textContent).toContain("JSON export is ready");

    fireEvent.click(screen.getByRole("link", { name: /Markdown export/ }));
    expect((await screen.findByRole("alert")).textContent).toContain(
      "The requested project was not found.",
    );
    expect(anchorClick).toHaveBeenCalledTimes(1);
  });

  it("previews the selected file and executes the exact authoritative preview", async () => {
    const user = userEvent.setup();
    const selectedPreview = preview();
    const result = executionResult(selectedPreview);
    const onPreview = vi.fn(async () => ({ ok: true as const, preview: selectedPreview }));
    const onExecute = vi.fn(async () => ({ ok: true as const, result }));
    const onComplete = vi.fn();
    render(
      <ProjectDataManagementControl
        project={project}
        onPreview={onPreview}
        onExecute={onExecute}
        onComplete={onComplete}
      />,
    );

    const content = '{"format":"helm-project-export","schemaVersion":1}';
    expect(screen.getByLabelText("Import reason").getAttribute("maxlength")).toBe("1000");
    await user.upload(
      screen.getByLabelText("JSON or CSV file"),
      importFile("helm-export.json", content, "application/json"),
    );
    expect((await screen.findByRole("status")).textContent).toContain("ready to preview");
    await user.type(screen.getByLabelText("Import reason"), "Restore the reviewed snapshot.");
    await user.click(screen.getByRole("button", { name: "Preview import" }));

    expect(onPreview).toHaveBeenCalledWith({
      source: { format: "json", content },
      targetProjectId: project.id,
      reason: "Restore the reviewed snapshot.",
    });
    const previewRegion = await screen.findByRole("region", { name: "Import preview" });
    expect(within(previewRegion).getByRole("heading", { name: "Ready to import" })).toBeTruthy();
    const counts = within(previewRegion).getByText("Creates", { selector: "dt" }).parentElement;
    expect(within(counts!).getByRole("definition").textContent).toBe("1");
    expect(
      within(previewRegion).getByRole("region", { name: "Creates details" }).textContent,
    ).toContain("Create task #2.");
    expect(
      within(previewRegion).getByRole("region", { name: "Updates details" }).textContent,
    ).toContain("Update project settings.");
    expect(
      within(previewRegion).getByRole("region", { name: "No changes details" }).textContent,
    ).toContain("Task #1 already matches.");

    await user.click(screen.getByRole("button", { name: "Import 2 changes" }));
    expect(onExecute).toHaveBeenCalledWith({
      source: { format: "json", content },
      targetProjectId: project.id,
      reason: "Restore the reviewed snapshot.",
      previewToken,
      idempotencyKey: expect.any(String),
    });
    await waitFor(() => expect(onComplete).toHaveBeenCalledWith(result));
    expect(screen.getByRole("status").textContent).toContain("Import complete");
    expect(screen.queryByRole("region", { name: "Import preview" })).toBeNull();
  });

  it("shows every blocking diagnostic and never enables execution", async () => {
    const user = userEvent.setup();
    const blocked = preview({
      creates: [],
      updates: [],
      noOps: [],
      conflicts: [
        {
          category: "conflict",
          code: "repository_conflict",
          message: "The repository root belongs to another project.",
          entityType: "project",
          sourceId: "source-project",
          targetId: project.id,
          path: ["project", "repositoryRoot"],
        },
      ],
      unsupported: [
        {
          category: "unsupported",
          code: "future_column",
          message: "Column future_mode is not supported.",
          entityType: "task",
          sourceId: "source-task-3",
          targetId: null,
          path: ["tasks", 2, "future_mode"],
        },
      ],
      executable: false,
    });
    const onExecute = vi.fn();
    render(
      <ProjectDataManagementControl
        project={project}
        onPreview={vi.fn(async () => ({ ok: true as const, preview: blocked }))}
        onExecute={onExecute}
      />,
    );

    await user.upload(
      screen.getByLabelText("JSON or CSV file"),
      importFile("tasks.csv", "title,priority\nOne,high", "text/csv"),
    );
    await user.type(screen.getByLabelText("Import reason"), "Bring in planned work.");
    await user.click(screen.getByRole("button", { name: "Preview import" }));

    const previewRegion = await screen.findByRole("region", { name: "Import preview" });
    expect(within(previewRegion).getByRole("heading", { name: "Import is blocked" })).toBeTruthy();
    expect(
      within(previewRegion).getByRole("region", { name: "Conflicts details" }).textContent,
    ).toContain("The repository root belongs to another project.");
    expect(
      within(previewRegion).getByRole("region", { name: "Unsupported details" }).textContent,
    ).toContain("Column future_mode is not supported.");
    expect(screen.getByRole("button", { name: "Import 0 changes" }).hasAttribute("disabled")).toBe(
      true,
    );
    expect(onExecute).not.toHaveBeenCalled();
  });

  it("keeps large previews readable while preserving authoritative counts", async () => {
    const user = userEvent.setup();
    const creates = Array.from({ length: 101 }, (_, index) => ({
      entityType: "task" as const,
      sourceId: `source-task-${index + 1}`,
      targetId: `task-${index + 1}`,
      message: `Create bounded task ${index + 1}.`,
    }));
    render(
      <ProjectDataManagementControl
        project={project}
        onPreview={vi.fn(async () => ({
          ok: true as const,
          preview: preview({ creates, updates: [], noOps: [] }),
        }))}
        onExecute={vi.fn()}
      />,
    );

    await user.upload(
      screen.getByLabelText("JSON or CSV file"),
      importFile("many.json", "{}", "application/json"),
    );
    await user.type(screen.getByLabelText("Import reason"), "Preview a large archive.");
    await user.click(screen.getByRole("button", { name: "Preview import" }));

    const previewRegion = await screen.findByRole("region", { name: "Import preview" });
    const createsRegion = within(previewRegion).getByRole("region", {
      name: "Creates details",
    });
    const createCount = within(previewRegion).getByText("Creates", {
      selector: "dt",
    }).parentElement;
    expect(within(createCount!).getByRole("definition").textContent).toBe("101");
    expect(createsRegion.textContent).toContain("Create bounded task 100.");
    expect(createsRegion.textContent).not.toContain("Create bounded task 101.");
    expect(createsRegion.textContent).toContain("Showing the first 100 of 101 details.");
  });

  it("creates a project from JSON on an empty instance and rejects CSV as a destination", async () => {
    const user = userEvent.setup();
    const newProjectPreview = preview({ targetProjectId: null });
    const onPreview = vi.fn(async () => ({ ok: true as const, preview: newProjectPreview }));
    render(
      <ProjectDataManagementControl project={null} onPreview={onPreview} onExecute={vi.fn()} />,
    );

    expect(screen.queryByRole("link", { name: /JSON export/ })).toBeNull();
    await user.upload(
      screen.getByLabelText("JSON or CSV file"),
      importFile("restore.json", "{}", "application/json"),
    );
    await user.type(
      screen.getByLabelText("Repository root for the imported project"),
      "/projects/restored",
    );
    await user.type(screen.getByLabelText("Import reason"), "Restore this project locally.");
    await user.click(screen.getByRole("button", { name: "Preview import" }));
    expect(onPreview).toHaveBeenCalledWith({
      source: { format: "json", content: "{}" },
      targetProjectId: null,
      repositoryRoot: "/projects/restored",
      reason: "Restore this project locally.",
    });

    await user.upload(
      screen.getByLabelText("JSON or CSV file"),
      importFile("tasks.csv", "title\nOne", "text/csv"),
    );
    expect(screen.getByText(/CSV needs an existing project/)).toBeTruthy();
    expect(screen.getByRole("button", { name: "Preview import" }).hasAttribute("disabled")).toBe(
      true,
    );
  });

  it("invalidates a preview after input changes and reuses its key after an uncertain response", async () => {
    const user = userEvent.setup();
    const selectedPreview = preview();
    const onExecute = vi
      .fn()
      .mockRejectedValueOnce(new Error("response lost"))
      .mockResolvedValueOnce({ ok: true as const, result: executionResult(selectedPreview) });
    render(
      <ProjectDataManagementControl
        project={project}
        onPreview={vi.fn(async () => ({ ok: true as const, preview: selectedPreview }))}
        onExecute={onExecute}
      />,
    );

    await user.upload(
      screen.getByLabelText("JSON or CSV file"),
      importFile("restore.json", "{}", "application/json"),
    );
    const reason = screen.getByLabelText("Import reason");
    await user.type(reason, "Restore data.");
    await user.click(screen.getByRole("button", { name: "Preview import" }));
    await screen.findByRole("region", { name: "Import preview" });

    await user.click(screen.getByRole("button", { name: "Import 2 changes" }));
    expect((await screen.findByRole("alert")).textContent).toContain(
      "could not confirm whether the import completed",
    );
    const firstKey = onExecute.mock.calls[0]![0].idempotencyKey;
    await user.click(screen.getByRole("button", { name: "Import 2 changes" }));
    await waitFor(() => expect(onExecute).toHaveBeenCalledTimes(2));
    expect(onExecute.mock.calls[1]![0].idempotencyKey).toBe(firstKey);

    await user.upload(
      screen.getByLabelText("JSON or CSV file"),
      importFile("restore-again.json", '{"second":true}', "application/json"),
    );
    expect(screen.queryByRole("region", { name: "Import preview" })).toBeNull();
  });

  it("cannot execute an earlier preview while a replacement preview is pending", async () => {
    const user = userEvent.setup();
    let resolveReplacement:
      | ((value: { readonly ok: true; readonly preview: ProjectImportPreview }) => void)
      | undefined;
    const replacement = new Promise<{ readonly ok: true; readonly preview: ProjectImportPreview }>(
      (resolve) => {
        resolveReplacement = resolve;
      },
    );
    const onPreview = vi
      .fn()
      .mockResolvedValueOnce({ ok: true as const, preview: preview() })
      .mockReturnValueOnce(replacement);
    const onExecute = vi.fn();
    render(
      <ProjectDataManagementControl
        project={project}
        onPreview={onPreview}
        onExecute={onExecute}
      />,
    );

    await user.upload(
      screen.getByLabelText("JSON or CSV file"),
      importFile("restore.json", "{}", "application/json"),
    );
    await user.type(screen.getByLabelText("Import reason"), "Restore data.");
    await user.click(screen.getByRole("button", { name: "Preview import" }));
    await screen.findByRole("region", { name: "Import preview" });

    await user.click(screen.getByRole("button", { name: "Preview import" }));
    const importButton = screen.getByRole("button", { name: "Import 2 changes" });
    expect(importButton.hasAttribute("disabled")).toBe(true);
    await user.click(importButton);
    expect(onExecute).not.toHaveBeenCalled();

    resolveReplacement?.({ ok: true, preview: preview() });
    await waitFor(() => expect(importButton.hasAttribute("disabled")).toBe(false));
  });

  it("reports an unreadable or unsupported file without calling the preview command", async () => {
    const user = userEvent.setup();
    const onPreview = vi.fn();
    render(
      <ProjectDataManagementControl project={project} onPreview={onPreview} onExecute={vi.fn()} />,
    );

    const unreadable = importFile("locked.json", "{}", "application/json");
    Object.defineProperty(unreadable, "text", {
      configurable: true,
      value: vi.fn().mockRejectedValue(new Error("denied")),
    });
    await user.upload(screen.getByLabelText("JSON or CSV file"), unreadable);
    expect((await screen.findByRole("alert")).textContent).toContain("could not read locked.json");

    fireEvent.change(screen.getByLabelText("JSON or CSV file"), {
      target: { files: [importFile("notes.txt", "hello", "text/plain")] },
    });
    expect(screen.getByRole("alert").textContent).toContain("Choose a JSON project export");
    expect(onPreview).not.toHaveBeenCalled();
  });

  it.each([
    ["oversized.csv", "text/csv", 2 * 1024 * 1024 + 1, "CSV", "2 MiB"],
    ["oversized.json", "application/json", 64 * 1024 * 1024 + 1, "JSON", "64 MiB"],
  ])("rejects %s from file metadata before reading it", async (name, type, size, format, limit) => {
    const user = userEvent.setup();
    const onPreview = vi.fn();
    const { file, read } = oversizedImportFile(name, type, size);
    render(
      <ProjectDataManagementControl project={project} onPreview={onPreview} onExecute={vi.fn()} />,
    );

    const input = screen.getByLabelText("JSON or CSV file");
    if (!(input instanceof HTMLInputElement)) throw new Error("Expected a file input.");
    expect(screen.getByText(/Maximum size: 64 MiB for JSON and 2 MiB for CSV/)).toBeTruthy();
    await user.upload(input, file);

    const alert = await screen.findByRole("alert");
    expect(alert.textContent).toContain(`${name} is too large for a ${format} import`);
    expect(alert.textContent).toContain(`${format} imports may be at most ${limit}`);
    expect(read).not.toHaveBeenCalled();
    expect(input.value).toBe("");
    expect(onPreview).not.toHaveBeenCalled();
  });
});
