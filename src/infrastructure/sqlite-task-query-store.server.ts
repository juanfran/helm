import { createHash, randomUUID } from "node:crypto";

import Database from "better-sqlite3";
import { and, asc, eq, isNull, max } from "drizzle-orm";
import { drizzle } from "drizzle-orm/better-sqlite3";
import { Effect } from "effect";
import { z } from "zod";

import type {
  TaskQueryEvaluationContext,
  TaskQueryStore,
  TaskSelectionItem,
} from "../application/task-queries";
import {
  InvalidTaskQueryError,
  SavedViewIdempotencyConflictError,
  SavedViewNameConflictError,
  SavedViewNotFoundError,
  SavedViewVersionConflictError,
  TaskQueryCursorError,
  TaskQueryPersistenceError,
  type TaskQueryError,
} from "../application/task-query-errors";
import {
  customFieldDefinitions,
  events,
  idempotencyRecords,
  projects,
  savedViews,
  schema,
} from "../db/schema";
import { importanceForEventKind, normalizeEventChangeHints } from "../domain/activity";
import {
  customFieldDefinitionSchema,
  customFieldSingleSelectValidationSchema,
  customFieldValueSchema,
  resolveReviewPolicy,
  taskCustomFieldAssignmentSchema,
  type CustomFieldDefinition,
} from "../domain/customization";
import {
  canonicalizeTaskSearchFields,
  canonicalizeTaskFilter,
  canonicalizeTaskSearchOrder,
  stableCanonicalJson,
  taskSearchPageSchema,
  taskFilterCustomFieldOperandType,
  type SearchTasksInput,
  type TaskFilterCustomFieldClause,
  type TaskFilterV1,
  type TaskSearchItem,
  type TaskSearchField,
  type TaskSearchMatchedSource,
  type TaskSearchOrder,
} from "../domain/task-filters";
import {
  canonicalizeSavedViewDefinition,
  migrateSavedViewDefinition,
  savedViewSchema,
  type ArchiveSavedViewInput,
  type CreateSavedViewInput,
  type GetSavedViewInput,
  type ListSavedViewsInput,
  type SavedView,
  type UpdateSavedViewInput,
} from "../domain/saved-views";
import {
  evaluateTaskEligibility,
  normalizeCapabilities,
  type Task,
  type TaskClaim,
  type TaskEligibility,
  type TaskRelation,
} from "../domain/tasks";
import { validateProjectReferencedPaths } from "./project-instructions.server";
import { readSqliteTaskProjections } from "./sqlite-task-store.server";

type DrizzleDatabase = ReturnType<typeof drizzle<typeof schema>>;
type DrizzleTransaction = Parameters<Parameters<DrizzleDatabase["transaction"]>[0]>[0];
type DatabaseSession = DrizzleDatabase | DrizzleTransaction;
type SavedViewRow = typeof savedViews.$inferSelect;

type LegacyQueryCursor = {
  readonly version: 1;
  readonly revision: number;
  readonly queryHash: string;
  readonly evaluationHash: string;
  readonly asOf: string;
  readonly offset: number;
};

type QueryCursor = {
  readonly version: 2;
  readonly revision: number;
  readonly queryHash: string;
  readonly evaluationHash: string;
  readonly asOf: string;
  readonly key: readonly (string | number | null)[];
};

type DecodedQueryCursor = LegacyQueryCursor | QueryCursor;

type QueryRow = {
  readonly id: string;
  readonly projectId: string;
  readonly sequence: number;
  readonly parentTaskId: string | null;
  readonly title: string;
  readonly lifecycle: Task["lifecycle"];
  readonly priority: Task["priority"];
  readonly priorityRank: number;
  readonly position: number;
  readonly notBefore: string | null;
  readonly dueAt: string | null;
  readonly size: Task["size"];
  readonly version: number;
  readonly archivedAt: string | null;
  readonly reviewModeOverride: Task["reviewModeOverride"];
  readonly projectReviewMode: "required" | "direct";
  readonly repositoryRoot: string;
  readonly relevance: number | null;
  readonly titleMatch: 0 | 1;
  readonly taskContentMatch: 0 | 1;
  readonly acceptanceCriteriaMatch: 0 | 1;
  readonly commentsMatch: 0 | 1;
  readonly reportsMatch: 0 | 1;
  readonly eligibilityStatus: TaskEligibility["status"];
  readonly totalCount: number;
  readonly descriptionText?: string;
  readonly expectedOutcome?: string;
  readonly acceptanceCriteria?: string;
  readonly agentContext?: string;
  readonly checklistJson?: string;
  readonly createdAt: string;
  readonly updatedAt: string;
};

type FullTaskSearchItem = Omit<TaskSearchItem, "task"> & {
  readonly task: Task & { readonly eligibility: TaskEligibility };
};

type SqliteValue = string | number | bigint | Buffer | null;

const LEGACY_CURSOR_PREFIX = "tq1:";
const CURSOR_PREFIX = "tq2:";
const legacyQueryCursorSchema = z.strictObject({
  version: z.literal(1),
  revision: z.number().int().nonnegative(),
  queryHash: z.string().regex(/^[a-f0-9]{64}$/),
  evaluationHash: z.string().regex(/^[a-f0-9]{64}$/),
  asOf: z.iso.datetime({ offset: true }),
  offset: z.number().int().nonnegative(),
});
const queryCursorSchema = z.strictObject({
  version: z.literal(2),
  revision: z.number().int().nonnegative(),
  queryHash: z.string().regex(/^[a-f0-9]{64}$/),
  evaluationHash: z.string().regex(/^[a-f0-9]{64}$/),
  asOf: z.iso.datetime({ offset: true }),
  key: z
    .array(z.union([z.string(), z.number().finite(), z.null()]))
    .min(1)
    .max(12),
});

class SqlBuilder {
  readonly parameters: SqliteValue[] = [];

  bind(value: SqliteValue) {
    this.parameters.push(value);
    return "?";
  }

  bindJson(value: unknown) {
    return this.bind(JSON.stringify(value));
  }
}

function hash(value: string) {
  return createHash("sha256").update(value).digest("hex");
}

function commandInputHash(command: string, input: unknown) {
  return hash(`${command}:${stableCanonicalJson(input)}`);
}

function persistenceError(error: unknown) {
  return new TaskQueryPersistenceError({
    message: error instanceof Error ? error.message : "The task query database operation failed.",
  });
}

function isTaskQueryError(error: unknown): error is TaskQueryError {
  return (
    error instanceof InvalidTaskQueryError ||
    error instanceof TaskQueryCursorError ||
    error instanceof SavedViewNotFoundError ||
    error instanceof SavedViewVersionConflictError ||
    error instanceof SavedViewNameConflictError ||
    error instanceof SavedViewIdempotencyConflictError ||
    error instanceof TaskQueryPersistenceError
  );
}

function commandError(error: unknown): TaskQueryError {
  return isTaskQueryError(error) ? error : persistenceError(error);
}

function currentRevision(database: Database.Database, projectId: string) {
  return (
    database
      .prepare<[string], { readonly revision: number }>(
        "select coalesce(max(cursor), 0) as revision from events where project_id = ?",
      )
      .get(projectId)?.revision ?? 0
  );
}

function evaluationHash(projectId: string, context: TaskQueryEvaluationContext) {
  return hash(
    stableCanonicalJson({
      projectId,
      today: context.today,
      agentCapabilities: normalizeCapabilities(context.agentCapabilities),
    }),
  );
}

function queryHash(
  filter: TaskFilterV1,
  order: readonly TaskSearchOrder[],
  fields: readonly TaskSearchField[],
) {
  return hash(stableCanonicalJson({ filter, order, fields }));
}

function legacyQueryHash(filter: TaskFilterV1, order: readonly TaskSearchOrder[]) {
  return hash(stableCanonicalJson({ filter, order }));
}

