import { expect, test } from "@playwright/test";

test.beforeEach(async ({ request }) => {
  for (const s of await (await request.get("/api/simulations")).json()) await request.delete(`/api/simulations/${s.id}`);
});

test("a scenario is picked as a card, shows its goals, ends at its end date and shows the result with stars", async ({ page }) => {
  await page.goto("/");
  await page.getByRole("button", { name: "Neue Simulation" }).click();
  await expect(page.getByTestId("scenario-picker")).toBeVisible();
  await expect(page.getByTestId("scenario-corona-crash-2020")).toBeVisible();
  await expect(page.getByTestId("scenario-zinswende-2022")).toBeVisible();

  await page.getByTestId("scenario-rallye-2023").getByRole("radio").check();
  await expect(page.getByTestId("scenario-rallye-2023")).toContainText("Erziele mindestens 5 Prozent Gewinn");
  await expect(page.getByTestId("by-day")).toHaveCount(0); // the scenario sets time, capital and rules itself
  await page.getByRole("button", { name: "Anlegen" }).click();

  await expect(page.getByTestId("sim-time")).toHaveText("02.01.2023");
  const goals = page.getByTestId("scenario-goals");
  await expect(goals).toContainText("Rallye 2023");
  await expect(goals.getByTestId("goal-list").locator("li")).toHaveCount(3);
  await expect(goals).toContainText("Zwischenstand");

  await page.getByRole("button", { name: "60 T/s" }).click();
  await page.getByRole("button", { name: "Start" }).click();

  const result = page.getByTestId("run-card");
  await expect(result).toBeVisible({ timeout: 20_000 });
  await expect(result.getByTestId("result-stars")).toHaveAttribute("aria-label", "0 von 3 Sternen"); // no trade, the main goal is missed
  await expect(result.getByTestId("goal-list").locator("li")).toHaveCount(3);
  await expect(result.getByTestId("run-grade")).toHaveAttribute("aria-label", "Ohne Note"); // no trade, no grade
  await result.getByRole("button", { name: "Schließen" }).click();
  await expect(result).toBeHidden();

  await expect(page.getByTestId("top-status")).toContainText("beendet");
  await expect(page.getByTestId("sim-time")).toHaveText("01.07.2023");
  await expect(goals).not.toContainText("Zwischenstand");
  await goals.getByRole("button", { name: "Ergebnis" }).click();
  await expect(result).toBeVisible();
});

test("a scenario that is not known is turned away and the free game is still there", async ({ page, request }) => {
  const r = await request.post("/api/simulations", { data: { name: "x", scenarioId: "gibt-es-nicht" } });
  expect(r.status()).toBe(400);
  await page.goto("/");
  await page.getByRole("button", { name: "Neue Simulation" }).click();
  await expect(page.getByRole("radio", { name: /Freies Spiel/ })).toBeChecked();
  await expect(page.getByTestId("by-day")).toBeVisible();
});
