import { createHash, randomUUID } from "node:crypto";

import Database from "better-sqlite3";
import { and, asc, eq, isNull } from "drizzle-orm";
import { drizzle } from "drizzle-orm/better-sqlite3";
import { Effect } from "effect";

import {
  CustomFieldDefinitionKeyConflictError,
  CustomFieldDefinitionNotFoundError,
  CustomFieldDefinitionOrderError,
  CustomFieldDefinitionStateError,
  CustomizationAuthorizationError,
  CustomizationIdempotencyConflictError,
  CustomizationPersistenceError,
  CustomizationProjectNotFoundError,
  CustomizationTagNotFoundError,
  CustomizationVersionConflictError,
  InvalidCustomizationInputError,
  type CustomizationCommandError,
} from "../application/customization-errors";
import {
  customizationCommandName,
  planCustomizationCommand,
  type CustomizationCommand,
  type CustomizationMutationPlan,
  type CustomizationStore,
  type LocalCustomizationHuman,
} from "../application/customizations";
import {
  customFieldDefinitionSchema,
  projectCustomizationSnapshotSchema,
  type CustomFieldDefinition,
  type ListProjectCustomizationInput,
  type ProjectCustomizationSnapshot,
} from "../domain/customization";
import {
  customFieldDefinitions,
  events,
  idempotencyRecords,
  projects,
  schema,
  tags,
} from "../db/schema";
import { importanceForEventKind, normalizeEventChangeHints } from "../domain/activity";

type DrizzleDatabase = ReturnType<typeof drizzle<typeof schema>>;
type DrizzleTransaction = Parameters<Parameters<DrizzleDatabase["transaction"]>[0]>[0];
type DatabaseSession = DrizzleDatabase | DrizzleTransaction;
type DefinitionRow = typeof customFieldDefinitions.$inferSelect;

function hash(command: string, input: unknown) {
  return createHash("sha256")
    .update(`${command}:${JSON.stringify(input)}`)
    .digest("hex");
}

function withoutIdempotencyKey<T extends { readonly idempotencyKey: string }>(input: T) {
  const { idempotencyKey: _idempotencyKey, ...semanticInput } = input;
  return semanticInput;
}

function persistenceError(error: unknown) {
  const correlationId = randomUUID();
  const detail = error instanceof Error ? `${error.name}: ${error.message}` : String(error);
  process.stderr.write(`[helm] customization persistence failure ${correlationId}: ${detail}\n`);
  return new CustomizationPersistenceError({
    message: "The customization database operation failed.",
    correlationId,
  });
}

function isCustomizationError(error: unknown): error is CustomizationCommandError {
  return (
    error instanceof InvalidCustomizationInputError ||
    error instanceof CustomizationAuthorizationError ||
    error instanceof CustomizationProjectNotFoundError ||
    error instanceof CustomizationVersionConflictError ||
    error instanceof CustomFieldDefinitionNotFoundError ||
    error instanceof CustomFieldDefinitionStateError ||
    error instanceof CustomFieldDefinitionKeyConflictError ||
    error instanceof CustomFieldDefinitionOrderError ||
    error instanceof CustomizationTagNotFoundError ||
    error instanceof CustomizationIdempotencyConflictError ||
    error instanceof CustomizationPersistenceError
  );
}

function commandError(error: unknown): CustomizationCommandError {
  return isCustomizationError(error) ? error : persistenceError(error);
}