function encodeCursor(cursor: QueryCursor) {
  return `${CURSOR_PREFIX}${Buffer.from(stableCanonicalJson(cursor)).toString("base64url")}`;
}

function malformedCursor(message = "The task-query cursor is malformed."): TaskQueryCursorError {
  return new TaskQueryCursorError({ reason: "malformed", message });
}

function decodeCursor(value: string): DecodedQueryCursor {
  try {
    const cursorSchema = value.startsWith(CURSOR_PREFIX)
      ? queryCursorSchema
      : value.startsWith(LEGACY_CURSOR_PREFIX)
        ? legacyQueryCursorSchema
        : null;
    if (!cursorSchema) throw malformedCursor();
    const prefix = value.startsWith(CURSOR_PREFIX) ? CURSOR_PREFIX : LEGACY_CURSOR_PREFIX;
    const parsed: unknown = JSON.parse(
      Buffer.from(value.slice(prefix.length), "base64url").toString("utf8"),
    );
    return cursorSchema.parse(parsed);
  } catch (error) {
    if (error instanceof TaskQueryCursorError) throw error;
    throw malformedCursor();
  }
}

function ftsTokens(text: string) {
  return text.normalize("NFKC").match(/[\p{L}\p{N}_]+/gu) ?? [];
}

function compileFtsExpression(search: NonNullable<TaskFilterV1["search"]>) {
  const tokens = ftsTokens(search.text);
  if (tokens.length === 0) return null;
  if (search.mode === "phrase") {
    return `"${tokens.join(" ").replaceAll('"', '""')}"`;
  }
  const expressions = tokens.map((token) => `"${token.replaceAll('"', '""')}"*`);
  return expressions.join(search.mode === "all" ? " AND " : " OR ");
}

const ftsSources = [
  "title",
  "task_content",
  "acceptance_criteria",
  "comments",
  "reports",
] as const satisfies readonly TaskSearchMatchedSource[];

const ftsSourceWeight: Record<TaskSearchMatchedSource, number> = {
  title: 8,
  task_content: 4,
  acceptance_criteria: 6,
  comments: 3,
  reports: 3,
};

type QueryCustomFieldDefinition = Pick<
  typeof customFieldDefinitions.$inferSelect,
  "id" | "type" | "validationJson"
>;

function customFieldClauseOperands(clause: TaskFilterCustomFieldClause) {
  if ("value" in clause) return [clause.value];
  if ("from" in clause) return [clause.from, clause.to];
  return [];
}

function invalidCustomFieldClause(index: number, message: string) {
  return new InvalidTaskQueryError({
    message: "The custom-field filter is invalid for this project.",
    issues: [`customFields.${index}: ${message}`],
  });
}

/** Structural schemas validate operand shapes; this pass validates project identity and type. */
function validateCustomFieldFilterDefinitions(database: Database.Database, filter: TaskFilterV1) {
  if (!filter.customFields) return;
  const rows = database
    .prepare<
      [string],
      {
        readonly id: string;
        readonly type: QueryCustomFieldDefinition["type"];
        readonly validationJson: string;
      }
    >(
      `select id, type, validation_json as validationJson
       from custom_field_definitions
       where project_id = ?`,
    )
    .all(filter.projectId);
  const definitions = new Map(rows.map((row) => [row.id, row]));
  for (const [index, clause] of filter.customFields.entries()) {
    const definition = definitions.get(clause.fieldId);
    if (!definition) {
      throw invalidCustomFieldClause(
        index,
        `Custom field ${clause.fieldId} does not exist in this project.`,
      );
    }
    const operandType = taskFilterCustomFieldOperandType(clause);
    if (operandType !== null && operandType !== definition.type) {
      throw invalidCustomFieldClause(
        index,
        `Custom field ${clause.fieldId} has type ${definition.type}, not ${operandType}.`,
      );
    }
    if (definition.type === "single_select") {
      const optionIds = new Set(
        customFieldSingleSelectValidationSchema
          .parse(JSON.parse(definition.validationJson))
          .options.map(({ id }) => id),
      );
      const unknownOption = customFieldClauseOperands(clause).find(
        (operand) => operand.type === "single_select" && !optionIds.has(operand.value),
      );
      if (unknownOption?.type === "single_select") {
        throw invalidCustomFieldClause(
          index,
          `Custom field ${clause.fieldId} does not define option ${unknownOption.value}.`,
        );
      }
    }
  }
}

function normalizeCustomFieldText(value: string) {
  return value.normalize("NFKC").toLocaleLowerCase("en-US");
}

function sqliteScalar(value: string | number | boolean): string | number {
  return typeof value === "boolean" ? Number(value) : value;
}

function installQueryFunctions(database: Database.Database) {
  database.function(
    "helm_query_text_matches",
    { deterministic: true },
    (value: unknown, wanted: unknown, operator: unknown) => {
      if (typeof value !== "string" || typeof wanted !== "string") return 0;
      const normalized = normalizeCustomFieldText(value);
      const normalizedWanted = normalizeCustomFieldText(wanted);
      if (operator === "contains") return Number(normalized.includes(normalizedWanted));
      if (operator === "starts_with") return Number(normalized.startsWith(normalizedWanted));
      if (operator === "ends_with") return Number(normalized.endsWith(normalizedWanted));
      return 0;
    },
  );
}

function ftsSourceHit(source: TaskSearchMatchedSource) {
  return `case when match_${source}.task_id is null then 0 else 1 end`;
}

function setFilterPredicate(
  builder: SqlBuilder,
  table: string,
  valueColumn: string,
  operator: "any_of" | "all_of" | "none_of",
  values: readonly string[],
) {
  if (operator !== "all_of") {
    const matches = `exists (
      select 1 from ${table} assigned
      where assigned.task_id = t.id
        and assigned.${valueColumn} in (
          select value from json_each(${builder.bindJson(values)})
        )
    )`;
    return operator === "any_of" ? matches : `not (${matches})`;
  }
  return `not exists (
    select 1 from json_each(${builder.bindJson(values)}) wanted
    where not exists (
      select 1 from ${table} assigned
      where assigned.task_id = t.id and assigned.${valueColumn} = wanted.value
    )
  )`;
}

function actorFilterPredicate(builder: SqlBuilder, filter: NonNullable<TaskFilterV1["actor"]>) {
  const predicates = filter.sources.map((source) => {
    const actors = builder.bindJson(filter.actors);
    if (source === "activity") {
      return `exists (
        select 1 from activity_entries entry, json_each(${actors}) wanted
        where entry.task_id = t.id and entry.project_id = t.project_id and (
          (json_extract(wanted.value, '$.type') in ('human', 'system')
            and entry.author_type = json_extract(wanted.value, '$.type')
            and entry.author_id = json_extract(wanted.value, '$.id'))
          or (json_extract(wanted.value, '$.type') = 'agent_profile'
            and entry.author_type = 'agent'
            and entry.agent_profile_id = json_extract(wanted.value, '$.id'))
          or (json_extract(wanted.value, '$.type') = 'agent_run'
            and entry.author_type = 'agent'
            and entry.agent_run_id = json_extract(wanted.value, '$.id'))
        )
      )`;
    }
    if (source === "attempt") {
      return `exists (
        select 1 from attempts attempt, json_each(${actors}) wanted
        where attempt.task_id = t.id and (
          (json_extract(wanted.value, '$.type') = 'agent_profile'
            and attempt.agent_profile_id = json_extract(wanted.value, '$.id'))
          or (json_extract(wanted.value, '$.type') = 'agent_run'
            and attempt.agent_run_id = json_extract(wanted.value, '$.id'))
        )
      )`;
    }
    return `exists (
      select 1 from events event, json_each(${actors}) wanted
      where event.project_id = t.project_id and (
        (event.entity_type = 'task' and event.entity_id = t.id)
        or exists (
          select 1 from json_each(event.changes_json, '$.taskIds') changed
          where changed.value = t.id
        )
      ) and (
        (json_extract(wanted.value, '$.type') in ('human', 'system')
          and event.actor_type = json_extract(wanted.value, '$.type')
          and event.actor_id = json_extract(wanted.value, '$.id'))
        or (json_extract(wanted.value, '$.type') = 'agent_run'
          and event.actor_type = 'agent'
          and event.actor_id = json_extract(wanted.value, '$.id'))
      )
    )`;
  });
  const matches = `(${predicates.join(" or ")})`;
  return filter.operator === "any_of" ? matches : `not ${matches}`;
}

