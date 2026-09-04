import { spawn } from "node:child_process";
import { existsSync, mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { createServer } from "node:net";
import { networkInterfaces, tmpdir } from "node:os";
import { join } from "node:path";

import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { StreamableHTTPClientTransport } from "@modelcontextprotocol/sdk/client/streamableHttp.js";
import Database from "better-sqlite3";

import { productionBuildStatus } from "./build-state.mjs";
import { HELM_PROJECT_ROOT } from "./environment.mjs";

const startupTimeoutMilliseconds = 60_000;
const shutdownTimeoutMilliseconds = 5_000;
const requestTimeoutMilliseconds = 2_000;
const mcpTimeoutMilliseconds = 5_000;
const commandTimeoutMilliseconds = 60_000;
const processLogLimit = 48_000;
const processRecords = [];
const processStates = new WeakMap();
const processGroups = new WeakSet();
let interruptionSignal;

function appendProcessLog(state, channel, chunk) {
  state.log += `[${channel}] ${chunk.toString()}`;
  if (state.log.length > processLogLimit) {
    state.log = `[earlier output truncated]\n${state.log.slice(-processLogLimit)}`;
  }
}

function captureProcess(child, label) {
  const state = { child, label, log: "", spawnError: null };
  processRecords.push(state);
  processStates.set(child, state);
  child.stdout?.on("data", (chunk) => appendProcessLog(state, "stdout", chunk));
  child.stderr?.on("data", (chunk) => appendProcessLog(state, "stderr", chunk));
  child.once("error", (error) => {
    state.spawnError = error;
  });
  return child;
}

function formatError(error) {
  if (!(error instanceof Error)) return String(error);

  let formatted = error.stack ?? error.message;
  if (error instanceof AggregateError) {
    formatted += error.errors
      .map((nestedError, index) => `\nAggregate error ${index + 1}: ${formatError(nestedError)}`)
      .join("");
  }
  if (error.cause !== undefined) {
    formatted += `\nCaused by: ${formatError(error.cause)}`;
  }
  return formatted;
}

function formatProcessLogs() {
  const output = processRecords
    .filter((state) => state.log.trim().length > 0 || state.spawnError)
    .map((state) => {
      const spawnError = state.spawnError ? `\n[spawn] ${formatError(state.spawnError)}` : "";
      const log = state.log.trimEnd();
      return `--- ${state.label} ---${spawnError}${log ? `\n${log}` : ""}`;
    });
  return output.length > 0 ? `\n\nSubprocess output:\n${output.join("\n")}` : "";
}

async function runStep(label, action) {
  if (interruptionSignal) {
    throw new Error(`Operational smoke was interrupted by ${interruptionSignal}.`);
  }
  process.stdout.write(`[helm-smoke] ${label}...\n`);
  try {
    const result = await action();
    if (interruptionSignal) {
      throw new Error(`Operational smoke was interrupted by ${interruptionSignal}.`);
    }
    process.stdout.write(`[helm-smoke] ${label}: passed\n`);
    return result;
  } catch (error) {
    throw new Error(`${label} failed.`, { cause: error });
  }
}

async function withDeadline(action, timeoutMilliseconds, message, onTimeout) {
  let timeout;
  const deadline = new Promise((_, reject) => {
    timeout = setTimeout(() => {
      try {
        onTimeout?.();
        reject(new Error(message));
      } catch (error) {
        reject(new Error(message, { cause: error }));
      }
    }, timeoutMilliseconds);
  });

  try {
    return await Promise.race([action, deadline]);
  } finally {
    clearTimeout(timeout);
  }
}

function listenOnPort(port) {
  return new Promise((resolve, reject) => {
    const server = createServer();
    server.once("error", (error) => {
      if (error.code === "EADDRINUSE") resolve(false);
      else reject(error);
    });
    server.listen(port, "127.0.0.1", () => {
      server.close((error) => (error ? reject(error) : resolve(true)));
    });
  });
}

async function reservePort() {
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

async function waitForPortRelease(port) {
  const deadline = Date.now() + shutdownTimeoutMilliseconds;
  while (Date.now() < deadline) {
    // oxlint-disable-next-line no-await-in-loop
    if (await listenOnPort(port)) return;
    // oxlint-disable-next-line no-await-in-loop
    await new Promise((resolve) => setTimeout(resolve, 100));
  }
  throw new Error(`Production shutdown did not release loopback port ${port}.`);
}

async function runCommand(label, script, arguments_, environment) {
  const child = captureProcess(
    spawn(process.execPath, [script, ...arguments_], {
      cwd: HELM_PROJECT_ROOT,
      detached: true,
      env: environment,
      stdio: ["ignore", "pipe", "pipe"],
    }),
    label,
  );
  processGroups.add(child);
  const outcome = await waitForExit(child, commandTimeoutMilliseconds);
  if (!outcome) {
    signalProcess(child, "SIGTERM");
    const stopped = await waitForExit(child, shutdownTimeoutMilliseconds);
    if (!stopped) {
      signalProcess(child, "SIGKILL");
      await waitForExit(child, shutdownTimeoutMilliseconds);
    }
    throw new Error(`${label} did not finish within ${commandTimeoutMilliseconds}ms.`);
  }

  const spawnError = processStates.get(child)?.spawnError;
  if (spawnError) throw new Error(`${label} could not start.`, { cause: spawnError });
  if (outcome.code === 0) return;
  if (outcome.signal) throw new Error(`${label} stopped after ${outcome.signal}.`);
  throw new Error(`${label} exited with status ${outcome.code ?? "unknown"}.`);
}

function startHelm(environment, options = {}) {
  const useShellLauncher = options.useShellLauncher ?? false;
  const label = options.label ?? "Helm production server";
  const child = captureProcess(
    spawn(
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
    ),
    label,
  );
  if (useShellLauncher) processGroups.add(child);
  return child;
}

function waitForExit(child, timeoutMilliseconds) {
  if (child.exitCode !== null || child.signalCode !== null) {
    return Promise.resolve({ code: child.exitCode, signal: child.signalCode });
  }

  return new Promise((resolve) => {
    const onClose = (code, signal) => {
      clearTimeout(timeout);
      resolve({ code, signal });
    };
    const timeout = setTimeout(() => {
      child.removeListener("close", onClose);
      resolve(null);
    }, timeoutMilliseconds);
    child.once("close", onClose);
  });
}

async function waitForReady(child, url) {
  const deadline = Date.now() + startupTimeoutMilliseconds;
  let lastStatus = null;
  while (Date.now() < deadline) {
    const state = processStates.get(child);
    if (state?.spawnError) throw new Error("Helm could not start the production launcher.");
    if (child.exitCode !== null || child.signalCode !== null) {
      throw new Error(
        `Helm exited before becoming ready (${child.signalCode ?? child.exitCode ?? "unknown"}).`,
      );
    }
    try {
      // oxlint-disable-next-line no-await-in-loop
      const response = await fetch(url, {
        redirect: "manual",
        signal: AbortSignal.timeout(requestTimeoutMilliseconds),
      });
      if (response.ok) return response;
      lastStatus = response.status;
    } catch {
      // Startup is still in progress.
    }
    // oxlint-disable-next-line no-await-in-loop
    await new Promise((resolve) => setTimeout(resolve, 100));
  }
  const status = lastStatus === null ? "no HTTP response" : `last HTTP status ${lastStatus}`;
  throw new Error(`Helm did not become ready before the timeout (${status}).`);
}

function signalProcess(child, signal) {
  try {
    if (processGroups.has(child) && child.pid) process.kill(-child.pid, signal);
    else child.kill(signal);
  } catch (error) {
    if (error.code !== "ESRCH") throw error;
  }
}

function interruptSmoke(signal) {
  interruptionSignal ??= signal;
  for (const { child } of processRecords) {
    if (child.exitCode !== null || child.signalCode !== null || !child.pid) continue;
    try {
      signalProcess(child, "SIGTERM");
    } catch {
      // The regular failure path reports process and cleanup diagnostics.
    }
  }
}

async function stopHelm(child, options = {}) {
  const allowAlreadyStopped = options.allowAlreadyStopped ?? false;
  if (child.exitCode !== null || child.signalCode !== null || !child.pid) {
    if (allowAlreadyStopped) return;
    throw new Error(
      `Helm exited before the shutdown probe (${child.signalCode ?? child.exitCode ?? "unknown"}).`,
    );
  }

  signalProcess(child, "SIGTERM");
  const stopped = await waitForExit(child, shutdownTimeoutMilliseconds);
  if (stopped) return;

  signalProcess(child, "SIGKILL");
  await waitForExit(child, shutdownTimeoutMilliseconds);
  throw new Error("Helm required SIGKILL instead of completing a clean production shutdown.");
}

async function stopHelmAndVerifyPort(child, port) {
  await stopHelm(child);
  await waitForPortRelease(port);
}

function verifyFreshDatabase(databasePath) {
  if (!existsSync(databasePath)) {
    throw new Error("The fresh-path migration did not create its SQLite database.");
  }

  const database = new Database(databasePath, { readonly: true });
  try {
    const tables = new Set(
      database
        .prepare("select name from sqlite_master where type = 'table'")
        .all()
        .map((row) => row.name),
    );
    const missing = ["events", "preferences", "projects", "tasks"].filter(
      (table) => !tables.has(table),
    );
    if (missing.length > 0) {
      throw new Error(`The fresh migration omitted required tables: ${missing.join(", ")}.`);
    }
  } finally {
    database.close();
  }
}

async function assertRemoteBindingRejected(environment, temporaryRoot) {
  const child = startHelm(
    {
      ...environment,
      HELM_UNSAFE_ALLOW_REMOTE: "0",
      HOST: "0.0.0.0",
    },
    { cwd: temporaryRoot, label: "unsafe remote-binding probe" },
  );
  const outcome = await waitForExit(child, shutdownTimeoutMilliseconds);
  if (!outcome) {
    await stopHelm(child);
    throw new Error("Helm did not reject an unacknowledged remote binding promptly.");
  }
  if (outcome.code === 0) {
    throw new Error("Helm accepted an unacknowledged remote binding.");
  }

  const log = processStates.get(child)?.log ?? "";
  if (!log.includes("HELM_UNSAFE_ALLOW_REMOTE=1")) {
    throw new Error("The rejected remote binding did not explain the required acknowledgement.");
  }
}

async function assertLoopbackOnly(port) {
  const addresses = Object.values(networkInterfaces())
    .flatMap((addressesForInterface) => addressesForInterface ?? [])
    .filter((address) => address.family === "IPv4" && !address.internal)
    .map((address) => address.address);

  for (const address of addresses) {
    let reachable = false;
    try {
      // oxlint-disable-next-line no-await-in-loop
      await fetch(`http://${address}:${port}`, {
        redirect: "manual",
        signal: AbortSignal.timeout(500),
      });
      reachable = true;
    } catch {
      // A loopback-bound server must not be reachable through this interface.
    }
    if (reachable) {
      throw new Error(`Helm was reachable through non-loopback interface ${address}.`);
    }
  }
}

async function verifyBrowserResponse(response) {
  const contentType = response.headers.get("content-type") ?? "";
  if (!contentType.toLowerCase().includes("text/html")) {
    throw new Error(
      `The browser endpoint returned unexpected content type ${contentType || "none"}.`,
    );
  }

  const html = await response.text();
  if (!/<html(?:\s|>)/i.test(html) || !html.includes("Helm")) {
    throw new Error("The browser endpoint did not return the Helm application shell.");
  }
  return html;
}

async function initializeMcp(origin, expectedCatalog) {
  const transport = new StreamableHTTPClientTransport(new URL(`${origin}/api/mcp`));
  const client = new Client({ name: "helm-operational-smoke", version: "1.0.0" });

  try {
    await withDeadline(
      client.connect(transport, { timeout: mcpTimeoutMilliseconds }),
      mcpTimeoutMilliseconds,
      "The MCP initialize exchange did not finish before its deadline.",
      () => void transport.close(),
    );
    const serverVersion = client.getServerVersion();
    if (serverVersion?.name !== "helm" || typeof serverVersion.version !== "string") {
      throw new Error("The MCP initialize result did not identify the Helm server.");
    }
    if (!client.getServerCapabilities()?.tools) {
      throw new Error("The MCP initialize result did not advertise Helm's tool capability.");
    }
    if (!transport.sessionId) {
      throw new Error("The MCP initialize response did not establish a server session.");
    }
    await client.ping({ timeout: requestTimeoutMilliseconds });
    if (expectedCatalog) {
      const expectedProject = expectedCatalog.activeProject;
      const [catalogResult, activeResult] = await Promise.all([
        client.callTool({ name: "list_projects" }),
        client.callTool({ name: "get_active_project" }),
      ]);
      const catalog = catalogResult.structuredContent;
      const activeState = activeResult.structuredContent;
      if (
        !catalog ||
        catalog.activeProjectId !== expectedProject.id ||
        !Array.isArray(catalog.projects) ||
        catalog.projects.length !== expectedCatalog.projects.length ||
        catalog.projects.some(
          (project, index) => project.id !== expectedCatalog.projects[index]?.id,
        )
      ) {
        throw new Error("MCP did not restore the persisted project catalog after restart.");
      }
      if (
        !activeState ||
        activeState.activeProject?.id !== expectedProject.id ||
        activeState.activeProjectVersion !== expectedCatalog.activeProjectVersion ||
        activeState.theme !== "dark"
      ) {
        throw new Error("MCP did not restore the persisted active project after restart.");
      }
    }
  } finally {
    try {
      if (transport.sessionId) {
        await withDeadline(
          transport.terminateSession(),
          mcpTimeoutMilliseconds,
          "The MCP session termination did not finish before its deadline.",
          () => void transport.close(),
        );
      }
    } finally {
      await client.close();
    }
  }
}

function persistProjectPreferences(databasePath, repositoryRoots) {
  const database = new Database(databasePath);
  try {
    const now = new Date().toISOString();
    const projects = repositoryRoots.map((repositoryRoot, index) => ({
      id: `operational-smoke-project-${index + 1}`,
      sequence: index + 1,
      name: `operational-smoke-repository-${index + 1}`,
      repositoryRoot,
      reviewMode: "required",
      version: 1,
      createdAt: now,
      updatedAt: now,
    }));
    const insertProject = database.prepare(
      `insert into projects (
          id, sequence, name, repository_root, review_mode, version, created_at, updated_at
        ) values (
          @id, @sequence, @name, @repositoryRoot, @reviewMode, @version, @createdAt, @updatedAt
        )`,
    );
    for (const project of projects) insertProject.run(project);
    const activeProject = projects[0];
    const result = database
      .prepare(
        `update preferences
         set active_project_id = ?, active_project_version = 3, theme = 'dark', updated_at = ?
         where id = 1`,
      )
      .run(activeProject.id, now);
    if (result.changes !== 1) {
      throw new Error("The migrated database did not contain Helm's preference projection.");
    }
    return { activeProject, activeProjectVersion: 3, projects };
  } finally {
    database.close();
  }
}

const temporaryRoot = mkdtempSync(join(tmpdir(), "helm-operational-smoke-"));
const databasePath = join(temporaryRoot, "nested", "data", "helm.db");
const repositoryRoots = [
  join(temporaryRoot, "operational-smoke-repository-1"),
  join(temporaryRoot, "operational-smoke-repository-2"),
];
for (const repositoryRoot of repositoryRoots) {
  mkdirSync(join(repositoryRoot, ".git"), { recursive: true });
}
const environment = {
  ...process.env,
  DATABASE_URL: databasePath,
  HELM_UNSAFE_ALLOW_REMOTE: "0",
  HOST: "127.0.0.1",
  NODE_ENV: "production",
};
let helmProcess;
let port;
let failure;
let persistedProject;
const signalHandlers = new Map(
  ["SIGINT", "SIGTERM"].map((signal) => [signal, () => interruptSmoke(signal)]),
);
for (const [signal, handler] of signalHandlers) process.on(signal, handler);

try {
  await runStep("fresh-path database migration", async () => {
    await runCommand(
      "database migration",
      join(HELM_PROJECT_ROOT, "scripts/database-command.mjs"),
      ["migrate"],
      environment,
    );
    verifyFreshDatabase(databasePath);
  });

  mkdirSync(join(HELM_PROJECT_ROOT, ".output"), { recursive: true });
  writeFileSync(
    join(HELM_PROJECT_ROOT, ".output", "helm-build.json"),
    '{"version":1,"fingerprint":"stale"}\n',
  );

  port = await reservePort();
  const origin = `http://127.0.0.1:${port}`;
  environment.PORT = String(port);

  await runStep("loopback-only production binding", async () => {
    await assertRemoteBindingRejected(environment, temporaryRoot);
  });

  await runStep("shell launcher and browser readiness", async () => {
    helmProcess = startHelm(environment, {
      cwd: temporaryRoot,
      label: "shell-launched production server",
      useShellLauncher: true,
    });
    const response = await waitForReady(helmProcess, origin);
    await verifyBrowserResponse(response);
    await assertLoopbackOnly(port);
  });

  await runStep("MCP initialize boundary", async () => {
    await initializeMcp(origin);
  });

  await runStep("shell-launched production shutdown", async () => {
    await stopHelmAndVerifyPort(helmProcess, port);
    helmProcess = undefined;
  });

  persistedProject = persistProjectPreferences(databasePath, repositoryRoots);

  await runStep("direct launcher restart and persistence", async () => {
    helmProcess = startHelm(environment, {
      cwd: temporaryRoot,
      label: "directly launched production server",
    });
    const response = await waitForReady(helmProcess, origin);
    const html = await verifyBrowserResponse(response);
    if (!html.includes('data-theme="dark"')) {
      throw new Error("The production restart did not restore persisted project preferences.");
    }
    if (productionBuildStatus() !== "current") {
      throw new Error("The production build manifest was not current after startup rebuilt it.");
    }
  });

  await runStep("MCP project persistence", async () => {
    await initializeMcp(origin, persistedProject);
  });

  await runStep("direct production shutdown", async () => {
    await stopHelmAndVerifyPort(helmProcess, port);
    helmProcess = undefined;
  });
} catch (error) {
  failure = error;
} finally {
  if (helmProcess) {
    try {
      await stopHelm(helmProcess, { allowAlreadyStopped: true });
      if (port) await waitForPortRelease(port);
    } catch (cleanupError) {
      failure = failure
        ? new AggregateError([failure, cleanupError], "Operational smoke and cleanup both failed.")
        : cleanupError;
    }
  }
  rmSync(temporaryRoot, { recursive: true, force: true });
  for (const [signal, handler] of signalHandlers) process.removeListener(signal, handler);
  if (interruptionSignal) {
    failure = new Error(`Operational smoke was interrupted by ${String(interruptionSignal)}.`, {
      cause: failure,
    });
  }
}

if (failure) {
  process.stderr.write(`Helm operational smoke test failed.\n${formatError(failure)}`);
  process.stderr.write(`${formatProcessLogs()}\n`);
  process.exitCode = 1;
} else {
  process.stdout.write("Helm operational smoke test passed.\n");
}
