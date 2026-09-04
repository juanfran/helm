import { randomUUID } from "node:crypto";
import { mkdtemp, open, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";

import Database from "better-sqlite3";
import { Effect } from "effect";

import type { PortabilityError } from "../application/portability-errors";
import {
  InvalidPortabilityInputError,
  PortabilityAuthorizationError,
  PortabilityConflictError,
  PortabilityIdempotencyConflictError,
  PortabilityNotFoundError,
  PortabilityPersistenceError,
  PortabilityPreviewStaleError,
  UnsupportedPortabilityVersionError,
} from "../application/portability-errors";
import type { PortabilityStore } from "../application/portability";
import {
  UnsupportedProjectExportFormatError,
  UnsupportedProjectExportSchemaVersionError,
} from "../domain/portability";
import { PortableCsvParseError } from "../domain/portable-csv";
import { createSqliteBackup } from "./sqlite-backup.server";
import {
  executeSqlitePortableCsvImportInCurrentTransaction,
  planSqlitePortableCsvImportInCurrentTransaction,
} from "./sqlite-portable-csv-import.server";
import { exportSqliteProjectMarkdown } from "./sqlite-portable-markdown.server";
import {
  executeSqliteProjectImportInCurrentTransaction,
  exportSqliteProject,
  previewSqliteProjectImport,
} from "./sqlite-portable-project.server";

function isPortabilityError(error: unknown): error is PortabilityError {
  return (
    error instanceof InvalidPortabilityInputError ||
    error instanceof UnsupportedPortabilityVersionError ||
    error instanceof PortabilityNotFoundError ||
    error instanceof PortabilityConflictError ||
    error instanceof PortabilityPreviewStaleError ||
    error instanceof PortabilityAuthorizationError ||
    error instanceof PortabilityIdempotencyConflictError ||
    error instanceof PortabilityPersistenceError
  );
}

function portabilityError(error: unknown): PortabilityError {
  if (isPortabilityError(error)) return error;
  if (error instanceof UnsupportedProjectExportSchemaVersionError) {
    return new UnsupportedPortabilityVersionError({
      receivedVersion: error.receivedVersion,
      message: error.message,
    });
  }
  if (error instanceof UnsupportedProjectExportFormatError) {
    return new InvalidPortabilityInputError({
      message: "The JSON import is not a Helm project export.",
      issues: [error.message],
    });
  }
  if (error instanceof PortableCsvParseError) {
    return new InvalidPortabilityInputError({
      message: "The CSV import could not be parsed.",
      issues: [error.message],
    });
  }
  const correlationId = randomUUID();
  const detail = error instanceof Error ? `${error.name}: ${error.message}` : String(error);
  process.stderr.write(`[helm] portability persistence failure ${correlationId}: ${detail}\n`);
  return new PortabilityPersistenceError({
    correlationId,
    message: "The project portability database operation failed.",
  });
}

function reportBackupCleanupFailure(error: unknown) {
  const correlationId = randomUUID();
  const detail = error instanceof Error ? `${error.name}: ${error.message}` : String(error);
  process.stderr.write(`[helm] backup cleanup failure ${correlationId}: ${detail}\n`);
}

async function backupBody(database: Database.Database, signal?: AbortSignal) {
  const temporaryDirectory = await mkdtemp(join(tmpdir(), "helm-portability-backup-"));
  const backupPath = join(temporaryDirectory, "helm.sqlite");
  let cleanupOwnedByStream = false;
  try {
    await createSqliteBackup(database, backupPath, { signal });
    const file = await open(backupPath, "r");
    let position = 0;
    let finished = false;
    let cleanupPromise: Promise<void> | null = null;
    let abortListener: (() => void) | null = null;

    function cleanup() {
      cleanupPromise ??= (async () => {
        if (abortListener) signal?.removeEventListener("abort", abortListener);
        try {
          await file.close();
        } catch (error) {
          reportBackupCleanupFailure(error);
        }
        try {
          await rm(temporaryDirectory, { recursive: true, force: true });
        } catch (error) {
          reportBackupCleanupFailure(error);
        }
      })();
      return cleanupPromise;
    }

    const body = new ReadableStream<Uint8Array>({
      start(controller) {
        abortListener = () => {
          if (finished) return;
          finished = true;
          controller.error(
            signal?.reason ?? new DOMException("The download was aborted.", "AbortError"),
          );
          void cleanup();
        };
        signal?.addEventListener("abort", abortListener, { once: true });
      },
      async pull(controller) {
        if (finished) return;
        const chunk = new Uint8Array(64 * 1024);
        try {
          const { bytesRead } = await file.read(chunk, 0, chunk.byteLength, position);
          if (finished) return;
          if (bytesRead === 0) {
            finished = true;
            controller.close();
            await cleanup();
            return;
          }
          position += bytesRead;
          controller.enqueue(bytesRead === chunk.byteLength ? chunk : chunk.subarray(0, bytesRead));
        } catch (error) {
          if (!finished) {
            finished = true;
            controller.error(error);
          }
          await cleanup();
        }
      },
      async cancel() {
        finished = true;
        await cleanup();
      },
    });
    if (signal?.aborted) {
      await body.cancel(signal.reason);
      throw signal.reason ?? new DOMException("The download was aborted.", "AbortError");
    }
    cleanupOwnedByStream = true;
    return body;
  } finally {
    if (!cleanupOwnedByStream) {
      await rm(temporaryDirectory, { recursive: true, force: true });
    }
  }
}

/** Creates the application repository around one shared SQLite connection. */
export function createSqlitePortabilityStore(database: Database.Database): PortabilityStore {
  return {
    createBackup(signal) {
      return Effect.tryPromise({
        try: () => backupBody(database, signal),
        catch: portabilityError,
      });
    },
    exportProject(input, context) {
      return Effect.try({
        try: () => exportSqliteProject(database, input, context),
        catch: portabilityError,
      });
    },
    exportProjectMarkdown(input, context) {
      return Effect.try({
        try: () => exportSqliteProjectMarkdown(database, input, context),
        catch: portabilityError,
      });
    },
    previewImport(input, actor, context) {
      return Effect.try({
        try: () => {
          if (input.source.format === "json") {
            return previewSqliteProjectImport(database, input, actor, context);
          }
          if (actor.type !== "human") {
            throw new PortabilityAuthorizationError({
              message: "Only the local human can import CSV task data.",
            });
          }
          const humanActor = { type: "human" as const, id: actor.id };
          return database
            .transaction(
              () =>
                planSqlitePortableCsvImportInCurrentTransaction(
                  database,
                  input,
                  humanActor,
                  context,
                ).preview,
            )
            .deferred();
        },
        catch: portabilityError,
      });
    },
    executeImport(input, actor, context) {
      return Effect.try({
        try: () =>
          database
            .transaction(() => {
              if (input.source.format === "json") {
                return executeSqliteProjectImportInCurrentTransaction(
                  database,
                  input,
                  actor,
                  context,
                );
              }
              if (actor.type !== "human") {
                throw new PortabilityAuthorizationError({
                  message: "Only the local human can import CSV task data.",
                });
              }
              const humanActor = { type: "human" as const, id: actor.id };
              const { executionPlan } = planSqlitePortableCsvImportInCurrentTransaction(
                database,
                input,
                humanActor,
                context,
              );
              return executeSqlitePortableCsvImportInCurrentTransaction(database, executionPlan, {
                previewToken: input.previewToken,
                idempotencyKey: input.idempotencyKey,
              });
            })
            .immediate(),
        catch: portabilityError,
      });
    },
  };
}