function relationFilterPredicate(
  builder: SqlBuilder,
  clause: NonNullable<TaskFilterV1["relations"]>[number],
) {
  const direction =
    clause.direction === "upstream"
      ? "relation.target_task_id = t.id"
      : clause.direction === "downstream"
        ? "relation.source_task_id = t.id"
        : "(relation.source_task_id = t.id or relation.target_task_id = t.id)";
  const otherTask = `case
    when relation.target_task_id = t.id then relation.source_task_id
    else relation.target_task_id
  end`;
  const conditions = [direction];
  if (clause.types) {
    conditions.push(
      `relation.type in (select value from json_each(${builder.bindJson(clause.types)}))`,
    );
  }
  if (clause.taskIds) {
    conditions.push(
      `${otherTask} in (select value from json_each(${builder.bindJson(clause.taskIds)}))`,
    );
  }
  const exists = `exists (
    select 1 from task_relations relation
    where relation.project_id = t.project_id and ${conditions.join(" and ")}
  )`;
  return clause.operator === "exists" ? exists : `not (${exists})`;
}

function customFieldFilterPredicate(builder: SqlBuilder, clause: TaskFilterCustomFieldClause) {
  const effective = "coalesce(value.value_json, definition.default_value_json)";
  const conditions = [
    `definition.id = ${builder.bind(clause.fieldId)}`,
    "definition.project_id = t.project_id",
    `(definition.retired_at is null
      or value.task_id is not null
      or julianday(t.created_at) <= julianday(definition.retired_at))`,
  ];
  if (clause.operator === "missing") {
    conditions.push(`${effective} is null`);
  } else if (clause.operator === "present") {
    conditions.push(`${effective} is not null`);
  } else {
    conditions.push(`${effective} is not null`);
    const operand = "value" in clause ? clause.value : "from" in clause ? clause.from : null;
    if (!operand) throw new Error("A value filter must include an operand.");
    conditions.push(`json_extract(${effective}, '$.type') = ${builder.bind(operand.type)}`);
    const current = `json_extract(${effective}, '$.value')`;
    if (clause.operator === "equals" || clause.operator === "not_equals") {
      const expected =
        typeof clause.value.value === "boolean" ? Number(clause.value.value) : clause.value.value;
      conditions.push(
        `${current} ${clause.operator === "equals" ? "=" : "<>"} ${builder.bind(expected)}`,
      );
    } else if (
      clause.operator === "contains" ||
      clause.operator === "not_contains" ||
      clause.operator === "starts_with" ||
      clause.operator === "ends_with"
    ) {
      const positiveOperator = clause.operator === "not_contains" ? "contains" : clause.operator;
      conditions.push(
        `helm_query_text_matches(
          cast(${current} as text),
          ${builder.bind(clause.value.value)},
          ${builder.bind(positiveOperator)}
        ) = ${clause.operator === "not_contains" ? 0 : 1}`,
      );
    } else if (clause.operator === "between") {
      conditions.push(
        `${current} >= ${builder.bind(clause.from.value)}`,
        `${current} <= ${builder.bind(clause.to.value)}`,
      );
    } else if ("value" in clause) {
      const operator = {
        greater_than: ">",
        greater_than_or_equal: ">=",
        less_than: "<",
        less_than_or_equal: "<=",
        before: "<",
        on_or_before: "<=",
        after: ">",
        on_or_after: ">=",
      }[clause.operator];
      conditions.push(`${current} ${operator} ${builder.bind(sqliteScalar(clause.value.value))}`);
    } else {
      throw new Error("A custom-field comparison must include a value.");
    }
  }
  return `exists (
    select 1
    from custom_field_definitions definition
    left join task_custom_field_values value
      on value.definition_id = definition.id and value.task_id = t.id
    where ${conditions.join(" and ")}
  )`;
}

function structuredFilterPredicates(builder: SqlBuilder, filter: TaskFilterV1) {
  const predicates = ["t.project_id = ctx.project_id"];
  if (filter.archiveState === "exclude") predicates.push("t.archived_at is null");
  if (filter.archiveState === "only") predicates.push("t.archived_at is not null");
  if (filter.lifecycles) {
    predicates.push(
      `t.lifecycle in (select value from json_each(${builder.bindJson(filter.lifecycles)}))`,
    );
  }
  if (filter.priorities) {
    predicates.push(
      `t.priority in (select value from json_each(${builder.bindJson(filter.priorities)}))`,
    );
  }
  if (filter.tags) {
    predicates.push(
      setFilterPredicate(builder, "task_tags", "tag_id", filter.tags.operator, filter.tags.values),
    );
  }
  if (filter.capabilities) {
    predicates.push(
      setFilterPredicate(
        builder,
        "task_capability_requirements",
        "capability",
        filter.capabilities.operator,
        filter.capabilities.values,
      ),
    );
  }
  if (filter.actor) predicates.push(actorFilterPredicate(builder, filter.actor));
  for (const clause of filter.dates ?? []) {
    const column = {
      not_before: "t.not_before",
      due_at: "t.due_at",
      created_at: "t.created_at",
      updated_at: "t.updated_at",
    }[clause.field];
    if (clause.operator === "missing") predicates.push(`${column} is null`);
    else if (clause.operator === "present") predicates.push(`${column} is not null`);
    else if (clause.operator === "between") {
      predicates.push(
        `${column} >= ${builder.bind(clause.from)}`,
        `${column} <= ${builder.bind(clause.to)}`,
      );
    } else {
      predicates.push(
        `${column} ${clause.operator === "on_or_after" ? ">=" : "<="} ${builder.bind(clause.value)}`,
      );
    }
  }
  for (const clause of filter.relations ?? []) {
    predicates.push(relationFilterPredicate(builder, clause));
  }
  for (const clause of filter.customFields ?? []) {
    predicates.push(customFieldFilterPredicate(builder, clause));
  }
  return predicates;
}

function orderExpression(field: TaskSearchOrder["field"]) {
  return {
    relevance: "q.relevance",
    priority: "q.priority_rank",
    position: "q.position",
    due_at: "q.due_at",
    not_before: "q.not_before",
    created_at: "q.created_at",
    updated_at: "q.updated_at",
    sequence: "q.sequence",
    title: "q.title collate binary",
    id: "q.id collate binary",
  }[field];
}

function orderSql(order: readonly TaskSearchOrder[]) {
  return order
    .flatMap(({ field, direction }) => {
      const expression = orderExpression(field);
      return [`${expression} is null ${direction}`, `${expression} ${direction}`];
    })
    .join(", ");
}

function cursorValue(row: QueryRow, field: TaskSearchOrder["field"]): string | number | null {
  if (field === "relevance") return row.relevance;
  if (field === "priority") return row.priorityRank;
  if (field === "position") return row.position;
  if (field === "due_at") return row.dueAt;
  if (field === "not_before") return row.notBefore;
  if (field === "created_at") return row.createdAt ?? null;
  if (field === "updated_at") return row.updatedAt ?? null;
  if (field === "sequence") return row.sequence;
  if (field === "title") return row.title;
  return row.id;
}

