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
import { events, idempotencyRecords, projects, savedViews, schema } from "../db/schema";
import { importanceForEventKind, normalizeEventChangeHints } from "../domain/activity";
import {
  canonicalizeTaskFilter,
  canonicalizeTaskSearchOrder,
  matchesStructuredTaskFilter,
  stableCanonicalJson,
  taskSearchPageSchema,
  type SearchTasksInput,
  type StructuredTaskFilterFacts,
  type TaskFilterActorReference,
  type TaskFilterActorSource,
  type TaskFilterV1,
  type TaskSearchItem,
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
import { normalizeCapabilities, taskPriorityRank } from "../domain/tasks";
import { readSqliteTaskProjections } from "./sqlite-task-store.server";

type DrizzleDatabase = ReturnType<typeof drizzle<typeof schema>>;
type DrizzleTransaction = Parameters<Parameters<DrizzleDatabase["transaction"]>[0]>[0];
type DatabaseSession = DrizzleDatabase | DrizzleTransaction;
type SavedViewRow = typeof savedViews.$inferSelect;

type QueryCursor = {
  readonly version: 1;
  readonly revision: number;
  readonly queryHash: string;
  readonly evaluationHash: string;
  readonly asOf: string;
  readonly offset: number;
};

type FtsHit = {
  readonly taskId: string;
  readonly relevance: number;
};

const CURSOR_PREFIX = "tq1:";
const queryCursorSchema = z.strictObject({
  version: z.literal(1),
  revision: z.number().int().nonnegative(),
  queryHash: z.string().regex(/^[a-f0-9]{64}$/),
  evaluationHash: z.string().regex(/^[a-f0-9]{64}$/),
  asOf: z.iso.datetime({ offset: true }),
  offset: z.number().int().nonnegative(),
});

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

function queryHash(filter: TaskFilterV1, order: readonly TaskSearchOrder[]) {
  return hash(stableCanonicalJson({ filter, order }));
}

function encodeCursor(cursor: QueryCursor) {
  return `${CURSOR_PREFIX}${Buffer.from(stableCanonicalJson(cursor)).toString("base64url")}`;
}

function malformedCursor(message = "The task-query cursor is malformed."): TaskQueryCursorError {
  return new TaskQueryCursorError({ reason: "malformed", message });
}

function decodeCursor(value: string): QueryCursor {
  try {
    if (!value.startsWith(CURSOR_PREFIX)) throw malformedCursor();
    const parsed: unknown = JSON.parse(
      Buffer.from(value.slice(CURSOR_PREFIX.length), "base64url").toString("utf8"),
    );
    return queryCursorSchema.parse(parsed);
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

function ftsHits(
  database: Database.Database,
  filter: TaskFilterV1,
): {
  readonly hits: readonly FtsHit[];
  readonly sources: ReadonlyMap<string, readonly TaskSearchMatchedSource[]>;
} | null {
  if (!filter.search) return null;
  const expression = compileFtsExpression(filter.search);
  if (!expression) return { hits: [], sources: new Map() };
  const matchingRows = database
    .prepare<[string, string], { readonly taskId: string }>(
      `select task_id as taskId
       from task_search
       where task_search match ? and project_id = ?
       order by task_id`,
    )
    .all(expression, filter.projectId);
  const sources = new Map<string, TaskSearchMatchedSource[]>();
  const sourceExpression =
    filter.search.mode === "all"
      ? compileFtsExpression({ ...filter.search, mode: "any" })
      : expression;
  for (const source of ftsSources) {
    const sourceHits = database
      .prepare<[string, string], { readonly taskId: string }>(
        `select task_id as taskId from task_search
         where task_search match ? and project_id = ?`,
      )
      .all(`${source}: (${sourceExpression})`, filter.projectId);
    for (const hit of sourceHits) {
      sources.set(hit.taskId, [...(sources.get(hit.taskId) ?? []), source]);
    }
  }
  // FTS5's bm25() uses corpus-wide inverse-document-frequency statistics, so another
  // project's writes could otherwise reorder this project's cursor pages. Fixed source
  // weights keep relevance deterministic and project-local while still favoring titles and
  // acceptance criteria over supporting discussion.
  const hits = matchingRows.map(({ taskId }) => ({
    taskId,
    relevance: -(sources.get(taskId) ?? []).reduce(
      (score, source) => score + ftsSourceWeight[source],
      0,
    ),
  }));
  return { hits, sources };
}

function allProjectTaskIds(database: Database.Database, projectId: string) {
  return database
    .prepare<[string], { readonly taskId: string }>(
      "select id as taskId from tasks where project_id = ? order by sequence, id",
    )
    .all(projectId)
    .map(({ taskId }) => taskId);
}

function pushActorFact(
  facts: Array<StructuredTaskFilterFacts["actors"][number]>,
  source: TaskFilterActorSource,
  actor: TaskFilterActorReference,
) {
  if (
    !facts.some(
      (fact) =>
        fact.source === source && fact.actor.type === actor.type && fact.actor.id === actor.id,
    )
  ) {
    facts.push({ source, actor });
  }
}

function actorFactsForTask(database: Database.Database, taskId: string): StructuredTaskFilterFacts {
  const facts: Array<StructuredTaskFilterFacts["actors"][number]> = [];
  const entries = database
    .prepare<
      [string],
      {
        readonly authorType: "human" | "agent" | "system";
        readonly authorId: string;
        readonly agentProfileId: string | null;
        readonly agentRunId: string | null;
      }
    >(
      `select author_type as authorType, author_id as authorId,
              agent_profile_id as agentProfileId, agent_run_id as agentRunId
       from activity_entries where task_id = ?`,
    )
    .all(taskId);
  for (const entry of entries) {
    if (entry.authorType === "agent") {
      if (entry.agentProfileId)
        pushActorFact(facts, "activity", { type: "agent_profile", id: entry.agentProfileId });
      if (entry.agentRunId)
        pushActorFact(facts, "activity", { type: "agent_run", id: entry.agentRunId });
    } else {
      pushActorFact(facts, "activity", { type: entry.authorType, id: entry.authorId });
    }
  }
  const reports = database
    .prepare<
      [string],
      { readonly agentProfileId: string | null; readonly agentRunId: string | null }
    >(
      `select agent_profile_id as agentProfileId, agent_run_id as agentRunId
       from attempts where task_id = ?`,
    )
    .all(taskId);
  for (const report of reports) {
    if (report.agentProfileId)
      pushActorFact(facts, "attempt", { type: "agent_profile", id: report.agentProfileId });
    if (report.agentRunId)
      pushActorFact(facts, "attempt", { type: "agent_run", id: report.agentRunId });
  }
  const eventActors = database
    .prepare<
      [string, string],
      { readonly actorType: "human" | "agent" | "system"; readonly actorId: string }
    >(
      `select distinct actor_type as actorType, actor_id as actorId
       from events
       where (entity_type = 'task' and entity_id = ?)
          or exists (
            select 1 from json_each(events.changes_json, '$.taskIds')
            where json_each.value = ?
          )`,
    )
    .all(taskId, taskId);
  for (const event of eventActors) {
    pushActorFact(
      facts,
      "event",
      event.actorType === "agent"
        ? { type: "agent_run", id: event.actorId }
        : { type: event.actorType, id: event.actorId },
    );
  }
  return { actors: facts };
}

function compareNullable<T>(
  left: T | null,
  right: T | null,
  compare: (leftValue: T, rightValue: T) => number,
) {
  if (left === null && right === null) return 0;
  if (left === null) return 1;
  if (right === null) return -1;
  return compare(left, right);
}

function fieldComparison(
  left: TaskSearchItem,
  right: TaskSearchItem,
  field: TaskSearchOrder["field"],
) {
  if (field === "relevance")
    return compareNullable(left.relevance, right.relevance, (a, b) => a - b);
  if (field === "priority")
    return taskPriorityRank[left.task.priority] - taskPriorityRank[right.task.priority];
  if (field === "position") return left.task.position - right.task.position;
  if (field === "sequence") return left.task.sequence - right.task.sequence;
  if (field === "title") return left.task.title.localeCompare(right.task.title);
  if (field === "id") return left.task.id.localeCompare(right.task.id);
  const leftValue =
    field === "due_at"
      ? left.task.dueAt
      : field === "not_before"
        ? left.task.notBefore
        : field === "created_at"
          ? left.task.createdAt
          : left.task.updatedAt;
  const rightValue =
    field === "due_at"
      ? right.task.dueAt
      : field === "not_before"
        ? right.task.notBefore
        : field === "created_at"
          ? right.task.createdAt
          : right.task.updatedAt;
  return compareNullable(leftValue, rightValue, (a, b) => a.localeCompare(b));
}

function compareSearchItems(
  left: TaskSearchItem,
  right: TaskSearchItem,
  order: readonly TaskSearchOrder[],
) {
  for (const item of order) {
    const comparison = fieldComparison(left, right, item.field);
    if (comparison !== 0) return item.direction === "asc" ? comparison : -comparison;
  }
  return left.task.id.localeCompare(right.task.id);
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
) {
  const filter = canonicalizeTaskFilter(filterInput);
  const order = canonicalizeTaskSearchOrder(orderInput, filter);
  const search = ftsHits(database, filter);
  const taskIds = search
    ? search.hits.map(({ taskId }) => taskId)
    : allProjectTaskIds(database, filter.projectId);
  if (taskIds.length === 0) return { filter, order, items: [] as TaskSearchItem[] };
  const relevance = new Map(search?.hits.map((hit) => [hit.taskId, hit.relevance]) ?? []);
  const projectionInput = {
    projectId: filter.projectId,
    includeArchived: true,
    today: context.today,
    now: context.now,
    agentCapabilities: context.agentCapabilities,
  };
  const tasks = search
    ? Array.from({ length: Math.ceil(taskIds.length / 500) }, (_, index) =>
        readSqliteTaskProjections(database, {
          ...projectionInput,
          taskIds: taskIds.slice(index * 500, (index + 1) * 500),
        }),
      ).flat()
    : readSqliteTaskProjections(database, projectionInput);
  const items = tasks
    .filter((task) =>
      matchesStructuredTaskFilter(
        task,
        filter,
        filter.actor ? actorFactsForTask(database, task.id) : { actors: [] },
      ),
    )
    .map((task) => ({
      task,
      relevance: search ? (relevance.get(task.id) ?? null) : null,
      matchedSources: [...(search?.sources.get(task.id) ?? [])],
    }))
    .toSorted((left, right) => compareSearchItems(left, right, order));
  return { filter, order, items };
}

function searchPage(
  database: Database.Database,
  input: SearchTasksInput,
  context: TaskQueryEvaluationContext,
) {
  const filter = canonicalizeTaskFilter(input.filter);
  const order = canonicalizeTaskSearchOrder(input.order, filter);
  const revision = currentRevision(database, filter.projectId);
  const expectedQueryHash = queryHash(filter, order);
  const expectedEvaluationHash = evaluationHash(filter.projectId, context);
  const cursor = input.cursor ? decodeCursor(input.cursor) : null;
  if (cursor?.queryHash !== undefined && cursor.queryHash !== expectedQueryHash) {
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
  const offset = cursor?.offset ?? 0;
  const result = resolveSqliteTaskQueryItems(database, filter, order, { ...context, now: asOf });
  if (offset > result.items.length)
    throw malformedCursor("The task-query cursor offset is invalid.");
  const items = result.items.slice(offset, offset + input.limit);
  const nextOffset = offset + items.length;
  const hasMore = nextOffset < result.items.length;
  return taskSearchPageSchema.parse({
    items,
    nextCursor: hasMore
      ? encodeCursor({
          version: 1,
          revision,
          queryHash: expectedQueryHash,
          evaluationHash: expectedEvaluationHash,
          asOf,
          offset: nextOffset,
        })
      : null,
    hasMore,
    total: result.items.length,
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
    throw new InvalidTaskQueryError({ message: "The saved-view project does not exist." });
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
    .set({ archivedAt: updatedRow.archivedAt, version: updatedRow.version, updatedAt: now })
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
    { reason: input.reason, previousVersion: row.version, version: view.version },
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
            .transaction(() =>
              resolveSqliteTaskQueryItems(database, filter, order, context).items.map(
                ({ task }): TaskSelectionItem => ({ id: task.id, version: task.version }),
              ),
            )
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
          db.transaction((tx) => createView(tx, input, actor, now), { behavior: "immediate" }),
        catch: commandError,
      });
    },
    updateSavedView(input, actor, now) {
      return Effect.try({
        try: () =>
          db.transaction((tx) => updateView(tx, input, actor, now), { behavior: "immediate" }),
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
