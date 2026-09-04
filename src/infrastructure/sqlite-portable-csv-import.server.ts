import { createHash } from "node:crypto";

import Database from "better-sqlite3";

import type { BulkTaskEvaluationContext } from "../application/bulk-tasks";
import {
  PortabilityIdempotencyConflictError,
  PortabilityPreviewStaleError,
} from "../application/portability-errors";
import { normalizeEventChangeHints } from "../domain/activity";
import {
  bulkTaskIntentSchema,
  type BulkTaskIntent,
  type BulkTaskPreview,
  type BulkTaskUpdatePatch,
} from "../domain/bulk-tasks";
import {
  customFieldDefinitionSchema,
  type CustomFieldDefinition,
  type CustomFieldValue,
} from "../domain/customization";
import {
  createProjectImportPreviewToken,
  projectImportExecutionResultSchema,
  projectImportPreviewSchema,
  stablePortabilityJson,
  type ExecuteProjectImportInput,
  type PreviewProjectImportInput,
  type ProjectImportChange,
  type ProjectImportConflict,
  type ProjectImportExecutionResult,
  type ProjectImportPreview,
  type ProjectImportUnsupported,
} from "../domain/portability";
import {
  parsePortableTaskCsv,
  PortableCsvParseError,
  type ParsedPortableTaskCsv,
  type PortableTaskCsvRow,
} from "../domain/portable-csv";
import {
  capabilityNameSchema,
  emptyRichTextDocument,
  normalizeCapabilities,
  taskDateSchema,
  taskPrioritySchema,
  taskSizeSchema,
  type Actor,
  type RichTextDocument,
  type TagInput,
} from "../domain/tasks";
import {
  executeSqliteBulkTasksInCurrentTransaction,
  previewSqliteBulkTasksInCurrentTransaction,
} from "./sqlite-bulk-task-store.server";

export type SqlitePortableCsvImportContext = { readonly now: string };
export type SqlitePortableCsvImportHumanActor = Actor & { readonly type: "human" };

type ProjectRow = {
  readonly id: string;
  readonly version: number;
  readonly updatedAt: string;
};

type TagRow = {
  readonly id: string;
  readonly name: string;
  readonly description: string;
  readonly color: string;
  readonly exclusiveGroup: string | null;
  readonly updatedAt: string;
};

type CustomFieldRow = {
  readonly id: string;
  readonly projectId: string;
  readonly fieldKey: string;
  readonly type: CustomFieldDefinition["type"];
  readonly validationJson: string;
  readonly defaultValueJson: string | null;
  readonly displayLabel: string;
  readonly description: string;
  readonly position: number;
  readonly retiredAt: string | null;
  readonly createdAt: string;
  readonly updatedAt: string;
};

type TaskIdentityRow = {
  readonly id: string;
  readonly projectId: string;
  readonly title: string;
  readonly version: number;
};

type PlannedRow = {
  readonly rowNumber: number;
  readonly sourceId: string;
  readonly kind: "create" | "update";
  readonly intent: BulkTaskIntent;
  readonly initialPreview: BulkTaskPreview;
};

type ObservedTask = {
  readonly rowNumber: number;
  readonly taskId: string;
  readonly projectId: string;
  readonly version: number;
};

type CsvImportCommandDescriptor = {
  readonly source: PreviewProjectImportInput["source"];
  readonly targetProjectId: string | null;
  readonly reason: string;
};

const privatePlanBrand: unique symbol = Symbol("SqlitePortableCsvImportExecutionPlan");

export type SqlitePortableCsvImportExecutionPlan = {
  readonly [privatePlanBrand]: true;
  readonly preview: ProjectImportPreview;
  readonly actor: SqlitePortableCsvImportHumanActor;
  readonly bulkContext: BulkTaskEvaluationContext;
  readonly rows: readonly PlannedRow[];
  readonly observedTasks: readonly ObservedTask[];
  readonly command: CsvImportCommandDescriptor;
};

export type PlannedSqlitePortableCsvImport = {
  readonly preview: ProjectImportPreview;
  readonly executionPlan: SqlitePortableCsvImportExecutionPlan;
};

export type ExecuteSqlitePortableCsvImportPlanInput = Pick<
  ExecuteProjectImportInput,
  "previewToken" | "idempotencyKey"
>;

const updateUnsupportedFields = [
  "title",
  "position",
  "size",
  "description",
  "expected_outcome",
  "acceptance_criteria",
  "agent_context",
  "checklist",
  "parent_task_id",
  "review_mode_override",
  "archived",
] as const;

const createUnsupportedFields = ["review_mode_override", "archived"] as const;
const CSV_IMPORT_COMMAND = "project.import.csv";

function sha256(value: string) {
  return createHash("sha256").update(value).digest("hex");
}

function sourceId(rowNumber: number) {
  return `csv-row-${rowNumber}`;
}

function path(rowNumber: number, field?: string) {
  return field === undefined ? ["rows", rowNumber] : ["rows", rowNumber, field];
}

