import { describe, expect, it } from "vitest";

import {
  PORTABLE_CSV_LIMITS,
  PortableCsvParseError,
  isPortableTaskCsvHeader,
  normalizePortableCsvHeader,
  parsePortableTaskCsv,
} from "./portable-csv";

function expectParseError(source: string, code: PortableCsvParseError["code"]) {
  try {
    parsePortableTaskCsv(source);
  } catch (error) {
    expect(error).toBeInstanceOf(PortableCsvParseError);
    if (!(error instanceof PortableCsvParseError)) throw error;
    expect(error).toMatchObject({ _tag: "PortableCsvParseError", code });
    return error;
  }
  throw new Error(`Expected CSV parsing to fail with ${code}.`);
}

describe("portable task CSV", () => {
  it("parses BOM-prefixed RFC 4180 fields, escaped quotes, commas, and embedded newlines", () => {
    const parsed = parsePortableTaskCsv(
      '\uFEFFTitle,DESCRIPTION,custom.Release-Risk\r\n"Ship, now","Line 1\r\nLine ""2""",high\r\n' +
        'Follow-up,"Uses\nLF",low\n',
    );

    expect(parsed.headers).toEqual(["title", "description", "custom.release_risk"]);
    expect(parsed.supportedHeaders).toEqual(["title", "description", "custom.release_risk"]);
    expect(parsed.unsupportedHeaders).toEqual([]);
    expect(parsed.rows).toEqual([
      {
        rowNumber: 2,
        values: {
          title: "Ship, now",
          description: 'Line 1\r\nLine "2"',
          "custom.release_risk": "high",
        },
        extraValues: [],
      },
      {
        rowNumber: 4,
        values: {
          title: "Follow-up",
          description: "Uses\nLF",
          "custom.release_risk": "low",
        },
        extraValues: [],
      },
    ]);
    expect(parsed.diagnostics).toEqual([]);
  });

  it("normalizes headers, rejects normalized duplicates, and reports unsupported columns", () => {
    expect(normalizePortableCsvHeader("  Expected Version  ")).toBe("expected_version");
    expect(normalizePortableCsvHeader(" custom. Release-Risk ")).toBe("custom.release_risk");
    expect(isPortableTaskCsvHeader("review_mode_override")).toBe(true);
    expect(isPortableTaskCsvHeader("custom.release_risk")).toBe(true);
    expect(isPortableTaskCsvHeader("custom.Bad-Key")).toBe(false);

    const parsed = parsePortableTaskCsv("Title,Mystery Column\nShip,kept\n");
    expect(parsed.unsupportedHeaders).toEqual([
      {
        sourceHeader: "Mystery Column",
        normalizedHeader: "mystery_column",
        columnNumber: 2,
      },
    ]);
    expect(parsed.rows[0]?.values).toEqual({ title: "Ship", mystery_column: "kept" });

    const duplicate = expectParseError("Task ID, task-id\nfirst,second", "duplicate_header");
    expect(duplicate).toMatchObject({ rowNumber: 1, columnNumber: 2 });
  });

  it("keeps physical row numbers and emits stable diagnostics for internal malformed-width rows", () => {
    const parsed = parsePortableTaskCsv(
      'title,priority\n"Spans\nlines",high\n\nOnly a title\nToo,many,values\n\n,\n',
    );

    expect(parsed.rows.map((row) => row.rowNumber)).toEqual([2, 4, 5, 6]);
    expect(parsed.rows[1]?.values).toEqual({ title: "", priority: "" });
    expect(parsed.rows[2]?.values).toEqual({ title: "Only a title", priority: "" });
    expect(parsed.rows[3]).toEqual({
      rowNumber: 6,
      values: { title: "Too", priority: "many" },
      extraValues: ["values"],
    });
    expect(parsed.diagnostics).toEqual([
      {
        code: "blank_row",
        rowNumber: 4,
        columnNumber: 1,
        message: "CSV row 4 is blank.",
        expectedColumns: 2,
        actualColumns: 1,
      },
      {
        code: "missing_columns",
        rowNumber: 5,
        columnNumber: 2,
        message: "CSV row 5 has 1 columns; expected 2.",
        expectedColumns: 2,
        actualColumns: 1,
      },
      {
        code: "extra_columns",
        rowNumber: 6,
        columnNumber: 3,
        message: "CSV row 6 has 3 columns; expected 2.",
        expectedColumns: 2,
        actualColumns: 3,
      },
    ]);
  });

  it("ignores blank trailing records without counting or diagnosing them", () => {
    const parsed = parsePortableTaskCsv(
      `title,priority\nShip,high\n\n,\n  \n${"\n".repeat(PORTABLE_CSV_LIMITS.maxDataRows + 10)}`,
    );

    expect(parsed.rows).toHaveLength(1);
    expect(parsed.rows[0]?.rowNumber).toBe(2);
    expect(parsed.diagnostics).toEqual([]);
  });

  it("enforces byte, row, column, and cell limits with source locations", () => {
    const oversized = expectParseError(
      "x".repeat(PORTABLE_CSV_LIMITS.maxBytes + 1),
      "file_too_large",
    );
    expect(oversized).toMatchObject({
      limit: PORTABLE_CSV_LIMITS.maxBytes,
      actual: PORTABLE_CSV_LIMITS.maxBytes + 1,
    });

    const tooManyRows = expectParseError(
      `title\n${Array.from(
        { length: PORTABLE_CSV_LIMITS.maxDataRows + 1 },
        (_, index) => `Task ${index + 1}`,
      ).join("\n")}`,
      "too_many_rows",
    );
    expect(tooManyRows).toMatchObject({ rowNumber: 1_002, columnNumber: 1, actual: 1_001 });

    const tooManyColumns = expectParseError(
      Array.from(
        { length: PORTABLE_CSV_LIMITS.maxColumns + 1 },
        (_, index) => `field_${index}`,
      ).join(","),
      "too_many_columns",
    );
    expect(tooManyColumns).toMatchObject({ rowNumber: 1, columnNumber: 101, actual: 101 });

    const cellTooLarge = expectParseError(
      `title\n${"x".repeat(PORTABLE_CSV_LIMITS.maxCellCharacters + 1)}`,
      "cell_too_large",
    );
    expect(cellTooLarge).toMatchObject({ rowNumber: 2, columnNumber: 1, actual: 20_001 });
  });

  it.each([
    ['title\n"unterminated', "unterminated_quote"],
    ['title\nbad"quote', "unexpected_quote"],
    ['title\n"closed"suffix', "unexpected_character_after_quote"],
    ["title\rvalue", "invalid_line_ending"],
    ["\uFEFF", "empty_file"],
    ["   \nvalue", "empty_header"],
  ] as const)("rejects malformed structure for %s", (source, code) => {
    expectParseError(source, code);
  });
});
