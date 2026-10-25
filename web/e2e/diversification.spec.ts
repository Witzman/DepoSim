import { expect, test } from "@playwright/test";

test.beforeEach(async ({ request }) => {
  for (const s of await (await request.get("/api/simulations")).json()) await request.delete(`/api/simulations/${s.id}`);
});

test("one position is a concentration of one and has nothing to mix", async ({ page }) => {
  await page.goto("/");
  await page.getByRole("button", { name: "Neue Simulation" }).click();
  await page.getByLabel("Name").fill("Streuung");
  await page.getByLabel("Datum").fill("2026-10-23");
  await page.getByLabel("Uhrzeit").fill("10:00");
  await page.getByRole("button", { name: "Anlegen" }).click();
  await expect(page.getByLabel("Menge")).toBeEnabled();
  await page.getByLabel("Menge").fill("1");
  await page.getByRole("button", { name: "Kaufen" }).click();
  await expect(page.getByTestId("position-SAP.DE")).toBeVisible();
  await page.getByRole("tab", { name: "Auswertung" }).click();
  await expect(page.getByTestId("effective-count")).toContainText("1,0");
  await expect(page.getByTestId("diversification-reason")).toContainText("nichts zu mischen");
});
