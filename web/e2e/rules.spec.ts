import { expect, test } from "@playwright/test";

test.beforeEach(async ({ request }) => {
  for (const s of await (await request.get("/api/simulations")).json()) await request.delete(`/api/simulations/${s.id}`);
});

test("Hardcore: the picker warns, the clock has no pause and no tempo, and orders wait for the clock", async ({ page }) => {
  await page.goto("/");
  await page.getByRole("button", { name: "Neue Simulation" }).click();
  await page.getByLabel("Name").fill("Hart");
  await page.getByLabel("Datum").fill("2026-10-23");
  await page.getByLabel("Uhrzeit").fill("10:00");
  await page.getByRole("radio", { name: /Hardcore/ }).check();
  await expect(page.getByRole("note")).toContainText("Ohne Pause");
  await page.getByRole("button", { name: "Anlegen" }).click();
  await expect(page.getByTestId("sim-time")).toHaveText("23.10.2026, 10:00:00");
  await expect(page.getByTestId("rules-badge")).toHaveText("Hardcore");
  await expect(page.getByRole("group", { name: "Tempo" })).toHaveCount(0);
  await expect(page.getByTestId("tempo-locked")).toBeVisible();

  await page.getByLabel("Menge").fill("1");
  await page.getByRole("button", { name: "Kaufen" }).click();
  await expect(page.getByTestId("ticket-problem")).toContainText("nur bei laufender Uhr");

  await page.getByRole("button", { name: "Start" }).click();
  await expect(page.getByTestId("no-pause")).toBeVisible();
  await expect(page.getByRole("button", { name: "Pause" })).toHaveCount(0);
});

test("a simulation without a choice is Entspannt and keeps pause and tempo", async ({ page }) => {
  await page.goto("/");
  await page.getByRole("button", { name: "Neue Simulation" }).click();
  await page.getByLabel("Datum").fill("2026-10-23");
  await page.getByLabel("Uhrzeit").fill("10:00");
  await page.getByRole("button", { name: "Anlegen" }).click();
  await expect(page.getByTestId("rules-badge")).toHaveText("Entspannt");
  await expect(page.getByRole("group", { name: "Tempo" })).toBeVisible();
  await page.getByRole("button", { name: "Start" }).click();
  await expect(page.getByRole("button", { name: "Pause" })).toBeVisible();
});
