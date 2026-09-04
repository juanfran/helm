import { createHash } from "node:crypto";
import { mkdir, mkdtemp, rm, symlink } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { performance } from "node:perf_hooks";

import Database from "better-sqlite3";
import { Effect, Either } from "effect";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { z } from "zod";

import { searchTasks, type TaskQueryServices } from "../application/task-queries";
import {
  canonicalizeTaskFilter,
  canonicalizeTaskSearchOrder,
  stableCanonicalJson,
  type TaskFilterV1,
  type TaskSearchField,
  type TaskSearchOrder,
} from "../domain/task-filters";
import { emptyRichTextDocument, type TaskLifecycle, type TaskPriority } from "../domain/tasks";
import { createSqliteProjectStore, type SqliteProjectStore } from "./sqlite-project-store.server";
import {
  createSqliteTaskQueryStore,
  resolveSqliteTaskQueryItems,
} from "./sqlite-task-query-store.server";

const PROJECT_ID = "query-engine-project";
const NOW = "2026-09-04T10:00:00.000Z";
const TODAY = "2026-09-04";

type TaskFixture = {
  readonly id?: string;
  readonly title?: string;
  readonly lifecycle?: TaskLifecycle;
  readonly priority?: TaskPriority;
  readonly position?: number;
  readonly notBefore?: string | null;
  readonly dueAt?: string | null;
  readonly archivedAt?: string | null;
  readonly createdAt?: string;
  readonly updatedAt?: string;
};

let temporaryRoot: string;
let repositoryRoot: string;
let projectStore: SqliteProjectStore;
let services: TaskQueryServices;
let nextSequence: number;
let insertTaskStatement: Database.Statement;

function taskFilter(overrides: Partial<TaskFilterV1> = {}): TaskFilterV1 {
  return {
    schemaVersion: 1,
    projectId: PROJECT_ID,
    archiveState: "exclude",
    ...overrides,
  };
}

function insertTask(overrides: TaskFixture = {}) {
  const sequence = nextSequence++;
  const id = overrides.id ?? `task-${String(sequence).padStart(5, "0")}`;
  const createdAt =
    overrides.createdAt ?? new Date(Date.parse(NOW) + sequence * 1_000).toISOString();
  insertTaskStatement.run({
    id,
    projectId: PROJECT_ID,
    sequence,
    title: overrides.title ?? `Task ${String(sequence).padStart(5, "0")}`,
    lifecycle: overrides.lifecycle ?? "backlog",
    priority: overrides.priority ?? "normal",
    position: overrides.position ?? sequence,
    notBefore: overrides.notBefore ?? null,
    dueAt: overrides.dueAt ?? null,
    descriptionJson: JSON.stringify(emptyRichTextDocument),
    checklistJson: "[]",
    archivedAt: overrides.archivedAt ?? null,
    createdAt,
    updatedAt: overrides.updatedAt ?? createdAt,
  });
  return id;
}

function runSearch(input: {
  readonly filter?: TaskFilterV1;
  readonly order?: readonly TaskSearchOrder[];
  readonly fields?: readonly TaskSearchField[];
  readonly limit?: number;
  readonly cursor?: string | null;
  readonly capabilities?: readonly string[];
}) {
  return Effect.runPromise(
    searchTasks(
      {
        filter: input.filter ?? taskFilter(),
        order: input.order,
        fields: input.fields ?? [],
        limit: input.limit ?? 100,
        cursor: input.cursor ?? null,
      },
      input.capabilities ?? [],
      services,
    ),
  );
}

async function collectIds(input: {
  readonly filter?: TaskFilterV1;
  readonly order: readonly TaskSearchOrder[];
  readonly limit?: number;
}) {
  const ids: string[] = [];
  let cursor: string | null = null;
  do {
    // oxlint-disable-next-line no-await-in-loop
    const page = await runSearch({ ...input, cursor, limit: input.limit ?? 7 });
    ids.push(...page.items.map(({ task }) => task.id));
    expect(page.total).toBe(41);
    cursor = page.nextCursor;
  } while (cursor);
  return ids;
}

function parseCursor(cursor: string) {
  const parsed: unknown = JSON.parse(Buffer.from(cursor.slice(4), "base64url").toString("utf8"));
  return z
    .object({
      revision: z.number().int().nonnegative(),
      evaluationHash: z.string(),
      asOf: z.string(),
      key: z.array(z.union([z.string(), z.number(), z.null()])),
    })
    .parse(parsed);
}

