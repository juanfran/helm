import { mkdirSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { dirname, resolve } from "node:path";

import { config } from "dotenv";

export const HELM_PROJECT_ROOT = fileURLToPath(new URL("../", import.meta.url));
export const DEFAULT_DATABASE_URL = "./data/helm.db";
export const DEFAULT_HOST = "127.0.0.1";

const environmentFiles = [".env.local", ".env"];
const loopbackHosts = new Set(["127.0.0.1", "::1", "localhost"]);

export function loadHelmEnvironment(options = {}) {
  const cwd = options.cwd ?? HELM_PROJECT_ROOT;
  const processEnv = options.processEnv ?? process.env;

  for (const filename of environmentFiles) {
    const result = config({
      path: resolve(cwd, filename),
      processEnv,
      override: false,
      quiet: true,
    });

    if (result.error && result.error.code !== "ENOENT") {
      throw new Error(`Helm could not load ${filename}.`);
    }
  }

  return processEnv;
}

function nonEmptyEnvironmentValue(value, fallback, name) {
  if (value === undefined) return fallback;
  const normalized = value.trim();
  if (normalized.length === 0) throw new Error(`${name} cannot be empty.`);
  return normalized;
}

export function resolveHelmEnvironment(processEnv = process.env) {
  return {
    databaseUrl: databaseUrlFromEnvironment(processEnv),
    host: serverHostFromEnvironment(processEnv),
  };
}

export function databaseUrlFromEnvironment(processEnv = process.env) {
  return nonEmptyEnvironmentValue(processEnv.DATABASE_URL, DEFAULT_DATABASE_URL, "DATABASE_URL");
}

export function serverHostFromEnvironment(processEnv = process.env) {
  const host = nonEmptyEnvironmentValue(processEnv.HOST, DEFAULT_HOST, "HOST");

  if (!loopbackHosts.has(host) && processEnv.HELM_UNSAFE_ALLOW_REMOTE !== "1") {
    throw new Error(
      "Refusing to expose Helm outside this machine. Set HELM_UNSAFE_ALLOW_REMOTE=1 to acknowledge the risk.",
    );
  }

  return host;
}

export function databaseFilePath(databaseUrl, cwd = HELM_PROJECT_ROOT) {
  if (databaseUrl === ":memory:") return null;

  const path = databaseUrl.startsWith("file:") ? databaseUrl.slice("file:".length) : databaseUrl;
  if (path.trim().length === 0) throw new Error("DATABASE_URL must identify a SQLite file.");

  return resolve(cwd, path);
}

export function ensureDatabaseParent(databaseUrl, cwd = HELM_PROJECT_ROOT) {
  const filePath = databaseFilePath(databaseUrl, cwd);
  if (filePath) mkdirSync(dirname(filePath), { recursive: true });
  return filePath;
}