function keysetPredicate(
  builder: SqlBuilder,
  order: readonly TaskSearchOrder[],
  key: readonly (string | number | null)[],
) {
  if (key.length !== order.length) throw malformedCursor("The task-query cursor key is invalid.");
  for (const [index, item] of order.entries()) {
    const value = key[index];
    const valid =
      item.field === "relevance"
        ? typeof value === "number" && Number.isFinite(value)
        : item.field === "priority"
          ? typeof value === "number" && Number.isInteger(value) && value >= 0 && value <= 3
          : item.field === "position"
            ? typeof value === "number" && Number.isInteger(value) && value >= 0
            : item.field === "sequence"
              ? typeof value === "number" && Number.isInteger(value) && value > 0
              : item.field === "title" || item.field === "id"
                ? typeof value === "string"
                : item.field === "created_at" || item.field === "updated_at"
                  ? typeof value === "string" &&
                    z.iso.datetime({ offset: true }).safeParse(value).success
                  : value === null ||
                    (typeof value === "string" && z.iso.date().safeParse(value).success);
    if (!valid) throw malformedCursor(`The ${item.field} cursor key is invalid.`);
  }
  const alternatives: string[] = [];
  for (const [index, item] of order.entries()) {
    const expression = orderExpression(item.field);
    const value = key[index] ?? null;
    const equal = order.slice(0, index).map((prior, priorIndex) => {
      const priorExpression = orderExpression(prior.field);
      const priorValue = key[priorIndex] ?? null;
      return priorValue === null
        ? `${priorExpression} is null`
        : `${priorExpression} = ${builder.bind(priorValue)}`;
    });
    let after: string;
    if (value === null) {
      after = item.direction === "asc" ? "0" : `${expression} is not null`;
    } else {
      const parameter = builder.bind(value);
      after =
        item.direction === "asc"
          ? `(${expression} > ${parameter} or ${expression} is null)`
          : `${expression} < ${parameter}`;
    }
    alternatives.push(`(${[...equal, after].join(" and ")})`);
  }
  return `(${alternatives.join(" or ")})`;
}

function selectOptionalColumns(fields: readonly TaskSearchField[]) {
  const selected = new Set(fields);
  return [
    ...(selected.has("descriptionText") ? ["detail.description_text as descriptionText"] : []),
    ...(selected.has("expectedOutcome") ? ["detail.expected_outcome as expectedOutcome"] : []),
    ...(selected.has("acceptanceCriteria")
      ? ["detail.acceptance_criteria as acceptanceCriteria"]
      : []),
    ...(selected.has("agentContext") ? ["detail.agent_context as agentContext"] : []),
    ...(selected.has("checklist") ? ["detail.checklist_json as checklistJson"] : []),
  ];
}

function queryRows(
  database: Database.Database,
  filter: TaskFilterV1,
  order: readonly TaskSearchOrder[],
  fields: readonly TaskSearchField[],
  context: TaskQueryEvaluationContext,
  cursor: DecodedQueryCursor | null,
  limit: number | null,
) {
  installQueryFunctions(database);
  validateCustomFieldFilterDefinitions(database, filter);
  const builder = new SqlBuilder();
  const ctes: string[] = [
    `query_context(project_id, today, now, capabilities_json) as (
      values (
        ${builder.bind(filter.projectId)},
        ${builder.bind(context.today)},
        ${builder.bind(context.now)},
        ${builder.bindJson(normalizeCapabilities(context.agentCapabilities))}
      )
    )`,
  ];
  const searchExpression = filter.search ? compileFtsExpression(filter.search) : null;
  let searchJoin = "";
  let sourceJoins = "";
  let relevance = "null";
  let sourceColumns =
    "0 as title_match, 0 as task_content_match, 0 as acceptance_criteria_match, 0 as comments_match, 0 as reports_match";
  if (filter.search && searchExpression) {
    const sourceExpression =
      filter.search.mode === "all"
        ? compileFtsExpression({ ...filter.search, mode: "any" })!
        : searchExpression;
    ctes.push(
      `fts_matching as (
        select distinct task_id from task_search
        where task_search match ${builder.bind(searchExpression)}
          and project_id = ${builder.bind(filter.projectId)}
      )`,
    );
    for (const source of ftsSources) {
      ctes.push(
        `fts_${source} as (
          select distinct task_id from task_search
          where task_search match ${builder.bind(`${source}: (${sourceExpression})`)}
            and project_id = ${builder.bind(filter.projectId)}
        )`,
      );
    }
    searchJoin = "join fts_matching search_match on search_match.task_id = t.id";
    sourceJoins = ftsSources
      .map((source) => `left join fts_${source} match_${source} on match_${source}.task_id = t.id`)
      .join("\n");
    relevance = `-(
      ${ftsSources.map((source) => `${ftsSourceWeight[source]} * ${ftsSourceHit(source)}`).join(" + ")}
    )`;
    sourceColumns = ftsSources
      .map((source) => `${ftsSourceHit(source)} as ${source}_match`)
      .join(", ");
  }
  const predicates = structuredFilterPredicates(builder, filter);
  if (filter.search && !searchExpression) predicates.push("0");
  const hasLiveClaim = `exists (
    select 1 from leases lease
    join agent_runs run on run.id = lease.agent_run_id
    where lease.task_id = t.id and lease.status = 'active'
      and lease.expires_at > ctx.now and run.status = 'active'
  )`;
  const hasBlockingDependency = `exists (
    select 1 from task_relations relation
    join tasks dependency on dependency.id = relation.source_task_id
    where relation.target_task_id = t.id and relation.type = 'blocks'
      and dependency.archived_at is null
      and dependency.lifecycle not in ('done', 'cancelled')
  )`;
  const hasManualBlocker = `exists (
    select 1 from manual_blockers blocker
    where blocker.task_id = t.id and blocker.status = 'active'
  )`;
  const hasMissingCapability = `exists (
    select 1 from task_capability_requirements requirement
    where requirement.task_id = t.id
      and requirement.capability not in (select value from json_each(ctx.capabilities_json))
  )`;
  const eligibility = `case
    when t.archived_at is not null then 'archived'
    when t.lifecycle = 'done' then 'complete'
    when ${hasLiveClaim} then 'claimed'
    when t.lifecycle <> 'ready' then 'not_ready'
    when t.not_before is not null and t.not_before > ctx.today then 'scheduled'
    when ${hasBlockingDependency} or ${hasManualBlocker} then 'blocked'
    when ${hasMissingCapability} then 'capability_mismatch'
    else 'claimable'
  end`;
  ctes.push(
    `base_rows as (
      select
        t.id,
        t.project_id,
        t.sequence,
        t.parent_task_id,
        t.title,
        t.lifecycle,
        t.priority,
        t.position,
        t.not_before,
        t.due_at,
        t.size,
        t.version,
        t.archived_at,
        t.review_mode_override,
        t.created_at,
        t.updated_at,
        project.review_mode as project_review_mode,
        project.repository_root as repository_root,
        case t.priority when 'urgent' then 0 when 'high' then 1 when 'normal' then 2 else 3 end as priority_rank,
        ${relevance} as relevance,
        ${sourceColumns},
        ${eligibility} as eligibility_status
      from tasks t
      join projects project on project.id = t.project_id
      cross join query_context ctx
      ${searchJoin}
      ${sourceJoins}
      where ${predicates.join(" and ")}
    )`,
  );
  const eligibilityFilter = filter.eligibility
    ? `where eligibility_status in (select value from json_each(${builder.bindJson(filter.eligibility)}))`
    : "";
  ctes.push(`filtered_rows as (select * from base_rows ${eligibilityFilter})`);
  const countCtes = [...ctes];
  const countParameters = [...builder.parameters];
  const pagePredicate =
    cursor?.version === 2 ? `where ${keysetPredicate(builder, order, cursor.key)}` : "";
  const pageLimit = limit === null ? "" : `limit ${builder.bind(limit + 1)}`;
  const pageOffset = cursor?.version === 1 ? `offset ${builder.bind(cursor.offset)}` : "";
  ctes.push(
    `page_rows as materialized (
      select q.* from filtered_rows q
      ${pagePredicate}
      order by ${orderSql(order)}
      ${pageLimit}
      ${pageOffset}
    )`,
  );
  const optionalColumns = selectOptionalColumns(fields);
  const sql = `with ${ctes.join(",\n")}
    select
      q.id,
      q.project_id as projectId,
      q.sequence,
      q.parent_task_id as parentTaskId,
      q.title,
      q.lifecycle,
      q.priority,
      q.priority_rank as priorityRank,
      q.position,
      q.not_before as notBefore,
      q.due_at as dueAt,
      q.size,
      q.version,
      q.archived_at as archivedAt,
      q.review_mode_override as reviewModeOverride,
      q.project_review_mode as projectReviewMode,
      q.repository_root as repositoryRoot,
      q.created_at as createdAt,
      q.updated_at as updatedAt,
      q.relevance,
      q.title_match as titleMatch,
      q.task_content_match as taskContentMatch,
      q.acceptance_criteria_match as acceptanceCriteriaMatch,
      q.comments_match as commentsMatch,
      q.reports_match as reportsMatch,
      q.eligibility_status as eligibilityStatus,
      (select count(*) from filtered_rows) as totalCount
      ${optionalColumns.length > 0 ? `, ${optionalColumns.join(", ")}` : ""}
    from page_rows q
    join tasks detail on detail.id = q.id
    order by ${orderSql(order)}
    `;
  const rows = database.prepare<SqliteValue[], QueryRow>(sql).all(...builder.parameters);
  const total =
    rows[0]?.totalCount ??
    database
      .prepare<SqliteValue[], { readonly total: number }>(
        `with ${countCtes.join(",\n")} select count(*) as total from filtered_rows`,
      )
      .get(...countParameters)?.total ??
    0;
  return { rows, total };
}