function conflict(
  code: string,
  message: string,
  options: {
    readonly rowNumber?: number;
    readonly sourceId?: string | null;
    readonly targetId?: string | null;
    readonly field?: string;
    readonly entityType?: ProjectImportConflict["entityType"];
  } = {},
): ProjectImportConflict {
  return {
    category: "conflict",
    code,
    message,
    entityType: options.entityType ?? "task",
    sourceId: options.sourceId ?? null,
    targetId: options.targetId ?? null,
    path: options.rowNumber === undefined ? [] : path(options.rowNumber, options.field),
  };
}

function unsupported(
  code: string,
  message: string,
  options: {
    readonly rowNumber?: number;
    readonly sourceId?: string | null;
    readonly targetId?: string | null;
    readonly field?: string;
    readonly entityType?: ProjectImportUnsupported["entityType"];
  } = {},
): ProjectImportUnsupported {
  return {
    category: "unsupported",
    code,
    message,
    entityType: options.entityType ?? "task",
    sourceId: options.sourceId ?? null,
    targetId: options.targetId ?? null,
    path: options.rowNumber === undefined ? [] : path(options.rowNumber, options.field),
  };
}

function change(source: string, targetId: string | null, message: string): ProjectImportChange {
  return { entityType: "task", sourceId: source, targetId, message };
}

function issueMessage(error: { readonly issues: readonly unknown[] }) {
  return error.issues
    .map((issue) => {
      if (!issue || typeof issue !== "object") return String(issue);
      const issuePath = Reflect.get(issue, "path");
      const message = Reflect.get(issue, "message");
      const prefix = Array.isArray(issuePath) ? issuePath.map(String).join(".") : "";
      return `${prefix ? `${prefix}: ` : ""}${typeof message === "string" ? message : "Invalid value."}`;
    })
    .join(" ");
}

function readProject(database: Database.Database, projectId: string) {
  return database
    .prepare<[string], ProjectRow>(
      `select id, version, updated_at as updatedAt from projects where id = ?`,
    )
    .get(projectId);
}

function readTags(database: Database.Database, projectId: string) {
  return database
    .prepare<[string], TagRow>(
      `select id, name, description, color, exclusive_group as exclusiveGroup,
              updated_at as updatedAt
         from tags where project_id = ? order by name, id`,
    )
    .all(projectId);
}

function customFieldDefinition(row: CustomFieldRow): CustomFieldDefinition {
  return customFieldDefinitionSchema.parse({
    id: row.id,
    projectId: row.projectId,
    key: row.fieldKey,
    type: row.type,
    validation: JSON.parse(row.validationJson),
    defaultValue: row.defaultValueJson === null ? null : JSON.parse(row.defaultValueJson),
    display: { label: row.displayLabel, description: row.description },
    position: row.position,
    retiredAt: row.retiredAt,
    createdAt: row.createdAt,
    updatedAt: row.updatedAt,
  });
}

function readCustomFields(database: Database.Database, projectId: string) {
  return database
    .prepare<[string], CustomFieldRow>(
      `select id, project_id as projectId, field_key as fieldKey, type,
              validation_json as validationJson, default_value_json as defaultValueJson,
              display_label as displayLabel, description, position,
              retired_at as retiredAt, created_at as createdAt, updated_at as updatedAt
         from custom_field_definitions where project_id = ? order by position, id`,
    )
    .all(projectId)
    .map(customFieldDefinition);
}

function readTask(database: Database.Database, taskId: string) {
  return database
    .prepare<[string], TaskIdentityRow>(
      `select id, project_id as projectId, title, version from tasks where id = ?`,
    )
    .get(taskId);
}

function readTaskTagIds(database: Database.Database, taskId: string) {
  return database
    .prepare<[string], { readonly id: string }>(
      `select tag_id as id from task_tags where task_id = ? order by tag_id`,
    )
    .all(taskId)
    .map(({ id }) => id);
}

function readTaskCapabilities(database: Database.Database, taskId: string) {
  return database
    .prepare<[string], { readonly capability: string }>(
      `select capability from task_capability_requirements
        where task_id = ? order by capability`,
    )
    .all(taskId)
    .map(({ capability }) => capability);
}

function splitList(value: string): readonly string[] {
  const trimmed = value.trim();
  if (trimmed.length === 0) return [];
  if (trimmed.startsWith("[")) {
    const parsed = JSON.parse(trimmed) as unknown;
    if (!Array.isArray(parsed) || parsed.some((entry) => typeof entry !== "string")) {
      throw new TypeError(
        "Use a JSON array of strings or a comma, semicolon, or pipe-separated list.",
      );
    }
    return [...new Set(parsed.map((entry) => entry.trim()).filter(Boolean))];
  }
  return [
    ...new Set(
      trimmed
        .split(/[|;,]/)
        .map((entry) => entry.trim())
        .filter(Boolean),
    ),
  ];
}

