export const PORTABLE_CSV_LIMITS = Object.freeze({
  maxBytes: 2 * 1024 * 1024,
  maxDataRows: 1_000,
  maxColumns: 100,
  maxCellCharacters: 20_000,
});

export const PORTABLE_TASK_CSV_HEADERS = [
  "task_id",
  "expected_version",
  "title",
  "lifecycle",
  "priority",
  "position",
  "not_before",
  "due_at",
  "size",
  "description",
  "expected_outcome",
  "acceptance_criteria",
  "agent_context",
  "checklist",
  "tags",
  "capabilities",
  "parent_task_id",
  "review_mode_override",
  "archived",
] as const;

export type PortableTaskCsvHeader = (typeof PORTABLE_TASK_CSV_HEADERS)[number] | `custom.${string}`;

export type PortableCsvParseErrorCode =
  | "file_too_large"
  | "empty_file"
  | "empty_header"
  | "duplicate_header"
  | "too_many_rows"
  | "too_many_columns"
  | "cell_too_large"
  | "unexpected_quote"
  | "unexpected_character_after_quote"
  | "unterminated_quote"
  | "invalid_line_ending";

export type PortableCsvParseErrorDetails = {
  readonly rowNumber?: number;
  readonly columnNumber?: number;
  readonly limit?: number;
  readonly actual?: number;
};

export class PortableCsvParseError extends Error {
  readonly _tag = "PortableCsvParseError" as const;
  readonly name = "PortableCsvParseError";
  readonly code: PortableCsvParseErrorCode;
  readonly rowNumber: number | null;
  readonly columnNumber: number | null;
  readonly limit: number | null;
  readonly actual: number | null;

  constructor(
    code: PortableCsvParseErrorCode,
    message: string,
    details: PortableCsvParseErrorDetails = {},
  ) {
    super(message);
    this.code = code;
    this.rowNumber = details.rowNumber ?? null;
    this.columnNumber = details.columnNumber ?? null;
    this.limit = details.limit ?? null;
    this.actual = details.actual ?? null;
  }
}

export type PortableCsvUnsupportedHeader = {
  readonly sourceHeader: string;
  readonly normalizedHeader: string;
  readonly columnNumber: number;
};

export type PortableCsvRowDiagnostic = {
  readonly code: "blank_row" | "missing_columns" | "extra_columns";
  readonly rowNumber: number;
  readonly columnNumber: number;
  readonly message: string;
  readonly expectedColumns: number;
  readonly actualColumns: number;
};

export type PortableTaskCsvRow = {
  /** One-based physical source line where this CSV record begins. */
  readonly rowNumber: number;
  /** Values keyed by every normalized header, including unsupported headers. */
  readonly values: Readonly<Record<string, string>>;
  /** Unmapped values from records wider than the header row. */
  readonly extraValues: readonly string[];
};

export type ParsedPortableTaskCsv = {
  /** Every header in source order after normalization. */
  readonly headers: readonly string[];
  readonly supportedHeaders: readonly PortableTaskCsvHeader[];
  readonly unsupportedHeaders: readonly PortableCsvUnsupportedHeader[];
  readonly rows: readonly PortableTaskCsvRow[];
  readonly diagnostics: readonly PortableCsvRowDiagnostic[];
};

type CsvRecord = {
  readonly rowNumber: number;
  readonly cells: readonly string[];
};

const knownHeaders = new Set<string>(PORTABLE_TASK_CSV_HEADERS);
const customFieldHeaderPattern = /^custom\.[a-z][a-z0-9_]{0,79}$/;

export function normalizePortableCsvHeader(header: string) {
  return header
    .replace(/^\uFEFF/, "")
    .normalize("NFKC")
    .trim()
    .toLocaleLowerCase("en-US")
    .replace(/\s*\.\s*/g, ".")
    .replace(/[\s-]+/g, "_");
}

export function isPortableTaskCsvHeader(header: string): header is PortableTaskCsvHeader {
  return knownHeaders.has(header) || customFieldHeaderPattern.test(header);
}

function parseError(
  code: PortableCsvParseErrorCode,
  message: string,
  details?: PortableCsvParseErrorDetails,
): never {
  throw new PortableCsvParseError(code, message, details);
}

function isBlankRecord(record: CsvRecord) {
  return record.cells.every((cell) => cell.trim().length === 0);
}

function utf8ByteLength(value: string) {
  return new TextEncoder().encode(value).byteLength;
}

/**
 * Parses the task-oriented CSV interchange boundary without applying task-domain policy.
 * Values intentionally remain strings for the import planner to validate and coerce later.
 */
