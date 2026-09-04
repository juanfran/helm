import { existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";

import { afterEach, describe, expect, it } from "vitest";

import { computeBuildFingerprint, productionBuildStatus } from "./build-state.mjs";
import {
  databaseFilePath,
  ensureDatabaseParent,
  loadHelmEnvironment,
  resolveHelmEnvironment,
  serverHostFromEnvironment,
} from "./environment.mjs";

const temporaryDirectories: string[] = [];

function temporaryDirectory(prefix: string) {
  const directory = mkdtempSync(join(tmpdir(), prefix));
  temporaryDirectories.push(directory);
  return directory;
}

function write(path: string, content: string) {
  mkdirSync(dirname(path), { recursive: true });
  writeFileSync(path, content);
}

afterEach(() => {
  for (const directory of temporaryDirectories.splice(0)) {
    rmSync(directory, { recursive: true, force: true });
  }
});

describe("Helm operational configuration", () => {
  it("loads process values before .env.local and .env without executing file content", () => {
    const root = temporaryDirectory("helm-environment-");
    const marker = join(root, "must-not-exist");
    write(
      join(root, ".env"),
      `HELM_PRECEDENCE=env\nHELM_ENV_ONLY=env\nHELM_LITERAL=$(touch ${marker})\n`,
    );
    write(join(root, ".env.local"), "HELM_PRECEDENCE=local\nHELM_LOCAL_ONLY=local\n");

    const withProcessValue = { HELM_PRECEDENCE: "process" };
    loadHelmEnvironment({ cwd: root, processEnv: withProcessValue });
    expect(withProcessValue).toMatchObject({
      HELM_ENV_ONLY: "env",
      HELM_LOCAL_ONLY: "local",
      HELM_PRECEDENCE: "process",
      HELM_LITERAL: `$(touch ${marker})`,
    });

    const fromFiles: Record<string, string | undefined> = {};
    loadHelmEnvironment({ cwd: root, processEnv: fromFiles });
    expect(fromFiles.HELM_PRECEDENCE).toBe("local");
    expect(existsSync(marker)).toBe(false);
  });

  it("uses safe defaults and requires an explicit acknowledgement for remote hosts", () => {
    expect(resolveHelmEnvironment({})).toEqual({
      databaseUrl: "./data/helm.db",
      host: "127.0.0.1",
    });
    expect(serverHostFromEnvironment({ HOST: "localhost" })).toBe("localhost");
    expect(() => serverHostFromEnvironment({ HOST: "0.0.0.0" })).toThrow(
      /HELM_UNSAFE_ALLOW_REMOTE=1/,
    );
    expect(serverHostFromEnvironment({ HOST: "0.0.0.0", HELM_UNSAFE_ALLOW_REMOTE: "1" })).toBe(
      "0.0.0.0",
    );
    expect(() => resolveHelmEnvironment({ DATABASE_URL: " " })).toThrow(
      "DATABASE_URL cannot be empty.",
    );
  });

  it("creates a fresh SQLite parent without treating in-memory databases as files", () => {
    const root = temporaryDirectory("helm-database-parent-");
    const databaseUrl = "./nested/state/helm.db";
    const expectedPath = join(root, "nested", "state", "helm.db");

    expect(databaseFilePath(databaseUrl, root)).toBe(expectedPath);
    expect(ensureDatabaseParent(databaseUrl, root)).toBe(expectedPath);
    expect(existsSync(dirname(expectedPath))).toBe(true);
    expect(ensureDatabaseParent(":memory:", root)).toBeNull();
  });

  it("invalidates a production build manifest when an input changes", () => {
    const root = temporaryDirectory("helm-build-state-");
    write(join(root, "src", "entry.ts"), "export const version = 1;\n");

    expect(productionBuildStatus(root)).toBe("missing-output");
    write(join(root, ".output", "server", "index.mjs"), "export {};\n");
    expect(productionBuildStatus(root)).toBe("missing-manifest");
    write(join(root, ".output", "helm-build.json"), '{"version":1,"fingerprint":null}\n');
    expect(productionBuildStatus(root)).toBe("invalid-manifest");

    write(
      join(root, ".output", "helm-build.json"),
      `${JSON.stringify({ version: 1, fingerprint: computeBuildFingerprint(root) })}\n`,
    );
    expect(productionBuildStatus(root)).toBe("current");

    write(join(root, "src", "entry.ts"), "export const version = 2;\n");
    expect(productionBuildStatus(root)).toBe("inputs-changed");
    expect(readFileSync(join(root, ".output", "server", "index.mjs"), "utf8")).toBe("export {};\n");
  });
});