function richText(value: string): RichTextDocument {
  if (value.length === 0) return emptyRichTextDocument;
  return {
    version: 1,
    doc: {
      type: "doc",
      content: [{ type: "paragraph", content: [{ type: "text", text: value }] }],
    },
  };
}

function checklist(value: string, rowNumber: number, sourceHash: string) {
  if (value.trim().length === 0) return [];
  const parsed: unknown = value.trim().startsWith("[") ? JSON.parse(value) : splitList(value);
  if (!Array.isArray(parsed)) throw new TypeError("Checklist must be a JSON array or list.");
  return parsed.map((entry, index) => {
    const candidate =
      typeof entry === "string"
        ? { text: entry, checked: false }
        : entry && typeof entry === "object"
          ? {
              text: Reflect.get(entry, "text"),
              checked: Reflect.get(entry, "checked") ?? false,
            }
          : null;
    if (
      candidate === null ||
      typeof candidate.text !== "string" ||
      candidate.text.trim().length === 0 ||
      typeof candidate.checked !== "boolean"
    ) {
      throw new TypeError("Checklist entries must be nonblank strings or {text, checked} objects.");
    }
    return {
      id: `csv-${sha256(`${sourceHash}:${rowNumber}:${index}`).slice(0, 24)}`,
      text: candidate.text.trim(),
      checked: candidate.checked,
    };
  });
}

function coerceCustomFieldValue(
  definition: CustomFieldDefinition,
  rawValue: string,
): CustomFieldValue {
  switch (definition.type) {
    case "text":
      return { type: "text", value: rawValue };
    case "number": {
      const value = Number(rawValue.trim());
      if (!Number.isFinite(value)) throw new TypeError("Use a finite number.");
      return { type: "number", value };
    }
    case "boolean": {
      const value = rawValue.trim().toLocaleLowerCase("en-US");
      if (["true", "yes", "1"].includes(value)) return { type: "boolean", value: true };
      if (["false", "no", "0"].includes(value)) return { type: "boolean", value: false };
      throw new TypeError("Use true/false, yes/no, or 1/0.");
    }
    case "date":
      return { type: "date", value: taskDateSchema.parse(rawValue.trim()) };
    case "single_select": {
      const requested = rawValue.trim();
      const normalized = requested.normalize("NFKC").toLocaleLowerCase("en-US");
      const option = definition.validation.options.find(
        ({ id, label }) =>
          id === requested || label.normalize("NFKC").toLocaleLowerCase("en-US") === normalized,
      );
      if (!option) throw new TypeError(`Use a configured option for ${definition.key}.`);
      return { type: "single_select", value: option.id };
    }
  }
  throw new TypeError("Use a supported custom-field type.");
}

function parseInteger(value: string, minimum: number, label: string) {
  const parsed = Number(value.trim());
  if (!Number.isSafeInteger(parsed) || parsed < minimum) {
    throw new TypeError(`${label} must be a whole number of at least ${minimum}.`);
  }
  return parsed;
}

function resolveTagNames(names: readonly string[], tags: readonly TagRow[]) {
  const byName = new Map(tags.map((tag) => [tag.name, tag]));
  return names.map((name) => {
    const tag = byName.get(name);
    if (!tag) throw new TypeError(`Tag ${JSON.stringify(name)} does not exist in the project.`);
    return tag;
  });
}

function tagInput(tag: TagRow): TagInput {
  return {
    name: tag.name,
    description: tag.description,
    color: tag.color,
    exclusiveGroup: tag.exclusiveGroup,
  };
}

function collectBulkFailures(
  preview: BulkTaskPreview,
  row: PortableTaskCsvRow,
  targetId: string | null,
) {
  return [...preview.failures, ...preview.targets.flatMap(({ failures }) => failures)].map(
    (failure) =>
      conflict(failure.code, failure.message, {
        rowNumber: row.rowNumber,
        sourceId: sourceId(row.rowNumber),
        targetId,
        field: failure.field,
      }),
  );
}

function parseIntent(
  intentInput: unknown,
  row: PortableTaskCsvRow,
  targetId: string | null,
  conflicts: ProjectImportConflict[],
) {
  const parsed = bulkTaskIntentSchema.safeParse(intentInput);
  if (parsed.success) return parsed.data;
  conflicts.push(
    conflict("invalid_value", issueMessage(parsed.error), {
      rowNumber: row.rowNumber,
      sourceId: sourceId(row.rowNumber),
      targetId,
    }),
  );
  return null;
}

function hasHeader(headers: ReadonlySet<string>, field: string) {
  return headers.has(field);
}

function hasSetChanges(value: unknown) {
  return (
    typeof value === "object" &&
    value !== null &&
    [Reflect.get(value, "add"), Reflect.get(value, "remove")].some(
      (entries) => Array.isArray(entries) && entries.length > 0,
    )
  );
}