export function parsePortableTaskCsv(source: string): ParsedPortableTaskCsv {
  const sourceBytes = utf8ByteLength(source);
  if (sourceBytes > PORTABLE_CSV_LIMITS.maxBytes) {
    parseError(
      "file_too_large",
      `CSV input is ${sourceBytes} bytes; the limit is ${PORTABLE_CSV_LIMITS.maxBytes} bytes.`,
      { limit: PORTABLE_CSV_LIMITS.maxBytes, actual: sourceBytes },
    );
  }

  const csv = source.startsWith("\uFEFF") ? source.slice(1) : source;
  if (csv.length === 0) {
    parseError("empty_file", "CSV input must contain a header row.");
  }

  let headers: readonly string[] | null = null;
  let supportedHeaders: readonly PortableTaskCsvHeader[] = [];
  let unsupportedHeaders: readonly PortableCsvUnsupportedHeader[] = [];
  const rows: PortableTaskCsvRow[] = [];
  const diagnostics: PortableCsvRowDiagnostic[] = [];
  let pendingBlankRecords: CsvRecord[] = [];

  function appendDataRecord(record: CsvRecord, blank: boolean) {
    if (rows.length >= PORTABLE_CSV_LIMITS.maxDataRows) {
      parseError(
        "too_many_rows",
        `CSV data exceeds the ${PORTABLE_CSV_LIMITS.maxDataRows}-row limit at row ${record.rowNumber}.`,
        {
          rowNumber: record.rowNumber,
          columnNumber: 1,
          limit: PORTABLE_CSV_LIMITS.maxDataRows,
          actual: rows.length + 1,
        },
      );
    }

    const currentHeaders = headers;
    if (currentHeaders === null) throw new Error("CSV headers must be parsed before data rows.");

    const values = Object.fromEntries(
      currentHeaders.map((header, index) => [header, record.cells[index] ?? ""]),
    );

    if (blank) {
      diagnostics.push({
        code: "blank_row",
        rowNumber: record.rowNumber,
        columnNumber: 1,
        message: `CSV row ${record.rowNumber} is blank.`,
        expectedColumns: currentHeaders.length,
        actualColumns: record.cells.length,
      });
    } else if (record.cells.length < currentHeaders.length) {
      diagnostics.push({
        code: "missing_columns",
        rowNumber: record.rowNumber,
        columnNumber: record.cells.length + 1,
        message: `CSV row ${record.rowNumber} has ${record.cells.length} columns; expected ${currentHeaders.length}.`,
        expectedColumns: currentHeaders.length,
        actualColumns: record.cells.length,
      });
    } else if (record.cells.length > currentHeaders.length) {
      diagnostics.push({
        code: "extra_columns",
        rowNumber: record.rowNumber,
        columnNumber: currentHeaders.length + 1,
        message: `CSV row ${record.rowNumber} has ${record.cells.length} columns; expected ${currentHeaders.length}.`,
        expectedColumns: currentHeaders.length,
        actualColumns: record.cells.length,
      });
    }

    rows.push({
      rowNumber: record.rowNumber,
      values,
      extraValues: record.cells.slice(currentHeaders.length),
    });
  }

  function consumeRecord(record: CsvRecord) {
    if (headers === null) {
      const normalizedHeaders = record.cells.map(normalizePortableCsvHeader);
      const seenHeaders = new Map<string, number>();
      for (const [index, header] of normalizedHeaders.entries()) {
        const columnNumber = index + 1;
        if (header.length === 0) {
          parseError("empty_header", `CSV header column ${columnNumber} is empty.`, {
            rowNumber: record.rowNumber,
            columnNumber,
          });
        }
        const earlierColumn = seenHeaders.get(header);
        if (earlierColumn !== undefined) {
          parseError(
            "duplicate_header",
            `CSV header ${JSON.stringify(header)} appears in columns ${earlierColumn} and ${columnNumber} after normalization.`,
            { rowNumber: record.rowNumber, columnNumber },
          );
        }
        seenHeaders.set(header, columnNumber);
      }

      headers = normalizedHeaders;
      supportedHeaders = normalizedHeaders.filter(isPortableTaskCsvHeader);
      unsupportedHeaders = normalizedHeaders.flatMap((header, index) =>
        isPortableTaskCsvHeader(header)
          ? []
          : [
              {
                sourceHeader: record.cells[index] ?? "",
                normalizedHeader: header,
                columnNumber: index + 1,
              },
            ],
      );
      return;
    }

    if (isBlankRecord(record)) {
      // Keep enough pending rows to report the first possible overflow if another data row
      // follows, without retaining an unbounded run of trailing blank lines.
      const pendingRecordLimit = PORTABLE_CSV_LIMITS.maxDataRows - rows.length + 1;
      if (pendingBlankRecords.length < pendingRecordLimit) pendingBlankRecords.push(record);
      return;
    }

    for (const blankRecord of pendingBlankRecords) appendDataRecord(blankRecord, true);
    pendingBlankRecords = [];
    appendDataRecord(record, false);
  }

  let cells: string[] = [];
  let cell = "";
  let cellCharacters = 0;
  let inQuotes = false;
  let afterClosingQuote = false;
  let lineNumber = 1;
  let recordStartLine = 1;
  let recordStarted = false;

  function currentColumnNumber() {
    return cells.length + 1;
  }

  function appendToCell(value: string, characterCount: number) {
    cell += value;
    cellCharacters += characterCount;
    recordStarted = true;
    if (cellCharacters > PORTABLE_CSV_LIMITS.maxCellCharacters) {
      parseError(
        "cell_too_large",
        `CSV cell at row ${lineNumber}, column ${currentColumnNumber()} exceeds the ${PORTABLE_CSV_LIMITS.maxCellCharacters}-character limit.`,
        {
          rowNumber: lineNumber,
          columnNumber: currentColumnNumber(),
          limit: PORTABLE_CSV_LIMITS.maxCellCharacters,
          actual: cellCharacters,
        },
      );
    }
  }

  function finishCell() {
    cells.push(cell);
    if (cells.length > PORTABLE_CSV_LIMITS.maxColumns) {
      parseError(
        "too_many_columns",
        `CSV row ${recordStartLine} exceeds the ${PORTABLE_CSV_LIMITS.maxColumns}-column limit.`,
        {
          rowNumber: recordStartLine,
          columnNumber: cells.length,
          limit: PORTABLE_CSV_LIMITS.maxColumns,
          actual: cells.length,
        },
      );
    }
    cell = "";
    cellCharacters = 0;
    afterClosingQuote = false;
  }

  function finishRecord() {
    finishCell();
    consumeRecord({ rowNumber: recordStartLine, cells });
    cells = [];
    recordStarted = false;
  }

  for (let index = 0; index < csv.length; index += 1) {
    const character = csv[index];

    if (inQuotes) {
      if (character === '"') {
        if (csv[index + 1] === '"') {
          appendToCell('"', 1);
          index += 1;
        } else {
          inQuotes = false;
          afterClosingQuote = true;
        }
      } else if (character === "\r" && csv[index + 1] === "\n") {
        appendToCell("\r\n", 2);
        index += 1;
        lineNumber += 1;
      } else if (character === "\n") {
        appendToCell("\n", 1);
        lineNumber += 1;
      } else {
        const codePoint = csv.codePointAt(index);
        const codeUnitWidth = codePoint !== undefined && codePoint > 0xffff ? 2 : 1;
        appendToCell(csv.slice(index, index + codeUnitWidth), 1);
        index += codeUnitWidth - 1;
      }
      continue;
    }

    if (afterClosingQuote) {
      if (character === ",") {
        finishCell();
        recordStarted = true;
        continue;
      }
      if (character === "\n") {
        finishRecord();
        lineNumber += 1;
        recordStartLine = lineNumber;
        continue;
      }
      if (character === "\r") {
        if (csv[index + 1] !== "\n") {
          parseError(
            "invalid_line_ending",
            `CSV row ${lineNumber} uses a carriage return without a following line feed.`,
            { rowNumber: lineNumber, columnNumber: currentColumnNumber() },
          );
        }
        finishRecord();
        index += 1;
        lineNumber += 1;
        recordStartLine = lineNumber;
        continue;
      }
      parseError(
        "unexpected_character_after_quote",
        `CSV row ${lineNumber}, column ${currentColumnNumber()} contains a character after a closing quote.`,
        { rowNumber: lineNumber, columnNumber: currentColumnNumber() },
      );
    }

    if (character === '"') {
      if (cellCharacters !== 0) {
        parseError(
          "unexpected_quote",
          `CSV row ${lineNumber}, column ${currentColumnNumber()} contains a quote in an unquoted field.`,
          { rowNumber: lineNumber, columnNumber: currentColumnNumber() },
        );
      }
      inQuotes = true;
      recordStarted = true;
    } else if (character === ",") {
      finishCell();
      recordStarted = true;
    } else if (character === "\n") {
      finishRecord();
      lineNumber += 1;
      recordStartLine = lineNumber;
    } else if (character === "\r") {
      if (csv[index + 1] !== "\n") {
        parseError(
          "invalid_line_ending",
          `CSV row ${lineNumber} uses a carriage return without a following line feed.`,
          { rowNumber: lineNumber, columnNumber: currentColumnNumber() },
        );
      }
      finishRecord();
      index += 1;
      lineNumber += 1;
      recordStartLine = lineNumber;
    } else {
      const codePoint = csv.codePointAt(index);
      const codeUnitWidth = codePoint !== undefined && codePoint > 0xffff ? 2 : 1;
      appendToCell(csv.slice(index, index + codeUnitWidth), 1);
      index += codeUnitWidth - 1;
    }
  }

  if (inQuotes) {
    parseError(
      "unterminated_quote",
      `CSV record beginning at row ${recordStartLine}, column ${currentColumnNumber()} has an unterminated quoted field.`,
      { rowNumber: recordStartLine, columnNumber: currentColumnNumber() },
    );
  }

  if (recordStarted || cells.length > 0 || cell.length > 0 || afterClosingQuote) finishRecord();
  if (headers === null) parseError("empty_file", "CSV input must contain a header row.");

  // Pending blank records are trailing rows and intentionally do not count toward the data-row limit.
  return { headers, supportedHeaders, unsupportedHeaders, rows, diagnostics };
}
