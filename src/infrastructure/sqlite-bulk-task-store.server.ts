import { createHash, randomUUID } from "node:crypto";

import Database from "better-sqlite3";
import { and, asc, eq, inArray, max } from "drizzle-orm";
import { drizzle } from "drizzle-orm/better-sqlite3";
import { Effect } from "effect";

import {
  BulkTaskIdempotencyConflictError,
  BulkTaskPersistenceError,
  BulkTaskPreviewMismatchError,
  BulkTaskPreviewStaleError,
  BulkTaskPreviewValidationError,
  type BulkTaskCommandError,
} from "../application/bulk-task-errors";
import {
  BULK_TASK_EXECUTE_COMMAND,
  assertBulkTaskExecutionMatchesPreview,
  canonicalBulkTaskIdempotencyJson,
  type BulkTaskEvaluationContext,
  type BulkTaskStore,
} from "../application/bulk-tasks";
import {
  customFieldDefinitions,
  events,
  idempotencyRecords,
  projects,
  schema,
  tags,
  taskCapabilityRequirements,
  taskCustomFieldValues,
  taskReferencedPaths,
  tasks,
  taskTags,
} from "../db/schema";
import { importanceForEventKind, normalizeEventChangeHints } from "../domain/activity";
import {
  MAX_BULK_UPDATE_TARGETS,
  bulkTaskExecutionResultSchema,
  bulkTaskCustomFieldsJson,
  bulkTaskPreviewSchema,
  canonicalBulkTaskIntentJson,
  canonicalBulkTaskPreviewStateJson,
  canonicalizeBulkTaskIntent,
  projectBulkTaskCreateCustomFields,
  projectBulkTaskUpdate,
  validateBulkTaskCreateItem,
  validateBulkTaskCreateParent,
  validateBulkTaskCreateTagDefinitions,
  type BulkTaskCreateItem,
  type BulkTaskCustomFieldChanges,
  type BulkTaskExecutionResult,
  type BulkTaskIntent,
  type BulkTaskPreview,
  type BulkTaskPreviewTarget,
  type BulkTaskUpdateProjection,
  type BulkTaskValidationFailure,
  type ExecuteBulkTasksInput,
} from "../domain/bulk-tasks";
import {
  customFieldDefinitionSchema,
  resolveReviewPolicy,
  type CustomFieldDefinition,
  type TaskCustomFieldAssignment,
} from "../domain/customization";
import { stableCanonicalJson } from "../domain/task-filters";
import {
  normalizeCapabilities,
  richTextToPlainText,
  type Actor,
  type TagInput,
  type Task,
  type TaskTag,
} from "../domain/tasks";
import {
  ProjectPathEscapeError,
  ProjectPathValidationError,
  validateProjectReferencedPaths,
} from "./project-instructions.server";
import { readSqliteTaskProjections } from "./sqlite-task-store.server";
import { resolveSqliteTaskQueryItems } from "./sqlite-task-query-store.server";

type DrizzleDatabase = ReturnType<typeof drizzle<typeof schema>>;
type TaskRow = typeof tasks.$inferSelect;
type TagRow = typeof tags.$inferSelect;
type CustomFieldDefinitionRow = typeof customFieldDefinitions.$inferSelect;

type CreatePlan = {
  readonly item: BulkTaskCreateItem;
  readonly sequence: number;
  readonly referencedPaths: readonly string[];
  readonly customFields: readonly TaskCustomFieldAssignment[];
  readonly failures: readonly BulkTaskValidationFailure[];
};

type UpdatePlan = {
  readonly task: Task;
  readonly projection: BulkTaskUpdateProjection;
};

type PreviewAnalysis = {
  readonly intent: BulkTaskIntent;
  readonly preview: BulkTaskPreview;
  readonly createPlans: readonly CreatePlan[];
  readonly updatePlans: readonly UpdatePlan[];
};

type UpdateSelection = {
  readonly selected: readonly Task[];
  readonly requestedRows: ReadonlyMap<string, TaskRow | Task>;
  readonly requestedIds: readonly string[];
  readonly matchedCount: number;
};

function hash(value: string) {
  return createHash("sha256").update(value).digest("hex");
}

function persistenceError(error: unknown) {
  const correlationId = randomUUID();
  const detail = error instanceof Error ? `${error.name}: ${error.message}` : String(error);
  process.stderr.write(`[helm] bulk task persistence failure ${correlationId}: ${detail}\n`);
  return new BulkTaskPersistenceError({
    message: "The bulk task database operation failed.",
    correlationId,
  });
}

