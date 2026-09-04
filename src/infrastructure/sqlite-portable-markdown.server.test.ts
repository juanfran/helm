import { describe, expect, it, vi } from "vitest";

import {
  PortabilityNotFoundError,
  PortabilityPersistenceError,
} from "../application/portability-errors";
import { createSqliteProjectStore } from "./sqlite-project-store.server";
import { exportSqliteProjectMarkdown } from "./sqlite-portable-markdown.server";

const now = "2026-09-04T12:00:00.000Z";
const richText = '{"version":1,"doc":{"type":"doc","content":[]}}';

function seededDatabase() {
  const store = createSqliteProjectStore(":memory:");
  store.database.exec(`
    insert into projects (
      id, sequence, name, repository_root, review_mode, version, created_at, updated_at
    ) values (
      'project-1', 1, 'Portable project', '/work/portable', 'required', 2, '${now}', '${now}'
    );
    insert into tasks (
      id, project_id, sequence, parent_task_id, title, lifecycle, priority, position,
      not_before, due_at, size, description_json, description_text, expected_outcome,
      acceptance_criteria, agent_context, checklist_json, review_mode_override,
      review_attempt_id, cancelled_from_lifecycle, version, archived_at, created_at, updated_at
    ) values
      (
        'task-1', 'project-1', 1, null, 'Ready task', 'ready', 'high', 0,
        null, null, null, '${richText}', 'Current ready task', 'Move safely',
        'Export current state', '', '[]', null, null, null, 1, null, '${now}', '${now}'
      ),
      (
        'task-2', 'project-1', 2, null, 'Archived task', 'done', 'normal', 1,
        null, null, null, '${richText}', 'Historical task', 'Already moved',
        'Keep archived state', '', '[]', null, null, null, 1, '${now}', '${now}', '${now}'
      );
    insert into saved_views (
      id, project_id, sequence, name, definition_version, definition_json, version,
      archived_at, created_at, updated_at
    ) values (
      'view-1', 'project-1', 1, 'Ready work', 1,
      '{"schemaVersion":1,"filter":{"schemaVersion":1,"projectId":"project-1","archiveState":"exclude","lifecycles":["ready"]},"order":[{"field":"sequence","direction":"asc"}],"grouping":{"type":"none"},"visibleFields":["title"],"presentation":"list"}',
      1, null, '${now}', '${now}'
    );
    insert into attempts (
      id, task_id, attempt_number, agent_run_id, agent_profile_id, agent_display_name,
      status, summary, changed_areas_json, verification_json, references_json,
      risks_json, follow_up_work_json, failure_classification, created_at, completed_at
    ) values
      ('attempt-1', 'task-1', 1, null, null, 'Archive agent', 'completed',
       'Ready history', '["src/domain"]', '["legacy check"]', '[]', '[]', '[]', null,
       '${now}', '${now}'),
      ('attempt-2', 'task-2', 1, null, null, null, 'failed',
       'Archived history', '[]', '[]', '[]', '[]', '[]', 'environment', '${now}', '${now}');
    insert into activity_entries (
      id, project_id, task_id, attempt_id, kind, author_type, author_id,
      author_display_name, agent_profile_id, agent_run_id, content_json, content_text,
      created_at, withdrawn_at, withdrawn_by_type, withdrawn_by_id, withdrawal_reason
    ) values
      ('entry-1', 'project-1', 'task-1', null, 'comment', 'human', 'local-human',
       'You', null, null, '${richText}', 'Visible note', '${now}', null, null, null, null),
      ('entry-2', 'project-1', 'task-2', null, 'comment', 'human', 'local-human',
       'You', null, null, '${richText}', 'Secret withdrawn text', '${now}', '${now}',
       'human', 'local-human', 'No longer relevant');
  `);
  return store;
}

