import { Effect, Either } from "effect";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

import {
  CustomFieldDefinitionKeyConflictError,
  CustomFieldDefinitionOrderError,
  CustomFieldDefinitionStateError,
  CustomizationAuthorizationError,
  CustomizationIdempotencyConflictError,
  CustomizationPersistenceError,
  CustomizationProjectNotFoundError,
  CustomizationTagNotFoundError,
  CustomizationVersionConflictError,
  InvalidCustomizationInputError,
} from "./customization-errors";
import {
  LOCAL_CUSTOMIZATION_HUMAN,
  addCustomFieldDefinition,
  clearTagReviewModeOverride,
  listProjectCustomization,
  reorderCustomFieldDefinitions,
  retireCustomFieldDefinition,
  setTagReviewModeOverride,
  type CustomizationServices,
} from "./customizations";
import { emptyRichTextDocument } from "../domain/tasks";
import { createSqliteCustomizationStore } from "../infrastructure/sqlite-customization-store.server";
import {
  createSqliteProjectStore,
  type SqliteProjectStore,
} from "../infrastructure/sqlite-project-store.server";

const projectId = "customization-project";
const otherProjectId = "other-customization-project";
const createdAt = "2026-09-04T08:00:00.000Z";
let now = "2026-09-04T10:00:00.000Z";
let projectStore: SqliteProjectStore;
let services: CustomizationServices;

function insertProject(id: string, sequence: number) {
  projectStore.database
    .prepare(
      `insert into projects (
         id, sequence, name, repository_root, review_mode, version, created_at, updated_at
       ) values (?, ?, ?, ?, 'required', 1, ?, ?)`,
    )
    .run(
      id,
      sequence,
      `Project ${sequence}`,
      `/tmp/customization-${sequence}`,
      createdAt,
      createdAt,
    );
}

function textDefinition(key: string, label = key) {
  return {
    key,
    type: "text" as const,
    validation: { minLength: 0, maxLength: 200 },
    defaultValue: null,
    display: { label, description: `${label} field` },
  };
}

function addInput(key: string, expectedProjectVersion: number, idempotencyKey = `add-${key}`) {
  return {
    projectId,
    definition: textDefinition(key),
    expectedProjectVersion,
    idempotencyKey,
  };
}

function insertTask(taskId: string) {
  projectStore.database
    .prepare(
      `insert into tasks (
         id, project_id, sequence, parent_task_id, title, lifecycle, priority, position,
         not_before, due_at, size, description_json, description_text, expected_outcome,
         acceptance_criteria, agent_context, checklist_json, review_mode_override,
         review_attempt_id, cancelled_from_lifecycle, version, archived_at, created_at, updated_at
       ) values (
         ?, ?, 1, null, 'Customization task', 'backlog', 'normal', 1,
         null, null, null, ?, '', '', '', '', '[]', null, null, null, 1, null, ?, ?
       )`,
    )
    .run(taskId, projectId, JSON.stringify(emptyRichTextDocument), createdAt, createdAt);
}

function insertTag(id: string, ownerProjectId: string, name: string) {
  projectStore.database
    .prepare(
      `insert into tags (
         id, project_id, name, description, color, exclusive_group,
         review_mode_override, created_at, updated_at
       ) values (?, ?, ?, '', '#2563eb', null, null, ?, ?)`,
    )
    .run(id, ownerProjectId, name, createdAt, createdAt);
}

beforeEach(() => {
  projectStore = createSqliteProjectStore(":memory:");
  insertProject(projectId, 1);
  insertProject(otherProjectId, 2);
  services = {
    store: createSqliteCustomizationStore(projectStore.database),
    clock: { now: () => now },
  };
});

afterEach(() => {
  vi.restoreAllMocks();
  projectStore.close();
  now = "2026-09-04T10:00:00.000Z";
});

