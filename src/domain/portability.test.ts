import { describe, expect, it } from "vitest";

import {
  HELM_PROJECT_EXPORT_EXCLUDED_SECTIONS,
  canonicalHelmProjectExportJson,
  compiledExecuteProjectImportInputSchema,
  compiledHelmProjectExportSchema,
  compiledPreviewProjectImportInputSchema,
  createProjectImportPreviewToken,
  executeProjectImportInputSchema,
  helmProjectExportSchema,
  parseHelmProjectExport,
  previewProjectImportInputSchema,
  projectImportExecutionResultSchema,
  projectImportPreviewSchema,
  projectImportPreviewTokenSchema,
  stablePortabilityJson,
  UnsupportedProjectExportFormatError,
  UnsupportedProjectExportSchemaVersionError,
  type HelmProjectExportV1,
} from "./portability";

const now = "2026-09-04T10:00:00.000Z";
const document = {
  version: 1 as const,
  doc: { type: "doc" as const, content: [] },
};

function artifact(): HelmProjectExportV1 {
  return {
    format: "helm-project-export",
    schemaVersion: 1,
    exportedAt: now,
    project: {
      id: "project-1",
      sequence: 1,
      name: "Helm",
      repositoryRoot: "/work/helm",
      reviewMode: "required",
      version: 4,
      createdAt: now,
      updatedAt: now,
    },
    tags: [
      {
        id: "tag-b",
        projectId: "project-1",
        name: "Beta",
        description: "Second tag",
        color: "#2563eb",
        exclusiveGroup: null,
        reviewModeOverride: null,
        createdAt: now,
        updatedAt: now,
      },
      {
        id: "tag-a",
        projectId: "project-1",
        name: "Alpha",
        description: "First tag",
        color: "#16a34a",
        exclusiveGroup: null,
        reviewModeOverride: "direct",
        createdAt: now,
        updatedAt: now,
      },
    ],
    customFieldDefinitions: [
      {
        id: "field-1",
        projectId: "project-1",
        key: "customer",
        type: "text",
        validation: { minLength: 0, maxLength: 100 },
        defaultValue: { type: "text", value: "Default customer" },
        display: { label: "Customer", description: "Customer name" },
        position: 0,
        retiredAt: null,
        createdAt: now,
        updatedAt: now,
      },
    ],
    tasks: [
      {
        id: "task-1",
        projectId: "project-1",
        sequence: 1,
        parentTaskId: null,
        title: "Export Helm",
        lifecycle: "review",
        priority: "high",
        position: 0,
        notBefore: null,
        dueAt: "2026-09-10",
        size: "m",
        description: document,
        expectedOutcome: "Helm data is portable.",
        acceptanceCriteria: "Round trips preserve observable state.",
        agentContext: "Do not import live leases.",
        checklist: [{ id: "check-1", text: "Verify export", checked: true }],
        reviewModeOverride: null,
        reviewAttemptId: "attempt-1",
        cancelledFromLifecycle: null,
        version: 3,
        archivedAt: null,
        createdAt: now,
        updatedAt: now,
        tagIds: ["tag-b", "tag-a"],
        customFieldValues: [
          {
            fieldId: "field-1",
            value: { type: "text", value: "Explicit customer" },
            updatedAt: now,
          },
        ],
        requiredCapabilities: ["typescript"],
        referencedPaths: ["src/domain/portability.ts"],
      },
    ],
    relations: [],
    savedViews: [
      {
        id: "view-1",
        projectId: "project-1",
        sequence: 1,
        name: "Review",
        definition: {
          schemaVersion: 1,
          filter: { schemaVersion: 1, projectId: "project-1", archiveState: "exclude" },
          order: [
            { field: "sequence", direction: "asc" },
            { field: "id", direction: "asc" },
          ],
          grouping: { type: "none" },
          visibleFields: ["title", "priority"],
          presentation: "list",
        },
        version: 1,
        archivedAt: null,
        createdAt: now,
        updatedAt: now,
      },
    ],
    agentProfiles: [
      {
        id: "profile-1",
        profileKey: "codex",
        displayName: "Coding agent",
        capabilities: ["typescript"],
        createdAt: now,
        updatedAt: now,
      },
    ],
    agentRuns: [
      {
        id: "run-1",
        profileId: "profile-1",
        sourceStatus: "active",
        status: "closed",
        clientName: "generic-agent",
        clientVersion: "1.0",
        createdAt: now,
        lastSeenAt: now,
        endedAt: now,
      },
    ],
    attempts: [
      {
        id: "attempt-1",
        taskId: "task-1",
        attemptNumber: 1,
        agentRunId: "run-1",
        agentProfileId: "profile-1",
        agentDisplayName: "Coding agent",
        status: "completed",
        summary: "Implemented export.",
        changedAreas: ["src/domain"],
        verificationResults: [{ name: "tests", status: "passed", details: "Passed" }],
        references: [],
        risks: [],
        followUpWork: [],
        failureClassification: null,
        createdAt: now,
        completedAt: now,
      },
    ],
    activityEntries: [
      {
        id: "entry-1",
        projectId: "project-1",
        taskId: "task-1",
        attemptId: "attempt-1",
        kind: "comment",
        author: { type: "agent", id: "run-1" },
        authorDisplayName: "Coding agent",
        agentProfileId: "profile-1",
        agentRunId: "run-1",
        content: document,
        contentText: "Verified",
        createdAt: now,
        withdrawnAt: null,
        withdrawnBy: null,
        withdrawalReason: null,
      },
    ],
    manualBlockers: [
      {
        id: "blocker-1",
        projectId: "project-1",
        taskId: "task-1",
        reason: "Awaiting review",
        status: "resolved",
        createdBy: { type: "human", id: "local-human" },
        createdAt: now,
        resolvedBy: { type: "human", id: "local-human" },
        resolvedAt: now,
        resolution: "Reviewed",
      },
    ],
    sourceEvents: [
      {
        sourceCursor: 12,
        projectId: "project-1",
        kind: "task.completed",
        importance: "routine",
        actor: { type: "agent", id: "run-1" },
        entity: { type: "task", id: "task-1" },
        payload: { summary: "Implemented export." },
        changes: {
          projectIds: ["project-1"],
          taskIds: ["task-1"],
          activityEntryIds: [],
          agentRunIds: ["run-1"],
          savedViewIds: [],
          scopes: ["tasks"],
        },
        occurredAt: now,
      },
    ],
  };
}

