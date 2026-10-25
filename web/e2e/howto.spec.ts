import { expect, test, type Page } from "@playwright/test";

test.beforeEach(async ({ request }) => {
  for (const s of await (await request.get("/api/simulations")).json()) await request.delete(`/api/simulations/${s.id}`);
});

async function createSimulation(page: Page) {
  await page.goto("/");
  await page.getByRole("button", { name: "Neue Simulation" }).click();
  await page.getByLabel("Name").fill("Anleitung");
  await page.getByLabel("Datum").fill("2026-10-23");
  await page.getByLabel("Uhrzeit").fill("10:00");
  await page.getByRole("button", { name: "Anlegen" }).click();
  await expect(page.getByTestId("sim-time")).toHaveText("23.10.2026, 10:00:00");
}

test("the manual opens from the top bar in a running game, searches, and closes with Esc", async ({ page }) => {
  await createSimulation(page);
  await page.getByTestId("howto-open").click();
  const dialog = page.getByTestId("howto");
  await expect(dialog).toBeVisible();
  await expect(page.getByTestId("howto-example-market-buy")).toContainText("4.834,47");
  await page.getByTestId("howto-input").fill("Mindestgebühr");
  await expect(page.getByTestId("howto-orders")).toBeVisible();
  await expect(page.getByTestId("howto-chart")).toHaveCount(0);
  await page.keyboard.press("Escape");
  await expect(dialog).not.toBeVisible();
});

test("the manual keeps the clock running underneath", async ({ page }) => {
  await createSimulation(page);
  await page.getByRole("heading", { name: "Depot" }).first().click();
  await page.keyboard.press("4");
  await page.getByRole("button", { name: "Start" }).click();
  await expect(page.getByTestId("top-status")).toHaveText(/läuft/);
  await page.getByTestId("howto-open").click();
  await expect(page.getByTestId("howto")).toBeVisible();
  const before = await page.getByTestId("sim-time").textContent();
  await expect(page.getByTestId("sim-time")).not.toHaveText(before ?? "", { timeout: 15000 });
  await expect(page.getByTestId("top-status")).toHaveText(/läuft/);
});

test("the key H and the palette open it, and 'Mehr dazu' jumps to the chapter", async ({ page }) => {
  await createSimulation(page);
  await page.getByRole("heading", { name: "Depot" }).first().click();
  await page.keyboard.press("h");
  await expect(page.getByTestId("howto")).toBeVisible();
  await page.keyboard.press("Escape");
  await page.keyboard.press("Control+k");
  await page.getByTestId("palette-input").fill("anleitung");
  await page.getByRole("option", { name: /So wird gespielt/ }).click();
  await expect(page.getByTestId("howto")).toBeVisible();
  await page.keyboard.press("Escape");
  await page.getByTestId("more-orders").click();
  await expect(page.getByTestId("howto-orders")).toBeInViewport();
});

test("it is readable on a phone without sideways scrolling", async ({ page }) => {
  await page.setViewportSize({ width: 375, height: 700 });
  await page.goto("/");
  await page.getByTestId("howto-open").click();
  const box = page.getByTestId("howto");
  await expect(box).toBeVisible();
  expect(await box.evaluate((el) => el.scrollWidth <= el.clientWidth)).toBe(true);
});
