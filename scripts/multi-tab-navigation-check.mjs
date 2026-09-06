import { expect } from "@playwright/test";

/** Tabs share Chrome's HTTP/1 connection pool; separate browser contexts do not. */
export async function verifyMultiTabNavigation(browser, origin, projectId) {
  const context = await browser.newContext();
  const pages = [];
  try {
    for (let index = 0; index < 6; index++) {
      // oxlint-disable-next-line no-await-in-loop -- Each extra tab must join already-live tabs.
      const page = await context.newPage();
      pages.push(page);
      // oxlint-disable-next-line no-await-in-loop
      await page.goto(`${origin}/${projectId}/search`);
      // oxlint-disable-next-line no-await-in-loop
      await expect(page.getByRole("heading", { name: "Search tasks" })).toBeVisible({
        timeout: 10_000,
      });
    }
    for (const page of pages) {
      // oxlint-disable-next-line no-await-in-loop
      await page
        .getByRole("navigation", { name: "Project navigation" })
        .getByRole("link", { name: "Settings", exact: true })
        .click();
      // oxlint-disable-next-line no-await-in-loop
      await expect(
        page.getByRole("heading", { name: "Project customization", exact: true }),
      ).toBeVisible({ timeout: 10_000 });
      // oxlint-disable-next-line no-await-in-loop
      await page
        .getByRole("navigation", { name: "Project navigation" })
        .getByRole("link", { name: "Tasks", exact: true })
        .click();
      // oxlint-disable-next-line no-await-in-loop
      await expect(page.getByRole("heading", { name: "Tasks", exact: true })).toBeVisible({
        timeout: 10_000,
      });
    }
    await pages[0].close();
    await pages[1].reload();
    await expect(pages[1].getByRole("heading", { name: "Tasks", exact: true })).toBeVisible({
      timeout: 10_000,
    });
  } finally {
    await context.close();
  }
}
