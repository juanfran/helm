import { describe, expect, it } from "vitest";

import { parseReadTaskTagsInput } from "./task-tag-functions";

describe("task tag function input", () => {
  it("normalizes the only client-controlled value", () => {
    expect(parseReadTaskTagsInput({ projectId: " project-1 ", ignored: "field" })).toEqual({
      projectId: "project-1",
    });
  });

  it.each([{}, { projectId: "" }, { projectId: "  " }, { projectId: 1 }, null, []])(
    "rejects an invalid input %#",
    (input) => {
      expect(() => parseReadTaskTagsInput(input)).toThrow(
        "A task-tag query requires a project id.",
      );
    },
  );
});