function isBulkTaskError(error: unknown): error is BulkTaskCommandError {
  return (
    error instanceof BulkTaskIdempotencyConflictError ||
    error instanceof BulkTaskPreviewMismatchError ||
    error instanceof BulkTaskPreviewStaleError ||
    error instanceof BulkTaskPreviewValidationError ||
    error instanceof BulkTaskPersistenceError
  );
}

function commandError(error: unknown): BulkTaskCommandError {
  return isBulkTaskError(error) ? error : persistenceError(error);
}

function validationFailure(
  code: BulkTaskValidationFailure["code"],
  message: string,
  options: Partial<Pick<BulkTaskValidationFailure, "targetKey" | "taskId" | "field">> = {},
): BulkTaskValidationFailure {
  return { code, message, ...options };
}

function taskTag(row: TagRow): TaskTag {
  return {
    id: row.id,
    name: row.name,
    description: row.description,
    color: row.color,
    exclusiveGroup: row.exclusiveGroup,
    reviewModeOverride: row.reviewModeOverride,
  };
}

function customFieldDefinition(row: CustomFieldDefinitionRow): CustomFieldDefinition {
  return customFieldDefinitionSchema.parse({
    id: row.id,
    projectId: row.projectId,
    key: row.fieldKey,
    type: row.type,
    validation: JSON.parse(row.validationJson),
    defaultValue: row.defaultValueJson === null ? null : JSON.parse(row.defaultValueJson),
    display: {
      label: row.displayLabel,
      description: row.description,
    },
    position: row.position,
    retiredAt: row.retiredAt,
    createdAt: row.createdAt,
    updatedAt: row.updatedAt,
  });
}

function projectRow(db: DrizzleDatabase, projectId: string) {
  return db.select().from(projects).where(eq(projects.id, projectId)).limit(1).get();
}

function projectTags(db: DrizzleDatabase, projectId: string) {
  return db
    .select()
    .from(tags)
    .where(eq(tags.projectId, projectId))
    .orderBy(asc(tags.name), asc(tags.id))
    .all();
}

function projectCustomFields(db: DrizzleDatabase, projectId: string) {
  return db
    .select()
    .from(customFieldDefinitions)
    .where(eq(customFieldDefinitions.projectId, projectId))
    .orderBy(asc(customFieldDefinitions.position), asc(customFieldDefinitions.id))
    .all();
}

function currentSequence(db: DrizzleDatabase, projectId: string) {
  return (
    db
      .select({ value: max(tasks.sequence) })
      .from(tasks)
      .where(eq(tasks.projectId, projectId))
      .get()?.value ?? 0
  );
}

function rowsForIds(db: DrizzleDatabase, taskIds: readonly string[]) {
  if (taskIds.length === 0) return [];
  return db
    .select()
    .from(tasks)
    .where(inArray(tasks.id, [...taskIds]))
    .all();
}

function relevantTagHash(
  intent: BulkTaskIntent,
  selectedTasks: readonly Task[],
  tagRows: readonly TagRow[],
) {
  if (intent.kind === "create") {
    const names = new Set(
      intent.items.flatMap((item) => (item.task.tags ?? []).map(({ name }) => name)),
    );
    const rows = tagRows
      .filter((row) => names.has(row.name))
      .map(({ id, name, description, color, exclusiveGroup, reviewModeOverride, updatedAt }) => ({
        id,
        name,
        description,
        color,
        exclusiveGroup,
        reviewModeOverride,
        updatedAt,
      }));
    const found = new Set(rows.map(({ name }) => name));
    return hash(
      stableCanonicalJson({
        rows,
        missingNames: [...names].filter((name) => !found.has(name)).toSorted(),
      }),
    );
  }
  if (!intent.patch.tags) return hash("[]");
  const relevantIds = new Set([
    ...intent.patch.tags.add,
    ...intent.patch.tags.remove,
    ...selectedTasks.flatMap((task) => task.tags.map(({ id }) => id)),
  ]);
  return hash(
    stableCanonicalJson(
      tagRows
        .filter(({ id }) => relevantIds.has(id))
        .map(({ id, name, description, color, exclusiveGroup, reviewModeOverride, updatedAt }) => ({
          id,
          name,
          description,
          color,
          exclusiveGroup,
          reviewModeOverride,
          updatedAt,
        })),
    ),
  );
}

function relevantCustomFieldHash(rows: readonly CustomFieldDefinitionRow[]) {
  return hash(stableCanonicalJson(rows.map(customFieldDefinition)));
}

function relevantStateHash(
  tagDefinitionsHash: string,
  customFieldDefinitionsHash: string,
  targets: readonly BulkTaskPreviewTarget[],
  failures: readonly BulkTaskValidationFailure[],
) {
  return hash(
    stableCanonicalJson({
      tagDefinitionsHash,
      customFieldDefinitionsHash,
      outcome: {
        targets: targets.map(({ targetKey, changed, changes, failures: targetFailures }) => ({
          targetKey,
          changed,
          changes,
          failures: targetFailures,
        })),
        failures,
      },
    }),
  );
}