function valuesForPage<T>(map: Map<string, T[]>, taskId: string) {
  return map.get(taskId) ?? [];
}

function pushForTask<T>(map: Map<string, T[]>, taskId: string, value: T) {
  map.set(taskId, [...(map.get(taskId) ?? []), value]);
}

function matchedSources(row: QueryRow): TaskSearchMatchedSource[] {
  return [
    ...(row.titleMatch ? (["title"] as const) : []),
    ...(row.taskContentMatch ? (["task_content"] as const) : []),
    ...(row.acceptanceCriteriaMatch ? (["acceptance_criteria"] as const) : []),
    ...(row.commentsMatch ? (["comments"] as const) : []),
    ...(row.reportsMatch ? (["reports"] as const) : []),
  ];
}

function customFieldDefinitionFromQueryRow(row: {
  readonly definitionId: string;
  readonly projectId: string;
  readonly fieldKey: string;
  readonly type: CustomFieldDefinition["type"];
  readonly validationJson: string;
  readonly defaultValueJson: string | null;
  readonly displayLabel: string;
  readonly description: string;
  readonly position: number;
  readonly retiredAt: string | null;
  readonly definitionCreatedAt: string;
  readonly definitionUpdatedAt: string;
}) {
  return customFieldDefinitionSchema.parse({
    id: row.definitionId,
    projectId: row.projectId,
    key: row.fieldKey,
    type: row.type,
    validation: JSON.parse(row.validationJson),
    defaultValue: row.defaultValueJson === null ? null : JSON.parse(row.defaultValueJson),
    display: { label: row.displayLabel, description: row.description },
    position: row.position,
    retiredAt: row.retiredAt,
    createdAt: row.definitionCreatedAt,
    updatedAt: row.definitionUpdatedAt,
  });
}