function createTaskIntent(
  row: PortableTaskCsvRow,
  projectId: string,
  reason: string,
  headers: ReadonlySet<string>,
  tags: readonly TagRow[],
  customFields: readonly CustomFieldDefinition[],
  sourceHash: string,
  conflicts: ProjectImportConflict[],
  unsupportedData: ProjectImportUnsupported[],
) {
  const rowId = sourceId(row.rowNumber);
  for (const field of createUnsupportedFields) {
    if (row.values[field]?.trim()) {
      unsupportedData.push(
        unsupported("unsupported_create_field", `CSV create does not support ${field}.`, {
          rowNumber: row.rowNumber,
          sourceId: rowId,
          field,
        }),
      );
    }
  }
  if (row.values.expected_version?.trim()) {
    conflicts.push(
      conflict("unexpected_expected_version", "A create row must not set expected_version.", {
        rowNumber: row.rowNumber,
        sourceId: rowId,
        field: "expected_version",
      }),
    );
  }
  if (!row.values.title?.trim()) {
    conflicts.push(
      conflict("missing_title", "A create row requires a nonblank title.", {
        rowNumber: row.rowNumber,
        sourceId: rowId,
        field: "title",
      }),
    );
  }
  if (
    conflicts.some(({ sourceId: id }) => id === rowId) ||
    unsupportedData.some(({ sourceId: id }) => id === rowId)
  ) {
    return null;
  }

  try {
    const selectedTags = resolveTagNames(splitList(row.values.tags ?? ""), tags);
    const values = customFields.flatMap((definition) => {
      const header = `custom.${definition.key}`;
      if (!hasHeader(headers, header) || (row.values[header] ?? "").trim().length === 0) return [];
      return [
        { fieldId: definition.id, value: coerceCustomFieldValue(definition, row.values[header]!) },
      ];
    });
    const task: Record<string, unknown> = {
      parentTaskId: row.values.parent_task_id?.trim() || null,
      lifecycle: row.values.lifecycle?.trim() || "backlog",
      title: row.values.title,
      description: richText(row.values.description ?? ""),
      expectedOutcome: row.values.expected_outcome ?? "",
      acceptanceCriteria: row.values.acceptance_criteria ?? "",
      agentContext: row.values.agent_context ?? "",
      checklist: checklist(row.values.checklist ?? "", row.rowNumber, sourceHash),
      referencedPaths: [],
      tags: selectedTags.map(tagInput),
      requiredCapabilities: normalizeCapabilities(splitList(row.values.capabilities ?? "")),
      customFields: values,
    };
    if (row.values.priority?.trim())
      task.priority = taskPrioritySchema.parse(row.values.priority.trim());
    if (row.values.position?.trim())
      task.position = parseInteger(row.values.position, 0, "position");
    if (row.values.not_before?.trim())
      task.notBefore = taskDateSchema.parse(row.values.not_before.trim());
    if (row.values.due_at?.trim()) task.dueAt = taskDateSchema.parse(row.values.due_at.trim());
    if (row.values.size?.trim()) task.size = taskSizeSchema.parse(row.values.size.trim());
    return parseIntent(
      { schemaVersion: 1, kind: "create", projectId, reason, items: [{ clientId: rowId, task }] },
      row,
      null,
      conflicts,
    );
  } catch (error) {
    conflicts.push(
      conflict("invalid_value", error instanceof Error ? error.message : String(error), {
        rowNumber: row.rowNumber,
        sourceId: rowId,
      }),
    );
    return null;
  }
}