function createPreviewAnalysis(
  db: DrizzleDatabase,
  intent: Extract<BulkTaskIntent, { kind: "create" }>,
  actor: Actor,
  context: BulkTaskEvaluationContext,
): PreviewAnalysis {
  const project = projectRow(db, intent.projectId);
  const sequenceBase = currentSequence(db, intent.projectId);
  const tagRows = projectTags(db, intent.projectId);
  const tagDefinitions = tagRows.map(taskTag);
  const customFieldRows = projectCustomFields(db, intent.projectId);
  const customDefinitions = customFieldRows.map(customFieldDefinition);
  const tagFailures = validateBulkTaskCreateTagDefinitions(intent.items, tagDefinitions);
  const parentIds = [
    ...new Set(
      intent.items.flatMap(({ task }) => (task.parentTaskId === null ? [] : [task.parentTaskId])),
    ),
  ];
  const parentRows = new Map(rowsForIds(db, parentIds).map((row) => [row.id, row]));
  const topFailures: BulkTaskValidationFailure[] = project
    ? []
    : [validationFailure("wrong_project", "The requested project does not exist.")];
  const createPlans: CreatePlan[] = intent.items.map((item, index) => {
    const customFieldProjection = projectBulkTaskCreateCustomFields(item, customDefinitions);
    const failures = [
      ...validateBulkTaskCreateItem(item),
      ...tagFailures.filter(({ targetKey }) => targetKey === item.clientId),
      ...customFieldProjection.failures,
    ];
    const parentFailure = validateBulkTaskCreateParent(
      item,
      intent.projectId,
      item.task.parentTaskId ? parentRows.get(item.task.parentTaskId) : undefined,
    );
    if (parentFailure) failures.push(parentFailure);
    let referencedPaths = item.task.referencedPaths ?? [];
    if (project) {
      try {
        referencedPaths = validateProjectReferencedPaths(
          project.repositoryRoot,
          item.task.referencedPaths ?? [],
        );
      } catch (error) {
        if (
          error instanceof ProjectPathEscapeError ||
          error instanceof ProjectPathValidationError
        ) {
          failures.push(
            validationFailure("invalid_path", error.message, {
              targetKey: item.clientId,
              field: "referencedPaths",
            }),
          );
        } else {
          throw error;
        }
      }
    }
    return {
      item,
      sequence: sequenceBase + index + 1,
      referencedPaths,
      customFields: customFieldProjection.projected,
      failures,
    };
  });
  const targets: BulkTaskPreviewTarget[] = createPlans.map((plan) => {
    const { item } = plan;
    const priority = item.task.priority ?? "normal";
    return {
      targetKey: item.clientId,
      clientId: item.clientId,
      taskId: null,
      sequence: plan.sequence,
      title: item.task.title,
      expectedVersion: 0,
      projectedVersion: 1,
      changed: plan.failures.length === 0 && Boolean(project),
      changes: [
        {
          field: "task",
          before: null,
          after: {
            title: item.task.title,
            lifecycle: item.task.lifecycle,
            priority,
            position: item.task.position ?? plan.sequence,
            notBefore: item.task.notBefore ?? null,
            dueAt: item.task.dueAt ?? null,
            size: item.task.size ?? null,
            parentTaskId: item.task.parentTaskId,
            tags: (item.task.tags ?? []).map(({ name }) => name).toSorted(),
            requiredCapabilities: normalizeCapabilities(item.task.requiredCapabilities),
            customFields: bulkTaskCustomFieldsJson(plan.customFields),
          },
        },
      ],
      failures: [...plan.failures],
    };
  });
  const selectedTasks: readonly Task[] = [];
  const stateTargets = [
    ...createPlans.map((plan) => ({
      targetKey: plan.item.clientId,
      taskId: null,
      version: 0,
    })),
    ...[...parentRows.values()]
      .map((row) => ({
        targetKey: `parent:${row.id}`,
        taskId: row.id,
        version: row.version,
      }))
      .toSorted((left, right) => left.targetKey.localeCompare(right.targetKey)),
    ...parentIds
      .filter((parentId) => !parentRows.has(parentId))
      .map((parentId) => ({
        targetKey: `parent:${parentId}`,
        taskId: null,
        version: 0,
      })),
  ];
  const intentHash = hash(canonicalBulkTaskIntentJson(intent));
  const customFieldDefinitionsHash = relevantCustomFieldHash(customFieldRows);
  const stateHash = hash(
    canonicalBulkTaskPreviewStateJson({
      schemaVersion: 1,
      projectId: intent.projectId,
      actor,
      evaluation: {
        today: context.today,
        agentCapabilities: normalizeCapabilities(context.agentCapabilities),
      },
      targets: stateTargets,
      tagDefinitionsHash: relevantStateHash(
        relevantTagHash(intent, selectedTasks, tagRows),
        customFieldDefinitionsHash,
        targets,
        topFailures,
      ),
      customFieldDefinitionsHash,
      sequenceBase,
    }),
  );
  const affectedCount = targets.filter(({ changed }) => changed).length;
  const allFailures = [...topFailures, ...targets.flatMap(({ failures }) => failures)];
  return {
    intent,
    createPlans,
    updatePlans: [],
    preview: {
      schemaVersion: 1,
      mode: "atomic",
      kind: "create",
      projectId: intent.projectId,
      matchedCount: intent.items.length,
      affectedCount,
      executable: allFailures.length === 0,
      targets,
      failures: topFailures,
      previewToken: `btp1:${intentHash}:${stateHash}`,
    },
  };
}