describe("portable project contract", () => {
  it("parses a complete v1 export through normal and compiled schemas", () => {
    const value = artifact();
    expect(helmProjectExportSchema.parse(value)).toEqual(value);
    expect(compiledHelmProjectExportSchema.parse(value)).toEqual(value);
    expect(parseHelmProjectExport(value)).toEqual(value);
    expect(value.tasks[0]?.customFieldValues).toEqual([
      expect.objectContaining({ value: { type: "text", value: "Explicit customer" } }),
    ]);
  });

  it("rejects unsupported envelopes before structural validation", () => {
    expect(() => parseHelmProjectExport({ ...artifact(), format: "other" })).toThrow(
      UnsupportedProjectExportFormatError,
    );
    expect(() => parseHelmProjectExport({ ...artifact(), schemaVersion: 2 })).toThrow(
      UnsupportedProjectExportSchemaVersionError,
    );
  });

  it("excludes process-local state and rejects it at strict boundaries", () => {
    const value = artifact();
    const serialized = canonicalHelmProjectExportJson(value);
    for (const field of HELM_PROJECT_EXPORT_EXCLUDED_SECTIONS) {
      expect(serialized).not.toContain(`"${field}"`);
    }
    expect(serialized).not.toContain("mcpSessionId");
    expect(serialized).not.toContain("tokenHash");

    expect(
      helmProjectExportSchema.safeParse({ ...value, leases: [{ tokenHash: "secret" }] }).success,
    ).toBe(false);
    expect(
      helmProjectExportSchema.safeParse({
        ...value,
        agentRuns: [{ ...value.agentRuns[0], mcpSessionId: "session-secret" }],
      }).success,
    ).toBe(false);
  });

  it("serializes object keys and portable collections deterministically", () => {
    const left = artifact();
    const right = {
      ...artifact(),
      tags: artifact().tags.toReversed(),
      tasks: [
        {
          ...artifact().tasks[0]!,
          tagIds: artifact().tasks[0]!.tagIds.toReversed(),
        },
      ],
    };
    expect(canonicalHelmProjectExportJson(left)).toBe(canonicalHelmProjectExportJson(right));
    expect(stablePortabilityJson({ z: 1, a: { y: 2, x: 3 } })).toBe('{"a":{"x":3,"y":2},"z":1}');
  });

  it("validates deterministic preview tokens and strict import inputs", () => {
    const sourceHash = "a".repeat(64);
    const targetHash = "b".repeat(64);
    const token = createProjectImportPreviewToken(sourceHash, targetHash);
    expect(token).toBe(`hip1:${sourceHash}:${targetHash}`);
    expect(projectImportPreviewTokenSchema.parse(token)).toBe(token);
    expect(projectImportPreviewTokenSchema.safeParse(`hip1:${targetHash}`).success).toBe(false);

    const previewInput = {
      source: { format: "json" as const, content: canonicalHelmProjectExportJson(artifact()) },
      targetProjectId: null,
      repositoryRoot: "/work/imported-helm",
      reason: "Restore the portable project.",
    };
    expect(previewProjectImportInputSchema.parse(previewInput)).toEqual(previewInput);
    expect(compiledPreviewProjectImportInputSchema.parse(previewInput)).toEqual(previewInput);
    expect(
      previewProjectImportInputSchema.safeParse({ ...previewInput, reason: "r".repeat(1_000) })
        .success,
    ).toBe(true);
    expect(
      compiledPreviewProjectImportInputSchema.safeParse({
        ...previewInput,
        reason: "r".repeat(1_001),
      }).success,
    ).toBe(false);
    expect(
      previewProjectImportInputSchema.safeParse({ ...previewInput, repositoryRoot: undefined })
        .success,
    ).toBe(false);

    const executeInput = {
      ...previewInput,
      previewToken: token,
      idempotencyKey: "import-project-1",
    };
    expect(executeProjectImportInputSchema.parse(executeInput)).toEqual(executeInput);
    expect(compiledExecuteProjectImportInputSchema.parse(executeInput)).toEqual(executeInput);
    expect(
      executeProjectImportInputSchema.safeParse({ ...executeInput, reason: "r".repeat(1_000) })
        .success,
    ).toBe(true);
    expect(
      compiledExecuteProjectImportInputSchema.safeParse({
        ...executeInput,
        reason: "r".repeat(1_001),
      }).success,
    ).toBe(false);
  });

  it("keeps preview and execution diagnostics internally consistent", () => {
    const token = createProjectImportPreviewToken("a".repeat(64), "b".repeat(64));
    const outcome = {
      sourceFormat: "json" as const,
      sourceProjectId: "project-1",
      targetProjectId: null,
      creates: [],
      updates: [],
      noOps: [],
      conflicts: [],
      unsupported: [],
    };
    expect(
      projectImportPreviewSchema.parse({
        format: "helm-project-import-preview",
        schemaVersion: 1,
        ...outcome,
        executable: true,
        previewToken: token,
      }),
    ).toBeTruthy();
    expect(
      projectImportPreviewSchema.safeParse({
        format: "helm-project-import-preview",
        schemaVersion: 1,
        ...outcome,
        executable: false,
        previewToken: token,
      }).success,
    ).toBe(false);
    expect(
      projectImportExecutionResultSchema.safeParse({
        format: "helm-project-import-result",
        schemaVersion: 1,
        ...outcome,
        executed: false,
        operationId: null,
        eventCursors: [99],
      }).success,
    ).toBe(false);
  });
});