function hydrateSearchItems(
  database: Database.Database,
  rows: readonly QueryRow[],
  fields: readonly TaskSearchField[],
  context: TaskQueryEvaluationContext,
): TaskSearchItem[] {
  if (rows.length === 0) return [];
  const ids = rows.map(({ id }) => id);
  const idsJson = JSON.stringify(ids);
  const tagsByTask = new Map<string, Task["tags"]>();
  const tagRows = database
    .prepare<
      [string],
      {
        readonly taskId: string;
        readonly id: string;
        readonly name: string;
        readonly description: string;
        readonly color: string;
        readonly exclusiveGroup: string | null;
        readonly reviewModeOverride: "required" | "direct" | null;
      }
    >(
      `select assignment.task_id as taskId, tag.id, tag.name, tag.description, tag.color,
              tag.exclusive_group as exclusiveGroup,
              tag.review_mode_override as reviewModeOverride
       from task_tags assignment
       join tags tag on tag.id = assignment.tag_id
       where assignment.task_id in (select value from json_each(?))
       order by assignment.task_id, tag.name collate binary, tag.id`,
    )
    .all(idsJson);
  for (const tag of tagRows) {
    pushForTask(tagsByTask, tag.taskId, {
      id: tag.id,
      name: tag.name,
      description: tag.description,
      color: tag.color,
      exclusiveGroup: tag.exclusiveGroup,
      reviewModeOverride: tag.reviewModeOverride,
    });
  }
  const capabilitiesByTask = new Map<string, string[]>();
  const capabilityRows = database
    .prepare<[string], { readonly taskId: string; readonly capability: string }>(
      `select task_id as taskId, capability
       from task_capability_requirements
       where task_id in (select value from json_each(?))
       order by task_id, capability collate binary`,
    )
    .all(idsJson);
  for (const requirement of capabilityRows) {
    pushForTask(capabilitiesByTask, requirement.taskId, requirement.capability);
  }
  const blockingByTask = new Map<string, string[]>();
  const blockingRows = database
    .prepare<[string], { readonly taskId: string; readonly blockingTaskId: string }>(
      `select relation.target_task_id as taskId, dependency.id as blockingTaskId
       from task_relations relation
       join tasks dependency on dependency.id = relation.source_task_id
       where relation.target_task_id in (select value from json_each(?))
         and relation.type = 'blocks'
         and dependency.archived_at is null
         and dependency.lifecycle not in ('done', 'cancelled')
       order by relation.target_task_id, dependency.id collate binary`,
    )
    .all(idsJson);
  for (const blocking of blockingRows) {
    pushForTask(blockingByTask, blocking.taskId, blocking.blockingTaskId);
  }
  const blockersByTask = new Map<string, Array<{ id: string; reason: string }>>();
  const blockerRows = database
    .prepare<[string], { readonly taskId: string; readonly id: string; readonly reason: string }>(
      `select task_id as taskId, id, reason
       from manual_blockers
       where task_id in (select value from json_each(?)) and status = 'active'
       order by task_id, created_at, id`,
    )
    .all(idsJson);
  for (const blocker of blockerRows) {
    pushForTask(blockersByTask, blocker.taskId, {
      id: blocker.id,
      reason: blocker.reason,
    });
  }
  const claimsByTask = new Map<string, TaskClaim>();
  const claimRows = database
    .prepare<
      [string, string],
      {
        readonly id: string;
        readonly taskId: string;
        readonly attemptId: string;
        readonly agentRunId: string;
        readonly agentProfileId: string;
        readonly agentDisplayName: string;
        readonly acquiredAt: string;
        readonly expiresAt: string;
        readonly invalidatedAt: string | null;
        readonly invalidationReason: string | null;
      }
    >(
      `select lease.id, lease.task_id as taskId, lease.attempt_id as attemptId,
              lease.agent_run_id as agentRunId, profile.id as agentProfileId,
              profile.display_name as agentDisplayName, lease.acquired_at as acquiredAt,
              lease.expires_at as expiresAt, lease.invalidated_at as invalidatedAt,
              lease.invalidation_reason as invalidationReason
       from leases lease
       join agent_runs run on run.id = lease.agent_run_id and run.status = 'active'
       join agent_profiles profile on profile.id = run.profile_id
       where lease.task_id in (select value from json_each(?))
         and lease.status = 'active' and lease.expires_at > ?
       order by lease.task_id, lease.acquired_at, lease.id`,
    )
    .all(idsJson, context.now);
  for (const claim of claimRows) {
    claimsByTask.set(claim.taskId, { ...claim, status: "active" });
  }

  const selected = new Set(fields);
  const relationsByTask = new Map<
    string,
    { upstream: TaskRelation[]; downstream: TaskRelation[] }
  >();
  if (selected.has("relations")) {
    const relationRows = database
      .prepare<
        [string, string],
        {
          readonly id: string;
          readonly projectId: string;
          readonly sourceTaskId: string;
          readonly sourceSequence: number;
          readonly sourceTitle: string;
          readonly targetTaskId: string;
          readonly targetSequence: number;
          readonly targetTitle: string;
          readonly type: TaskRelation["type"];
          readonly createdAt: string;
        }
      >(
        `select relation.id, relation.project_id as projectId,
                relation.source_task_id as sourceTaskId, source.sequence as sourceSequence,
                source.title as sourceTitle, relation.target_task_id as targetTaskId,
                target.sequence as targetSequence, target.title as targetTitle,
                relation.type, relation.created_at as createdAt
         from task_relations relation
         join tasks source on source.id = relation.source_task_id
         join tasks target on target.id = relation.target_task_id
         where relation.source_task_id in (select value from json_each(?))
            or relation.target_task_id in (select value from json_each(?))
         order by relation.created_at, relation.id`,
      )
      .all(idsJson, idsJson);
    const pageIds = new Set(ids);
    for (const relation of relationRows) {
      if (pageIds.has(relation.targetTaskId)) {
        const facts = relationsByTask.get(relation.targetTaskId) ?? {
          upstream: [],
          downstream: [],
        };
        facts.upstream.push(relation);
        relationsByTask.set(relation.targetTaskId, facts);
      }
      if (pageIds.has(relation.sourceTaskId)) {
        const facts = relationsByTask.get(relation.sourceTaskId) ?? {
          upstream: [],
          downstream: [],
        };
        facts.downstream.push(relation);
        relationsByTask.set(relation.sourceTaskId, facts);
      }
    }
  }

  const customFieldsByTask = new Map<string, NonNullable<TaskSearchItem["task"]["customFields"]>>();
  if (selected.has("customFields")) {
    type CustomFieldRow = Parameters<typeof customFieldDefinitionFromQueryRow>[0] & {
      readonly taskId: string;
      readonly valueJson: string | null;
    };
    const fieldRows = database
      .prepare<[string], CustomFieldRow>(
        `select task.id as taskId, definition.id as definitionId,
                definition.project_id as projectId, definition.field_key as fieldKey,
                definition.type, definition.validation_json as validationJson,
                definition.default_value_json as defaultValueJson,
                definition.display_label as displayLabel, definition.description,
                definition.position, definition.retired_at as retiredAt,
                definition.created_at as definitionCreatedAt,
                definition.updated_at as definitionUpdatedAt,
                value.value_json as valueJson
         from json_each(?) wanted
         join tasks task on task.id = wanted.value
         join custom_field_definitions definition on definition.project_id = task.project_id
         left join task_custom_field_values value
           on value.task_id = task.id and value.definition_id = definition.id
         where definition.retired_at is null
            or value.task_id is not null
            or julianday(task.created_at) <= julianday(definition.retired_at)
         order by task.id, definition.position, definition.id`,
      )
      .all(idsJson);
    const definitions = new Map<string, CustomFieldDefinition>();
    for (const field of fieldRows) {
      const definition =
        definitions.get(field.definitionId) ?? customFieldDefinitionFromQueryRow(field);
      definitions.set(field.definitionId, definition);
      const explicit =
        field.valueJson === null
          ? undefined
          : customFieldValueSchema.parse(JSON.parse(field.valueJson));
      const value = explicit ?? definition.defaultValue;
      pushForTask(
        customFieldsByTask,
        field.taskId,
        taskCustomFieldAssignmentSchema.parse({
          definition,
          value,
          source: explicit ? "explicit" : value === null ? "unset" : "default",
        }),
      );
    }
  }

  const pathsByTask = new Map<string, string[]>();
  if (selected.has("referencedPaths")) {
    const pathRows = database
      .prepare<[string], { readonly taskId: string; readonly path: string }>(
        `select task_id as taskId, path from task_referenced_paths
         where task_id in (select value from json_each(?))
         order by task_id, path collate binary`,
      )
      .all(idsJson);
    for (const path of pathRows) pushForTask(pathsByTask, path.taskId, path.path);
  }

  return rows.map((row) => {
    const tags = valuesForPage(tagsByTask, row.id);
    const requiredCapabilities = valuesForPage(capabilitiesByTask, row.id);
    const claim = claimsByTask.get(row.id) ?? null;
    const blockingTaskIds = valuesForPage(blockingByTask, row.id);
    const manualBlockers = valuesForPage(blockersByTask, row.id);
    const eligibility = evaluateTaskEligibility(
      {
        archivedAt: row.archivedAt,
        lifecycle: row.lifecycle,
        claim,
        notBefore: row.notBefore,
        requiredCapabilities,
        priority: row.priority,
        position: row.position,
        dueAt: row.dueAt,
        sequence: row.sequence,
        manualBlockers,
      },
      context,
      blockingTaskIds,
      manualBlockers,
    );
    if (eligibility.status !== row.eligibilityStatus) {
      throw new Error(`Task ${row.id} changed while its query projection was being hydrated.`);
    }
    const relationFacts = relationsByTask.get(row.id) ?? {
      upstream: [],
      downstream: [],
    };
    const task: TaskSearchItem["task"] = {
      id: row.id,
      projectId: row.projectId,
      sequence: row.sequence,
      parentTaskId: row.parentTaskId,
      title: row.title,
      lifecycle: row.lifecycle,
      priority: row.priority,
      position: row.position,
      notBefore: row.notBefore,
      dueAt: row.dueAt,
      size: row.size,
      tags,
      requiredCapabilities,
      claim,
      eligibility,
      version: row.version,
      ...(selected.has("descriptionText") ? { descriptionText: row.descriptionText ?? "" } : {}),
      ...(selected.has("expectedOutcome") ? { expectedOutcome: row.expectedOutcome ?? "" } : {}),
      ...(selected.has("acceptanceCriteria")
        ? { acceptanceCriteria: row.acceptanceCriteria ?? "" }
        : {}),
      ...(selected.has("agentContext") ? { agentContext: row.agentContext ?? "" } : {}),
      ...(selected.has("checklist") ? { checklist: JSON.parse(row.checklistJson ?? "[]") } : {}),
      ...(selected.has("relations")
        ? {
            upstreamRelations: relationFacts.upstream,
            downstreamRelations: relationFacts.downstream,
          }
        : {}),
      ...(selected.has("customFields")
        ? { customFields: valuesForPage(customFieldsByTask, row.id) }
        : {}),
      ...(selected.has("reviewPolicy")
        ? {
            reviewPolicy: resolveReviewPolicy({
              projectId: row.projectId,
              projectMode: row.projectReviewMode,
              taskId: row.id,
              taskOverride: row.reviewModeOverride,
              tags: tags.map(({ id, name, reviewModeOverride }) => ({
                id,
                name,
                reviewModeOverride,
              })),
            }),
          }
        : {}),
      ...(selected.has("referencedPaths")
        ? {
            referencedPaths: validateProjectReferencedPaths(
              row.repositoryRoot,
              valuesForPage(pathsByTask, row.id),
            ),
          }
        : {}),
      ...(selected.has("timestamps")
        ? {
            archivedAt: row.archivedAt,
            createdAt: row.createdAt,
            updatedAt: row.updatedAt,
          }
        : {}),
    };
    return {
      task,
      relevance: row.relevance,
      matchedSources: matchedSources(row),
    };
  });
}

/**
 * Resolve the shared structured task query against the caller's current
 * SQLite session. Bulk commands call this from their immediate transaction so
 * target validation and writes observe one database snapshot.
 */