function updateSelection(
  database: Database.Database,
  db: DrizzleDatabase,
  intent: Extract<BulkTaskIntent, { kind: "update" }>,
  context: BulkTaskEvaluationContext,
): UpdateSelection {
  if (intent.selection.type === "filter") {
    const result = resolveSqliteTaskQueryItems(
      database,
      intent.selection.filter,
      undefined,
      {
        today: context.today,
        now: context.now,
        agentCapabilities: context.agentCapabilities,
      },
      { maxHydratedItems: MAX_BULK_UPDATE_TARGETS },
    );
    const selected = result.items.map(({ task }) => task);
    return {
      selected,
      requestedRows: new Map(selected.map((task) => [task.id, task])),
      requestedIds: selected.map(({ id }) => id),
      matchedCount: result.total,
    };
  }

  const rows = rowsForIds(db, intent.selection.taskIds);
  const rowsById = new Map(rows.map((row) => [row.id, row]));
  const projectIds = intent.selection.taskIds.filter(
    (taskId) => rowsById.get(taskId)?.projectId === intent.projectId,
  );
  const projections = readSqliteTaskProjections(database, {
    projectId: intent.projectId,
    taskIds: projectIds,
    includeArchived: true,
    today: context.today,
    now: context.now,
    agentCapabilities: context.agentCapabilities,
  });
  return {
    selected: projections,
    requestedRows: rowsById,
    requestedIds: intent.selection.taskIds,
    matchedCount: intent.selection.taskIds.length,
  };
}