beforeEach(async () => {
  temporaryRoot = await mkdtemp(join(tmpdir(), "helm-query-engine-"));
  repositoryRoot = join(temporaryRoot, "repository");
  await mkdir(join(repositoryRoot, ".git"), { recursive: true });
  projectStore = createSqliteProjectStore(":memory:");
  projectStore.database
    .prepare(
      `insert into projects (
        id, sequence, name, repository_root, review_mode, version, created_at, updated_at
      ) values (?, 1, 'Query engine', ?, 'required', 1, ?, ?)`,
    )
    .run(PROJECT_ID, repositoryRoot, NOW, NOW);
  services = {
    store: createSqliteTaskQueryStore(projectStore.database),
    clock: { today: () => TODAY, now: () => NOW },
  };
  nextSequence = 1;
  insertTaskStatement = projectStore.database.prepare(
    `insert into tasks (
      id, project_id, sequence, parent_task_id, title, lifecycle, priority, position,
      not_before, due_at, size, description_json, description_text, expected_outcome,
      acceptance_criteria, agent_context, checklist_json, review_mode_override,
      review_attempt_id, cancelled_from_lifecycle, version, archived_at, created_at, updated_at
    ) values (
      @id, @projectId, @sequence, null, @title, @lifecycle, @priority, @position,
      @notBefore, @dueAt, null, @descriptionJson, '', '', '', '', @checklistJson, null,
      null, null, 1, @archivedAt, @createdAt, @updatedAt
    )`,
  );
});

afterEach(async () => {
  projectStore.close();
  await rm(temporaryRoot, { recursive: true, force: true });
});