function updateTaskIntent(
  database: Database.Database,
  row: PortableTaskCsvRow,
  projectId: string,
  reason: string,
  headers: ReadonlySet<string>,
  tags: readonly TagRow[],
  customFields: readonly CustomFieldDefinition[],
  seenTaskIds: Set<string>,
  conflicts: ProjectImportConflict[],
  unsupportedData: ProjectImportUnsupported[],
) {
  const rowId = sourceId(row.rowNumber);
  const taskId = row.values.task_id!.trim();
  for (const field of updateUnsupportedFields) {
    if (row.values[field]?.trim()) {
      unsupportedData.push(
        unsupported("unsupported_update_field", `CSV update does not support ${field}.`, {
          rowNumber: row.rowNumber,
          sourceId: rowId,
          targetId: taskId,
          field,
        }),
      );
    }
  }
  if (seenTaskIds.has(taskId)) {
    conflicts.push(
      conflict("duplicate_task", `Task ${taskId} appears in more than one CSV update row.`, {
        rowNumber: row.rowNumber,
        sourceId: rowId,
        targetId: taskId,
        field: "task_id",
      }),
    );
  }
  seenTaskIds.add(taskId);
  const task = readTask(database, taskId);
  if (!task || task.projectId !== projectId) {
    conflicts.push(
      conflict("task_not_found", `Task ${taskId} does not exist in the target project.`, {
        rowNumber: row.rowNumber,
        sourceId: rowId,
        targetId: taskId,
        field: "task_id",
      }),
    );
  }
  const rawVersion = row.values.expected_version?.trim() ?? "";
  let expectedVersion: number | null = null;
  try {
    expectedVersion = parseInteger(rawVersion, 1, "expected_version");
  } catch (error) {
    conflicts.push(
      conflict("invalid_expected_version", error instanceof Error ? error.message : String(error), {
        rowNumber: row.rowNumber,
        sourceId: rowId,
        targetId: taskId,
        field: "expected_version",
      }),
    );
  }
  if (task && expectedVersion !== null && task.version !== expectedVersion) {
    conflicts.push(
      conflict(
        "version_conflict",
        `Task ${taskId} is version ${task.version}; CSV expected version ${expectedVersion}.`,
        {
          rowNumber: row.rowNumber,
          sourceId: rowId,
          targetId: taskId,
          field: "expected_version",
        },
      ),
    );
  }
  if (
    conflicts.some(({ sourceId: id }) => id === rowId) ||
    unsupportedData.some(({ sourceId: id }) => id === rowId)
  ) {
    return null;
  }

  try {
    const patch: Record<string, unknown> = {};
    if (row.values.lifecycle?.trim()) patch.lifecycle = row.values.lifecycle.trim();
    if (row.values.priority?.trim())
      patch.priority = taskPrioritySchema.parse(row.values.priority.trim());
    if (hasHeader(headers, "not_before")) {
      patch.notBefore = row.values.not_before?.trim()
        ? taskDateSchema.parse(row.values.not_before.trim())
        : null;
    }
    if (hasHeader(headers, "due_at")) {
      patch.dueAt = row.values.due_at?.trim()
        ? taskDateSchema.parse(row.values.due_at.trim())
        : null;
    }
    if (hasHeader(headers, "tags")) {
      const desired = resolveTagNames(splitList(row.values.tags ?? ""), tags).map(({ id }) => id);
      const current = readTaskTagIds(database, taskId);
      const desiredSet = new Set(desired);
      const currentSet = new Set(current);
      patch.tags = {
        add: desired.filter((id) => !currentSet.has(id)),
        remove: current.filter((id) => !desiredSet.has(id)),
      };
    }
    if (hasHeader(headers, "capabilities")) {
      const desired = normalizeCapabilities(splitList(row.values.capabilities ?? ""));
      for (const capability of desired) capabilityNameSchema.parse(capability);
      const current = normalizeCapabilities(readTaskCapabilities(database, taskId));
      const desiredSet = new Set(desired);
      const currentSet = new Set(current);
      patch.capabilities = {
        add: desired.filter((value) => !currentSet.has(value)),
        remove: current.filter((value) => !desiredSet.has(value)),
      };
    }
    const customSet: Array<{ fieldId: string; value: CustomFieldValue }> = [];
    const customClear: string[] = [];
    for (const definition of customFields) {
      const header = `custom.${definition.key}`;
      if (!hasHeader(headers, header)) continue;
      const value = row.values[header] ?? "";
      if (value.trim().length === 0) customClear.push(definition.id);
      else
        customSet.push({
          fieldId: definition.id,
          value: coerceCustomFieldValue(definition, value),
        });
    }
    if (customSet.length > 0 || customClear.length > 0) {
      patch.customFields = { set: customSet, clear: customClear };
    }
    const hasScalar = ["lifecycle", "priority", "notBefore", "dueAt"].some((field) =>
      Object.prototype.hasOwnProperty.call(patch, field),
    );
    const tagChanges = Reflect.get(patch, "tags");
    const capabilityChanges = Reflect.get(patch, "capabilities");
    if (
      !hasScalar &&
      !hasSetChanges(tagChanges) &&
      !hasSetChanges(capabilityChanges) &&
      customSet.length === 0 &&
      customClear.length === 0
    ) {
      return "no-op" as const;
    }
    return parseIntent(
      {
        schemaVersion: 1,
        kind: "update",
        projectId,
        reason,
        selection: { type: "ids", taskIds: [taskId] },
        patch: patch as BulkTaskUpdatePatch,
      },
      row,
      taskId,
      conflicts,
    );
  } catch (error) {
    conflicts.push(
      conflict("invalid_value", error instanceof Error ? error.message : String(error), {
        rowNumber: row.rowNumber,
        sourceId: rowId,
        targetId: taskId,
      }),
    );
    return null;
  }
}

function rejectedExecution(
  preview: ProjectImportPreview,
  conflicts: readonly ProjectImportConflict[] = preview.conflicts,
): ProjectImportExecutionResult {
  return projectImportExecutionResultSchema.parse({
    format: "helm-project-import-result",
    schemaVersion: 1,
    sourceFormat: preview.sourceFormat,
    sourceProjectId: preview.sourceProjectId,
    targetProjectId: preview.targetProjectId,
    creates: preview.creates,
    updates: preview.updates,
    noOps: preview.noOps,
    conflicts,
    unsupported: preview.unsupported,
    executed: false,
    operationId: null,
    eventCursors: [],
  });
}