function definitionFromRow(row: DefinitionRow): CustomFieldDefinition {
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

function requireProject(db: DatabaseSession, projectId: string) {
  const project = db.select().from(projects).where(eq(projects.id, projectId)).limit(1).get();
  if (!project) {
    throw new CustomizationProjectNotFoundError({
      projectId,
      message: "That project does not exist.",
    });
  }
  return project;
}

function readSnapshot(
  db: DatabaseSession,
  input: ListProjectCustomizationInput,
): ProjectCustomizationSnapshot {
  const project = requireProject(db, input.projectId);
  const definitions = db
    .select()
    .from(customFieldDefinitions)
    .where(
      input.includeRetired
        ? eq(customFieldDefinitions.projectId, input.projectId)
        : and(
            eq(customFieldDefinitions.projectId, input.projectId),
            isNull(customFieldDefinitions.retiredAt),
          ),
    )
    .orderBy(asc(customFieldDefinitions.position), asc(customFieldDefinitions.id))
    .all()
    .map(definitionFromRow);
  const tagReviewRules = db
    .select({
      tagId: tags.id,
      tagName: tags.name,
      reviewMode: tags.reviewModeOverride,
    })
    .from(tags)
    .where(eq(tags.projectId, input.projectId))
    .orderBy(asc(tags.name), asc(tags.id))
    .all()
    .flatMap((tag) =>
      tag.reviewMode === null
        ? []
        : [{ tagId: tag.tagId, tagName: tag.tagName, reviewMode: tag.reviewMode }],
    );
  return projectCustomizationSnapshotSchema.parse({
    schemaVersion: 1,
    projectId: project.id,
    projectVersion: project.version,
    definitions,
    tagReviewRules,
  });
}

function existingResult(db: DatabaseSession, command: string, key: string, inputHash: string) {
  const existing = db
    .select()
    .from(idempotencyRecords)
    .where(eq(idempotencyRecords.key, key))
    .limit(1)
    .get();
  if (!existing) return null;
  if (existing.command !== command || existing.inputHash !== inputHash) {
    throw new CustomizationIdempotencyConflictError({
      key,
      message: "That idempotency key was already used for a different command.",
    });
  }
  return projectCustomizationSnapshotSchema.parse(JSON.parse(existing.resultJson));
}

function assertProjectVersion(
  project: { readonly id: string; readonly sequence: number; readonly version: number },
  expectedVersion: number,
) {
  if (project.version === expectedVersion) return;
  throw new CustomizationVersionConflictError({
    projectId: project.id,
    expectedVersion,
    currentVersion: project.version,
    changeSummary: `Project #${project.sequence} is now version ${project.version}.`,
    message: `Project version conflict: expected ${expectedVersion}, current ${project.version}.`,
  });
}

function aggregateState(db: DatabaseSession, projectId: string) {
  return {
    projectId,
    definitions: db
      .select()
      .from(customFieldDefinitions)
      .where(eq(customFieldDefinitions.projectId, projectId))
      .orderBy(asc(customFieldDefinitions.position), asc(customFieldDefinitions.id))
      .all()
      .map(definitionFromRow),
    tags: db
      .select({
        id: tags.id,
        name: tags.name,
        reviewModeOverride: tags.reviewModeOverride,
      })
      .from(tags)
      .where(eq(tags.projectId, projectId))
      .orderBy(asc(tags.name), asc(tags.id))
      .all(),
  };
}

function applyMutationPlan(db: DatabaseSession, plan: CustomizationMutationPlan, now: string) {
  switch (plan.type) {
    case "add_field_definition": {
      const definition = plan.definition;
      db.insert(customFieldDefinitions)
        .values({
          id: definition.id,
          projectId: definition.projectId,
          fieldKey: definition.key,
          type: definition.type,
          validationJson: JSON.stringify(definition.validation),
          defaultValueJson:
            definition.defaultValue === null ? null : JSON.stringify(definition.defaultValue),
          displayLabel: definition.display.label,
          description: definition.display.description,
          position: definition.position,
          retiredAt: definition.retiredAt,
          createdAt: definition.createdAt,
          updatedAt: definition.updatedAt,
        })
        .run();
      break;
    }
    case "retire_field_definition":
      db.update(customFieldDefinitions)
        .set({ retiredAt: now, updatedAt: now })
        .where(eq(customFieldDefinitions.id, plan.fieldId))
        .run();
      break;
    case "reorder_field_definitions":
      for (const { fieldId, position } of plan.positions) {
        db.update(customFieldDefinitions)
          .set({ position, updatedAt: now })
          .where(eq(customFieldDefinitions.id, fieldId))
          .run();
      }
      break;
    case "set_tag_review_mode_override":
      db.update(tags)
        .set({ reviewModeOverride: plan.reviewModeOverride, updatedAt: now })
        .where(eq(tags.id, plan.tagId))
        .run();
      break;
  }
  return plan.event;
}

function advanceProjectVersion(
  db: DatabaseSession,
  project: { readonly id: string; readonly version: number },
  expectedVersion: number,
  now: string,
) {
  const update = db
    .update(projects)
    .set({ version: project.version + 1, updatedAt: now })
    .where(and(eq(projects.id, project.id), eq(projects.version, expectedVersion)))
    .run();
  if (update.changes === 1) return;
  const currentVersion =
    db
      .select({ version: projects.version })
      .from(projects)
      .where(eq(projects.id, project.id))
      .limit(1)
      .get()?.version ?? project.version;
  throw new CustomizationVersionConflictError({
    projectId: project.id,
    expectedVersion,
    currentVersion,
    changeSummary: `The project is now version ${currentVersion}.`,
    message: `Project version conflict: expected ${expectedVersion}, current ${currentVersion}.`,
  });
}

function appendEvent(
  db: DatabaseSession,
  event: CustomizationMutationPlan["event"],
  projectId: string,
  projectVersion: number,
  actor: LocalCustomizationHuman,
  now: string,
) {
  db.insert(events)
    .values({
      projectId,
      kind: event.kind,
      importance: importanceForEventKind(event.kind),
      actorType: actor.type,
      actorId: actor.id,
      entityType: event.entityType,
      entityId: event.entityId,
      payloadJson: JSON.stringify({ ...event.payload, projectVersion }),
      changesJson: JSON.stringify(
        normalizeEventChangeHints({ projectIds: [projectId], scopes: ["projects"] }),
      ),
      occurredAt: now,
    })
    .run();
}

function recordResult(
  db: DatabaseSession,
  key: string,
  command: string,
  inputHash: string,
  result: ProjectCustomizationSnapshot,
  now: string,
) {
  db.insert(idempotencyRecords)
    .values({
      key,
      command,
      inputHash,
      resultJson: JSON.stringify(result),
      createdAt: now,
    })
    .run();
}

function executeCommand(
  db: DatabaseSession,
  command: CustomizationCommand,
  actor: LocalCustomizationHuman,
  now: string,
) {
  const name = customizationCommandName(command);
  const semanticInput = withoutIdempotencyKey(command.input);
  const inputHash = hash(name, semanticInput);
  const retry = existingResult(db, name, command.input.idempotencyKey, inputHash);
  if (retry) return retry;
  const project = requireProject(db, command.input.projectId);
  assertProjectVersion(project, command.input.expectedProjectVersion);
  const plan = planCustomizationCommand(command, aggregateState(db, project.id), now, randomUUID());
  const event = applyMutationPlan(db, plan, now);
  advanceProjectVersion(db, project, command.input.expectedProjectVersion, now);
  appendEvent(db, event, project.id, project.version + 1, actor, now);
  const result = readSnapshot(db, { projectId: project.id, includeRetired: true });
  recordResult(db, command.input.idempotencyKey, name, inputHash, result, now);
  return result;
}

export function createSqliteCustomizationStore(database: Database.Database): CustomizationStore {
  const db = drizzle(database, { schema });
  return {
    list(input) {
      return Effect.try({
        try: () => readSnapshot(db, input),
        catch: commandError,
      });
    },
    execute(command, actor, now) {
      return Effect.try({
        try: () =>
          db.transaction((tx) => executeCommand(tx, command, actor, now), {
            behavior: "immediate",
          }),
        catch: commandError,
      });
    },
  };
}
