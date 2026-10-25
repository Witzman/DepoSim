import { expect, test } from "@playwright/test";

test.beforeEach(async ({ request }) => {
  for (const s of await (await request.get("/api/simulations")).json()) await request.delete(`/api/simulations/${s.id}`);
});

async function dayGame(page: import("@playwright/test").Page, name: string, play: boolean) {
  await page.goto("/");
  await page.getByRole("button", { name: "Neue Simulation" }).click();
  await page.getByLabel("Name").fill(name);
  await page.getByTestId("by-day").check();
  await page.getByLabel("Datum").fill("2026-02-02");
  await page.getByRole("button", { name: "Anlegen" }).click();
  await expect(page.getByTestId("sim-time")).toHaveText("02.02.2026");
  if (play) {
    await page.getByLabel("Menge").fill("20");
    await page.getByRole("button", { name: "Kaufen" }).click();
    await page.getByRole("button", { name: "60 T/s" }).click();
    await page.getByRole("button", { name: "Start" }).click();
    await expect(page.getByTestId("sim-time")).toHaveText("24.10.2026", { timeout: 20_000 });
  }
  await page.getByRole("tab", { name: "Auswertung" }).click();
}

test("without history the outlook gives no numbers, only the reason, and the warning stays", async ({ page }) => {
  await dayGame(page, "Neu", false);
  const panel = page.getByTestId("outlook");
  await expect(panel.getByTestId("outlook-refused")).toContainText("Zu wenig Historie");
  await expect(panel.getByTestId("outlook-fan")).toHaveCount(0);
  await expect(panel.getByTestId("outlook-warning")).toContainText("keine Prognose");
});

test("with history: fan, percentiles, shares; the same seed gives the same numbers, another seed other ones", async ({ page }) => {
  await dayGame(page, "Lang", true);
  const panel = page.getByTestId("outlook");
  await expect(panel.getByTestId("outlook-fan")).toBeVisible();
  await expect(panel.getByTestId("outlook-fan")).toHaveAttribute("aria-label", /Simulation über 1 Jahr: Median/);
  await expect(panel.getByTestId("outlook-table").getByRole("row")).toHaveCount(8); // head and seven percentiles
  await expect(panel.getByTestId("outlook-meta")).toContainText("5.000 Pfade");
  await expect(panel.getByTestId("outlook-meta")).toContainText("Seed 42");
  await expect(panel.getByTestId("outlook-warning")).toBeVisible();
  const cells = panel.getByTestId("outlook-table").getByRole("cell");
  const first = await cells.allInnerTexts();

  await panel.getByTestId("horizon-5").click();
  await expect(panel.getByTestId("outlook-fan")).toHaveAttribute("aria-label", /über 5 Jahre/);
  await panel.getByTestId("horizon-1").click();
  await expect(cells).toHaveText(first); // same seed, same table

  await panel.getByTestId("outlook-seed").fill("7");
  await expect(panel.getByTestId("outlook-meta")).toContainText("Seed 7");
  await expect.poll(async () => (await cells.allInnerTexts()).join("|")).not.toBe(first.join("|"));

  await panel.getByTestId("outlook-goal").fill("1000000");
  await expect(panel.getByTestId("p-goal")).toBeVisible();
  await panel.getByTestId("outlook-save").fill("500");
  await expect(panel.getByTestId("outlook-probs")).toContainText("Eingezahlt (netto)");
});
