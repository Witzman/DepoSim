import { expect, test, type Page } from "@playwright/test";

test.beforeEach(async ({ request }) => {
  for (const s of await (await request.get("/api/simulations")).json()) await request.delete(`/api/simulations/${s.id}`);
});

async function createSimulation(page: Page) {
  await page.goto("/");
  await page.getByRole("button", { name: "Neue Simulation" }).click();
  await page.getByLabel("Name").fill("Auswertung");
  await page.getByLabel("Datum").fill("2026-10-23");
  await page.getByLabel("Uhrzeit").fill("10:00");
  await page.getByRole("button", { name: "Anlegen" }).click();
  await expect(page.getByTestId("sim-time")).toHaveText("23.10.2026, 10:00:00");
  await expect(page.getByLabel("Menge")).toBeEnabled();
}

test("a fresh simulation shows dashes with the reason, not invented figures", async ({ page }) => {
  await createSimulation(page);
  await page.getByRole("tab", { name: "Auswertung" }).click();
  await expect(page.getByTestId("metrics").locator("tbody tr").first()).toContainText("—");
  await expect(page.getByTestId("metrics-note")).toContainText("zu wenige Werte");
});

test("fees, distribution and the benchmark follow the trades of two depots", async ({ page }) => {
  await createSimulation(page);
  await page.getByLabel("Menge").fill("1");
  await expect(page.getByTestId("cost-total")).toBeVisible();
  await page.getByRole("button", { name: "Kaufen" }).click();
  await expect(page.getByTestId("position-SAP.DE")).toBeVisible();
  await page.getByRole("button", { name: "+ Depot" }).click();

  await page.getByRole("tab", { name: "Auswertung" }).click();
  const metrics = page.getByTestId("metrics");
  await expect(metrics).toContainText("Depot 1");
  await expect(metrics).toContainText("Depot 2");
  await expect(page.getByTestId("correlation")).toBeVisible();

  const fees = page.getByTestId("fees");
  await expect(fees.getByRole("row").nth(1)).toContainText("4,90"); // depot 1 paid the minimum commission
  await expect(fees.getByRole("row").nth(2)).toContainText("0,00");

  // Depot 2 is the open one: only cash.
  await expect(page.getByTestId("dist-Sektor")).toContainText("Guthaben");
  await page.getByRole("tab", { name: "Depot 1" }).click();
  await expect(page.getByTestId("dist-Sektor")).toContainText("Technology");
  await expect(page.getByTestId("dist-Handelsland")).toContainText("Deutschland");
  await expect(page.getByTestId("dist-Währung")).toContainText("EUR");

  await expect(page.getByTestId("curves")).toHaveAttribute("data-series", "2");
  await page.getByLabel("Maßstab", { exact: true }).selectOption("EUNL.DE");
  await expect(page.getByTestId("curves")).toHaveAttribute("data-series", "3");
  await expect(page.getByTestId("legend-benchmark")).toContainText("EUNL.DE");
  await expect(page.getByTestId("metrics-bench")).toBeVisible();
  await page.getByLabel("Maßstab", { exact: true }).selectOption("");
  await expect(page.getByTestId("curves")).toHaveAttribute("data-series", "2");
});
