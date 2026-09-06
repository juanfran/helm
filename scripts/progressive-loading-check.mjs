import assert from "node:assert/strict";
import { expect } from "@playwright/test";

function findInputKeys(node) {
  if (!node || typeof node !== "object") return undefined;
  if (Array.isArray(node.k) && node.k.includes("projectId")) return node.k;
  for (const child of Object.values(node)) {
    const result = findInputKeys(child);
    if (result) return result;
  }
  return undefined;
}

function inputKeys(request) {
  const payload = new URL(request.url()).searchParams.get("payload");
  if (!payload) return [];
  // Inspect field names, not generated server-function IDs (which change on every build).
  return findInputKeys(JSON.parse(payload)) ?? [];
}

export async function verifyProgressiveLoading({
  browser,
  origin,
  projectId,
  taskId,
  title,
  addComment,
}) {
  const page = await browser.newPage();
  let release;
  const held = new Promise((resolve) => {
    release = resolve;
  });
  let captured = false;
  let first = true;
  const requests = [];
  page.on("request", (request) => {
    if (request.url().includes("/_serverFn/")) requests.push(inputKeys(request));
  });
  await page.route("**/_serverFn/**", async (route) => {
    const keys = inputKeys(route.request());
    if (first && keys.length === 2 && keys.includes("projectId") && keys.includes("limit")) {
      first = false;
      const response = await route.fetch();
      captured = true;
      // The database read has finished. Delivery is held to simulate an old snapshot in flight.
      await held;
      await route.fulfill({ response });
    } else await route.continue();
  });
  try {
    await page.goto(`${origin}/${projectId}/tasks/${taskId}`);
    await expect.poll(() => captured).toBe(true);
    await expect(page.getByLabel("Expected outcome", { exact: true })).toBeVisible();
    await page.getByRole("button", { name: "Open collaboration", exact: true }).click();
    await expect(page.getByText("Loading collaboration…", { exact: true })).toBeVisible();
    await expect(page.getByRole("button", { name: "Save changes", exact: true })).toBeEnabled();

    const projectedTask = page.waitForResponse((response) => {
      const keys = inputKeys(response.request());
      return keys.includes("taskIds") && keys.includes("includeArchived") && response.ok();
    });
    const comment = "Agent update received while collaboration was loading.";
    await addComment(comment);
    await (await projectedTask).finished();
    release();
    await expect(page.getByText(comment, { exact: true })).toHaveCount(1);
    await page.unrouteAll({ behavior: "wait" });

    const before = requests.length;
    const started = performance.now();
    await page
      .getByRole("navigation", { name: "Project navigation" })
      .getByRole("link", { name: "Tasks", exact: true })
      .click();
    await expect(page.getByRole("heading", { name: "Tasks", exact: true })).toBeVisible();
    await page.getByRole("link", { name: `Open task #1: ${title}` }).click();
    await expect(page.getByLabel("Expected outcome", { exact: true })).toBeVisible();
    assert.deepEqual(requests.slice(before), [], "Warm task navigation refetched workspace data.");
    process.stdout.write(
      `[helm-workflow] warm task round trip: ${Math.round(performance.now() - started)} ms, zero RPCs\n`,
    );
  } finally {
    release();
    await page.unrouteAll({ behavior: "wait" });
    await page.close();
  }
}
