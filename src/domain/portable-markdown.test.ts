import { describe, expect, it } from "vitest";

import { activityEntrySchema, type ActivityEntry } from "./activity";
import { renderPortableMarkdown } from "./portable-markdown";
import type { Project } from "./projects";
import {
  emptyRichTextDocument,
  taskAttemptSummarySchema,
  taskSchema,
  type Task,
  type TaskAttemptSummary,
} from "./tasks";

const project: Project = {
  id: "project-1",
  sequence: 1,
  name: "Portable Helm",
  repositoryRoot: "/work/portable-helm",
  reviewMode: "required",
  version: 4,
  createdAt: "2026-09-01T08:00:00.000Z",
  updatedAt: "2026-09-04T12:00:00.000Z",
};

function task(overrides: Partial<Task> = {}) {
  return taskSchema.parse({
    id: "task-1",
    projectId: project.id,
    sequence: 1,
    title: "Verify portability",
    lifecycle: "ready",
    priority: "high",
    position: 2,
    description: emptyRichTextDocument,
    descriptionText: "Keep current state readable.",
    expectedOutcome: "The project can move safely.",
    acceptanceCriteria: "Current state and history are distinct.",
    agentContext: "Inspect the generated document.",
    checklist: [{ id: "check-1", text: "Read the export", checked: true }],
    version: 3,
    archivedAt: null,
    createdAt: "2026-09-02T08:00:00.000Z",
    updatedAt: "2026-09-04T10:00:00.000Z",
    ...overrides,
  });
}

function attempt(overrides: Partial<TaskAttemptSummary> = {}) {
  return taskAttemptSummarySchema.parse({
    id: "attempt-1",
    taskId: "task-1",
    attemptNumber: 1,
    agentRunId: "run-1",
    agentProfileId: "profile-1",
    agentDisplayName: "Portability agent",
    status: "completed",
    summary: "Generated and checked the archive.",
    changedAreas: ["src/domain"],
    verificationResults: [{ name: "unit tests", status: "passed", details: "All passed." }],
    references: ["issue-14"],
    risks: ["Large archives need bounded parsing."],
    followUpWork: ["Add the download adapter."],
    failureClassification: null,
    createdAt: "2026-09-03T09:00:00.000Z",
    completedAt: "2026-09-03T09:30:00.000Z",
    ...overrides,
  });
}

function entry(overrides: Partial<ActivityEntry> = {}) {
  return activityEntrySchema.parse({
    id: "entry-1",
    projectId: project.id,
    taskId: "task-1",
    attemptId: null,
    kind: "comment",
    author: { type: "human", id: "local-human" },
    authorDisplayName: "You",
    agentProfileId: null,
    content: emptyRichTextDocument,
    contentText: "The current snapshot looks correct.",
    createdAt: "2026-09-04T11:00:00.000Z",
    withdrawnAt: null,
    withdrawnBy: null,
    withdrawalReason: null,
    ...overrides,
  });
}

