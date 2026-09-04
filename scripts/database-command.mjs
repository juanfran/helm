import { existsSync } from "node:fs";
import { join } from "node:path";
import { spawn } from "node:child_process";

import {
  databaseUrlFromEnvironment,
  ensureDatabaseParent,
  HELM_PROJECT_ROOT,
  loadHelmEnvironment,
} from "./environment.mjs";

const supportedCommands = new Set(["generate", "migrate", "push", "pull", "studio"]);
const [command, ...arguments_] = process.argv.slice(2);

if (!command || !supportedCommands.has(command)) {
  throw new Error(
    "Choose one supported Drizzle command: generate, migrate, push, pull, or studio.",
  );
}

loadHelmEnvironment();
ensureDatabaseParent(databaseUrlFromEnvironment(), HELM_PROJECT_ROOT);

const drizzleCli = join(HELM_PROJECT_ROOT, "node_modules/drizzle-kit/bin.cjs");
if (!existsSync(drizzleCli)) {
  throw new Error("Drizzle Kit is not installed. Run pnpm install before using database tools.");
}

const child = spawn(process.execPath, [drizzleCli, command, ...arguments_], {
  cwd: HELM_PROJECT_ROOT,
  env: process.env,
  stdio: "inherit",
});

const exitCode = await new Promise((resolve, reject) => {
  child.once("error", () => reject(new Error("Helm could not start the database command.")));
  child.once("close", (code, signal) => {
    if (signal) reject(new Error(`The database command stopped after ${signal}.`));
    else resolve(code ?? 1);
  });
});

process.exitCode = exitCode;
