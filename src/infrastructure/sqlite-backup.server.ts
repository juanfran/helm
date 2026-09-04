import { link, lstat, mkdtemp, rm, stat } from "node:fs/promises";
import { basename, dirname, isAbsolute, join, resolve } from "node:path";

import Database from "better-sqlite3";

const DEFAULT_PAGES_PER_STEP = 128;
const MAX_PAGES_PER_STEP = 4_096;

export class SqliteBackupPathError extends Error {
  override readonly name = "SqliteBackupPathError";
}

export class SqliteBackupDestinationExistsError extends Error {
  override readonly name = "SqliteBackupDestinationExistsError";
}

export class SqliteRestoreTargetNotEmptyError extends Error {
  override readonly name = "SqliteRestoreTargetNotEmptyError";
}

export class SqliteBackupIntegrityError extends Error {
  override readonly name = "SqliteBackupIntegrityError";
}

export class SqliteBackupAbortedError extends Error {
  override readonly name = "SqliteBackupAbortedError";
}

export type SqliteBackupProgress = Readonly<Database.BackupMetadata>;

export type SqliteBackupOptions = {
  readonly pagesPerStep?: number;
  readonly signal?: AbortSignal;
  readonly onProgress?: (progress: SqliteBackupProgress) => void;
};

export type SqliteBackupResult = {
  readonly destinationPath: string;
  readonly totalPages: number;
};

function errorCode(error: unknown) {
  if (typeof error !== "object" || error === null || !("code" in error)) return null;
  const code = Reflect.get(error, "code");
  return typeof code === "string" ? code : null;
}

function explicitFilePath(value: string, label: string) {
  if (typeof value !== "string" || value.trim().length === 0) {
    throw new SqliteBackupPathError(`${label} must be a non-empty absolute file path.`);
  }
  const trimmed = value.trim();
  if (!isAbsolute(trimmed) || trimmed === "/" || trimmed.includes("\0")) {
    throw new SqliteBackupPathError(`${label} must be a non-empty absolute file path.`);
  }
  return resolve(trimmed);
}

async function pathState(path: string) {
  try {
    return await lstat(path);
  } catch (error) {
    if (errorCode(error) === "ENOENT") return null;
    throw error;
  }
}

async function requireExistingParent(path: string, label: string) {
  const parentPath = dirname(path);
  let parent;
  try {
    parent = await stat(parentPath);
  } catch (error) {
    if (errorCode(error) === "ENOENT") {
      throw new SqliteBackupPathError(`${label} parent directory does not exist: ${parentPath}`);
    }
    throw error;
  }
  if (!parent.isDirectory()) {
    throw new SqliteBackupPathError(`${label} parent is not a directory: ${parentPath}`);
  }
  return parentPath;
}

function pagesPerStep(value: number | undefined) {
  const pages = value ?? DEFAULT_PAGES_PER_STEP;
  if (!Number.isSafeInteger(pages) || pages < 1 || pages > MAX_PAGES_PER_STEP) {
    throw new RangeError(`pagesPerStep must be an integer between 1 and ${MAX_PAGES_PER_STEP}.`);
  }
  return pages;
}

function throwIfAborted(signal: AbortSignal | undefined) {
  if (!signal?.aborted) return;
  throw new SqliteBackupAbortedError("The SQLite backup was aborted.");
}

function sqliteIntegrityCheck(path: string) {
  const database = new Database(path, { readonly: true, fileMustExist: true });
  try {
    assertSqliteIntegrity(database, path);
  } finally {
    database.close();
  }
}

function assertSqliteIntegrity(database: Database.Database, path: string) {
  const result = database.pragma("integrity_check", { simple: true });
  if (result !== "ok") {
    throw new SqliteBackupIntegrityError(
      `SQLite integrity check failed for ${path}: ${String(result)}`,
    );
  }
}

async function snapshotSqliteFile(sourcePath: string, destinationPath: string) {
  const source = new Database(sourcePath, { readonly: true, fileMustExist: true });
  try {
    assertSqliteIntegrity(source, sourcePath);
    await source.backup(destinationPath, {
      progress: () => DEFAULT_PAGES_PER_STEP,
    });
  } finally {
    source.close();
  }
  sqliteIntegrityCheck(destinationPath);
}

