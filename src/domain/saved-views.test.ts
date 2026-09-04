import { describe, expect, it } from "vitest";

import {
  canonicalizeTaskFilter,
  canonicalizeTaskSearchOrder,
  taskFilterV1Schema,
  taskSearchOrderSchema,
} from "./task-filters";
import {
  archiveSavedViewInputSchema,
  assertSavedViewProjectMatches,
  canonicalizeSavedViewDefinition,
  compiledArchiveSavedViewInputSchema,
  compiledCreateSavedViewInputSchema,
  compiledGetSavedViewInputSchema,
  compiledListSavedViewsInputSchema,
  compiledRestoreSavedViewInputSchema,
  compiledSavedViewDefinitionV1Schema,
  compiledSavedViewSchema,
  compiledUpdateSavedViewInputSchema,
  createSavedViewInputSchema,
  getSavedViewInputSchema,
  listSavedViewsInputSchema,
  migrateSavedViewDefinition,
  restoreSavedViewInputSchema,
  savedViewDefinitionV1Schema,
  savedViewProjectMatches,
  savedViewSchema,
  updateSavedViewInputSchema,
} from "./saved-views";

function taskFilter(projectId = "project-1") {
  return taskFilterV1Schema.parse({ schemaVersion: 1, projectId });
}

function taskOrder() {
  return [taskSearchOrderSchema.parse({ field: "priority", direction: "asc" })];
}

function definition(projectId = "project-1") {
  return {
    schemaVersion: 1 as const,
    filter: taskFilter(projectId),
    order: taskOrder(),
    grouping: { type: "lifecycle" as const },
    visibleFields: ["title", "lifecycle", "priority"] as const,
  };
}

