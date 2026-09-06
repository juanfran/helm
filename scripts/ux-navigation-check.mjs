import assert from "node:assert/strict";
import { expect } from "@playwright/test";

export async function verifyStableProjectHeader(page) {
  const header = page.getByRole("banner", { name: "Project header" });
  const originalHeader = await header.elementHandle();
  const appearance = await header.getByLabel("Appearance", { exact: true }).elementHandle();
  assert(originalHeader && appearance);
  for (const label of ["Dashboard", "Activity", "Settings", "Search", "Tasks"]) {
    // oxlint-disable-next-line no-await-in-loop -- One browser exercises successive route changes.
    await page
      .getByRole("navigation", { name: "Project navigation" })
      .getByRole("link", { name: label, exact: true })
      .click();
    // oxlint-disable-next-line no-await-in-loop
    await expect(header.getByRole("link", { name: label, exact: true })).toHaveAttribute(
      "aria-current",
      "page",
    );
    // oxlint-disable-next-line no-await-in-loop
    assert(
      // oxlint-disable-next-line no-await-in-loop
      await originalHeader.evaluate((element) => element.isConnected),
      `Header remounted on ${label}.`,
    );
    // oxlint-disable-next-line no-await-in-loop
    assert(
      // oxlint-disable-next-line no-await-in-loop
      await appearance.evaluate((element) => element.isConnected),
      `Appearance reset on ${label}.`,
    );
    // oxlint-disable-next-line no-await-in-loop
    await expect(header).toHaveCount(1);
  }
  await page.getByRole("heading", { name: "Tasks", exact: true }).waitFor();
}

export async function verifyTaskChrome(page) {
  const capture = await page.getByRole("form", { name: "Quick capture" }).boundingBox();
  const bulk = await page.getByRole("button", { name: "Bulk actions", exact: true }).boundingBox();
  assert(
    capture && bulk && bulk.y - (capture.y + capture.height) >= 12,
    "Bulk actions touches quick capture.",
  );

  const counts = page.getByRole("region", { name: "Task counts" });
  const backlog = counts.getByRole("link", { name: /backlog/ });
  await backlog.click();
  await expect(backlog).toHaveAttribute("aria-current", /true|page/);
  await page.mouse.move(900, 900);
  const active = await backlog.evaluate((element) => ({
    background: getComputedStyle(element).backgroundColor,
    color: getComputedStyle(element).color,
  }));
  const inactive = await counts
    .getByRole("link", { name: "All", exact: true })
    .evaluate((element) => ({
      background: getComputedStyle(element).backgroundColor,
      color: getComputedStyle(element).color,
    }));
  assert.notDeepEqual(active, inactive, "The selected queue filter has no visible state.");
  await counts.getByRole("link", { name: "All", exact: true }).click();
  const row = page.getByRole("list", { name: "Tasks", exact: true }).locator("li").first();
  await row.getByRole("link").hover();
  const hover = await row.evaluate((element) => ({
    background: getComputedStyle(element).backgroundColor,
    radius: getComputedStyle(element).borderTopRightRadius,
    childBackground: getComputedStyle(element.querySelector("a")).backgroundColor,
  }));
  assert.notEqual(
    hover.background,
    "rgba(0, 0, 0, 0)",
    "Hover must paint the whole row, including its gutter.",
  );
  assert.notEqual(hover.radius, "0px");
  assert.equal(
    hover.childBackground,
    "rgba(0, 0, 0, 0)",
    "An inner hover background masks the row corners.",
  );

  const header = page.getByRole("banner", { name: "Project header" });
  const notifications = await header.getByRole("button", { name: /Notifications/ }).boundingBox();
  const appearance = await header.getByLabel("Appearance", { exact: true }).boundingBox();
  assert(notifications && appearance);
  assert(
    Math.abs(notifications.y + notifications.height / 2 - appearance.y - appearance.height / 2) <=
      1,
    "Appearance and notifications are not vertically aligned.",
  );
  assert.equal(appearance.height, notifications.height, "Header control heights differ.");
}

export async function verifyPolicyAlignment(page) {
  const card = page.getByRole("region", { name: "Effective review policy" });
  await expect(card).toBeVisible();
  const layout = await card.evaluate((element) => {
    const label = element.querySelector("div").getBoundingClientRect();
    const explanation = element.querySelector(":scope > p");
    const box = explanation.getBoundingClientRect();
    return {
      label: label.toJSON(),
      explanation: box.toJSON(),
      margin: getComputedStyle(explanation).margin,
    };
  });
  assert.equal(layout.margin, "0px", "The policy explanation retains paragraph margins.");
  if (page.viewportSize().width > 560) {
    assert(
      Math.abs(
        layout.label.y +
          layout.label.height / 2 -
          layout.explanation.y -
          layout.explanation.height / 2,
      ) <= 1,
      "Review-policy columns are misaligned.",
    );
  } else {
    assert(
      layout.explanation.y >= layout.label.bottom,
      "Narrow policy text must stack below its label.",
    );
  }
}