function updatePreviewAnalysis(
  database: Database.Database,
  db: DrizzleDatabase,
  intent: Extract<BulkTaskIntent, { kind: "update" }>,
  actor: Actor,
  context: BulkTaskEvaluationContext,
): PreviewAnalysis {
  const project = projectRow(db, intent.projectId);
  const tagRows = projectTags(db, intent.projectId);
  const tagDefinitions = tagRows.map(taskTag);
  const customFieldRows = projectCustomFields(db, intent.projectId);
  const customDefinitions = customFieldRows.map(customFieldDefinition);
  const selection = updateSelection(database, db, intent, context);
  const selectedById = new Map(selection.selected.map((task) => [task.id, task]));
  const topFailures: BulkTaskValidationFailure[] = [];
  if (!project) {
    topFailures.push(validationFailure("wrong_project", "The requested project does not exist."));
  }
  if (selection.matchedCount > MAX_BULK_UPDATE_TARGETS) {
    topFailures.push(
      validationFailure(
        "selection_limit",
        `The filter matched ${selection.matchedCount} tasks; narrow it to ${MAX_BULK_UPDATE_TARGETS} or fewer.`,
      ),
    );
  }

  const updatePlans: UpdatePlan[] = [];
  const targets: BulkTaskPreviewTarget[] = [];
  if (selection.matchedCount <= MAX_BULK_UPDATE_TARGETS) {
    for (const taskId of selection.requestedIds) {
      const task = selectedById.get(taskId);
      if (task) {
        const projection = projectBulkTaskUpdate(
          task,
          intent.patch,
          tagDefinitions,
          customDefinitions,
        );
        updatePlans.push({ task, projection });
        const changed = projection.failures.length === 0 && projection.changes.length > 0;
        targets.push({
          targetKey: task.id,
          clientId: null,
          taskId: task.id,
          sequence: task.sequence,
          title: task.title,
          expectedVersion: task.version,
          projectedVersion: task.version + (changed ? 1 : 0),
          changed,
          changes: [...projection.changes],
          failures: [...projection.failures],
        });
        continue;
      }

      if (intent.selection.type === "filter") continue;
      const row = selection.requestedRows.get(taskId);
      const wrongProject = Boolean(row && row.projectId !== intent.projectId);
      const targetFailure = validationFailure(
        wrongProject ? "wrong_project" : "task_not_found",
        wrongProject
          ? `Task ${taskId} does not belong to the requested project.`
          : `Task ${taskId} does not exist.`,
        { targetKey: taskId, taskId },
      );
      targets.push({
        targetKey: taskId,
        clientId: null,
        taskId,
        sequence: row?.sequence ?? null,
        title: row?.title ?? "Unavailable task",
        expectedVersion: row?.version ?? null,
        projectedVersion: null,
        changed: false,
        changes: [],
        failures: [targetFailure],
      });
    }
  }

  const affectedCount = targets.filter(({ changed }) => changed).length;
  const hasValidationFailures =
    topFailures.length > 0 || targets.some(({ failures }) => failures.length > 0);
  if (affectedCount === 0 && !hasValidationFailures) {
    topFailures.push(
      validationFailure("no_changes", "The bulk update would not change any tasks."),
    );
  }

  const stateTargets = selection.requestedIds.map((taskId) => {
    const task = selectedById.get(taskId);
    const row = selection.requestedRows.get(taskId);
    return {
      targetKey: taskId,
      taskId: task?.id ?? row?.id ?? null,
      version: task?.version ?? row?.version ?? 0,
    };
  });
  const intentHash = hash(canonicalBulkTaskIntentJson(intent));
  const customFieldDefinitionsHash = relevantCustomFieldHash(customFieldRows);
  const stateHash = hash(
    canonicalBulkTaskPreviewStateJson({
      schemaVersion: 1,
      projectId: intent.projectId,
      actor,
      evaluation: {
        today: context.today,
        agentCapabilities: normalizeCapabilities(context.agentCapabilities),
      },
      targets: stateTargets,
      tagDefinitionsHash: relevantStateHash(
        relevantTagHash(intent, selection.selected, tagRows),
        customFieldDefinitionsHash,
        targets,
        topFailures,
      ),
      customFieldDefinitionsHash,
      sequenceBase: null,
    }),
  );
  const allFailures = [...topFailures, ...targets.flatMap(({ failures }) => failures)];
  return {
    intent,
    createPlans: [],
    updatePlans,
    preview: bulkTaskPreviewSchema.parse({
      schemaVersion: 1,
      mode: "atomic",
      kind: "update",
      projectId: intent.projectId,
      matchedCount:
        intent.selection.type === "ids" ? intent.selection.taskIds.length : selection.matchedCount,
      affectedCount,
      executable: allFailures.length === 0,
      targets,
      failures: topFailures,
      previewToken: `btp1:${intentHash}:${stateHash}`,
    }),
  };
}

function analyzePreview(
  database: Database.Database,
  db: DrizzleDatabase,
  intentInput: BulkTaskIntent,
  actor: Actor,
  context: BulkTaskEvaluationContext,
): PreviewAnalysis {
  const intent = canonicalizeBulkTaskIntent(intentInput);
  const analysis =
    intent.kind === "create"
      ? createPreviewAnalysis(db, intent, actor, context)
      : updatePreviewAnalysis(database, db, intent, actor, context);
  return {
    ...analysis,
    preview: bulkTaskPreviewSchema.parse(analysis.preview),
  };
}

function commandInputHash(input: ExecuteBulkTasksInput, actor: Actor) {
  return hash(canonicalBulkTaskIdempotencyJson(input, actor));
}

function existingIdempotentResult(db: DrizzleDatabase, input: ExecuteBulkTasksInput, actor: Actor) {
  const existing = db
    .select()
    .from(idempotencyRecords)
    .where(eq(idempotencyRecords.key, input.idempotencyKey))
    .limit(1)
    .get();
  if (!existing) return null;
  const expectedHash = commandInputHash(input, actor);
  if (existing.command !== BULK_TASK_EXECUTE_COMMAND || existing.inputHash !== expectedHash) {
    throw new BulkTaskIdempotencyConflictError({
      key: input.idempotencyKey,
      message: "That idempotency key was already used for a different command.",
    });
  }
  return bulkTaskExecutionResultSchema.parse(JSON.parse(existing.resultJson));
}

