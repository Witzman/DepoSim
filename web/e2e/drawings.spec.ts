import { expect, test, type Page } from "@playwright/test";

test.beforeEach(async ({ request }) => {
  for (const s of await (await request.get("/api/simulations")).json()) await request.delete(`/api/simulations/${s.id}`);
});

async function createSimulation(page: Page) {
  await page.goto("/");
  await page.getByRole("button", { name: "Neue Simulation" }).click();
  await page.getByLabel("Name").fill("Zeichnen");
  await page.getByLabel("Datum").fill("2026-10-23");
  await page.getByLabel("Uhrzeit").fill("11:00");
  await page.getByRole("button", { name: "Anlegen" }).click();
  await expect(page.getByTestId("sim-time")).toHaveText("23.10.2026, 11:00:00");
  await expect(page.getByTestId("chart")).not.toHaveAttribute("data-bars", "0");
}

/** Click at a fraction of the chart host's box. */
async function clickChart(page: Page, fx: number, fy: number) {
  const box = (await page.getByTestId("chart").boundingBox())!;
  await page.mouse.click(box.x + box.width * fx, box.y + box.height * fy);
}

const drawings = (page: Page) => page.getByTestId("chart");

test("a horizontal line is placed with one click, survives a reload and is cleared with Alle löschen", async ({ page }) => {
  await createSimulation(page);
  await expect(drawings(page)).toHaveAttribute("data-drawings", "0");
  const tool = page.getByRole("button", { name: "Waagerechte Linie" });
  await tool.click();
  await expect(tool).toHaveAttribute("aria-pressed", "true");
  await clickChart(page, 0.5, 0.3);
  await expect(drawings(page)).toHaveAttribute("data-drawings", "1");
  await expect(tool).toHaveAttribute("aria-pressed", "false");

  await page.reload();
  await expect(drawings(page)).toHaveAttribute("data-drawings", "1");

  await page.getByRole("button", { name: "Alle löschen" }).click();
  await expect(drawings(page)).toHaveAttribute("data-drawings", "0");
  await page.reload();
  await expect(drawings(page)).toHaveAttribute("data-drawings", "0");
});

test("a trend line needs two clicks and Esc after the first leaves nothing", async ({ page }) => {
  await createSimulation(page);
  const tool = page.getByRole("button", { name: "Trendlinie" });
  await tool.click();
  await clickChart(page, 0.55, 0.4);
  await expect(drawings(page)).toHaveAttribute("data-drawings", "0");
  await page.keyboard.press("Escape");
  await expect(tool).toHaveAttribute("aria-pressed", "false");
  await clickChart(page, 0.8, 0.3);
  await expect(drawings(page)).toHaveAttribute("data-drawings", "0");

  await tool.click();
  await clickChart(page, 0.55, 0.4);
  await page.waitForTimeout(700); // lightweight-charts swallows a second click within ~500 ms
  await clickChart(page, 0.8, 0.3);
  await expect(drawings(page)).toHaveAttribute("data-drawings", "1");
});

test("a marker takes its text from an inline field, no browser prompt", async ({ page }) => {
  page.on("dialog", () => { throw new Error("window.prompt must not be used"); });
  await createSimulation(page);
  await page.getByRole("button", { name: "Markierung" }).click();
  await clickChart(page, 0.5, 0.5);
  await expect(drawings(page)).toHaveAttribute("data-drawings", "0");
  await page.getByLabel("Text der Markierung").fill("Einstieg");
  await page.keyboard.press("Enter");
  await expect(drawings(page)).toHaveAttribute("data-drawings", "1");
  await page.reload();
  await expect(drawings(page)).toHaveAttribute("data-drawings", "1");
});

test("Löschen removes the drawing near the click, and drawings stay with their symbol", async ({ page }) => {
  await createSimulation(page);
  await page.getByRole("button", { name: "Waagerechte Linie" }).click();
  await clickChart(page, 0.5, 0.3);
  await expect(drawings(page)).toHaveAttribute("data-drawings", "1");

  // Another symbol has its own drawings.
  await page.getByLabel("Wertpapier").selectOption("SIE.DE");
  await expect(drawings(page)).toHaveAttribute("data-drawings", "0");
  await page.getByLabel("Wertpapier").selectOption("SAP.DE");
  await expect(drawings(page)).toHaveAttribute("data-drawings", "1");

  const del = page.getByRole("group", { name: "Zeichenwerkzeuge" }).getByRole("button", { name: "Löschen", exact: true });
  await del.click();
  await expect(del).toHaveAttribute("aria-pressed", "true");
  // The line moved with the autoscale since it was placed, so sweep down the chart until it is hit
  // (a click that misses by more than a few pixels removes nothing, see the unit tests).
  for (let fy = 0.08; fy < 0.95; fy += 0.025) {
    await clickChart(page, 0.5, fy);
    if ((await drawings(page).getAttribute("data-drawings")) === "0") break;
  }
  await expect(drawings(page)).toHaveAttribute("data-drawings", "0");
});
