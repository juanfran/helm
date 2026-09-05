import assert from "node:assert/strict";
import { spawn } from "node:child_process";
import { randomUUID } from "node:crypto";
import { mkdirSync, mkdtempSync, rmSync } from "node:fs";
import { createServer } from "node:net";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { setTimeout as delay } from "node:timers/promises";

import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { StreamableHTTPClientTransport } from "@modelcontextprotocol/sdk/client/streamableHttp.js";
import { chromium, expect as playwrightExpect } from "@playwright/test";

import { HELM_PROJECT_ROOT } from "./environment.mjs";

const timeout = 20_000;
const expect = playwrightExpect.configure({ timeout });
const clients = [];
const browserErrors = [];
const requestedScripts = new Set();
const useServerProcessGroup = process.platform !== "win32";
const temporaryRoot = mkdtempSync(join(tmpdir(), "helm-workflow-smoke-"));
const repositoryRoot = join(temporaryRoot, "workflow-repository");
mkdirSync(join(repositoryRoot, ".git"), { recursive: true });
let server;
let browser;
let page;
let serverLog = "";
let interrupted;
let failure;

async function step(name, action) {
  if (interrupted) throw new Error(`Interrupted by ${interrupted}.`);
  process.stdout.write(`[helm-workflow] ${name}...\n`);
  await action();
  if (interrupted) throw new Error(`Interrupted by ${interrupted}.`);
  process.stdout.write(`[helm-workflow] ${name}: passed\n`);
}

function reservePort() {
  return new Promise((resolve, reject) => {
    const listener = createServer();
    listener.once("error", reject);
    listener.listen(0, "127.0.0.1", () => {
      const address = listener.address();
      assert(address && typeof address !== "string");
      listener.close((error) => (error ? reject(error) : resolve(address.port)));
    });
  });
}

async function waitForServer(origin) {
  const deadline = Date.now() + 90_000;
  while (Date.now() < deadline) {
    if (interrupted) throw new Error(`Interrupted by ${interrupted}.`);
    if (server.exitCode !== null || server.signalCode !== null) {
      throw new Error("Production server exited before becoming ready.");
    }
    try {
      // oxlint-disable-next-line no-await-in-loop
      const response = await fetch(origin, { signal: AbortSignal.timeout(2_000) });
      if (response.ok) return;
    } catch {
      // The production launcher may still be starting or rebuilding.
    }
    // oxlint-disable-next-line no-await-in-loop
    await delay(100);
  }
  throw new Error("Production server did not become ready within 90 seconds.");
}

async function call(client, name, arguments_ = {}) {
  const response = await client.callTool({ name, arguments: arguments_ }, undefined, { timeout });
  const result = response.structuredContent;
  assert(result, `${name} did not return structured content.`);
  assert(!response.isError && result.ok !== false, `${name}: ${JSON.stringify(result)}`);
  return result;
}

async function connectAgent(origin, suffix) {
  const client = new Client({ name: `helm-workflow-${suffix}`, version: "1.0.0" });
  const transport = new StreamableHTTPClientTransport(new URL(`${origin}/api/mcp`), {
    fetch: (url, init) =>
      fetch(url, {
        ...init,
        signal:
          init?.method === "DELETE"
            ? AbortSignal.any([...(init.signal ? [init.signal] : []), AbortSignal.timeout(5_000)])
            : init?.signal,
      }),
  });
  clients.push({ client, transport });
  await client.connect(transport, { timeout });
  const { registration } = await call(client, "register_agent_run", {
    profileKey: `workflow-${suffix}`,
    displayName: `Workflow agent ${suffix}`,
    capabilities: ["typescript"],
    idempotencyKey: randomUUID(),
  });
  return { client, registration };
}

function richText(text) {
  return {
    version: 1,
    doc: { type: "doc", content: [{ type: "paragraph", content: [{ type: "text", text }] }] },
  };
}

function signalOwnedServer(signal) {
  if (!server?.pid) return;
  try {
    // A detached group contains only this smoke's launcher and any build subprocesses it starts.
    if (useServerProcessGroup) process.kill(-server.pid, signal);
    else server.kill(signal);
  } catch (error) {
    if (error.code !== "ESRCH") throw error;
  }
}