function appendEvent(
  db: DrizzleDatabase,
  input: {
    projectId: string;
    kind: string;
    actor: Actor;
    entityType: string;
    entityId: string;
    payload: unknown;
    taskIds: readonly string[];
    occurredAt: string;
  },
) {
  return db
    .insert(events)
    .values({
      projectId: input.projectId,
      kind: input.kind,
      importance: importanceForEventKind(input.kind),
      actorType: input.actor.type,
      actorId: input.actor.id,
      entityType: input.entityType,
      entityId: input.entityId,
      payloadJson: JSON.stringify(input.payload),
      changesJson: JSON.stringify(
        normalizeEventChangeHints({
          projectIds: [input.projectId],
          taskIds: [...input.taskIds],
          scopes: ["tasks"],
        }),
      ),
      occurredAt: input.occurredAt,
    })
    .returning({ cursor: events.cursor })
    .get();
}

function appendParentEvent(
  db: DrizzleDatabase,
  analysis: PreviewAnalysis,
  actor: Actor,
  operationId: string,
  affectedTaskIds: readonly string[],
  occurredAt: string,
) {
  return appendEvent(db, {
    projectId: analysis.intent.projectId,
    kind: analysis.intent.kind === "create" ? "task.bulk.created" : "task.bulk.updated",
    actor,
    entityType: "bulk_task_operation",
    entityId: operationId,
    payload: {
      operationId,
      reason: analysis.intent.reason,
      mode: "atomic",
      kind: analysis.intent.kind,
      matchedCount: analysis.preview.matchedCount,
      affectedCount: analysis.preview.affectedCount,
    },
    taskIds: affectedTaskIds,
    occurredAt,
  });
}

function resolveOrCreateTag(
  db: DrizzleDatabase,
  projectId: string,
  input: TagInput,
  occurredAt: string,
) {
  const existing = db
    .select()
    .from(tags)
    .where(and(eq(tags.projectId, projectId), eq(tags.name, input.name)))
    .limit(1)
    .get();
  if (existing) return existing;
  return db
    .insert(tags)
    .values({
      id: randomUUID(),
      projectId,
      name: input.name,
      description: input.description,
      color: input.color.toLocaleLowerCase("en-US"),
      exclusiveGroup: input.exclusiveGroup ?? null,
      createdAt: occurredAt,
      updatedAt: occurredAt,
    })
    .returning()
    .get();
}

function replaceCreateAssignments(
  db: DrizzleDatabase,
  taskId: string,
  projectId: string,
  tagInputs: readonly TagInput[],
  capabilities: readonly string[],
  referencedPaths: readonly string[],
  customFields: readonly BulkTaskCreateItem["task"]["customFields"][number][],
  occurredAt: string,
) {
  const assignedTags: TagRow[] = [];
  for (const tagInput of tagInputs) {
    const tag = resolveOrCreateTag(db, projectId, tagInput, occurredAt);
    db.insert(taskTags).values({ taskId, tagId: tag.id }).run();
    assignedTags.push(tag);
  }
  for (const capability of normalizeCapabilities(capabilities)) {
    db.insert(taskCapabilityRequirements).values({ taskId, capability }).run();
  }
  for (const path of [...new Set(referencedPaths)].toSorted()) {
    db.insert(taskReferencedPaths).values({ taskId, path }).run();
  }
  for (const { fieldId, value } of customFields) {
    db.insert(taskCustomFieldValues)
      .values({
        taskId,
        definitionId: fieldId,
        valueJson: JSON.stringify(value),
        updatedAt: occurredAt,
      })
      .run();
  }
  return assignedTags;
}

