import { describe, expect, it } from "vitest";
import { z } from "zod";

import {
  emptyTaskSearchParams,
  parseSavedViewSearchRouteParams,
  parseTaskSearchRouteParams,
} from "./task-search-route-params";

function trimToNullable(value: unknown) {
  if (typeof value !== "string") return value === undefined ? null : value;
  const trimmed = value.trim();
  return trimmed ? trimmed : null;
}

const legacyCursorSchema = z.preprocess(
  trimToNullable,
  z.string().max(4_000).nullable().catch(null),
);
const legacyTaskSearchParamsSchema = z.object({
  q: z.string().max(500).catch(""),
  mode: z.enum(["all", "any", "phrase"]).catch("all"),
  lifecycle: z.preprocess(
    (value) => (value === "" || value === undefined ? null : value),
    z
      .enum(["backlog", "ready", "in_progress", "review", "done", "cancelled"])
      .nullable()
      .catch(null),
  ),
  eligibility: z.preprocess(
    (value) => (value === "" || value === undefined ? null : value),
    z
      .enum([
        "not_ready",
        "scheduled",
        "blocked",
        "capability_mismatch",
        "claimable",
        "claimed",
        "complete",
        "archived",
      ])
      .nullable()
      .catch(null),
  ),
  priority: z.preprocess(
    (value) => (value === "" || value === undefined ? null : value),
    z.enum(["urgent", "high", "normal", "low"]).nullable().catch(null),
  ),
  tag: z.preprocess(trimToNullable, z.string().min(1).max(200).nullable().catch(null)),
  capability: z.preprocess(
    trimToNullable,
    z
      .string()
      .trim()
      .min(1)
      .max(80)
      .regex(/^[a-z0-9][a-z0-9._:-]*$/i)
      .nullable()
      .catch(null),
  ),
  presentation: z.enum(["list", "board"]).catch("list"),
  cursor: legacyCursorSchema,
});

describe("task search route parameter validation", () => {
  it("preserves the established defaults and accepted URL values", () => {
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

    expect(
      parseTaskSearchRouteParams({
        q: " review evidence ",
        mode: "phrase",
        lifecycle: "in_progress",
        eligibility: "capability_mismatch",
        priority: "urgent",
        tag: " tag-1 ",
        capability: " TypeScript ",
        presentation: "board",
        cursor: " tq2.cursor ",
      }),
    ).toEqual({
      q: " review evidence ",
      mode: "phrase",
      lifecycle: "in_progress",
      eligibility: "capability_mismatch",
      priority: "urgent",
      tag: "tag-1",
      capability: "TypeScript",
      presentation: "board",
      cursor: "tq2.cursor",
    });
  });

  it("falls back field-by-field when URL values are malformed", () => {
    expect(
      parseTaskSearchRouteParams({
        q: 42,
        mode: "broken",
        lifecycle: "unknown",
        eligibility: "unknown",
        priority: "unknown",
        tag: false,
        capability: "has spaces",
        presentation: "broken",
        cursor: { token: "invalid" },
      }),
    ).toEqual(emptyTaskSearchParams);
  });

  it("keeps the established length boundaries and nullable normalization", () => {
    const atLimits = parseTaskSearchRouteParams({
      q: "q".repeat(500),
      tag: ` ${"t".repeat(200)} `,
      capability: ` ${"c".repeat(80)} `,
      cursor: ` ${"x".repeat(4_000)} `,
    });
    expect(atLimits).toMatchObject({
      q: "q".repeat(500),
      tag: "t".repeat(200),
      capability: "c".repeat(80),
      cursor: "x".repeat(4_000),
    });

    expect(
      parseTaskSearchRouteParams({
        q: "q".repeat(501),
        lifecycle: "",
        eligibility: undefined,
        priority: " ",
        tag: ` ${"t".repeat(201)} `,
        capability: ` ${"c".repeat(81)} `,
        cursor: ` ${"x".repeat(4_001)} `,
      }),
    ).toEqual(emptyTaskSearchParams);
  });

  it("uses the identical cursor contract for saved-view pagination", () => {
    expect(parseSavedViewSearchRouteParams({ cursor: " tq2.cursor " })).toEqual({
      cursor: "tq2.cursor",
    });
    expect(parseSavedViewSearchRouteParams({ cursor: "x".repeat(4_001) })).toEqual({
      cursor: null,
    });
    expect(parseSavedViewSearchRouteParams({})).toEqual({ cursor: null });
  });

  it("matches the former Zod route contract across valid, boundary, and malformed values", () => {
    const cases: readonly Record<string, unknown>[] = [
      {},
      {
        q: "search text",
        mode: "any",
        lifecycle: "review",
        eligibility: "claimable",
        priority: "low",
        tag: " tag-1 ",
        capability: " TypeScript ",
        presentation: "board",
        cursor: " tq2.cursor ",
      },
      {
        q: "q".repeat(500),
        tag: "t".repeat(200),
        capability: "c".repeat(80),
        cursor: "x".repeat(4_000),
      },
      {
        q: "q".repeat(501),
        mode: "invalid",
        lifecycle: " ",
        eligibility: 1,
        priority: false,
        tag: "t".repeat(201),
        capability: "not valid",
        presentation: null,
        cursor: "x".repeat(4_001),
      },
      {
        q: null,
        mode: undefined,
        lifecycle: "",
        eligibility: "",
        priority: "",
        tag: " ",
        capability: " ",
        presentation: {},
        cursor: " ",
        ignored: "field",
      },
    ];

    for (const routeSearch of cases) {
      expect(parseTaskSearchRouteParams(routeSearch)).toEqual(
        legacyTaskSearchParamsSchema.parse(routeSearch),
      );
    }
  });
});
