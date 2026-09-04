import { randomUUID } from "node:crypto";

import Database from "better-sqlite3";

import type { PortabilityExportContext, ProjectMarkdownExport } from "../application/portability";
import {
  PortabilityNotFoundError,
  PortabilityPersistenceError,
} from "../application/portability-errors";
import { activityEntrySchema, type ActivityEntry } from "../domain/activity";
import type { ExportProjectMarkdownInput } from "../domain/portability";
import { renderPortableMarkdown } from "../domain/portable-markdown";
import { projectSchema } from "../domain/projects";
import { migrateSavedViewDefinition } from "../domain/saved-views";
import { taskAttemptSummarySchema, type TaskAttemptSummary } from "../domain/tasks";
import { resolveSqliteTaskQueryItems } from "./sqlite-task-query-store.server";
import { readSqliteTaskProjections } from "./sqlite-task-store.server";

type AttemptProjection = {
  readonly id: string;
  readonly taskId: string;
  readonly attemptNumber: number;
  readonly agentRunId: string | null;
  readonly agentProfileId: string | null;
  readonly agentDisplayName: string | null;
  readonly status: "active" | "completed" | "failed" | "abandoned" | "cancelled";
  readonly summary: string;
  readonly changedAreasJson: string;
  readonly verificationJson: string;
  readonly referencesJson: string;
  readonly risksJson: string;
  readonly followUpWorkJson: string;
  readonly failureClassification:
    | "implementation"
    | "verification"
    | "environment"
    | "requirements"
    | "unknown"
    | null;
  readonly createdAt: string;
  readonly completedAt: string | null;
};

type ActivityProjection = {
  readonly id: string;
  readonly projectId: string;
  readonly taskId: string;
  readonly attemptId: string | null;
  readonly kind: "comment" | "progress" | "decision" | "change_request" | "system";
  readonly authorType: "human" | "agent" | "system";
  readonly authorId: string;
  readonly authorDisplayName: string;
  readonly agentProfileId: string | null;
  readonly contentJson: string;
  readonly contentText: string;
  readonly createdAt: string;
  readonly withdrawnAt: string | null;
  readonly withdrawnByType: "human" | "agent" | "system" | null;
  readonly withdrawnById: string | null;
  readonly withdrawalReason: string | null;
};

const SQLITE_HISTORY_TASK_BATCH_SIZE = 500;

type ScopedHistoryBindings = [projectId: string, ...taskIds: string[]];

function chunks<T>(values: readonly T[], size: number) {
  const result: T[][] = [];
  for (let offset = 0; offset < values.length; offset += size) {
    result.push(values.slice(offset, offset + size));
  }
  return result;
}

function taskIdPlaceholders(taskIds: readonly string[]) {
  return taskIds.map(() => "?").join(", ");
}

const attemptProjectionSql = `select
   a.id,
   a.task_id as taskId,
   a.attempt_number as attemptNumber,
   a.agent_run_id as agentRunId,
   coalesce(a.agent_profile_id, r.profile_id) as agentProfileId,
   coalesce(a.agent_display_name, p.display_name) as agentDisplayName,
   a.status,
   a.summary,
   a.changed_areas_json as changedAreasJson,
   a.verification_json as verificationJson,
   a.references_json as referencesJson,
   a.risks_json as risksJson,
   a.follow_up_work_json as followUpWorkJson,
   a.failure_classification as failureClassification,
   a.created_at as createdAt,
   a.completed_at as completedAt
 from attempts a
 join tasks t on t.id = a.task_id
 left join agent_runs r on r.id = a.agent_run_id
 left join agent_profiles p on p.id = coalesce(a.agent_profile_id, r.profile_id)`;

const activityProjectionSql = `select
   id,
   project_id as projectId,
   task_id as taskId,
   attempt_id as attemptId,
   kind,
   author_type as authorType,
   author_id as authorId,
   author_display_name as authorDisplayName,
   agent_profile_id as agentProfileId,
   content_json as contentJson,
   content_text as contentText,
   created_at as createdAt,
   withdrawn_at as withdrawnAt,
   withdrawn_by_type as withdrawnByType,
   withdrawn_by_id as withdrawnById,
   withdrawal_reason as withdrawalReason
 from activity_entries`;

function readAttemptRows(
  database: Database.Database,
  projectId: string,
  selectedTaskIds: readonly string[] | null,
) {
  if (selectedTaskIds === null) {
    return database
      .prepare<[string], AttemptProjection>(
        `${attemptProjectionSql}
         where t.project_id = ?
         order by a.attempt_number, a.created_at, a.id`,
      )
      .all(projectId);
  }
  return chunks(selectedTaskIds, SQLITE_HISTORY_TASK_BATCH_SIZE).flatMap((taskIds) =>
    database
      .prepare<ScopedHistoryBindings, AttemptProjection>(
        `${attemptProjectionSql}
         where t.project_id = ? and a.task_id in (${taskIdPlaceholders(taskIds)})
         order by a.attempt_number, a.created_at, a.id`,
      )
      .all(projectId, ...taskIds),
  );
}

function readActivityRows(
  database: Database.Database,
  projectId: string,
  selectedTaskIds: readonly string[] | null,
) {
  if (selectedTaskIds === null) {
    return database
      .prepare<[string], ActivityProjection>(
        `${activityProjectionSql}
         where project_id = ?
         order by created_at, id`,
      )
      .all(projectId);
  }
  return chunks(selectedTaskIds, SQLITE_HISTORY_TASK_BATCH_SIZE).flatMap((taskIds) =>
    database
      .prepare<ScopedHistoryBindings, ActivityProjection>(
        `${activityProjectionSql}
         where project_id = ? and task_id in (${taskIdPlaceholders(taskIds)})
         order by created_at, id`,
      )
      .all(projectId, ...taskIds),
  );
}