function outerInputHash(
  executionPlan: SqlitePortableCsvImportExecutionPlan,
  input: ExecuteSqlitePortableCsvImportPlanInput,
) {
  return sha256(
    stablePortabilityJson({
      command: CSV_IMPORT_COMMAND,
      source: executionPlan.command.source,
      targetProjectId: executionPlan.command.targetProjectId,
      reason: executionPlan.command.reason,
      previewToken: input.previewToken,
      actor: executionPlan.actor,
    }),
  );
}

function existingOuterResult(
  database: Database.Database,
  executionPlan: SqlitePortableCsvImportExecutionPlan,
  input: ExecuteSqlitePortableCsvImportPlanInput,
) {
  const existing = database
    .prepare<
      [string],
      { readonly command: string; readonly inputHash: string; readonly resultJson: string }
    >(
      `select command, input_hash as inputHash, result_json as resultJson
         from idempotency_records where key = ?`,
    )
    .get(input.idempotencyKey);
  if (!existing) return null;
  if (
    existing.command !== CSV_IMPORT_COMMAND ||
    existing.inputHash !== outerInputHash(executionPlan, input)
  ) {
    throw new PortabilityIdempotencyConflictError({
      key: input.idempotencyKey,
      message: "That idempotency key was already used for a different import command.",
    });
  }
  return projectImportExecutionResultSchema.parse(JSON.parse(existing.resultJson));
}

