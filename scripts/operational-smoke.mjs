import { spawn } from "node:child_process";
import { createServer } from "node:net";
import { existsSync, mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

import Database from "better-sqlite3";

import { productionBuildStatus } from "./build-state.mjs";
import { HELM_PROJECT_ROOT } from "./environment.mjs";

const timeoutMilliseconds = 60_000;
const processErrors = new WeakMap();
const processGroups = new WeakSet();

function reservePort() {
  return new Promise((resolve, reject) => {
    const server = createServer();
    server.once("error", reject);
    server.listen(0, "127.0.0.1", () => {
      const address = server.address();
      if (!address || typeof address === "string") {
        server.close();
        reject(new Error("Helm could not reserve a smoke-test port."));
        return;
      }
      server.close((error) => (error ? reject(error) : resolve(address.port)));
    });
  });
}

function runCommand(script, arguments_, environment) {
  return new Promise((resolve, reject) => {
    const child = spawn(process.execPath, [script, ...arguments_], {
      cwd: HELM_PROJECT_ROOT,
      env: environment,
      stdio: "ignore",
    });
    child.once("error", () => reject(new Error("Helm could not start an operational command.")));
    child.once("close", (code, signal) => {
      if (code === 0) resolve();
      else
        reject(
          new Error(
            signal
              ? `An operational command stopped after ${signal}.`
              : `An operational command exited with status ${code ?? "unknown"}.`,
          ),
        );
    });
  });
}

function startHelm(environment, options = {}) {
  const useShellLauncher = options.useShellLauncher ?? false;
  const child = spawn(
    useShellLauncher ? "sh" : process.execPath,
    [
      useShellLauncher
        ? join(HELM_PROJECT_ROOT, "start.sh")
        : join(HELM_PROJECT_ROOT, "scripts/start.mjs"),
    ],
    {
      cwd: options.cwd ?? HELM_PROJECT_ROOT,
      detached: useShellLauncher,
      env: environment,
      stdio: ["ignore", "pipe", "pipe"],
    },
  );
  if (useShellLauncher) processGroups.add(child);
  child.once("error", () => {
    processErrors.set(child, new Error("Helm could not start the production launcher."));
  });
  child.stdout.resume();
  child.stderr.resume();
  return child;
}

async function waitForReady(child, url) {
  const deadline = Date.now() + timeoutMilliseconds;
  while (Date.now() < deadline) {
    const processError = processErrors.get(child);
    if (processError) throw processError;
    if (child.exitCode !== null) throw new Error("Helm exited before becoming ready.");
    try {
      // oxlint-disable-next-line no-await-in-loop
      const response = await fetch(url, { signal: AbortSignal.timeout(1_000) });
      if (response.ok) return response;
    } catch {
      // Startup is still in progress.
    }
    // oxlint-disable-next-line no-await-in-loop
    await new Promise((resolve) => setTimeout(resolve, 100));
  }
  throw new Error("Helm did not become ready before the smoke-test timeout.");
}

async function stopHelm(child) {
  if (child.exitCode !== null || !child.pid) return;

  const closed = new Promise((resolve) => child.once("close", resolve));
  if (processGroups.has(child) && child.pid) process.kill(-child.pid, "SIGTERM");
  else child.kill("SIGTERM");
  const stopped = await Promise.race([
    closed.then(() => true),
    new Promise((resolve) => setTimeout(() => resolve(false), 5_000)),
  ]);
  if (!stopped) {
    if (processGroups.has(child) && child.pid) process.kill(-child.pid, "SIGKILL");
    else child.kill("SIGKILL");
    await closed;
  }
}

async function initializeMcp(origin) {
  const response = await fetch(`${origin}/api/mcp`, {
    method: "POST",
    headers: {
      accept: "application/json, text/event-stream",
      "content-type": "application/json",
    },
    body: JSON.stringify({
      jsonrpc: "2.0",
      id: 1,
      method: "initialize",
      params: {
        protocolVersion: "2025-06-18",
        capabilities: {},
        clientInfo: { name: "helm-operational-smoke", version: "1.0.0" },
      },
    }),
    signal: AbortSignal.timeout(5_000),
  });
  if (!response.ok) throw new Error("The production MCP endpoint rejected initialization.");

  const sessionId = response.headers.get("mcp-session-id");
  if (sessionId) {
    await fetch(`${origin}/api/mcp`, {
      method: "DELETE",
      headers: { "mcp-session-id": sessionId },
      signal: AbortSignal.timeout(5_000),
    });
  }
}

const temporaryRoot = mkdtempSync(join(tmpdir(), "helm-operational-smoke-"));
const databasePath = join(temporaryRoot, "nested", "data", "helm.db");
const environment = {
  ...process.env,
  DATABASE_URL: databasePath,
  HELM_UNSAFE_ALLOW_REMOTE: "0",
  HOST: "127.0.0.1",
  NODE_ENV: "production",
};
let helmProcess;

try {
  await runCommand(
    join(HELM_PROJECT_ROOT, "scripts/database-command.mjs"),
    ["migrate"],
    environment,
  );
  if (!existsSync(databasePath)) {
    throw new Error("The fresh-path migration did not create its SQLite database.");
  }

  mkdirSync(join(HELM_PROJECT_ROOT, ".output"), { recursive: true });
  writeFileSync(
    join(HELM_PROJECT_ROOT, ".output", "helm-build.json"),
    '{"version":1,"fingerprint":"stale"}\n',
  );

  const port = await reservePort();
  const origin = `http://127.0.0.1:${port}`;
  environment.PORT = String(port);

  helmProcess = startHelm(environment, { cwd: temporaryRoot, useShellLauncher: true });
  await waitForReady(helmProcess, origin);
  await initializeMcp(origin);
  await stopHelm(helmProcess);
  helmProcess = undefined;

  const database = new Database(databasePath);
  try {
    database.prepare("update preferences set theme = 'dark' where id = 1").run();
  } finally {
    database.close();
  }

  helmProcess = startHelm(environment, { cwd: temporaryRoot });
  const restartedResponse = await waitForReady(helmProcess, origin);
  const html = await restartedResponse.text();
  if (!html.includes('data-theme="dark"')) {
    throw new Error("The production restart did not restore persisted project preferences.");
  }
  if (productionBuildStatus() !== "current") {
    throw new Error("The production build manifest was not current after startup rebuilt it.");
  }
} finally {
  try {
    if (helmProcess) await stopHelm(helmProcess);
  } finally {
    rmSync(temporaryRoot, { recursive: true, force: true });
  }
}

process.stdout.write("Helm operational smoke test passed.\n");