function ownedServerIsRunning() {
  if (!server?.pid) return false;
  if (!useServerProcessGroup) return server.exitCode === null && server.signalCode === null;
  try {
    // Check the group even after its launcher exits: a rebuilding child can outlive its parent.
    process.kill(-server.pid, 0);
    return true;
  } catch (error) {
    if (error.code === "ESRCH") return false;
    throw error;
  }
}

async function waitForOwnedServerExit() {
  const deadline = Date.now() + 5_000;
  while (ownedServerIsRunning() && Date.now() < deadline) {
    // oxlint-disable-next-line no-await-in-loop
    await delay(50);
  }
  return !ownedServerIsRunning();
}

async function closeServer() {
  if (!ownedServerIsRunning()) return;
  signalOwnedServer("SIGTERM");
  if (await waitForOwnedServerExit()) return;
  signalOwnedServer("SIGKILL");
  if (!(await waitForOwnedServerExit())) {
    throw new Error("The owned production process group did not stop within its cleanup deadline.");
  }
  throw new Error("Production server required SIGKILL during workflow cleanup.");
}

const signalHandlers = new Map(
  ["SIGINT", "SIGTERM"].map((signal) => [
    signal,
    () => {
      interrupted = signal;
      try {
        signalOwnedServer("SIGTERM");
      } catch (error) {
        failure ??= error;
      }
      void browser?.close().catch((error) => {
        failure ??= error;
      });
    },
  ]),
);
for (const [signal, handler] of signalHandlers) process.on(signal, handler);

