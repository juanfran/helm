import { mkdir } from "node:fs/promises";
import { dirname, resolve } from "node:path";
import { pathToFileURL } from "node:url";

import {
  SqliteBackupPathError,
  restoreSqliteBackupOffline,
} from "../src/infrastructure/sqlite-backup.server";
import {
  HELM_PROJECT_ROOT,
  databaseFilePath,
  databaseUrlFromEnvironment,
  loadHelmEnvironment,
} from "./environment.mjs";

export function restoreTargetFromArguments(
  args: readonly string[],
  processEnvironment: Record<string, string | undefined> = process.env,
  environmentRoot = HELM_PROJECT_ROOT,
) {
  if (args.length > 2) {
    throw new TypeError("Usage: pnpm backup:restore <backup-file> [target-database]");
  }
  const backupPath = args[0]?.trim();
  if (!backupPath) {
    throw new TypeError("Usage: pnpm backup:restore <backup-file> [target-database]");
  }

  const configured = loadHelmEnvironment({
    cwd: environmentRoot,
    processEnv: { ...processEnvironment },
  });
  const targetPath =
    args[1]?.trim() || databaseFilePath(databaseUrlFromEnvironment(configured), environmentRoot);
  if (!targetPath) {
    throw new SqliteBackupPathError(
      "SQLite backup restoration requires a file-backed target database.",
    );
  }
  return { backupPath: resolve(backupPath), targetPath: resolve(targetPath) };
}

export async function runRestoreBackup(
  args: readonly string[],
  processEnvironment: Record<string, string | undefined> = process.env,
) {
  const { backupPath, targetPath } = restoreTargetFromArguments(args, processEnvironment);
  await mkdir(dirname(targetPath), { recursive: true });
  await restoreSqliteBackupOffline(backupPath, targetPath);
  return targetPath;
}

const entryPath = process.argv[1];
if (entryPath && import.meta.url === pathToFileURL(entryPath).href) {
  try {
    const targetPath = await runRestoreBackup(process.argv.slice(2));
    process.stdout.write(`Restored Helm backup to ${targetPath}\n`);
  } catch (error) {
    const message = error instanceof Error ? error.message : "Unknown restoration error.";
    process.stderr.write(`Helm backup restoration failed: ${message}\n`);
    process.exitCode = 1;
  }
}
