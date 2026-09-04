import { describe, expect, it } from "vitest";

import {
  emptyTaskSearchParams,
  taskFilterFromSearchParams,
  taskSearchInputFromParams,
  taskSearchParamsSchema,
  taskSearchResultFields,
} from "./task-search-params";

describe("task search route parameters", () => {
  it("defaults to the list presentation and the canonical project query", () => {
    expect(emptyTaskSearchParams).toEqual({
      q: "",
      mode: "all",
      lifecycle: null,
      eligibility: null,
      priority: null,
      tag: null,
      capability: null,
      presentation: "list",
      cursor: null,
    });
    expect(taskSearchInputFromParams("project-1", emptyTaskSearchParams)).toMatchObject({
      filter: { schemaVersion: 1, projectId: "project-1", archiveState: "exclude" },
      fields: taskSearchResultFields,
      limit: 100,
      cursor: null,
    });
  });

  it("compiles route controls into the shared structured filter", () => {
    const search = taskSearchParamsSchema.parse({
      q: " review evidence ",
      mode: "phrase",
      lifecycle: "review",
      eligibility: "blocked",
      priority: "high",
      tag: "tag-1",
      capability: "TypeScript",
      presentation: "board",
    });
    expect(taskFilterFromSearchParams("project-1", search)).toEqual({
      schemaVersion: 1,
      projectId: "project-1",
      search: { text: "review evidence", mode: "phrase" },
      archiveState: "exclude",
      lifecycles: ["review"],
      eligibility: ["blocked"],
      priorities: ["high"],
      tags: { operator: "any_of", values: ["tag-1"] },
      capabilities: { operator: "any_of", values: ["typescript"] },
    });
  });

  it("recovers malformed URL values and includes archived work only when selected", () => {
    const search = taskSearchParamsSchema.parse({
      mode: "broken",
      lifecycle: "unknown",
      eligibility: "archived",
      presentation: "broken",
      tag: " ",
      capability: "x".repeat(81),
      cursor: "x".repeat(4_001),
    });
    expect(search).toMatchObject({
      mode: "all",
      lifecycle: null,
      presentation: "list",
      tag: null,
      capability: null,
      cursor: null,
    });
    expect(taskFilterFromSearchParams("project-1", search)).toMatchObject({
      archiveState: "only",
      eligibility: ["archived"],
    });
  });
});