function executeCreates(
  db: DrizzleDatabase,
  analysis: PreviewAnalysis,
  actor: Actor,
  operationId: string,
  occurredAt: string,
) {
  const generated = analysis.createPlans.map((plan) => ({
    plan,
    taskId: randomUUID(),
  }));
  const parentEvent = appendParentEvent(
    db,
    analysis,
    actor,
    operationId,
    generated.map(({ taskId }) => taskId),
    occurredAt,
  );
  const items: BulkTaskExecutionResult["items"][number][] = [];
  const project = projectRow(db, analysis.intent.projectId);
  if (!project) throw new Error("The bulk-create project does not exist.");

  for (const { plan, taskId } of generated) {
    const { task } = plan.item;
    const priority = task.priority ?? "normal";
    db.insert(tasks)
      .values({
        id: taskId,
        projectId: analysis.intent.projectId,
        sequence: plan.sequence,
        parentTaskId: task.parentTaskId,
        title: task.title,
        lifecycle: task.lifecycle,
        priority,
        position: task.position ?? plan.sequence,
        notBefore: task.notBefore ?? null,
        dueAt: task.dueAt ?? null,
        size: task.size ?? null,
        descriptionJson: JSON.stringify(task.description),
        descriptionText: richTextToPlainText(task.description),
        expectedOutcome: task.expectedOutcome,
        acceptanceCriteria: task.acceptanceCriteria,
        agentContext: task.agentContext,
        checklistJson: JSON.stringify(task.checklist),
        reviewAttemptId: null,
        cancelledFromLifecycle: null,
        version: 1,
        archivedAt: null,
        createdAt: occurredAt,
        updatedAt: occurredAt,
      })
      .run();
    const assignedTags = replaceCreateAssignments(
      db,
      taskId,
      analysis.intent.projectId,
      task.tags ?? [],
      task.requiredCapabilities ?? [],
      plan.referencedPaths,
      task.customFields,
      occurredAt,
    );
    const reviewPolicy = resolveReviewPolicy({
      projectId: project.id,
      projectMode: project.reviewMode,
      taskId,
      taskOverride: null,
      tags: assignedTags.map(({ id, name, reviewModeOverride }) => ({
        id,
        name,
        reviewModeOverride,
      })),
    });
    appendEvent(db, {
      projectId: analysis.intent.projectId,
      kind: "task.created",
      actor,
      entityType: "task",
      entityId: taskId,
      payload: {
        operationId,
        parentEventCursor: parentEvent.cursor,
        previousVersion: 0,
        version: 1,
        sequence: plan.sequence,
        title: task.title,
        lifecycle: task.lifecycle,
        priority,
        parentTaskId: task.parentTaskId,
        tags: assignedTags.map(taskTag),
        requiredCapabilities: normalizeCapabilities(task.requiredCapabilities ?? []),
        customFields: task.customFields,
        reviewModeOverride: null,
        reviewPolicy,
        referencedPaths: [...plan.referencedPaths],
      },
      taskIds: [taskId],
      occurredAt,
    });
    items.push({
      targetKey: plan.item.clientId,
      clientId: plan.item.clientId,
      taskId,
      version: 1,
      changed: true,
    });
  }

  return bulkTaskExecutionResultSchema.parse({
    schemaVersion: 1,
    mode: "atomic",
    kind: "create",
    operationId,
    projectId: analysis.intent.projectId,
    matchedCount: analysis.preview.matchedCount,
    affectedCount: analysis.preview.affectedCount,
    parentEventCursor: parentEvent.cursor,
    items,
  });
}

function replaceUpdateAssignments(
  db: DrizzleDatabase,
  taskId: string,
  projection: BulkTaskUpdateProjection,
  changeTags: boolean,
  changeCapabilities: boolean,
  customFields: BulkTaskCustomFieldChanges | undefined,
  occurredAt: string,
) {
  if (changeTags) {
    db.delete(taskTags).where(eq(taskTags.taskId, taskId)).run();
    for (const tag of projection.projected.tags) {
      db.insert(taskTags).values({ taskId, tagId: tag.id }).run();
    }
  }
  if (changeCapabilities) {
    db.delete(taskCapabilityRequirements)
      .where(eq(taskCapabilityRequirements.taskId, taskId))
      .run();
    for (const capability of projection.projected.requiredCapabilities) {
      db.insert(taskCapabilityRequirements).values({ taskId, capability }).run();
    }
  }
  if (customFields) {
    for (const definitionId of customFields.clear) {
      db.delete(taskCustomFieldValues)
        .where(
          and(
            eq(taskCustomFieldValues.taskId, taskId),
            eq(taskCustomFieldValues.definitionId, definitionId),
          ),
        )
        .run();
    }
    for (const { fieldId, value } of customFields.set) {
      db.delete(taskCustomFieldValues)
        .where(
          and(
            eq(taskCustomFieldValues.taskId, taskId),
            eq(taskCustomFieldValues.definitionId, fieldId),
          ),
        )
        .run();
      db.insert(taskCustomFieldValues)
        .values({
          taskId,
          definitionId: fieldId,
          valueJson: JSON.stringify(value),
          updatedAt: occurredAt,
        })
        .run();
    }
  }
}