function isSourcePath(database: Database.Database, candidate: string) {
  return !database.memory && resolve(database.name) === candidate;
}

/**
 * Creates a complete SQLite snapshot without replacing an existing filesystem entry.
 * The online backup copies a bounded number of pages per event-loop turn so live reads
 * and writes can continue while SQLite maintains a consistent destination image.
 */
export async function createSqliteBackup(
  database: Database.Database,
  destination: string,
  options: SqliteBackupOptions = {},
): Promise<SqliteBackupResult> {
  if (!database.open) throw new Error("Cannot back up a closed SQLite database.");
  const destinationPath = explicitFilePath(destination, "Backup destination");
  if (isSourcePath(database, destinationPath)) {
    throw new SqliteBackupDestinationExistsError(
      "The backup destination must not be the live SQLite database.",
    );
  }
  const parentPath = await requireExistingParent(destinationPath, "Backup destination");
  if (await pathState(destinationPath)) {
    throw new SqliteBackupDestinationExistsError(
      `The backup destination already exists: ${destinationPath}`,
    );
  }

  const rate = pagesPerStep(options.pagesPerStep);
  throwIfAborted(options.signal);
  const stagingDirectory = await mkdtemp(
    join(parentPath, `.${basename(destinationPath)}.helm-backup-`),
  );
  const stagingPath = join(stagingDirectory, "database.sqlite");

  try {
    const metadata = await database.backup(stagingPath, {
      progress(progress) {
        throwIfAborted(options.signal);
        options.onProgress?.(progress);
        return rate;
      },
    });
    throwIfAborted(options.signal);
    sqliteIntegrityCheck(stagingPath);
    try {
      // A hard link publishes the completed image atomically and fails rather than
      // replacing a destination that appeared while the online backup was running.
      await link(stagingPath, destinationPath);
    } catch (error) {
      if (errorCode(error) === "EEXIST") {
        throw new SqliteBackupDestinationExistsError(
          `The backup destination already exists: ${destinationPath}`,
        );
      }
      throw error;
    }
    return { destinationPath, totalPages: metadata.totalPages };
  } finally {
    await rm(stagingDirectory, { recursive: true, force: true });
  }
}

/**
 * Installs a verified backup for a process that is not using the target database.
 * The target must be absent. Publishing with a hard link is atomic and fails if
 * any filesystem entry appears at the target, so restoration never overwrites a
 * path that changed after validation. Callers must start a new Helm process after
 * this function returns.
 */
export async function restoreSqliteBackupOffline(backup: string, target: string): Promise<void> {
  const backupPath = explicitFilePath(backup, "Backup source");
  const targetPath = explicitFilePath(target, "Restore target");
  if (backupPath === targetPath) {
    throw new SqliteBackupPathError(
      "The backup source and restore target must be different files.",
    );
  }

  const sourceState = await pathState(backupPath);
  if (!sourceState?.isFile() || sourceState.isSymbolicLink() || sourceState.size === 0) {
    throw new SqliteBackupPathError(
      `The backup source is not a non-empty regular file: ${backupPath}`,
    );
  }
  const parentPath = await requireExistingParent(targetPath, "Restore target");
  if (await pathState(targetPath)) {
    throw new SqliteRestoreTargetNotEmptyError(`The restore target must not exist: ${targetPath}`);
  }

  const stagingDirectory = await mkdtemp(
    join(parentPath, `.${basename(targetPath)}.helm-restore-`),
  );
  const stagingPath = join(stagingDirectory, "database.sqlite");
  try {
    // Open the source through SQLite and snapshot it rather than copying only the
    // main file. If the source is a live WAL database, this preserves every
    // committed page visible to the source connection in one consistent image.
    await snapshotSqliteFile(backupPath, stagingPath);

    try {
      await link(stagingPath, targetPath);
    } catch (error) {
      if (errorCode(error) === "EEXIST") {
        throw new SqliteRestoreTargetNotEmptyError(
          `The restore target appeared before it could be installed safely: ${targetPath}`,
        );
      }
      throw error;
    }
  } finally {
    await rm(stagingDirectory, { recursive: true, force: true });
  }
}