export function planSqlitePortableCsvImportInCurrentTransaction(
  database: Database.Database,
  input: PreviewProjectImportInput,
  actor: SqlitePortableCsvImportHumanActor,
  context: SqlitePortableCsvImportContext,
): PlannedSqlitePortableCsvImport {
  if (actor.type !== "human") throw new TypeError("CSV imports require a human actor.");
  const creates: ProjectImportChange[] = [];
  const updates: ProjectImportChange[] = [];
  const noOps: ProjectImportChange[] = [];
  const conflicts: ProjectImportConflict[] = [];
  const unsupportedData: ProjectImportUnsupported[] = [];
  const plannedRows: PlannedRow[] = [];
  const observedTasks: ObservedTask[] = [];
  const sourceHash = sha256(
    stablePortabilityJson({
      source: input.source,
      targetProjectId: input.targetProjectId,
      reason: input.reason,
    }),
  );
  const bulkContext: BulkTaskEvaluationContext = {
    now: context.now,
    today: context.now.slice(0, 10),
    agentCapabilities: [],
  };

  let parsedCsv: ParsedPortableTaskCsv | null = null;
  if (input.source.format === "csv") {
    try {
      parsedCsv = parsePortableTaskCsv(input.source.content);
      for (const header of parsedCsv.unsupportedHeaders) {
        unsupportedData.push(
          unsupported(
            "unknown_header",
            `CSV column ${header.columnNumber} (${JSON.stringify(header.sourceHeader)}) is not supported.`,
            { entityType: null, field: header.normalizedHeader },
          ),
        );
      }
      for (const diagnostic of parsedCsv.diagnostics) {
        unsupportedData.push(
          unsupported(diagnostic.code, diagnostic.message, {
            rowNumber: diagnostic.rowNumber,
            sourceId: sourceId(diagnostic.rowNumber),
          }),
        );
      }
    } catch (error) {
      if (!(error instanceof PortableCsvParseError)) throw error;
      conflicts.push(
        conflict(error.code, error.message, {
          rowNumber: error.rowNumber ?? undefined,
          field: error.columnNumber === null ? undefined : `column_${error.columnNumber}`,
        }),
      );
    }
  }

  if (input.source.format !== "csv") {
    unsupportedData.push(
      unsupported("source_format", "This planner only supports task-oriented CSV imports.", {
        entityType: null,
      }),
    );
  }
  if (input.targetProjectId === null) {
    conflicts.push(
      conflict("target_project_required", "CSV imports require an existing target project.", {
        entityType: "project",
      }),
    );
  }

  const targetProjectId = input.targetProjectId;
  const project = targetProjectId === null ? undefined : readProject(database, targetProjectId);
  if (targetProjectId !== null && !project) {
    conflicts.push(
      conflict("project_not_found", `Target project ${targetProjectId} does not exist.`, {
        entityType: "project",
        targetId: targetProjectId,
      }),
    );
  }

  const tags = project ? readTags(database, project.id) : [];
  const customFields = project ? readCustomFields(database, project.id) : [];
  if (parsedCsv && project) {
    const parsed = parsedCsv;
    const headers = new Set(parsed.headers);
    const definitionsByKey = new Map(
      customFields.map((definition) => [definition.key, definition]),
    );
    for (const header of parsed.supportedHeaders) {
      if (header.startsWith("custom.") && !definitionsByKey.has(header.slice("custom.".length))) {
        conflicts.push(
          conflict(
            "custom_field_not_found",
            `Custom field ${header.slice("custom.".length)} does not exist in the target project.`,
            {
              field: header,
            },
          ),
        );
      }
    }

    const seenTaskIds = new Set<string>();
    for (const row of parsed.rows) {
      const beforeConflictCount = conflicts.length;
      const beforeUnsupportedCount = unsupportedData.length;
      const taskId = row.values.task_id?.trim() ?? "";
      const observedTask = taskId ? readTask(database, taskId) : undefined;
      if (observedTask) {
        observedTasks.push({
          rowNumber: row.rowNumber,
          taskId: observedTask.id,
          projectId: observedTask.projectId,
          version: observedTask.version,
        });
      }
      const intent = taskId
        ? updateTaskIntent(
            database,
            row,
            project.id,
            input.reason,
            headers,
            tags,
            customFields,
            seenTaskIds,
            conflicts,
            unsupportedData,
          )
        : createTaskIntent(
            row,
            project.id,
            input.reason,
            headers,
            tags,
            customFields,
            sourceHash,
            conflicts,
            unsupportedData,
          );
      if (intent === "no-op") {
        noOps.push(
          change(
            sourceId(row.rowNumber),
            taskId,
            `CSV row ${row.rowNumber} would not change task ${taskId}.`,
          ),
        );
        continue;
      }
      if (
        !intent ||
        conflicts.length !== beforeConflictCount ||
        unsupportedData.length !== beforeUnsupportedCount
      )
        continue;
      const bulkPreview = previewSqliteBulkTasksInCurrentTransaction(
        database,
        intent,
        actor,
        bulkContext,
      );
      const failures = collectBulkFailures(bulkPreview, row, taskId || null);
      if (failures.length > 0) {
        if (failures.every(({ code }) => code === "no_changes")) {
          noOps.push(
            change(
              sourceId(row.rowNumber),
              taskId,
              `CSV row ${row.rowNumber} would not change task ${taskId}.`,
            ),
          );
        } else {
          conflicts.push(...failures);
        }
        continue;
      }
      const operation: PlannedRow = {
        rowNumber: row.rowNumber,
        sourceId: sourceId(row.rowNumber),
        kind: intent.kind,
        intent,
        initialPreview: bulkPreview,
      };
      plannedRows.push(operation);
      if (intent.kind === "create") {
        creates.push(
          change(
            operation.sourceId,
            null,
            `Create task ${JSON.stringify(row.values.title?.trim())} from CSV row ${row.rowNumber}.`,
          ),
        );
      } else {
        updates.push(
          change(
            operation.sourceId,
            taskId,
            `Update task ${taskId} from CSV row ${row.rowNumber}.`,
          ),
        );
      }
    }
  }

  const stateHash = sha256(
    stablePortabilityJson({
      project: project ?? null,
      tags,
      customFields,
      bulkPreviews: plannedRows.map(({ rowNumber, initialPreview }) => ({
        rowNumber,
        previewToken: initialPreview.previewToken,
      })),
      observedTasks,
      conflicts,
      unsupported: unsupportedData,
    }),
  );
  const preview = projectImportPreviewSchema.parse({
    format: "helm-project-import-preview",
    schemaVersion: 1,
    sourceFormat: input.source.format,
    sourceProjectId: null,
    targetProjectId,
    creates,
    updates,
    noOps,
    conflicts,
    unsupported: unsupportedData,
    executable: conflicts.length === 0 && unsupportedData.length === 0,
    previewToken: createProjectImportPreviewToken(sourceHash, stateHash),
  });
  const executionPlan: SqlitePortableCsvImportExecutionPlan = {
    [privatePlanBrand]: true,
    preview,
    actor,
    bulkContext,
    rows: plannedRows,
    observedTasks,
    command: {
      source: input.source,
      targetProjectId: input.targetProjectId,
      reason: input.reason,
    },
  };
  return { preview, executionPlan };
}

