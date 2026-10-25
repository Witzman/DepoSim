import { expect, test } from "@playwright/test";

test.beforeEach(async ({ request }) => {
  for (const s of await (await request.get("/api/simulations")).json()) await request.delete(`/api/simulations/${s.id}`);
});

test("a daily simulation is made from a date, steps by days, trades at the next open and shows day candles only", async ({ page }) => {
  await page.goto("/");
  await page.getByRole("button", { name: "Neue Simulation" }).click();
  await page.getByLabel("Name").fill("Tage");
  await page.getByTestId("by-day").check();
  await expect(page.getByLabel(/Uhrzeit/)).toBeDisabled();
  await page.getByLabel("Datum").fill("2026-09-01");
  await page.getByRole("button", { name: "Anlegen" }).click();

  await expect(page.getByTestId("sim-time")).toHaveText("01.09.2026");
  await expect(page.getByTestId("daily-note")).toBeVisible();
  await expect(page.getByTestId("tf-1d")).toBeVisible();
  await expect(page.getByTestId("tf-1m")).toHaveCount(0);
  await expect(page.getByRole("button", { name: "1 T/s" })).toBeVisible();

  await page.getByLabel("Menge").fill("1");
  await page.getByRole("button", { name: "Kaufen" }).click();
  await expect(page.getByTestId("position-SAP.DE")).toHaveCount(0); // a market order waits for the next open
  await page.getByTestId("day-step").click();
  await expect(page.getByTestId("sim-time")).not.toHaveText("01.09.2026");
  await expect(page.getByTestId("position-SAP.DE")).toBeVisible();
});
