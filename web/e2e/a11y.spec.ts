import { expect, test } from "@playwright/test";

test.beforeEach(async ({ request }) => {
  for (const s of await (await request.get("/api/simulations")).json()) await request.delete(`/api/simulations/${s.id}`);
});

test("the view tabs point at their panel and move with the arrow keys; an invalid indicator value is explained", async ({ page }) => {
  await page.goto("/");
  await page.getByRole("button", { name: "Neue Simulation" }).click();
  await page.getByLabel("Name").fill("Tasten");
  await page.getByTestId("by-day").check();
  await page.getByLabel("Datum").fill("2026-03-02");
  await page.getByRole("button", { name: "Anlegen" }).click();
  await expect(page.getByTestId("sim-time")).toHaveText("02.03.2026");

  const panel = page.getByRole("tabpanel").first();
  await expect(panel).toHaveAttribute("id", "view-panel");
  const trade = page.getByRole("tab", { name: "Handel" });
  const eval_ = page.getByRole("tab", { name: "Auswertung" });
  await expect(trade).toHaveAttribute("aria-controls", "view-panel");
  await expect(trade).toHaveAttribute("tabindex", "0");
  await expect(eval_).toHaveAttribute("tabindex", "-1");

  await trade.focus();
  await page.keyboard.press("ArrowRight");
  await expect(eval_).toHaveAttribute("aria-selected", "true");
  await expect(eval_).toBeFocused();
  await expect(panel).toHaveAttribute("aria-labelledby", "tab-evaluation");
  await page.keyboard.press("End");
  await expect(page.getByRole("tab", { name: "Daten" })).toHaveAttribute("aria-selected", "true");
  await page.keyboard.press("Home");
  await expect(trade).toHaveAttribute("aria-selected", "true");

  await page.getByText("Indikatoren").click();
  const period = page.getByLabel("SMA Periode");
  await period.fill("0");
  await expect(page.getByTestId("ind-problem")).toContainText("SMA Periode");
  await period.fill("30");
  await expect(page.getByTestId("ind-problem")).toHaveCount(0);
});
