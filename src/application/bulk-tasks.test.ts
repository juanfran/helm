import { Effect, Either } from "effect";
import { describe, expect, it, vi } from "vitest";

import {
  executeBulkTasksInputSchema,
  type BulkTaskExecutionResult,
  type BulkTaskPreview,
} from "../domain/bulk-tasks";
import type { Actor } from "../domain/tasks";
import {
  BulkTaskPreviewMismatchError,
  BulkTaskPreviewStaleError,
  BulkTaskPreviewValidationError,
} from "./bulk-task-errors";
import {
  assertBulkTaskExecutionMatchesPreview,
  canonicalBulkTaskIdempotencyJson,
  executeBulkTasks,
  previewBulkTasks,
  type BulkTaskServices,
  type BulkTaskStore,
} from "./bulk-tasks";

const actor: Actor = { type: "agent", id: "run-1" };
const preview: BulkTaskPreview = {
  schemaVersion: 1,
  mode: "atomic",
  kind: "update",
  projectId: "project-1",
  matchedCount: 2,
  affectedCount: 2,
  executable: true,
  targets: [],
  failures: [],
  previewToken: `btp1:${"a".repeat(64)}:${"b".repeat(64)}`,
};
const execution: BulkTaskExecutionResult = {
  schemaVersion: 1,
  mode: "atomic",
  kind: "update",
  operationId: "bulk-1",
  projectId: "project-1",
  matchedCount: 2,
  affectedCount: 2,
  parentEventCursor: 10,
  items: [],
};

function intent() {
  return {
    schemaVersion: 1 as const,
    kind: "update" as const,
    projectId: "project-1",
    reason: "Apply one planning decision",
    selection: { type: "ids" as const, taskIds: ["task-b", "task-a"] },
    patch: { capabilities: { add: ["TypeScript", "typescript"], remove: [] } },
  };
}

function services(store: BulkTaskStore): BulkTaskServices {
  return {
    store,
    clock: {
      today: () => "2026-09-04",
      now: () => "2026-09-04T12:00:00.000Z",
    },
  };
}

describe("bulk task application commands", () => {
  it("canonicalizes preview input and supplies actor-bound evaluation context", async () => {
    const previewOperation = vi.fn(() => Effect.succeed(preview));
    const store: BulkTaskStore = {
      preview: previewOperation,
      execute: () => Effect.succeed(execution),
    };

    const result = await Effect.runPromise(
      previewBulkTasks(intent(), actor, services(store), ["GPU", "gpu"]),
    );

    expect(result).toEqual(preview);
    expect(previewOperation).toHaveBeenCalledWith(
      expect.objectContaining({
        selection: { type: "ids", taskIds: ["task-a", "task-b"] },
        patch: { capabilities: { add: ["typescript"], remove: [] } },
      }),
      actor,
      {
        today: "2026-09-04",
        now: "2026-09-04T12:00:00.000Z",
        agentCapabilities: ["gpu"],
      },
    );
  });

  it("executes the exact canonical intent and preview token with one idempotency key", async () => {
    const executeOperation = vi.fn(() => Effect.succeed(execution));
    const store: BulkTaskStore = {
      preview: () => Effect.succeed(preview),
      execute: executeOperation,
    };
    const command = {
      intent: intent(),
      previewToken: preview.previewToken,
      idempotencyKey: "bulk-execute-1",
    };

    expect(
      await Effect.runPromise(executeBulkTasks(command, actor, services(store), ["GPU"])),
    ).toEqual(execution);
    expect(executeOperation).toHaveBeenCalledWith(
      expect.objectContaining({
        intent: expect.objectContaining({
          selection: { type: "ids", taskIds: ["task-a", "task-b"] },
        }),
        previewToken: preview.previewToken,
        idempotencyKey: "bulk-execute-1",
      }),
      actor,
      expect.objectContaining({ agentCapabilities: ["gpu"] }),
    );
  });

  it("rejects malformed commands before invoking persistence", async () => {
    const previewOperation = vi.fn(() => Effect.succeed(preview));
    const store: BulkTaskStore = {
      preview: previewOperation,
      execute: () => Effect.succeed(execution),
    };
    const result = await Effect.runPromise(
      Effect.either(previewBulkTasks({ ...intent(), patch: {} }, actor, services(store))),
    );

    expect(Either.isLeft(result) && result.left["_tag"]).toBe("InvalidBulkTaskInputError");
    expect(previewOperation).not.toHaveBeenCalled();
  });

  it("preserves typed stale-preview failures from the store", async () => {
    const stale = new BulkTaskPreviewStaleError({
      reason: "target_version_changed",
      taskIds: ["task-a"],
      message: "One selected task changed after preview.",
    });
    const store: BulkTaskStore = {
      preview: () => Effect.succeed(preview),
      execute: () => Effect.fail(stale),
    };
    const result = await Effect.runPromise(
      Effect.either(
        executeBulkTasks(
          {
            intent: intent(),
            previewToken: preview.previewToken,
            idempotencyKey: "stale-execution",
          },
          actor,
          services(store),
        ),
      ),
    );

    expect(Either.isLeft(result) && result.left).toEqual(stale);
  });

  it("owns idempotency identity and preview-conflict classification", () => {
    const command = executeBulkTasksInputSchema.parse({
      intent: intent(),
      previewToken: preview.previewToken,
      idempotencyKey: "bulk-execute-1",
    });
    const retry = { ...command, idempotencyKey: "bulk-execute-retry" };

    expect(canonicalBulkTaskIdempotencyJson(command, actor)).toBe(
      canonicalBulkTaskIdempotencyJson(retry, actor),
    );
    expect(canonicalBulkTaskIdempotencyJson(command, actor)).not.toBe(
      canonicalBulkTaskIdempotencyJson(command, {
        type: "human",
        id: "local-human",
      }),
    );
    expect(() =>
      assertBulkTaskExecutionMatchesPreview(
        {
          ...command,
          previewToken: `btp1:${"c".repeat(64)}:${"b".repeat(64)}`,
        },
        preview,
      ),
    ).toThrowError(BulkTaskPreviewMismatchError);
    expect(() =>
      assertBulkTaskExecutionMatchesPreview(
        {
          ...command,
          previewToken: `btp1:${"a".repeat(64)}:${"c".repeat(64)}`,
        },
        preview,
      ),
    ).toThrowError(BulkTaskPreviewStaleError);
    expect(() =>
      assertBulkTaskExecutionMatchesPreview(command, {
        ...preview,
        executable: false,
        failures: [
          {
            code: "no_changes",
            message: "The bulk update would not change any tasks.",
          },
        ],
      }),
    ).toThrowError(BulkTaskPreviewValidationError);
    expect(assertBulkTaskExecutionMatchesPreview(command, preview)).toBeUndefined();
  });
});