describe("saved-view domain contract", () => {
  it("parses representative definitions identically through normal and compiled schemas", () => {
    const input = definition();
    const expected = {
      ...input,
      visibleFields: [...input.visibleFields],
      presentation: "list" as const,
    };

    expect(savedViewDefinitionV1Schema.parse(input)).toEqual(expected);
    expect(compiledSavedViewDefinitionV1Schema.parse(input)).toEqual(expected);

    const canonical = canonicalizeSavedViewDefinition(expected);
    const canonicalFilter = canonicalizeTaskFilter(expected.filter);
    expect(canonical).toEqual({
      ...expected,
      filter: canonicalFilter,
      order: canonicalizeTaskSearchOrder(expected.order, canonicalFilter),
    });
  });

  it("defaults list queries to active views and the presentation to list", () => {
    expect(listSavedViewsInputSchema.parse({ projectId: "project-1" })).toEqual({
      projectId: "project-1",
      includeArchived: false,
    });
    expect(compiledListSavedViewsInputSchema.parse({ projectId: "project-1" })).toEqual({
      projectId: "project-1",
      includeArchived: false,
    });
    expect(savedViewDefinitionV1Schema.parse(definition()).presentation).toBe("list");
  });

  it("rejects duplicate visible fields, malformed grouping, unknown keys, and versions", () => {
    expect(() =>
      savedViewDefinitionV1Schema.parse({
        ...definition(),
        visibleFields: ["title", "title"],
      }),
    ).toThrow(/only appear once/i);
    expect(() =>
      compiledSavedViewDefinitionV1Schema.parse({
        ...definition(),
        grouping: { type: "tag" },
      }),
    ).toThrow();
    expect(() =>
      savedViewDefinitionV1Schema.parse({ ...definition(), unexpected: true }),
    ).toThrow();
    expect(() => migrateSavedViewDefinition({ ...definition(), schemaVersion: 2 })).toThrow(
      /unsupported saved-view definition schema version/i,
    );
    expect(() => migrateSavedViewDefinition({ ...definition(), schemaVersion: "1" })).toThrow(
      /unsupported saved-view definition schema version/i,
    );
    expect(() =>
      savedViewDefinitionV1Schema.parse({
        ...definition(),
        order: [{ field: "relevance", direction: "asc" }],
      }),
    ).toThrow(/relevance ordering requires a text search/i);
  });

  it("migrates the documented v0 and unversioned formats without dropping fields", () => {
    const filter = taskFilter();
    const order = taskOrder();
    const legacy = {
      schemaVersion: 0 as const,
      filter,
      order,
      grouping: { type: "tag" as const, tagId: "tag-1" },
      visibleFields: ["title", "tags", "due_at"] as const,
      presentation: "board" as const,
    };
    const expectedFilter = canonicalizeTaskFilter(filter);
    const expected = {
      schemaVersion: 1,
      filter: expectedFilter,
      order: canonicalizeTaskSearchOrder(order, expectedFilter),
      grouping: legacy.grouping,
      visibleFields: [...legacy.visibleFields],
      presentation: "board",
    };

    expect(migrateSavedViewDefinition(legacy)).toEqual(expected);
    expect(migrateSavedViewDefinition({ filter })).toEqual({
      schemaVersion: 1,
      filter: expectedFilter,
      order: canonicalizeTaskSearchOrder(undefined, expectedFilter),
      grouping: { type: "none" },
      visibleFields: ["title", "lifecycle", "priority"],
      presentation: "list",
    });
    expect(() => migrateSavedViewDefinition({ ...legacy, discardedField: true })).toThrow();
  });

  it("enforces project ownership in records and create or update inputs", () => {
    const matching = savedViewDefinitionV1Schema.parse(definition());
    const mismatching = savedViewDefinitionV1Schema.parse(definition("project-2"));
    expect(savedViewProjectMatches("project-1", matching)).toBe(true);
    expect(savedViewProjectMatches("project-1", mismatching)).toBe(false);
    expect(() => assertSavedViewProjectMatches("project-1", mismatching)).toThrow(
      /does not match filter project/i,
    );

    const createInput = {
      projectId: "project-1",
      name: "Review queue",
      definition: matching,
      idempotencyKey: "create-review-queue",
    };
    expect(compiledCreateSavedViewInputSchema.parse(createInput)).toEqual(
      createSavedViewInputSchema.parse(createInput),
    );
    expect(() =>
      createSavedViewInputSchema.parse({ ...createInput, definition: mismatching }),
    ).toThrow(/must target the saved view's project/i);

    const updateInput = {
      ...createInput,
      savedViewId: "view-1",
      expectedVersion: 1,
    };
    expect(compiledUpdateSavedViewInputSchema.parse(updateInput)).toEqual(
      updateSavedViewInputSchema.parse(updateInput),
    );
    expect(() =>
      updateSavedViewInputSchema.parse({ ...updateInput, definition: mismatching }),
    ).toThrow(/must target the saved view's project/i);

    const record = {
      id: "view-1",
      projectId: "project-1",
      sequence: 1,
      name: "Review queue",
      definition: matching,
      version: 1,
      archivedAt: null,
      createdAt: "2026-09-04T12:00:00.000Z",
      updatedAt: "2026-09-04T12:00:00.000Z",
    };
    expect(compiledSavedViewSchema.parse(record)).toEqual(savedViewSchema.parse(record));
    expect(() => savedViewSchema.parse({ ...record, definition: mismatching })).toThrow(
      /must target the saved view's project/i,
    );
  });

  it("bounds and compiles saved-view read and lifecycle command inputs", () => {
    const getInput = { projectId: "project-1", savedViewId: "view-1" };
    expect(compiledGetSavedViewInputSchema.parse(getInput)).toEqual(
      getSavedViewInputSchema.parse(getInput),
    );

    const lifecycleInput = {
      ...getInput,
      expectedVersion: 2,
      reason: "This queue is no longer active.",
      idempotencyKey: "archive-review-queue",
    };
    expect(compiledArchiveSavedViewInputSchema.parse(lifecycleInput)).toEqual(
      archiveSavedViewInputSchema.parse(lifecycleInput),
    );
    expect(compiledRestoreSavedViewInputSchema.parse(lifecycleInput)).toEqual(
      restoreSavedViewInputSchema.parse(lifecycleInput),
    );
    expect(() =>
      archiveSavedViewInputSchema.parse({ ...lifecycleInput, reason: "x".repeat(1_001) }),
    ).toThrow();
    expect(() =>
      getSavedViewInputSchema.parse({ ...getInput, savedViewId: "x".repeat(201) }),
    ).toThrow();
  });
});