export function executeSqlitePortableCsvImportInCurrentTransaction(
  database: Database.Database,
  executionPlan: SqlitePortableCsvImportExecutionPlan,
  input: ExecuteSqlitePortableCsvImportPlanInput,
): ProjectImportExecutionResult {
  if (!executionPlan[privatePlanBrand])
    throw new TypeError("Use a CSV execution plan returned by the planner.");
  if (!database.inTransaction) {
    throw new TypeError("CSV import execution requires a caller-owned SQLite transaction.");
  }
  const existing = existingOuterResult(database, executionPlan, input);
  if (existing) return existing;
  if (input.previewToken !== executionPlan.preview.previewToken) {
    throw new PortabilityPreviewStaleError({
      message: "The CSV import preview token does not match the current plan.",
    });
  }
  if (!executionPlan.preview.executable) return rejectedExecution(executionPlan.preview);

  for (const observed of executionPlan.observedTasks) {
    const current = readTask(database, observed.taskId);
    if (
      !current ||
      current.projectId !== observed.projectId ||
      current.version !== observed.version
    ) {
      throw new PortabilityPreviewStaleError({
        message: `CSV row ${observed.rowNumber} changed after preview.`,
      });
    }
  }

  for (const row of executionPlan.rows) {
    const currentPreview = previewSqliteBulkTasksInCurrentTransaction(
      database,
      row.intent,
      executionPlan.actor,
      executionPlan.bulkContext,
    );
    if (currentPreview.previewToken !== row.initialPreview.previewToken) {
      throw new PortabilityPreviewStaleError({
        message: `CSV row ${row.rowNumber} changed after preview.`,
      });
    }
  }

  const createdIds = new Map<string, string>();
  const eventCursors: number[] = [];
  const operationIds: string[] = [];
  for (const row of executionPlan.rows) {
    // Earlier create rows legitimately change the sequence base, so bind each inner
    // command to the caller-owned transaction snapshot immediately before execution.
    const currentPreview = previewSqliteBulkTasksInCurrentTransaction(
      database,
      row.intent,
      executionPlan.actor,
      executionPlan.bulkContext,
    );
    const result = executeSqliteBulkTasksInCurrentTransaction(
      database,
      {
        intent: row.intent,
        previewToken: currentPreview.previewToken,
        idempotencyKey: `csv-import:${sha256(stablePortabilityJson({ outer: input.idempotencyKey, row: row.rowNumber, kind: row.kind }))}`,
      },
      executionPlan.actor,
      executionPlan.bulkContext,
    );
    eventCursors.push(result.parentEventCursor);
    operationIds.push(result.operationId);
    if (row.kind === "create") createdIds.set(row.sourceId, result.items[0]!.taskId);
  }

  const creates = executionPlan.preview.creates.map((entry) => ({
    ...entry,
    targetId: createdIds.get(entry.sourceId) ?? entry.targetId,
    message: `Created task ${createdIds.get(entry.sourceId) ?? "from CSV"}.`,
  }));
  const taskIds = [
    ...creates.flatMap(({ targetId }) => (targetId === null ? [] : [targetId])),
    ...executionPlan.preview.updates.flatMap(({ targetId }) =>
      targetId === null ? [] : [targetId],
    ),
  ];
  const operationId = `csv-import-${sha256(
    stablePortabilityJson({
      previewToken: input.previewToken,
      idempotencyKey: input.idempotencyKey,
      operationIds,
    }),
  ).slice(0, 32)}`;
  const targetProjectId = executionPlan.preview.targetProjectId;
  if (targetProjectId === null) throw new Error("An executable CSV import needs a target project.");
  const importEvent = database
    .prepare<
      {
        projectId: string;
        actorType: string;
        actorId: string;
        entityId: string;
        payloadJson: string;
        changesJson: string;
        occurredAt: string;
      },
      { readonly cursor: number }
    >(
      `insert into events (
         project_id, kind, importance, actor_type, actor_id, entity_type,
         entity_id, payload_json, changes_json, occurred_at
       ) values (
         @projectId, '${CSV_IMPORT_COMMAND}', 'routine', @actorType, @actorId,
         'project_import', @entityId, @payloadJson, @changesJson, @occurredAt
       ) returning cursor`,
    )
    .get({
      projectId: targetProjectId,
      actorType: executionPlan.actor.type,
      actorId: executionPlan.actor.id,
      entityId: operationId,
      payloadJson: JSON.stringify({
        operationId,
        reason: executionPlan.command.reason,
        sourceFormat: "csv",
        creates: creates.length,
        updates: executionPlan.preview.updates.length,
        noOps: executionPlan.preview.noOps.length,
        bulkOperationIds: operationIds,
        bulkEventCursors: eventCursors,
      }),
      changesJson: JSON.stringify(
        normalizeEventChangeHints({
          projectIds: [targetProjectId],
          taskIds,
          scopes: ["tasks", "activity"],
        }),
      ),
      occurredAt: executionPlan.bulkContext.now,
    });
  if (!importEvent) throw new Error("The CSV import audit event was not appended.");
  eventCursors.push(importEvent.cursor);
  const result = projectImportExecutionResultSchema.parse({
    format: "helm-project-import-result",
    schemaVersion: 1,
    sourceFormat: executionPlan.preview.sourceFormat,
    sourceProjectId: null,
    targetProjectId: executionPlan.preview.targetProjectId,
    creates,
    updates: executionPlan.preview.updates,
    noOps: executionPlan.preview.noOps,
    conflicts: [],
    unsupported: [],
    executed: true,
    operationId,
    eventCursors,
  });
  database
    .prepare(
      `insert into idempotency_records (
         key, command, input_hash, result_json, created_at
       ) values (?, ?, ?, ?, ?)`,
    )
    .run(
      input.idempotencyKey,
      CSV_IMPORT_COMMAND,
      outerInputHash(executionPlan, input),
      JSON.stringify(result),
      executionPlan.bulkContext.now,
    );
  return result;
}
