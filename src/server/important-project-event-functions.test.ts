import { describe, expect, it } from "vitest";

import { parseReadImportantProjectEventsInput } from "./important-project-event-functions";

describe("important project event function input", () => {
  it("normalizes the only client-controlled value", () => {
    expect(
      parseReadImportantProjectEventsInput({ projectId: " project-1 ", ignored: "field" }),
    ).toEqual({ projectId: "project-1" });
  });

  it.each([{}, { projectId: "" }, { projectId: "  " }, { projectId: 1 }, null, []])(
    "rejects an invalid input %#",
    (input) => {
      expect(() => parseReadImportantProjectEventsInput(input)).toThrow(
        "An important-event query requires a project id.",
      );
    },
  );
});
