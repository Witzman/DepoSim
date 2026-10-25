import { expect, test } from "@playwright/test";

test.beforeEach(async ({ request }) => {
  for (const s of await (await request.get("/api/simulations")).json()) await request.delete(`/api/simulations/${s.id}`);
});

test("the rolling chapter fills with history: windows, months with numbers, falls and ranges, with the benchmark beside the depot", async ({ page, request }) => {
  await page.goto("/");
  await page.getByRole("button", { name: "Neue Simulation" }).click();
  await page.getByLabel("Name").fill("Verlauf");
  await page.getByTestId("by-day").check();
  await page.getByLabel("Datum").fill("2026-02-02");
  await page.getByRole("button", { name: "Anlegen" }).click();
  await expect(page.getByTestId("sim-time")).toHaveText("02.02.2026");
  const sim = (await (await request.get("/api/simulations")).json())[0];
  expect((await request.patch(`/api/simulations/${sim.id}`, { data: { benchmark: "EUNL.DE" } })).status()).toBe(200);

  await page.getByRole("tab", { name: "Auswertung" }).click();
  const panel = page.getByTestId("rolling");
  await expect(panel.getByTestId("rolling-empty")).toBeVisible(); // not a single day played: no window to show
  await expect(panel.getByTestId("window-10")).toBeDisabled();

  await page.getByRole("tab", { name: "Handel" }).click();
  await page.getByLabel("Menge").fill("20");
  await page.getByRole("button", { name: "Kaufen" }).click();
  await page.getByRole("button", { name: "60 T/s" }).click();
  await page.getByRole("button", { name: "Start" }).click();
  await expect(page.getByTestId("sim-time")).toHaveText("24.10.2026", { timeout: 20_000 });
  await page.getByRole("tab", { name: "Auswertung" }).click();

  await expect(panel.getByTestId("window-10")).toBeEnabled();
  await expect(panel.getByTestId("window-90")).toBeEnabled();
  await expect(panel.getByTestId("window-250")).toBeDisabled(); // about 180 trading days are not enough for 250
  await expect(panel.getByTestId("window-250")).toHaveAttribute("title", /reichen .* Tage nicht/);
  await expect(panel.locator("svg.rolling-svg").first()).toBeVisible();
  await expect(panel.locator("svg.rolling-svg").first()).toHaveAttribute("aria-label", /Volatilität über 90 Handelstage.*Maßstab EUNL\.DE/);
  await panel.getByRole("button", { name: "Sharpe" }).click();
  await expect(panel.locator("svg.rolling-svg").first()).toHaveAttribute("aria-label", /Sharpe über 90 Handelstage/);
  await panel.getByTestId("window-30").click();
  await expect(panel.locator("svg.rolling-svg").first()).toHaveAttribute("aria-label", /über 30 Handelstage/);

  // beta needs 60 days in common with the benchmark
  await expect(panel.getByText("Beta und Korrelation zum Maßstab (60 Tage)")).toBeVisible();
  await expect(panel.locator("svg.rolling-svg")).toHaveCount(2);

  const heat = panel.getByTestId("heat-depot");
  await expect(heat.getByRole("row", { name: /^2026/ })).toBeVisible();
  await expect(heat.getByRole("row", { name: /^2026/ }).getByRole("cell").filter({ hasText: "%" }).first()).toBeVisible(); // a number in the cell, not only a colour
  await expect(heat.getByRole("row", { name: /^2026/ }).getByRole("cell").first()).toHaveText("·"); // January was not played
  await expect(heat).toContainText("Bester Monat");
  await expect(panel.getByTestId("heat-benchmark")).toBeVisible();

  await expect(panel.getByTestId("ranges")).toContainText("Nach 20 Handelstagen im Plus:");
  await expect(panel.getByTestId("ranges")).toContainText("Nach 250 Handelstagen im Plus: noch zu wenig Fenster");
  await expect(panel).toContainText("keine Prognose");
});

test("without a benchmark only the depot is shown", async ({ page }) => {
  await page.goto("/");
  await page.getByRole("button", { name: "Neue Simulation" }).click();
  await page.getByLabel("Name").fill("Ohne");
  await page.getByTestId("by-day").check();
  await page.getByLabel("Datum").fill("2026-02-02");
  await page.getByRole("button", { name: "Anlegen" }).click();
  await page.getByRole("button", { name: "60 T/s" }).click();
  await page.getByRole("button", { name: "Start" }).click();
  await expect(page.getByTestId("sim-time")).toHaveText("24.10.2026", { timeout: 20_000 });
  await page.getByRole("tab", { name: "Auswertung" }).click();
  const panel = page.getByTestId("rolling");
  await expect(panel).toContainText("Ohne Maßstab gibt es keinen Vergleich");
  await expect(panel.getByTestId("heat-benchmark")).toHaveCount(0);
});