function executeUpdates(
  db: DrizzleDatabase,
  analysis: PreviewAnalysis,
  actor: Actor,
  operationId: string,
  occurredAt: string,
) {
  if (analysis.intent.kind !== "update") throw new Error("Expected a bulk update intent.");
  const affectedTaskIds = analysis.updatePlans
    .filter(({ projection }) => projection.changes.length > 0)
    .map(({ task }) => task.id);
  const parentEvent = appendParentEvent(
    db,
    analysis,
    actor,
    operationId,
    affectedTaskIds,
    occurredAt,
  );
  const items: BulkTaskExecutionResult["items"][number][] = [];

  for (const { task, projection } of analysis.updatePlans) {
    const changed = projection.changes.length > 0;
    const version = task.version + (changed ? 1 : 0);
    if (changed) {
      const mutation = db
        .update(tasks)
        .set({
          lifecycle: projection.projected.lifecycle,
          priority: projection.projected.priority,
          notBefore: projection.projected.notBefore,
          dueAt: projection.projected.dueAt,
          version,
          updatedAt: occurredAt,
        })
        .where(and(eq(tasks.id, task.id), eq(tasks.version, task.version)))
        .run();
      if (mutation.changes !== 1) {
        throw new BulkTaskPreviewStaleError({
          reason: "target_version_changed",
          taskIds: [task.id],
          message: `Task ${task.id} changed while the bulk operation was executing.`,
        });
      }
      replaceUpdateAssignments(
        db,
        task.id,
        projection,
        Boolean(analysis.intent.patch.tags),
        Boolean(analysis.intent.patch.capabilities),
        analysis.intent.patch.customFields,
        occurredAt,
      );
      appendEvent(db, {
        projectId: analysis.intent.projectId,
        kind: "task.planning.updated",
        actor,
        entityType: "task",
        entityId: task.id,
        payload: {
          operationId,
          parentEventCursor: parentEvent.cursor,
          previousVersion: task.version,
          version,
          changes: [...projection.changes],
        },
        taskIds: [task.id],
        occurredAt,
      });
    }
    items.push({
      targetKey: task.id,
      clientId: null,
      taskId: task.id,
      version,
      changed,
    });
  }

  return bulkTaskExecutionResultSchema.parse({
    schemaVersion: 1,
    mode: "atomic",
    kind: "update",
    operationId,
    projectId: analysis.intent.projectId,
    matchedCount: analysis.preview.matchedCount,
    affectedCount: analysis.preview.affectedCount,
    parentEventCursor: parentEvent.cursor,
    items,
  });
}

function recordIdempotentResult(
  db: DrizzleDatabase,
  input: ExecuteBulkTasksInput,
  actor: Actor,
  result: BulkTaskExecutionResult,
  occurredAt: string,
) {
  db.insert(idempotencyRecords)
    .values({
      key: input.idempotencyKey,
      command: BULK_TASK_EXECUTE_COMMAND,
      inputHash: commandInputHash(input, actor),
      resultJson: JSON.stringify(result),
      createdAt: occurredAt,
    })
    .run();
}

function executeAnalyzed(
  database: Database.Database,
  db: DrizzleDatabase,
  input: ExecuteBulkTasksInput,
  actor: Actor,
  context: BulkTaskEvaluationContext,
) {
  const existing = existingIdempotentResult(db, input, actor);
  if (existing) return existing;

  const analysis = analyzePreview(database, db, input.intent, actor, context);
  assertBulkTaskExecutionMatchesPreview(input, analysis.preview);

  const operationId = randomUUID();
  const result =
    analysis.intent.kind === "create"
      ? executeCreates(db, analysis, actor, operationId, context.now)
      : executeUpdates(db, analysis, actor, operationId, context.now);
  recordIdempotentResult(db, input, actor, result, context.now);
  return result;
}

/**
 * Recomputes a bulk preview on the caller's current SQLite snapshot.
 *
 * This seam exists for higher-level atomic workflows, such as portable imports,
 * that need the normal bulk validation and projection rules without opening a
 * separately committing transaction. The caller must already own the desired
 * transaction on `database`.
 */
export function previewSqliteBulkTasksInCurrentTransaction(
  database: Database.Database,
  intent: BulkTaskIntent,
  actor: Actor,
  context: BulkTaskEvaluationContext,
) {
  return analyzePreview(database, drizzle(database, { schema }), intent, actor, context).preview;
}

/**
 * Executes a previously previewed bulk command in the caller's current SQLite
 * transaction. It never begins or commits a transaction itself.
 */
export function executeSqliteBulkTasksInCurrentTransaction(
  database: Database.Database,
  input: ExecuteBulkTasksInput,
  actor: Actor,
  context: BulkTaskEvaluationContext,
) {
  return executeAnalyzed(database, drizzle(database, { schema }), input, actor, context);
}

export function createSqliteBulkTaskStore(database: Database.Database): BulkTaskStore {
  return {
    preview(intent, actor, context) {
      return Effect.try({
        try: () =>
          database
            .transaction(() =>
              previewSqliteBulkTasksInCurrentTransaction(database, intent, actor, context),
            )
            .deferred(),
        catch: commandError,
      });
    },
    execute(input, actor, context) {
      return Effect.try({
        try: () =>
          database
            .transaction(() =>
              executeSqliteBulkTasksInCurrentTransaction(database, input, actor, context),
            )
            .immediate(),
        catch: commandError,
      });
    },
  };
}