export function resolveSqliteTaskQueryItems(
  database: Database.Database,
  filterInput: TaskFilterV1,
  orderInput: readonly TaskSearchOrder[] | undefined,
  context: TaskQueryEvaluationContext,
  options: { readonly maxHydratedItems?: number } = {},
) {
  const filter = canonicalizeTaskFilter(filterInput);
  const order = canonicalizeTaskSearchOrder(orderInput, filter);
  const result = queryRows(
    database,
    filter,
    order,
    [],
    context,
    null,
    options.maxHydratedItems ?? null,
  );
  if (options.maxHydratedItems !== undefined && result.total > options.maxHydratedItems) {
    return {
      filter,
      order,
      items: [] as FullTaskSearchItem[],
      total: result.total,
    };
  }
  const rows = result.rows;
  const rowsById = new Map(rows.map((row) => [row.id, row]));
  const tasks = Array.from({ length: Math.ceil(rows.length / 500) }, (_, index) =>
    readSqliteTaskProjections(database, {
      projectId: filter.projectId,
      includeArchived: true,
      today: context.today,
      now: context.now,
      agentCapabilities: context.agentCapabilities,
      taskIds: rows.slice(index * 500, (index + 1) * 500).map(({ id }) => id),
    }),
  ).flat();
  const tasksById = new Map(tasks.map((task) => [task.id, task]));
  const items: FullTaskSearchItem[] = rows.map((row) => {
    const task = tasksById.get(row.id);
    if (!task?.eligibility) throw new Error(`Task ${row.id} could not be hydrated.`);
    return {
      task: { ...task, eligibility: task.eligibility },
      relevance: row.relevance,
      matchedSources: matchedSources(rowsById.get(row.id)!),
    };
  });
  return { filter, order, items, total: result.total };
}

function searchPage(
  database: Database.Database,
  input: SearchTasksInput,
  context: TaskQueryEvaluationContext,
) {
  const filter = canonicalizeTaskFilter(input.filter);
  const order = canonicalizeTaskSearchOrder(input.order, filter);
  const fields = canonicalizeTaskSearchFields(input.fields);
  const revision = currentRevision(database, filter.projectId);
  const expectedQueryHash = queryHash(filter, order, fields);
  const expectedEvaluationHash = evaluationHash(filter.projectId, context);
  const cursor = input.cursor ? decodeCursor(input.cursor) : null;
  const expectedCursorHash =
    cursor?.version === 1 && fields.length === 0
      ? legacyQueryHash(filter, order)
      : expectedQueryHash;
  if (cursor?.queryHash !== undefined && cursor.queryHash !== expectedCursorHash) {
    throw new TaskQueryCursorError({
      reason: "query_mismatch",
      message: "The cursor belongs to a different task query.",
    });
  }
  if (cursor && cursor.evaluationHash !== expectedEvaluationHash) {
    throw new TaskQueryCursorError({
      reason: "evaluation_context_changed",
      message: "The date or effective agent capabilities changed; restart this task query.",
    });
  }
  if (cursor && cursor.revision !== revision) {
    throw new TaskQueryCursorError({
      reason: "stale",
      cursorRevision: cursor.revision,
      currentRevision: revision,
      message: "The project changed during pagination; restart this task query.",
    });
  }
  const asOf = cursor?.asOf ?? context.now;
  const result = queryRows(
    database,
    filter,
    order,
    fields,
    { ...context, now: asOf },
    cursor,
    input.limit,
  );
  if (cursor?.version === 1 && cursor.offset > result.total) {
    throw malformedCursor("The task-query cursor offset is invalid.");
  }
  const pageRows = result.rows.slice(0, input.limit);
  const items = hydrateSearchItems(database, pageRows, fields, {
    ...context,
    now: asOf,
  });
  const hasMore = result.rows.length > input.limit;
  const lastRow = pageRows.at(-1);
  return taskSearchPageSchema.parse({
    items,
    nextCursor:
      hasMore && lastRow
        ? encodeCursor({
            version: 2,
            revision,
            queryHash: expectedQueryHash,
            evaluationHash: expectedEvaluationHash,
            asOf,
            key: order.map(({ field }) => cursorValue(lastRow, field)),
          })
        : null,
    hasMore,
    total: result.total,
    revision,
  });
}

function savedViewFromRow(row: SavedViewRow): SavedView {
  const definition = migrateSavedViewDefinition(JSON.parse(row.definitionJson));
  if (row.definitionVersion !== definition.schemaVersion && row.definitionVersion !== 0) {
    throw new InvalidTaskQueryError({
      message: `Saved view ${row.id} has unsupported definition version ${row.definitionVersion}.`,
    });
  }
  return savedViewSchema.parse({
    id: row.id,
    projectId: row.projectId,
    sequence: row.sequence,
    name: row.name,
    definition,
    version: row.version,
    archivedAt: row.archivedAt,
    createdAt: row.createdAt,
    updatedAt: row.updatedAt,
  });
}

function existingIdempotentView(
  db: DatabaseSession,
  command: string,
  key: string,
  inputHash: string,
) {
  const existing = db
    .select()
    .from(idempotencyRecords)
    .where(eq(idempotencyRecords.key, key))
    .limit(1)
    .get();
  if (!existing) return null;
  if (existing.command !== command || existing.inputHash !== inputHash) {
    throw new SavedViewIdempotencyConflictError({
      key,
      message: "That idempotency key was already used for a different command.",
    });
  }
  return savedViewSchema.parse(JSON.parse(existing.resultJson));
}

function ensureProject(db: DatabaseSession, projectId: string) {
  const project = db
    .select({ id: projects.id })
    .from(projects)
    .where(eq(projects.id, projectId))
    .limit(1)
    .get();
  if (!project) {
    throw new InvalidTaskQueryError({
      message: "The saved-view project does not exist.",
    });
  }
}

function ensureAvailableName(
  db: DatabaseSession,
  projectId: string,
  name: string,
  excludingId?: string,
) {
  const existing = db
    .select({ id: savedViews.id })
    .from(savedViews)
    .where(
      and(
        eq(savedViews.projectId, projectId),
        eq(savedViews.name, name),
        isNull(savedViews.archivedAt),
      ),
    )
    .limit(1)
    .get();
  if (existing && existing.id !== excludingId) {
    throw new SavedViewNameConflictError({
      projectId,
      name,
      message: `An active saved view named ${name} already exists.`,
    });
  }
}

function requireSavedView(db: DatabaseSession, projectId: string, savedViewId: string) {
  const row = db
    .select()
    .from(savedViews)
    .where(and(eq(savedViews.id, savedViewId), eq(savedViews.projectId, projectId)))
    .limit(1)
    .get();
  if (!row) {
    throw new SavedViewNotFoundError({
      savedViewId,
      message: "That saved view does not exist in this project.",
    });
  }
  return row;
}

function assertViewVersion(row: SavedViewRow, expectedVersion: number) {
  if (row.version === expectedVersion) return;
  throw new SavedViewVersionConflictError({
    savedViewId: row.id,
    expectedVersion,
    currentVersion: row.version,
    message: `Expected saved-view version ${expectedVersion}, but the current version is ${row.version}.`,
  });
}

function appendSavedViewEvent(
  db: DatabaseSession,
  view: SavedView,
  kind: string,
  actor: { readonly type: "human" | "agent" | "system"; readonly id: string },
  payload: Record<string, unknown>,
  now: string,
) {
  db.insert(events)
    .values({
      projectId: view.projectId,
      kind,
      importance: importanceForEventKind(kind),
      actorType: actor.type,
      actorId: actor.id,
      entityType: "saved_view",
      entityId: view.id,
      payloadJson: JSON.stringify(payload),
      changesJson: JSON.stringify(
        normalizeEventChangeHints({
          projectIds: [view.projectId],
          savedViewIds: [view.id],
          scopes: ["views"],
        }),
      ),
      occurredAt: now,
    })
    .run();
}

function recordIdempotentView(
  db: DatabaseSession,
  key: string,
  command: string,
  inputHash: string,
  view: SavedView,
  now: string,
) {
  db.insert(idempotencyRecords)
    .values({
      key,
      command,
      inputHash,
      resultJson: JSON.stringify(view),
      createdAt: now,
    })
    .run();
}