describe("SQLite portable Markdown export", () => {
  it("exports all current state and history while redacting withdrawn content", () => {
    const store = seededDatabase();
    try {
      const result = exportSqliteProjectMarkdown(
        store.database,
        { projectId: "project-1", savedViewId: null },
        { now },
      );

      expect(result).toMatchObject({ projectName: "Portable project", viewName: null });
      expect(result.markdown).toContain("Ready task");
      expect(result.markdown).toContain("Archived task");
      expect(result.markdown).toContain("Ready history");
      expect(result.markdown).toContain("Archived history");
      expect(result.markdown).toContain("Visible note");
      expect(result.markdown).toContain("The withdrawn entry content is intentionally omitted");
      expect(result.markdown).not.toContain("Secret withdrawn text");
      expect(result.markdown).toContain("legacy check — Not Run");
    } finally {
      store.close();
    }
  });

  it("limits a saved-view export and rejects cross-project or missing identifiers", () => {
    const store = seededDatabase();
    try {
      const result = exportSqliteProjectMarkdown(
        store.database,
        { projectId: "project-1", savedViewId: "view-1" },
        { now },
      );
      expect(result.viewName).toBe("Ready work");
      expect(result.markdown).toContain("Ready task");
      expect(result.markdown).not.toContain("Archived task");
      expect(result.markdown).not.toContain("Archived history");

      expect(() =>
        exportSqliteProjectMarkdown(
          store.database,
          { projectId: "project-1", savedViewId: "view-missing" },
          { now },
        ),
      ).toThrow(PortabilityNotFoundError);
      expect(() =>
        exportSqliteProjectMarkdown(
          store.database,
          { projectId: "project-missing", savedViewId: null },
          { now },
        ),
      ).toThrow(PortabilityNotFoundError);
    } finally {
      store.close();
    }
  });

  it("pushes a saved-view task scope into history queries", () => {
    const store = seededDatabase();
    const prepare = vi.spyOn(store.database, "prepare");
    try {
      store.database.exec(`
        with recursive generated(value) as (
          select 2
          union all
          select value + 1 from generated where value < 2001
        )
        insert into attempts (
          id, task_id, attempt_number, agent_run_id, agent_profile_id, agent_display_name,
          status, summary, changed_areas_json, verification_json, references_json,
          risks_json, follow_up_work_json, failure_classification, created_at, completed_at
        )
        select
          'unrelated-attempt-' || value, 'task-2', value, null, null, null,
          'completed', 'Unrelated history ' || value, '[]', '[]', '[]', '[]', '[]', null,
          '${now}', '${now}'
        from generated;

        with recursive generated(value) as (
          select 1
          union all
          select value + 1 from generated where value < 2000
        )
        insert into activity_entries (
          id, project_id, task_id, attempt_id, kind, author_type, author_id,
          author_display_name, agent_profile_id, agent_run_id, content_json, content_text,
          created_at, withdrawn_at, withdrawn_by_type, withdrawn_by_id, withdrawal_reason
        )
        select
          'unrelated-entry-' || value, 'project-1', 'task-2', null, 'comment',
          'human', 'local-human', 'You', null, null, '${richText}',
          'Unrelated note ' || value, '${now}', null, null, null, null
        from generated;
      `);

      const result = exportSqliteProjectMarkdown(
        store.database,
        { projectId: "project-1", savedViewId: "view-1" },
        { now },
      );

      expect(result.markdown).toContain("Ready history");
      expect(result.markdown).not.toContain("Unrelated history");
      expect(result.markdown).not.toContain("Unrelated note");

      const statements = prepare.mock.calls.map(([source]) =>
        source.replace(/\s+/g, " ").trim().toLowerCase(),
      );
      const attemptQuery = statements.find((source) => source.includes("from attempts a"));
      const activityQuery = statements.find((source) => source.includes("from activity_entries"));
      expect(attemptQuery).toContain("where t.project_id = ? and a.task_id in (?)");
      expect(activityQuery).toContain("where project_id = ? and task_id in (?)");
    } finally {
      prepare.mockRestore();
      store.close();
    }
  }, 15_000);

  it("chunks large saved-view history scopes below SQLite's bind limit", () => {
    const store = seededDatabase();
    const prepare = vi.spyOn(store.database, "prepare");
    try {
      store.database.exec(`
        with recursive generated(value) as (
          select 3
          union all
          select value + 1 from generated where value < 502
        )
        insert into tasks (
          id, project_id, sequence, parent_task_id, title, lifecycle, priority, position,
          not_before, due_at, size, description_json, description_text, expected_outcome,
          acceptance_criteria, agent_context, checklist_json, review_mode_override,
          review_attempt_id, cancelled_from_lifecycle, version, archived_at, created_at, updated_at
        )
        select
          'selected-task-' || value, 'project-1', value, null, 'Selected task ' || value,
          'ready', 'normal', value, null, null, null, '${richText}', '', '', '', '', '[]',
          null, null, null, 1, null, '${now}', '${now}'
        from generated;
      `);

      const result = exportSqliteProjectMarkdown(
        store.database,
        { projectId: "project-1", savedViewId: "view-1" },
        { now },
      );

      expect(result.markdown).toContain("Selected task 502");
      const statements = prepare.mock.calls.map(([source]) =>
        source.replace(/\s+/g, " ").trim().toLowerCase(),
      );
      const attemptQueries = statements.filter(
        (source) => source.includes("from attempts a") && source.includes("a.task_id in"),
      );
      const activityQueries = statements.filter(
        (source) => source.includes("from activity_entries") && source.includes("task_id in"),
      );
      expect(attemptQueries).toHaveLength(2);
      expect(activityQueries).toHaveLength(2);
      expect(
        attemptQueries
          .map((source) => source.match(/\?/g)?.length ?? 0)
          .toSorted((left, right) => left - right),
      ).toEqual([2, 501]);
      expect(
        activityQueries
          .map((source) => source.match(/\?/g)?.length ?? 0)
          .toSorted((left, right) => left - right),
      ).toEqual([2, 501]);
    } finally {
      prepare.mockRestore();
      store.close();
    }
  });

  it("logs private persistence details under a correlation ID and returns a safe error", () => {
    const store = seededDatabase();
    const stderr = vi.spyOn(process.stderr, "write").mockReturnValue(true);
    try {
      store.database
        .prepare("update tasks set checklist_json = ? where id = ?")
        .run("not-json", "task-1");

      let failure: unknown;
      try {
        exportSqliteProjectMarkdown(
          store.database,
          { projectId: "project-1", savedViewId: null },
          { now },
        );
      } catch (error) {
        failure = error;
      }

      expect(failure).toBeInstanceOf(PortabilityPersistenceError);
      expect(failure).toMatchObject({
        message: "The Markdown export database operation failed.",
        correlationId: expect.stringMatching(/^[0-9a-f-]{36}$/),
      });
      if (!(failure instanceof PortabilityPersistenceError)) {
        throw new Error("Expected a typed Markdown persistence failure.");
      }
      expect(stderr.mock.calls.join("\n")).toContain(failure.correlationId);
      expect(stderr.mock.calls.join("\n")).toContain("SyntaxError");
      expect(failure.message).not.toContain("JSON");
    } finally {
      stderr.mockRestore();
      store.close();
    }
  });
});