describe("portable Markdown", () => {
  it("renders readable current state and separately ordered attempt history", () => {
    const first = task({
      tags: [
        {
          id: "tag-2",
          name: "release",
          description: "Release readiness",
          color: "#2563eb",
          exclusiveGroup: null,
          reviewModeOverride: "required",
        },
      ],
      requiredCapabilities: ["typescript", "sqlite"],
      referencedPaths: ["src/domain/portable-markdown.ts"],
      customFields: [
        {
          definition: {
            id: "field-1",
            projectId: project.id,
            key: "risk",
            type: "number",
            validation: { min: 0, max: 5, integer: true },
            defaultValue: { type: "number", value: 2 },
            display: { label: "Risk", description: "Delivery risk" },
            position: 0,
            retiredAt: null,
            createdAt: "2026-09-01T08:00:00.000Z",
            updatedAt: "2026-09-01T08:00:00.000Z",
          },
          value: { type: "number", value: 4 },
          source: "explicit",
        },
      ],
    });
    const second = task({
      id: "task-2",
      sequence: 2,
      title: "Publish the archive",
      descriptionText: "Download it from settings.",
    });
    const markdown = renderPortableMarkdown({
      project,
      viewName: "Release readiness",
      tasks: [second, first],
      attempts: [
        attempt({ id: "attempt-2", attemptNumber: 2, summary: "Second outcome." }),
        attempt(),
      ],
      entries: [entry()],
    });

    expect(markdown).toContain("# Helm Markdown export");
    expect(markdown).toContain("- Project: Portable Helm");
    expect(markdown).toContain("- Scope: Saved view");
    expect(markdown).toContain("- View: Release readiness");
    expect(markdown).toContain("#### Planning");
    expect(markdown).toContain("#### Tags");
    expect(markdown).toContain("release (\\#2563eb)");
    expect(markdown).toContain("#### Required capabilities");
    expect(markdown).toContain("- sqlite\n- typescript");
    expect(markdown).toContain("##### Risk (risk)");
    expect(markdown).toContain("#### Checklist");
    expect(markdown).toContain("- [x] Read the export");
    expect(markdown).toContain("#### Comments and activity");
    expect(markdown).toContain("The current snapshot looks correct.");

    const currentState = markdown.indexOf("## Current state");
    const firstTask = markdown.indexOf("### Task #1: Verify portability");
    const secondTask = markdown.indexOf("### Task #2: Publish the archive");
    const history = markdown.indexOf("## Historical attempts");
    const firstAttempt = markdown.indexOf("Attempt 1", history);
    const secondAttempt = markdown.indexOf("Attempt 2", history);
    expect(currentState).toBeLessThan(firstTask);
    expect(firstTask).toBeLessThan(secondTask);
    expect(secondTask).toBeLessThan(history);
    expect(firstAttempt).toBeLessThan(secondAttempt);
    expect(markdown.slice(0, history)).not.toContain("Generated and checked the archive.");
    expect(markdown.slice(history)).toContain("Generated and checked the archive.");
    expect(markdown.slice(history)).toContain(
      "Attribution: Portability agent (profile profile\\-1, run run\\-1)",
    );
    expect(markdown.slice(history)).toContain("#### Verification");
    expect(markdown.slice(history)).toContain("unit tests — Passed — All passed\\.");
    expect(markdown.slice(history)).toContain("#### Risks");
    expect(markdown.slice(history)).toContain("#### Follow-up work");
  });

  it("keeps headings, lists, fences, and HTML from user text structurally literal", () => {
    const hostile = [
      "# forged heading",
      "- forged list",
      "```danger",
      "</pre><h1>forged html</h1>",
      "```",
    ].join("\n");
    const markdown = renderPortableMarkdown({
      project: { ...project, name: "Project\n# injected" },
      viewName: "View\n- injected",
      tasks: [
        task({
          title: "Task\n## injected",
          descriptionText: hostile,
          expectedOutcome: hostile,
          checklist: [{ id: "unsafe", text: "item\n- nested", checked: false }],
        }),
      ],
      attempts: [attempt({ summary: hostile, changedAreas: ["# forged area"] })],
      entries: [entry({ contentText: hostile })],
    });

    expect(markdown).toContain("- Project: Project \\# injected");
    expect(markdown).toContain("- View: View \\- injected");
    expect(markdown).toContain("### Task #1: Task \\#\\# injected");
    expect(markdown).toContain("&#35; forged heading");
    expect(markdown).toContain("&#45; forged list");
    expect(markdown).toContain("&#96;&#96;&#96;danger");
    expect(markdown).toContain("&lt;/pre&gt;&lt;h1&gt;forged html&lt;/h1&gt;");
    expect(markdown).not.toContain("</pre><h1>forged html</h1>");
    expect(markdown).not.toMatch(/\n# forged heading/);
    expect(markdown).not.toMatch(/\n- forged list/);
    expect(markdown).not.toContain("```danger");
  });

  it("labels empty sections and represents withdrawals without exposing their content", () => {
    const emptyTask = task({
      descriptionText: "",
      expectedOutcome: "",
      acceptanceCriteria: "",
      agentContext: "",
      checklist: [],
      tags: [],
      customFields: [],
      requiredCapabilities: [],
      referencedPaths: [],
      upstreamRelations: [],
      downstreamRelations: [],
    });
    const withdrawn = entry({
      id: "entry-withdrawn",
      contentText: "SECRET WITHDRAWN BODY",
      withdrawnAt: "2026-09-04T11:30:00.000Z",
      withdrawnBy: { type: "human", id: "local-human" },
      withdrawalReason: "Contains obsolete credentials.",
    });
    const markdown = renderPortableMarkdown({
      project,
      tasks: [emptyTask],
      attempts: [],
      entries: [withdrawn],
    });

    expect(markdown).toContain("- Scope: Entire project");
    expect(markdown).not.toContain("- View:");
    expect(markdown.match(/_None\._/g)?.length).toBeGreaterThan(5);
    expect(markdown).toContain("##### Comment entry\\-withdrawn");
    expect(markdown).toContain("- Status: Withdrawn");
    expect(markdown).toContain("_The withdrawn entry content is intentionally omitted._");
    expect(markdown).toContain("Contains obsolete credentials.");
    expect(markdown).not.toContain("SECRET WITHDRAWN BODY");
    expect(markdown).toContain("_No historical attempts are included in this export._");

    const completelyEmpty = renderPortableMarkdown({
      project,
      tasks: [],
      attempts: [attempt()],
      entries: [entry()],
    });
    expect(completelyEmpty).toContain("_No tasks are included in this export._");
    expect(completelyEmpty).toContain("_No historical attempts are included in this export._");
    expect(completelyEmpty).not.toContain("Generated and checked the archive.");
  });
});
