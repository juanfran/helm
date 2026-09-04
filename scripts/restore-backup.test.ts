import { mkdir, mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";

import Database from "better-sqlite3";
import { afterEach, describe, expect, it } from "vitest";

import { createSqliteBackup } from "../src/infrastructure/sqlite-backup.server";
import { restoreTargetFromArguments, runRestoreBackup } from "./restore-backup";

const temporaryRoots: string[] = [];

async function temporaryRoot() {
  const root = await mkdtemp(join(tmpdir(), "helm-restore-command-"));
  temporaryRoots.push(root);
  return root;
}

afterEach(async () => {
  await Promise.all(
    temporaryRoots.splice(0).map((root) => rm(root, { recursive: true, force: true })),
  );
});

describe("backup restoration command", () => {
  it("requires a backup and resolves the configured file-backed target", async () => {
    const root = await temporaryRoot();
    expect(() => restoreTargetFromArguments([], {})).toThrow(/usage/i);
    expect(
      restoreTargetFromArguments([join(root, "backup.sqlite")], {
        DATABASE_URL: join(root, "nested", "helm.sqlite"),
      }),
    ).toEqual({
      backupPath: join(root, "backup.sqlite"),
      targetPath: join(root, "nested", "helm.sqlite"),
    });
    expect(restoreTargetFromArguments([join(root, "backup.sqlite")], {}, root)).toEqual({
      backupPath: join(root, "backup.sqlite"),
      targetPath: join(root, "data", "helm.db"),
    });
  });

  it("restores into an explicit offline target", async () => {
    const root = await temporaryRoot();
    const backupPath = join(root, "backup.sqlite");
    const targetDirectory = join(root, "target");
    const targetPath = join(targetDirectory, "helm.sqlite");
    const source = new Database(join(root, "source.sqlite"));
    source.exec("create table notes (value text not null); insert into notes values ('portable');");
    await createSqliteBackup(source, backupPath);
    source.close();

    await mkdir(targetDirectory);
    await writeFile(targetPath, "");
    await expect(runRestoreBackup([backupPath, targetPath], {})).rejects.toThrow(
      "The restore target must not exist",
    );
    await rm(targetPath);

    await expect(runRestoreBackup([backupPath, targetPath], {})).resolves.toBe(targetPath);
    const restored = new Database(targetPath, { readonly: true });
    try {
      expect(restored.prepare("select value from notes").pluck().get()).toBe("portable");
    } finally {
      restored.close();
    }
  });
});