function createView(
  db: DatabaseSession,
  input: CreateSavedViewInput,
  actor: { readonly type: "human" | "agent" | "system"; readonly id: string },
  now: string,
) {
  const command = "saved_view.create";
  const definition = canonicalizeSavedViewDefinition(input.definition);
  const inputHash = commandInputHash(command, {
    projectId: input.projectId,
    name: input.name,
    definition,
  });
  const existing = existingIdempotentView(db, command, input.idempotencyKey, inputHash);
  if (existing) return existing;
  ensureProject(db, input.projectId);
  ensureAvailableName(db, input.projectId, input.name);
  const sequence =
    (db
      .select({ value: max(savedViews.sequence) })
      .from(savedViews)
      .where(eq(savedViews.projectId, input.projectId))
      .get()?.value ?? 0) + 1;
  const row: SavedViewRow = {
    id: randomUUID(),
    projectId: input.projectId,
    sequence,
    name: input.name,
    definitionVersion: definition.schemaVersion,
    definitionJson: JSON.stringify(definition),
    version: 1,
    archivedAt: null,
    createdAt: now,
    updatedAt: now,
  };
  db.insert(savedViews).values(row).run();
  const view = savedViewFromRow(row);
  appendSavedViewEvent(db, view, "saved_view.created", actor, { name: view.name, version: 1 }, now);
  recordIdempotentView(db, input.idempotencyKey, command, inputHash, view, now);
  return view;
}

function updateView(
  db: DatabaseSession,
  input: UpdateSavedViewInput,
  actor: { readonly type: "human" | "agent" | "system"; readonly id: string },
  now: string,
) {
  const command = "saved_view.update";
  const definition = canonicalizeSavedViewDefinition(input.definition);
  const inputHash = commandInputHash(command, {
    projectId: input.projectId,
    savedViewId: input.savedViewId,
    name: input.name,
    definition,
    expectedVersion: input.expectedVersion,
  });
  const existing = existingIdempotentView(db, command, input.idempotencyKey, inputHash);
  if (existing) return existing;
  const row = requireSavedView(db, input.projectId, input.savedViewId);
  assertViewVersion(row, input.expectedVersion);
  if (!row.archivedAt) ensureAvailableName(db, input.projectId, input.name, row.id);
  const updatedRow: SavedViewRow = {
    ...row,
    name: input.name,
    definitionVersion: definition.schemaVersion,
    definitionJson: JSON.stringify(definition),
    version: row.version + 1,
    updatedAt: now,
  };
  const update = db
    .update(savedViews)
    .set(updatedRow)
    .where(and(eq(savedViews.id, row.id), eq(savedViews.version, row.version)))
    .run();
  if (update.changes !== 1) {
    throw new SavedViewVersionConflictError({
      savedViewId: row.id,
      expectedVersion: row.version,
      currentVersion: requireSavedView(db, row.projectId, row.id).version,
      message: "The saved view changed while it was being updated.",
    });
  }
  const view = savedViewFromRow(updatedRow);
  appendSavedViewEvent(
    db,
    view,
    "saved_view.updated",
    actor,
    { name: view.name, previousVersion: row.version, version: view.version },
    now,
  );
  recordIdempotentView(db, input.idempotencyKey, command, inputHash, view, now);
  return view;
}

function changeViewArchiveState(
  db: DatabaseSession,
  input: ArchiveSavedViewInput,
  actor: { readonly type: "human" | "agent" | "system"; readonly id: string },
  now: string,
  restore: boolean,
) {
  const command = restore ? "saved_view.restore" : "saved_view.archive";
  const inputHash = commandInputHash(command, {
    projectId: input.projectId,
    savedViewId: input.savedViewId,
    expectedVersion: input.expectedVersion,
    reason: input.reason,
  });
  const existing = existingIdempotentView(db, command, input.idempotencyKey, inputHash);
  if (existing) return existing;
  const row = requireSavedView(db, input.projectId, input.savedViewId);
  assertViewVersion(row, input.expectedVersion);
  if (restore ? !row.archivedAt : Boolean(row.archivedAt)) {
    throw new InvalidTaskQueryError({
      message: restore
        ? "That saved view is not archived."
        : "That saved view is already archived.",
    });
  }
  if (restore) ensureAvailableName(db, row.projectId, row.name, row.id);
  const updatedRow: SavedViewRow = {
    ...row,
    archivedAt: restore ? null : now,
    version: row.version + 1,
    updatedAt: now,
  };
  const update = db
    .update(savedViews)
    .set({
      archivedAt: updatedRow.archivedAt,
      version: updatedRow.version,
      updatedAt: now,
    })
    .where(and(eq(savedViews.id, row.id), eq(savedViews.version, row.version)))
    .run();
  if (update.changes !== 1) {
    throw new SavedViewVersionConflictError({
      savedViewId: row.id,
      expectedVersion: row.version,
      currentVersion: requireSavedView(db, row.projectId, row.id).version,
      message: "The saved view changed while its archive state was being updated.",
    });
  }
  const view = savedViewFromRow(updatedRow);
  appendSavedViewEvent(
    db,
    view,
    restore ? "saved_view.restored" : "saved_view.archived",
    actor,
    {
      reason: input.reason,
      previousVersion: row.version,
      version: view.version,
    },
    now,
  );
  recordIdempotentView(db, input.idempotencyKey, command, inputHash, view, now);
  return view;
}

export function createSqliteTaskQueryStore(database: Database.Database): TaskQueryStore {
  const db = drizzle(database, { schema });
  return {
    search(input, context) {
      return Effect.try({
        try: () => database.transaction(() => searchPage(database, input, context)).deferred(),
        catch: commandError,
      });
    },
    resolveSelection(filter, order, context) {
      return Effect.try({
        try: () =>
          database
            .transaction(() => {
              const canonicalFilter = canonicalizeTaskFilter(filter);
              const canonicalOrder = canonicalizeTaskSearchOrder(order, canonicalFilter);
              return queryRows(
                database,
                canonicalFilter,
                canonicalOrder,
                [],
                context,
                null,
                null,
              ).rows.map((row): TaskSelectionItem => ({
                id: row.id,
                version: row.version,
              }));
            })
            .deferred(),
        catch: commandError,
      });
    },
    listSavedViews(input: ListSavedViewsInput) {
      return Effect.try({
        try: () =>
          db
            .select()
            .from(savedViews)
            .where(
              input.includeArchived
                ? eq(savedViews.projectId, input.projectId)
                : and(eq(savedViews.projectId, input.projectId), isNull(savedViews.archivedAt)),
            )
            .orderBy(asc(savedViews.sequence), asc(savedViews.id))
            .all()
            .map(savedViewFromRow),
        catch: commandError,
      });
    },
    getSavedView(input: GetSavedViewInput) {
      return Effect.try({
        try: () => savedViewFromRow(requireSavedView(db, input.projectId, input.savedViewId)),
        catch: commandError,
      });
    },
    createSavedView(input, actor, now) {
      return Effect.try({
        try: () =>
          db.transaction((tx) => createView(tx, input, actor, now), {
            behavior: "immediate",
          }),
        catch: commandError,
      });
    },
    updateSavedView(input, actor, now) {
      return Effect.try({
        try: () =>
          db.transaction((tx) => updateView(tx, input, actor, now), {
            behavior: "immediate",
          }),
        catch: commandError,
      });
    },
    archiveSavedView(input, actor, now) {
      return Effect.try({
        try: () =>
          db.transaction((tx) => changeViewArchiveState(tx, input, actor, now, false), {
            behavior: "immediate",
          }),
        catch: commandError,
      });
    },
    restoreSavedView(input, actor, now) {
      return Effect.try({
        try: () =>
          db.transaction((tx) => changeViewArchiveState(tx, input, actor, now, true), {
            behavior: "immediate",
          }),
        catch: commandError,
      });
    },
  };
}