describe("bounded SQLite task query engine", () => {
  it("keeps a compact 5,000-task page inside latency, statement, and payload budgets", async () => {
    projectStore.database.transaction(() => {
      for (let index = 0; index < 5_000; index += 1) {
        insertTask({
          position: index % 37,
          priority: (["urgent", "high", "normal", "low"] as const)[index % 4],
          dueAt: index % 5 === 0 ? null : `2026-10-${String((index % 28) + 1).padStart(2, "0")}`,
        });
      }
    })();

    await runSearch({});
    const durations: number[] = [];
    let finalPage: Awaited<ReturnType<typeof runSearch>> | undefined;
    const prepare = vi.spyOn(projectStore.database, "prepare");
    try {
      for (let sample = 0; sample < 20; sample += 1) {
        prepare.mockClear();
        const startedAt = performance.now();
        // oxlint-disable-next-line no-await-in-loop
        finalPage = await runSearch({});
        durations.push(performance.now() - startedAt);
        expect(prepare.mock.calls.length).toBeLessThanOrEqual(20);
      }
    } finally {
      prepare.mockRestore();
    }

    const sorted = durations.toSorted((left, right) => left - right);
    const p95 = sorted[Math.ceil(sorted.length * 0.95) - 1]!;
    expect(p95).toBeLessThanOrEqual(750);
    expect(finalPage).toMatchObject({ total: 5_000, hasMore: true });
    expect(finalPage?.items).toHaveLength(100);
    expect(Buffer.byteLength(JSON.stringify(finalPage), "utf8")).toBeLessThanOrEqual(64 * 1_024);
    expect(finalPage?.items[0]?.task).not.toHaveProperty("descriptionText");
    expect(finalPage?.items[0]?.task).not.toHaveProperty("createdAt");

    const allIds = new Set<string>();
    let deepCursor: string | null = null;
    let deepPage: Awaited<ReturnType<typeof runSearch>> | undefined;
    for (let pageIndex = 0; pageIndex < 50; pageIndex += 1) {
      // oxlint-disable-next-line no-await-in-loop
      deepPage = await runSearch({ cursor: deepCursor });
      for (const { task } of deepPage.items) allIds.add(task.id);
      deepCursor = deepPage.nextCursor;
    }
    expect(allIds.size).toBe(5_000);
    expect(deepPage).toMatchObject({
      total: 5_000,
      hasMore: false,
      nextCursor: null,
    });

    const capped = resolveSqliteTaskQueryItems(
      projectStore.database,
      taskFilter(),
      undefined,
      { today: TODAY, now: NOW, agentCapabilities: [] },
      { maxHydratedItems: 200 },
    );
    expect(capped).toMatchObject({ total: 5_000, items: [] });
  });

  it("paginates every order and null direction without gaps, including bytewise text ties", async () => {
    const titles = ["Alpha", "alpha", "Álpha", "Zulu", "zulu", "Éclair"];
    for (let index = 0; index < 41; index += 1) {
      insertTask({
        title: `${titles[index % titles.length]} needle`,
        priority: (["urgent", "high", "normal", "low"] as const)[index % 4],
        position: index % 5,
        notBefore: index % 4 === 0 ? null : `2026-09-${String((index % 28) + 1).padStart(2, "0")}`,
        dueAt: index % 3 === 0 ? null : `2026-10-${String((index % 28) + 1).padStart(2, "0")}`,
        createdAt: `2026-09-04T10:${String(index).padStart(2, "0")}:00.000Z`,
        updatedAt: `2026-09-05T10:${String(40 - index).padStart(2, "0")}:00.000Z`,
      });
    }

    const fields = [
      "relevance",
      "priority",
      "position",
      "due_at",
      "not_before",
      "created_at",
      "updated_at",
      "sequence",
      "title",
      "id",
    ] as const;
    for (const field of fields) {
      for (const direction of ["asc", "desc"] as const) {
        const filter =
          field === "relevance"
            ? taskFilter({ search: { text: "needle", mode: "all" } })
            : taskFilter();
        const order = [{ field, direction }] as const;
        // oxlint-disable-next-line no-await-in-loop
        const first = await collectIds({ filter, order });
        // oxlint-disable-next-line no-await-in-loop
        const second = await collectIds({ filter, order });
        expect(first).toEqual(second);
        expect(new Set(first).size).toBe(41);
      }
    }
  });

  it("binds tq2 cursors to fields, validates key types, and accepts legacy tq1 offsets", async () => {
    for (let index = 0; index < 12; index += 1) insertTask({ position: index % 2 });
    const order = [{ field: "priority", direction: "asc" }] as const;
    const first = await runSearch({ order, limit: 5 });
    expect(first.nextCursor).toMatch(/^tq2:/);
    const second = await runSearch({
      order,
      limit: 5,
      cursor: first.nextCursor,
    });

    const fieldMismatch = await Effect.runPromise(
      Effect.either(
        searchTasks(
          {
            filter: taskFilter(),
            order,
            fields: ["timestamps"],
            limit: 5,
            cursor: first.nextCursor,
          },
          [],
          services,
        ),
      ),
    );
    expect(Either.isLeft(fieldMismatch) && fieldMismatch.left).toMatchObject({
      _tag: "TaskQueryCursorError",
      reason: "query_mismatch",
    });

    const decoded = parseCursor(first.nextCursor!);
    decoded.key[0] = "normal";
    const malformedCursor = `tq2:${Buffer.from(JSON.stringify({ ...decoded, version: 2 })).toString("base64url")}`;
    const malformed = await Effect.runPromise(
      Effect.either(
        searchTasks(
          { filter: taskFilter(), order, limit: 5, cursor: malformedCursor },
          [],
          services,
        ),
      ),
    );
    expect(Either.isLeft(malformed) && malformed.left).toMatchObject({
      _tag: "TaskQueryCursorError",
      reason: "malformed",
    });

    const canonicalFilter = canonicalizeTaskFilter(taskFilter());
    const canonicalOrder = canonicalizeTaskSearchOrder(order, canonicalFilter);
    const legacyHash = createHash("sha256")
      .update(stableCanonicalJson({ filter: canonicalFilter, order: canonicalOrder }))
      .digest("hex");
    const legacyCursorForOffset = (offset: number) =>
      `tq1:${Buffer.from(
        stableCanonicalJson({
          version: 1,
          revision: decoded.revision,
          queryHash: legacyHash,
          evaluationHash: decoded.evaluationHash,
          asOf: decoded.asOf,
          offset,
        }),
      ).toString("base64url")}`;
    const legacySecond = await runSearch({
      order,
      limit: 5,
      cursor: legacyCursorForOffset(5),
    });
    expect(legacySecond.items.map(({ task }) => task.id)).toEqual(
      second.items.map(({ task }) => task.id),
    );

    const legacyOverrun = await Effect.runPromise(
      Effect.either(
        searchTasks(
          {
            filter: taskFilter(),
            order,
            fields: [],
            limit: 5,
            cursor: legacyCursorForOffset(13),
          },
          [],
          services,
        ),
      ),
    );
    expect(Either.isLeft(legacyOverrun) && legacyOverrun.left).toMatchObject({
      _tag: "TaskQueryCursorError",
      reason: "malformed",
    });
  });

  it("keeps Unicode text, literal wildcard, and offset retirement semantics exact", async () => {
    const taskId = insertTask({ createdAt: "2026-09-04T12:00:00.000+02:00" });
    projectStore.database
      .prepare(
        `insert into custom_field_definitions (
          id, project_id, field_key, type, validation_json, default_value_json,
          display_label, description, position, retired_at, created_at, updated_at
        ) values (?, ?, ?, 'text', ?, ?, ?, '', 0, ?, ?, ?)`,
      )
      .run(
        "unicode-field",
        PROJECT_ID,
        "unicode_value",
        JSON.stringify({ minLength: 0, maxLength: 20_000 }),
        JSON.stringify({ type: "text", value: "CAFÉ 100%_ready" }),
        "Unicode value",
        "2026-09-04T10:30:00.000Z",
        NOW,
        NOW,
      );

    const page = await runSearch({
      filter: taskFilter({
        customFields: [
          {
            fieldId: "unicode-field",
            operator: "contains",
            value: { type: "text", value: "cafe\u0301 100%_" },
          },
        ],
      }),
      fields: ["customFields"],
    });
    expect(page.items.map(({ task }) => task.id)).toEqual([taskId]);
    expect(page.items[0]?.task.customFields?.[0]).toMatchObject({
      source: "default",
    });

    const wildcardIsLiteral = await runSearch({
      filter: taskFilter({
        customFields: [
          {
            fieldId: "unicode-field",
            operator: "contains",
            value: { type: "text", value: "%x_" },
          },
        ],
      }),
    });
    expect(wildcardIsLiteral.items).toEqual([]);
  });

  it("projects claims only for live runs and rejects referenced-path symlink escapes", async () => {
    const liveTask = insertTask({ lifecycle: "ready" });
    const expiredTask = insertTask({ lifecycle: "ready" });
    const closedRunTask = insertTask({ lifecycle: "ready" });
    projectStore.database
      .prepare(
        `insert into agent_profiles (
          id, profile_key, display_name, capabilities_json, created_at, updated_at
        ) values ('profile-live', 'profile-live', 'Live agent', '[]', ?, ?)`,
      )
      .run(NOW, NOW);
    for (const [runId, status, sessionId] of [
      ["run-live", "active", "session-live"],
      ["run-closed", "closed", "session-closed"],
    ] as const) {
      projectStore.database
        .prepare(
          `insert into agent_runs (
            id, profile_id, mcp_session_id, status, created_at, last_seen_at, ended_at
          ) values (?, 'profile-live', ?, ?, ?, ?, ?)`,
        )
        .run(runId, sessionId, status, NOW, NOW, status === "closed" ? NOW : null);
    }
    for (const [taskId, runId, expiresAt] of [
      [liveTask, "run-live", "2026-09-04T11:00:00.000Z"],
      [expiredTask, "run-live", "2026-09-04T09:00:00.000Z"],
      [closedRunTask, "run-closed", "2026-09-04T11:00:00.000Z"],
    ] as const) {
      const attemptId = `attempt-${taskId}`;
      projectStore.database
        .prepare(
          `insert into attempts (
            id, task_id, attempt_number, agent_run_id, agent_profile_id, agent_display_name,
            status, summary, changed_areas_json, verification_json, references_json,
            risks_json, follow_up_work_json, created_at
          ) values (?, ?, 1, ?, 'profile-live', 'Live agent', 'active', '', '[]', '[]',
            '[]', '[]', '[]', ?)`,
        )
        .run(attemptId, taskId, runId, NOW);
      projectStore.database
        .prepare(
          `insert into leases (
            id, task_id, attempt_id, agent_run_id, token_hash, status, acquired_at, expires_at
          ) values (?, ?, ?, ?, ?, 'active', ?, ?)`,
        )
        .run(`lease-${taskId}`, taskId, attemptId, runId, `token-${taskId}`, NOW, expiresAt);
    }

    const claimed = await runSearch({
      filter: taskFilter({ eligibility: ["claimed"] }),
    });
    expect(claimed.items.map(({ task }) => task.id)).toEqual([liveTask]);
    const claimable = await runSearch({
      filter: taskFilter({ eligibility: ["claimable"] }),
    });
    expect(claimable.items.map(({ task }) => task.id)).toEqual([expiredTask, closedRunTask]);
    expect(claimable.items.every(({ task }) => task.claim === null)).toBe(true);

    const outside = join(temporaryRoot, "outside");
    await mkdir(outside);
    await symlink(outside, join(repositoryRoot, "escape"));
    projectStore.database
      .prepare("insert into task_referenced_paths (task_id, path) values (?, 'escape/file.ts')")
      .run(liveTask);
    const escaped = await Effect.runPromise(
      Effect.either(
        searchTasks(
          {
            filter: taskFilter({ lifecycles: ["ready"] }),
            fields: ["referencedPaths"],
          },
          [],
          services,
        ),
      ),
    );
    expect(Either.isLeft(escaped) && escaped.left).toMatchObject({
      _tag: "TaskQueryPersistenceError",
    });
  });
});
