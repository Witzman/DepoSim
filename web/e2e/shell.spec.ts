import { expect, test, type Page } from "@playwright/test";

async function createSimulation(page: Page, date = "2026-10-23") {
  await page.goto("/");
  await page.getByRole("button", { name: "Neue Simulation" }).click();
  await page.getByLabel("Name").fill("E2E");
  await page.getByLabel("Datum").fill(date);
  await page.getByLabel("Uhrzeit").fill("10:00");
  await page.getByRole("button", { name: "Anlegen" }).click();
}

test("a new simulation shows the chart and starts at the chosen time", async ({ page }) => {
  await createSimulation(page);
  await expect(page.getByTestId("chart").locator("canvas").first()).toBeVisible();
  await expect(page.getByTestId("sim-time")).toHaveText("23.10.2026, 10:00:00");
});

test("the clock runs after Start at tempo 60 and holds after Pause", async ({ page }) => {
  await createSimulation(page);
  const time = page.getByTestId("sim-time");
  await expect(time).toHaveText("23.10.2026, 10:00:00");
  await page.getByRole("button", { name: "60x" }).click();
  await page.getByRole("button", { name: "Start" }).click();
  await expect(time).not.toHaveText("23.10.2026, 10:00:00", { timeout: 3000 });
  await page.getByRole("button", { name: "Pause" }).click();
  await expect(page.getByRole("button", { name: "Start" })).toBeVisible();
  const held = await time.textContent();
  await page.waitForTimeout(1000);
  await expect(time).toHaveText(held!);
});

test("new candles arrive while the clock runs, and the history is shown from the start", async ({ page }) => {
  await createSimulation(page);
  const chart = page.getByTestId("chart");
  await expect(chart).toHaveAttribute("data-bars", /^[1-9]\d*$/); // SAP has traded since 09:00 Berlin
  const before = Number(await chart.getAttribute("data-bars"));
  await page.getByRole("button", { name: "60x" }).click();
  await page.getByRole("button", { name: "Start" }).click();
  await expect.poll(async () => Number(await chart.getAttribute("data-bars")), { timeout: 5000 }).toBeGreaterThan(before);
});

test("the theme switch changes the theme attribute and the page background", async ({ page }) => {
  await page.goto("/");
  const bg = () => page.evaluate(() => getComputedStyle(document.body).backgroundColor);
  const before = await bg();
  const attrBefore = await page.evaluate(() => document.documentElement.dataset.theme ?? "");
  await page.getByTestId("theme-toggle").click();
  const attrAfter = await page.evaluate(() => document.documentElement.dataset.theme ?? "");
  expect(attrAfter).not.toBe(attrBefore);
  expect(await bg()).not.toBe(before);
});

test("at 360 px wide nothing scrolls sideways", async ({ page }) => {
  await page.setViewportSize({ width: 360, height: 800 });
  await createSimulation(page);
  await expect(page.getByTestId("chart").locator("canvas").first()).toBeVisible();
  const overflow = await page.evaluate(() => document.documentElement.scrollWidth - window.innerWidth);
  expect(overflow).toBeLessThanOrEqual(0);
});

test("a day with no trading is explained in words, and nothing is created", async ({ page }) => {
  await createSimulation(page, "2026-10-24"); // a Saturday
  await expect(page.getByRole("alert")).toContainText("keine Kurse");
  await expect(page.getByTestId("sim-time")).toHaveCount(0);
});