describe("project customization application and SQLite seam", () => {
  it("adds, reorders, lists, attributes, and retries definitions atomically", async () => {
    const empty = await Effect.runPromise(
      listProjectCustomization({ projectId, includeRetired: true }, services),
    );
    expect(empty).toEqual({
      schemaVersion: 1,
      projectId,
      projectVersion: 1,
      definitions: [],
      tagReviewRules: [],
    });

    const firstInput = addInput("risk_notes", 1);
    const first = await Effect.runPromise(
      addCustomFieldDefinition(firstInput, LOCAL_CUSTOMIZATION_HUMAN, services),
    );
    const retry = await Effect.runPromise(
      addCustomFieldDefinition(firstInput, LOCAL_CUSTOMIZATION_HUMAN, services),
    );
    expect(retry).toEqual(first);
    expect(first).toMatchObject({
      projectVersion: 2,
      definitions: [
        {
          projectId,
          key: "risk_notes",
          type: "text",
          position: 0,
          retiredAt: null,
          createdAt: now,
          updatedAt: now,
        },
      ],
    });

    now = "2026-09-04T10:05:00.000Z";
    const second = await Effect.runPromise(
      addCustomFieldDefinition(addInput("owner_notes", 2), LOCAL_CUSTOMIZATION_HUMAN, services),
    );
    const firstId = second.definitions.find(({ key }) => key === "risk_notes")!.id;
    const secondId = second.definitions.find(({ key }) => key === "owner_notes")!.id;
    now = "2026-09-04T10:10:00.000Z";
    const reordered = await Effect.runPromise(
      reorderCustomFieldDefinitions(
        {
          projectId,
          orderedFieldIds: [secondId, firstId],
          expectedProjectVersion: 3,
          idempotencyKey: "reorder-fields",
        },
        LOCAL_CUSTOMIZATION_HUMAN,
        services,
      ),
    );
    expect(reordered.projectVersion).toBe(4);
    expect(reordered.definitions.map(({ key, position }) => [key, position])).toEqual([
      ["owner_notes", 0],
      ["risk_notes", 1],
    ]);

    const events = projectStore.database
      .prepare<[], { kind: string; actorType: string; actorId: string; payloadJson: string }>(
        `select kind, actor_type as actorType, actor_id as actorId, payload_json as payloadJson
         from events where kind like 'customization.%' order by cursor`,
      )
      .all();
    expect(events.map(({ kind }) => kind)).toEqual([
      "customization.field.added",
      "customization.field.added",
      "customization.fields.reordered",
    ]);
    expect(events[0]).toMatchObject({ actorType: "human", actorId: "local-human" });
    expect(JSON.parse(events[0]!.payloadJson)).toMatchObject({
      fieldKey: "risk_notes",
      projectVersion: 2,
    });
    expect(
      projectStore.database
        .prepare("select count(*) from idempotency_records where key = 'add-risk_notes'")
        .pluck()
        .get(),
    ).toBe(1);
  });

  it("rejects invalid input, unauthorized actors, stale versions, duplicate keys, and incomplete orders", async () => {
    const invalid = await Effect.runPromise(
      Effect.either(
        addCustomFieldDefinition(
          {
            projectId,
            definition: {
              key: "risk_score",
              type: "number",
              validation: { min: 0, max: 5, integer: true },
              defaultValue: { type: "number", value: 8 },
              display: { label: "Risk score", description: "" },
            },
            expectedProjectVersion: 1,
            idempotencyKey: "invalid-default",
          },
          LOCAL_CUSTOMIZATION_HUMAN,
          services,
        ),
      ),
    );
    expect(Either.isLeft(invalid) && invalid.left).toBeInstanceOf(InvalidCustomizationInputError);

    const unauthorized = await Effect.runPromise(
      Effect.either(
        addCustomFieldDefinition(
          addInput("private_field", 1),
          { type: "human", id: "other" },
          services,
        ),
      ),
    );
    expect(Either.isLeft(unauthorized) && unauthorized.left).toBeInstanceOf(
      CustomizationAuthorizationError,
    );

    const first = await Effect.runPromise(
      addCustomFieldDefinition(addInput("status_notes", 1), LOCAL_CUSTOMIZATION_HUMAN, services),
    );
    const stale = await Effect.runPromise(
      Effect.either(
        addCustomFieldDefinition(addInput("stale_field", 1), LOCAL_CUSTOMIZATION_HUMAN, services),
      ),
    );
    expect(Either.isLeft(stale) && stale.left).toEqual(
      expect.objectContaining({
        _tag: "CustomizationVersionConflictError",
        expectedVersion: 1,
        currentVersion: 2,
      }),
    );
    expect(Either.isLeft(stale) && stale.left).toBeInstanceOf(CustomizationVersionConflictError);

    const duplicateKey = await Effect.runPromise(
      Effect.either(
        addCustomFieldDefinition(
          addInput("status_notes", 2, "duplicate-key"),
          LOCAL_CUSTOMIZATION_HUMAN,
          services,
        ),
      ),
    );
    expect(Either.isLeft(duplicateKey) && duplicateKey.left).toBeInstanceOf(
      CustomFieldDefinitionKeyConflictError,
    );

    const badOrder = await Effect.runPromise(
      Effect.either(
        reorderCustomFieldDefinitions(
          {
            projectId,
            orderedFieldIds: ["unknown-field"],
            expectedProjectVersion: 2,
            idempotencyKey: "bad-order",
          },
          LOCAL_CUSTOMIZATION_HUMAN,
          services,
        ),
      ),
    );
    expect(Either.isLeft(badOrder) && badOrder.left).toEqual(
      expect.objectContaining({
        _tag: "CustomFieldDefinitionOrderError",
        missingFieldIds: [first.definitions[0]!.id],
        unexpectedFieldIds: ["unknown-field"],
      }),
    );
    expect(Either.isLeft(badOrder) && badOrder.left).toBeInstanceOf(
      CustomFieldDefinitionOrderError,
    );
    expect(
      projectStore.database
        .prepare("select version from projects where id = ?")
        .pluck()
        .get(projectId),
    ).toBe(2);

    const missingProject = await Effect.runPromise(
      Effect.either(
        listProjectCustomization({ projectId: "missing-project", includeRetired: true }, services),
      ),
    );
    expect(Either.isLeft(missingProject) && missingProject.left).toBeInstanceOf(
      CustomizationProjectNotFoundError,
    );
  });

  it("returns an idempotency conflict before re-evaluating a changed command", async () => {
    await Effect.runPromise(
      addCustomFieldDefinition(
        addInput("first_field", 1, "shared-customization-key"),
        LOCAL_CUSTOMIZATION_HUMAN,
        services,
      ),
    );
    const conflict = await Effect.runPromise(
      Effect.either(
        addCustomFieldDefinition(
          addInput("second_field", 1, "shared-customization-key"),
          LOCAL_CUSTOMIZATION_HUMAN,
          services,
        ),
      ),
    );
    expect(Either.isLeft(conflict) && conflict.left).toEqual(
      expect.objectContaining({
        _tag: "CustomizationIdempotencyConflictError",
        key: "shared-customization-key",
      }),
    );
    expect(Either.isLeft(conflict) && conflict.left).toBeInstanceOf(
      CustomizationIdempotencyConflictError,
    );
  });

  it("retires definitions without deleting historical task values", async () => {
    const added = await Effect.runPromise(
      addCustomFieldDefinition(addInput("risk_notes", 1), LOCAL_CUSTOMIZATION_HUMAN, services),
    );
    const fieldId = added.definitions[0]!.id;
    insertTask("customized-task");
    projectStore.database
      .prepare(
        `insert into task_custom_field_values (task_id, definition_id, value_json, updated_at)
         values (?, ?, ?, ?)`,
      )
      .run(
        "customized-task",
        fieldId,
        JSON.stringify({ type: "text", value: "Keep this history" }),
        now,
      );

    now = "2026-09-04T11:00:00.000Z";
    const retired = await Effect.runPromise(
      retireCustomFieldDefinition(
        {
          projectId,
          fieldId,
          expectedProjectVersion: 2,
          reason: "The field is no longer used.",
          idempotencyKey: "retire-risk-notes",
        },
        LOCAL_CUSTOMIZATION_HUMAN,
        services,
      ),
    );
    expect(retired).toMatchObject({
      projectVersion: 3,
      definitions: [{ id: fieldId, retiredAt: now }],
    });
    expect(
      projectStore.database
        .prepare(
          `select value_json from task_custom_field_values
           where task_id = 'customized-task' and definition_id = ?`,
        )
        .pluck()
        .get(fieldId),
    ).toBe(JSON.stringify({ type: "text", value: "Keep this history" }));
    expect(
      (
        await Effect.runPromise(
          listProjectCustomization({ projectId, includeRetired: false }, services),
        )
      ).definitions,
    ).toEqual([]);

    const alreadyRetired = await Effect.runPromise(
      Effect.either(
        retireCustomFieldDefinition(
          {
            projectId,
            fieldId,
            expectedProjectVersion: 3,
            reason: "Retry with a new key.",
            idempotencyKey: "retire-again",
          },
          LOCAL_CUSTOMIZATION_HUMAN,
          services,
        ),
      ),
    );
    expect(Either.isLeft(alreadyRetired) && alreadyRetired.left).toBeInstanceOf(
      CustomFieldDefinitionStateError,
    );
  });

  it("sets and clears only review overrides for tags in the requested project", async () => {
    insertTag("local-tag", projectId, "review-sensitive");
    insertTag("foreign-tag", otherProjectId, "foreign");

    const set = await Effect.runPromise(
      setTagReviewModeOverride(
        {
          projectId,
          tagId: "local-tag",
          reviewModeOverride: "direct",
          expectedProjectVersion: 1,
          reason: "Trusted mechanical work.",
          idempotencyKey: "set-local-tag-policy",
        },
        LOCAL_CUSTOMIZATION_HUMAN,
        services,
      ),
    );
    expect(set).toMatchObject({
      projectVersion: 2,
      tagReviewRules: [{ tagId: "local-tag", tagName: "review-sensitive", reviewMode: "direct" }],
    });

    now = "2026-09-04T10:30:00.000Z";
    const cleared = await Effect.runPromise(
      clearTagReviewModeOverride(
        {
          projectId,
          tagId: "local-tag",
          reviewModeOverride: null,
          expectedProjectVersion: 2,
          reason: "Return to project policy.",
          idempotencyKey: "clear-local-tag-policy",
        },
        LOCAL_CUSTOMIZATION_HUMAN,
        services,
      ),
    );
    expect(cleared).toMatchObject({ projectVersion: 3, tagReviewRules: [] });

    const foreign = await Effect.runPromise(
      Effect.either(
        setTagReviewModeOverride(
          {
            projectId,
            tagId: "foreign-tag",
            reviewModeOverride: "required",
            expectedProjectVersion: 3,
            reason: "Must not cross project scope.",
            idempotencyKey: "foreign-tag-policy",
          },
          LOCAL_CUSTOMIZATION_HUMAN,
          services,
        ),
      ),
    );
    expect(Either.isLeft(foreign) && foreign.left).toEqual(
      expect.objectContaining({
        _tag: "CustomizationTagNotFoundError",
        projectId,
        tagId: "foreign-tag",
      }),
    );
    expect(Either.isLeft(foreign) && foreign.left).toBeInstanceOf(CustomizationTagNotFoundError);
    expect(
      projectStore.database
        .prepare("select review_mode_override from tags where id = 'foreign-tag'")
        .pluck()
        .get(),
    ).toBeNull();
  });

  it("rolls back projection, project version, audit, and idempotency on an unknown defect", async () => {
    projectStore.database.exec(`
      create trigger reject_customization_event before insert on events
      when NEW.kind like 'customization.%'
      begin
        select raise(abort, 'private audit failure detail');
      end;
    `);
    const stderr = vi.spyOn(process.stderr, "write").mockImplementation(() => true);
    const result = await Effect.runPromise(
      Effect.either(
        addCustomFieldDefinition(
          addInput("rollback_field", 1, "rollback-customization"),
          LOCAL_CUSTOMIZATION_HUMAN,
          services,
        ),
      ),
    );
    expect(Either.isLeft(result) && result.left).toEqual(
      expect.objectContaining({
        _tag: "CustomizationPersistenceError",
        message: "The customization database operation failed.",
        correlationId: expect.stringMatching(/^[0-9a-f-]{36}$/),
      }),
    );
    expect(Either.isLeft(result) && result.left).toBeInstanceOf(CustomizationPersistenceError);
    const failure = Either.isLeft(result) ? result.left : null;
    const correlationId =
      failure instanceof CustomizationPersistenceError ? failure.correlationId : "";
    expect(stderr).toHaveBeenCalledWith(
      expect.stringContaining(`customization persistence failure ${correlationId}`),
    );
    expect(stderr).toHaveBeenCalledWith(expect.stringContaining("private audit failure detail"));
    expect(Either.isLeft(result) && result.left.message).not.toContain("private audit failure");
    expect(
      projectStore.database
        .prepare("select count(*) from custom_field_definitions where project_id = ?")
        .pluck()
        .get(projectId),
    ).toBe(0);
    expect(
      projectStore.database
        .prepare("select version from projects where id = ?")
        .pluck()
        .get(projectId),
    ).toBe(1);
    expect(
      projectStore.database
        .prepare("select count(*) from idempotency_records where key = 'rollback-customization'")
        .pluck()
        .get(),
    ).toBe(0);
    expect(
      projectStore.database
        .prepare("select count(*) from events where kind like 'customization.%'")
        .pluck()
        .get(),
    ).toBe(0);
  });
});