function isPortabilityError(error: unknown) {
  return error instanceof PortabilityNotFoundError || error instanceof PortabilityPersistenceError;
}

function persistenceError(error: unknown) {
  if (isPortabilityError(error)) return error;
  const correlationId = randomUUID();
  const detail = error instanceof Error ? `${error.name}: ${error.message}` : String(error);
  process.stderr.write(`[helm] Markdown export persistence failure ${correlationId}: ${detail}\n`);
  return new PortabilityPersistenceError({
    correlationId,
    message: "The Markdown export database operation failed.",
  });
}

function parseStringArray(value: string) {
  const parsed = JSON.parse(value) as unknown;
  return Array.isArray(parsed) ? parsed : [];
}

function attemptFromRow(row: AttemptProjection): TaskAttemptSummary {
  const legacyVerification = JSON.parse(row.verificationJson) as unknown;
  const verificationResults = Array.isArray(legacyVerification)
    ? legacyVerification.map((result) =>
        typeof result === "string"
          ? {
              name: result,
              status: "not_run" as const,
              details: "Imported from a legacy verification note.",
            }
          : result,
      )
    : [];
  return taskAttemptSummarySchema.parse({
    id: row.id,
    taskId: row.taskId,
    attemptNumber: row.attemptNumber,
    agentRunId: row.agentRunId,
    agentProfileId: row.agentProfileId,
    agentDisplayName: row.agentDisplayName,
    status: row.status,
    summary: row.summary,
    changedAreas: parseStringArray(row.changedAreasJson),
    verificationResults,
    references: parseStringArray(row.referencesJson),
    risks: parseStringArray(row.risksJson),
    followUpWork: parseStringArray(row.followUpWorkJson),
    failureClassification: row.failureClassification,
    createdAt: row.createdAt,
    completedAt: row.completedAt,
  });
}

function activityFromRow(row: ActivityProjection): ActivityEntry {
  return activityEntrySchema.parse({
    id: row.id,
    projectId: row.projectId,
    taskId: row.taskId,
    attemptId: row.attemptId,
    kind: row.kind,
    author: { type: row.authorType, id: row.authorId },
    authorDisplayName: row.authorDisplayName,
    agentProfileId: row.agentProfileId,
    content: row.withdrawnAt ? null : JSON.parse(row.contentJson),
    contentText: row.withdrawnAt ? "" : row.contentText,
    createdAt: row.createdAt,
    withdrawnAt: row.withdrawnAt,
    withdrawnBy:
      row.withdrawnByType && row.withdrawnById
        ? { type: row.withdrawnByType, id: row.withdrawnById }
        : null,
    withdrawalReason: row.withdrawalReason,
  });
}

/**
 * Renders one project or saved-view snapshot from a single deferred read transaction.
 * Current task state is hydrated through the canonical task projection; historical
 * attempts and activity are attached only for tasks inside the selected scope.
 */
export function exportSqliteProjectMarkdown(
  database: Database.Database,
  input: ExportProjectMarkdownInput,
  context: PortabilityExportContext,
): ProjectMarkdownExport {
  try {
    return database
      .transaction(() => {
        const projectRow = database
          .prepare(
            `select id, sequence, name, repository_root as repositoryRoot,
                    review_mode as reviewMode, version, created_at as createdAt,
                    updated_at as updatedAt
             from projects where id = ? limit 1`,
          )
          .get(input.projectId);
        if (!projectRow) {
          throw new PortabilityNotFoundError({
            entityType: "project",
            entityId: input.projectId,
            message: "That project does not exist.",
          });
        }
        const project = projectSchema.parse(projectRow);

        let viewName: string | null = null;
        let selectedTasks;
        if (input.savedViewId) {
          const view = database
            .prepare<[string, string], { readonly name: string; readonly definitionJson: string }>(
              `select name, definition_json as definitionJson
               from saved_views where id = ? and project_id = ? limit 1`,
            )
            .get(input.savedViewId, input.projectId);
          if (!view) {
            throw new PortabilityNotFoundError({
              entityType: "saved_view",
              entityId: input.savedViewId,
              message: "That saved view does not exist in this project.",
            });
          }
          const definition = migrateSavedViewDefinition(JSON.parse(view.definitionJson));
          viewName = view.name;
          selectedTasks = resolveSqliteTaskQueryItems(
            database,
            definition.filter,
            definition.order,
            {
              today: context.now.slice(0, 10),
              now: context.now,
              agentCapabilities: [],
            },
          ).items.map(({ task }) => task);
        } else {
          selectedTasks = readSqliteTaskProjections(database, {
            projectId: input.projectId,
            includeArchived: true,
            today: context.now.slice(0, 10),
            now: context.now,
            agentCapabilities: [],
          });
        }

        const selectedTaskIds = input.savedViewId ? selectedTasks.map(({ id }) => id) : null;
        const attempts = readAttemptRows(database, input.projectId, selectedTaskIds).map(
          attemptFromRow,
        );
        const entries = readActivityRows(database, input.projectId, selectedTaskIds).map(
          activityFromRow,
        );

        return {
          projectName: project.name,
          viewName,
          markdown: renderPortableMarkdown({
            project,
            viewName,
            tasks: selectedTasks,
            attempts,
            entries,
          }),
        };
      })
      .deferred();
  } catch (error) {
    throw persistenceError(error);
  }
}