try {
  const port = await reservePort();
  const origin = `http://127.0.0.1:${port}`;
  await step("isolated production server and hydrated browser", async () => {
    server = spawn(process.execPath, [join(HELM_PROJECT_ROOT, "scripts/start.mjs")], {
      cwd: HELM_PROJECT_ROOT,
      detached: useServerProcessGroup,
      env: {
        ...process.env,
        DATABASE_URL: join(temporaryRoot, "data", "helm.db"),
        HOST: "127.0.0.1",
        PORT: String(port),
        HELM_UNSAFE_ALLOW_REMOTE: "0",
        NODE_ENV: "production",
      },
      stdio: ["ignore", "pipe", "pipe"],
    });
    server.once("error", (error) => {
      serverLog += `${error.stack}\n`;
    });
    for (const stream of [server.stdout, server.stderr]) {
      stream.on("data", (chunk) => {
        serverLog = `${serverLog}${chunk}`.slice(-40_000);
      });
    }
    await waitForServer(origin);
    serverLog = "";
    browser = await chromium.launch();
    page = await browser.newPage({ viewport: { width: 1440, height: 1000 } });
    page.setDefaultTimeout(timeout);
    page.on("request", (request) => {
      if (request.resourceType() === "script") requestedScripts.add(request.url());
    });
    page.on("pageerror", (error) => browserErrors.push(error.message));
    page.on("console", (message) => {
      if (message.type() === "error") browserErrors.push(message.text());
    });
    await page.goto(origin);
    await expect(
      page.getByRole("heading", { name: "Bring your repository aboard." }),
    ).toBeVisible();
  });

  const title = "Verify the human and agent workflow";
  const outcome = "A human can review evidence submitted by an agent.";
  let projectId;
  let taskId;
  let agent;
  let competitor;
  let grant;
  let eventCursor;

  await step("human project creation, capture, and preparation", async () => {
    await page.getByLabel("Repository root", { exact: true }).fill(repositoryRoot);
    await page.getByRole("button", { name: "Create project", exact: true }).click();
    await expect(page.getByRole("heading", { name: "Tasks", exact: true })).toBeVisible();
    await page.getByPlaceholder("Capture a task…").fill(title);
    await page.getByRole("button", { name: "Add backlog task" }).click();
    await page.getByRole("button", { name: `Open task #1: ${title}` }).click();
    await expect(page.getByRole("button", { name: "Edit description", exact: true })).toBeVisible();
    assert(
      ![...requestedScripts].some((url) => url.includes("rich-text-editor")),
      "The editor loaded before its interaction.",
    );
    await page.getByRole("button", { name: "Edit description", exact: true }).click();
    await page
      .locator('[contenteditable="true"][aria-label="Description"]')
      .fill("Prepared by a human in the rich-text editor.");
    await page.getByLabel("Expected outcome", { exact: true }).fill(outcome);
    await page
      .getByLabel("Acceptance criteria", { exact: true })
      .fill("Review retains the report and actor history.");
    await page
      .getByLabel("Checklist", { exact: true })
      .fill("Verify the completion report\nApprove and reopen the task");
    await page.getByLabel("Required capabilities", { exact: true }).fill("typescript");
    await page.getByRole("button", { name: "Move to ready", exact: true }).click();
    await expect(page.getByRole("button", { name: "Save preparation", exact: true })).toBeVisible();
    await expect(page.getByText("Live", { exact: true })).toBeVisible();
  });

  await step("interaction-only dashboard code and a visible lazy loading state", async () => {
    assert(
      ![...requestedScripts].some((url) => url.includes("operational-dashboard")),
      "The dashboard loaded before its interaction.",
    );
    let releaseDashboard;
    const holdDashboard = new Promise((resolve) => {
      releaseDashboard = resolve;
    });
    await page.route("**/assets/operational-dashboard-*.js", async (route) => {
      await holdDashboard;
      await route.continue();
    });
    try {
      await page.getByRole("button", { name: "Dashboard", exact: true }).click();
      await expect(page.getByLabel("Loading dashboard", { exact: true })).toBeVisible();
      releaseDashboard();
      await expect(page.getByRole("heading", { name: "What needs attention now" })).toBeVisible();
    } finally {
      releaseDashboard();
      await page.unrouteAll({ behavior: "wait" });
    }
    await page.getByRole("button", { name: "Tasks", exact: true }).click();
    await expect(page.getByRole("button", { name: "Save preparation", exact: true })).toBeVisible();
  });

  await step("MCP registration, discovery, and context", async () => {
    [agent, competitor] = await Promise.all([
      connectAgent(origin, "primary"),
      connectAgent(origin, "competing"),
    ]);
    const catalog = await call(agent.client, "list_projects");
    assert.equal(catalog.projects.length, 1);
    projectId = catalog.activeProjectId;
    assert.equal(catalog.projects[0].repositoryRoot, repositoryRoot);
    const { page: work } = await call(agent.client, "find_work", { projectId });
    assert.equal(work.candidates.length, 1);
    taskId = work.candidates[0].id;
    const { context } = await call(agent.client, "get_task_context", { projectId, taskId });
    assert.equal(context.task.expectedOutcome, outcome);
    assert.equal(context.task.descriptionText, "Prepared by a human in the rich-text editor.");
    assert.equal(context.task.lifecycle, "ready");
    assert.equal(context.paths.repositoryRoot, repositoryRoot);
    assert.equal(context.checklist.length, 2);
    const { payload } = await call(agent.client, "read_events", { projectId });
    eventCursor = payload.nextCursor;
  });

  await step("atomic competing claims, retry safety, and live claim visibility", async () => {
    const inputs = [
      { projectId, idempotencyKey: randomUUID() },
      { projectId, idempotencyKey: randomUUID() },
    ];
    const results = await Promise.all([
      agent.client.callTool({ name: "claim_next", arguments: inputs[0] }, undefined, { timeout }),
      competitor.client.callTool(
        {
          name: "claim_next",
          arguments: inputs[1],
        },
        undefined,
        { timeout },
      ),
    ]);
    assert.equal(results.filter((result) => result.structuredContent?.ok).length, 1);
    if (!results[0].structuredContent.ok) {
      [agent, competitor] = [competitor, agent];
      grant = results[1].structuredContent.grant;
    } else {
      grant = results[0].structuredContent.grant;
    }
    const winningIndex = results[0].structuredContent.ok ? 0 : 1;
    const losingResult = results[1 - winningIndex];
    assert.equal(losingResult.isError, true);
    assert.equal(losingResult.structuredContent.error.type, "TaskClaimUnavailableError");
    assert.deepEqual(losingResult.structuredContent.error.reasons, [
      "No task is currently eligible for this agent.",
    ]);
    const replay = await call(agent.client, "claim_next", inputs[winningIndex]);
    assert.deepEqual(replay.grant, grant);
    assert.equal(grant.task.id, taskId);
    assert.equal(grant.task.lifecycle, "in_progress");
    await expect(page.getByRole("region", { name: "Current claim" })).toContainText(
      agent.registration.profile.displayName,
    );
  });

  const progressText = "The end-to-end workflow is verified; preparing evidence for review.";
  const resultSummary = "The human and agent collaboration loop works through production adapters.";
  await step("agent progress, evidence, and live human review", async () => {
    const progress = await call(agent.client, "report_progress", {
      projectId,
      taskId,
      entryId: randomUUID(),
      content: richText(progressText),
      leaseToken: grant.leaseToken,
      expectedTaskVersion: grant.task.version,
      idempotencyKey: randomUUID(),
    });
    assert.equal(progress.payload.entry.author.id, agent.registration.run.id);
    const { context } = await call(agent.client, "get_task_context", { projectId, taskId });
    const { result } = await call(agent.client, "complete_task", {
      projectId,
      taskId,
      leaseToken: grant.leaseToken,
      expectedVersion: context.task.version,
      idempotencyKey: randomUUID(),
      report: {
        resultSummary,
        changedAreas: ["Workflow verification"],
        verificationResults: [
          {
            name: "Production UI and MCP",
            status: "passed",
            details: "Captured and claimed one prepared task.",
          },
        ],
        references: [],
        risks: [],
        followUpWork: [],
      },
    });
    assert.equal(result.task.lifecycle, "review");
    await expect(page.getByRole("region", { name: "Review actions" })).toBeVisible();
    await expect(page.getByText(resultSummary, { exact: true })).toBeVisible();
    await page
      .getByLabel("Approval summary", { exact: true })
      .fill("The evidence satisfies both acceptance criteria and checklist.");
    await page.getByRole("button", { name: "Approve", exact: true }).click();
    await expect(page.getByRole("form", { name: "Reopen completed task" })).toBeVisible();
    await page
      .getByLabel("Reopen reason", { exact: true })
      .fill("Exercise a follow-up without losing the original attempt.");
    await page.getByRole("button", { name: "Reopen", exact: true }).click();
    await expect(page.getByRole("button", { name: "Save preparation", exact: true })).toBeVisible();
  });

  await step("durable event replay and preserved attributed attempt history", async () => {
    const { context } = await call(agent.client, "get_task_context", { projectId, taskId });
    assert.equal(context.task.lifecycle, "ready");
    assert.equal(context.priorAttempts.length, 1);
    assert.equal(context.priorAttempts[0].summary, resultSummary);
    assert.equal(context.priorAttempts[0].agentRunId, agent.registration.run.id);
    assert(
      context.entries.some(
        (entry) =>
          entry.contentText === progressText && entry.author.id === agent.registration.run.id,
      ),
    );
    const { payload } = await call(agent.client, "read_events", {
      projectId,
      afterCursor: eventCursor,
    });
    assert(payload.events.length >= 5);
    assert(payload.events.every((event) => event.cursor > eventCursor));
    assert.equal(new Set(payload.events.map((event) => event.cursor)).size, payload.events.length);
    assert(payload.events.some((event) => event.actor.type === "human"));
    assert(
      payload.events.some(
        (event) => event.actor.type === "agent" && event.actor.id === agent.registration.run.id,
      ),
    );
    const replay = await call(agent.client, "read_events", { projectId, afterCursor: eventCursor });
    assert.deepEqual(replay.payload.events, payload.events);
    const tail = await call(agent.client, "read_events", {
      projectId,
      afterCursor: payload.nextCursor,
    });
    assert.equal(tail.payload.events.length, 0);
    await page.getByRole("button", { name: "Activity", exact: true }).click();
    await expect(page.getByText(/^task · reopened$/i).first()).toBeVisible();
  });

  await step("intent-preloaded search and direct saved-view navigation", async () => {
    const searchLink = page.getByRole("link", { name: "Search", exact: true });
    const preload = page.waitForResponse(
      (response) =>
        response.url().includes("/assets/") && response.url().includes("search") && response.ok(),
    );
    await searchLink.hover();
    await preload;
    assert.equal(new URL(page.url()).pathname, "/");
    await searchLink.click();
    await expect(
      page.getByRole("heading", { name: "Find the work behind the work." }),
    ).toBeVisible();
    await page.reload();
    await expect(page.getByRole("region", { name: "Task search results" })).toContainText(title);
    await page.getByLabel("Saved view name").fill("Workflow review queue");
    await page.getByRole("button", { name: "Save view", exact: true }).click();
    await expect(
      page.getByRole("heading", { name: "Workflow review queue", exact: true }),
    ).toBeVisible();
    assert.match(new URL(page.url()).pathname, /^\/views\//);
    await page.reload();
    await expect(
      page.getByRole("heading", { name: "Workflow review queue", exact: true }),
    ).toBeVisible();
    await expect(page.getByRole("region", { name: "Task search results" })).toContainText(title);
  });

  assert.deepEqual(browserErrors, [], "Unexpected browser console or hydration errors.");

  await step("visible slow route loading and recoverable request failure", async () => {
    const probe = await browser.newPage();
    probe.setDefaultTimeout(timeout);
    const errors = [];
    const consoleErrors = [];
    probe.on("pageerror", (error) => errors.push(error.message));
    probe.on("console", (message) => {
      if (message.type() === "error") consoleErrors.push(message.text());
    });
    let releaseRequests;
    const holdRequests = new Promise((resolve) => {
      releaseRequests = resolve;
    });
    let held = 0;
    await probe.route("**/_serverFn/**", async (route) => {
      held += 1;
      await holdRequests;
      await route.continue();
    });
    try {
      await probe.goto(`${origin}/search`);
      await expect.poll(() => held, { timeout }).toBeGreaterThan(0);
      await expect(
        probe.getByText("Loading this view…", { exact: true }).filter({ visible: true }).first(),
      ).toBeVisible({
        timeout,
      });
      releaseRequests();
      await expect(
        probe.getByRole("heading", { name: "Find the work behind the work." }),
      ).toBeVisible({ timeout });
      await probe.unrouteAll({ behavior: "wait" });
      assert.deepEqual(consoleErrors, [], "Slow route loading produced a browser error.");
      await probe.route("**/_serverFn/**", (route) =>
        route.fulfill({
          status: 503,
          contentType: "text/plain",
          body: "Injected workflow smoke failure",
        }),
      );
      await probe.reload();
      await expect(probe.getByRole("heading", { name: "Search could not be loaded" })).toBeVisible({
        timeout,
      });
      await probe.unrouteAll({ behavior: "wait" });
      await probe.getByRole("button", { name: "Try again", exact: true }).click();
      await expect(
        probe.getByRole("heading", { name: "Find the work behind the work." }),
      ).toBeVisible({ timeout });
      await expect(probe.getByRole("region", { name: "Task search results" })).toContainText(title);
      assert.deepEqual(errors, [], "The handled route failure caused an uncaught browser error.");
      assert.deepEqual(
        consoleErrors.filter(
          (message) =>
            !message.includes("503") && !message.includes("Injected workflow smoke failure"),
        ),
        [],
        "Route recovery produced an unexpected console or hydration error.",
      );
    } finally {
      releaseRequests();
      await probe.close();
    }
  });
} catch (error) {
  failure = error;
  if (page && !page.isClosed()) {
    process.stderr.write(
      `\nLast browser view (${String(page.url())}):\n${(
        await page
          .locator("body")
          .innerText()
          .catch(() => "unavailable")
      ).slice(-16_000)}\n`,
    );
  }
} finally {
  const cleanupResults = await Promise.allSettled([
    ...clients.map(async ({ client, transport }) => {
      try {
        if (transport.sessionId) await transport.terminateSession();
      } finally {
        await client.close();
      }
    }),
    browser?.close(),
  ]);
  try {
    await closeServer();
  } catch (error) {
    cleanupResults.push({ status: "rejected", reason: error });
  }
  for (const result of cleanupResults) {
    if (result.status === "rejected") failure ??= result.reason;
  }
  rmSync(temporaryRoot, { recursive: true, force: true });
  for (const [signal, handler] of signalHandlers) process.removeListener(signal, handler);
}

if (failure) {
  process.stderr.write(
    `Helm workflow smoke failed.\n${failure.stack ?? failure}\n\nProduction output:\n${serverLog}\n`,
  );
  process.exitCode = 1;
} else {
  process.stdout.write("Helm workflow smoke passed.\n");
}
