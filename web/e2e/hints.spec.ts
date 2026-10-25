import { expect, test } from "@playwright/test";

test.beforeEach(async ({ request }) => {
  for (const s of await (await request.get("/api/simulations")).json()) await request.delete(`/api/simulations/${s.id}`);
});

async function simulation(page: import("@playwright/test").Page) {
  await page.goto("/");
  await page.getByRole("button", { name: "Neue Simulation" }).click();
  await page.getByLabel("Name").fill("Hinweise");
  await page.getByLabel("Datum").fill("2026-10-23");
  await page.getByLabel("Uhrzeit").fill("10:00");
  await page.getByRole("button", { name: "Anlegen" }).click();
  await expect(page.getByLabel("Menge")).toBeEnabled();
}

test("the ticket warns before a big buy, the clump hint appears after it, can be hidden and brought back", async ({ page }) => {
  await simulation(page);
  await page.getByLabel("Menge").fill("60");
  await expect(page.getByTestId("ticket-note").first()).toContainText("wäre SAP.DE");
  await page.getByRole("button", { name: "Kaufen" }).click();
  await expect(page.getByTestId("position-SAP.DE")).toBeVisible();

  const hint = page.getByTestId("hint-rule-largest");
  await expect(hint).toContainText("SAP.DE ist");
  await expect(page.getByTestId("hints-count")).toBeVisible();

  await hint.getByRole("button", { name: "Warum?" }).click();
  await expect(page.getByTestId("glossary")).toBeVisible();
  await page.keyboard.press("Escape");

  await hint.getByRole("button", { name: "Ausblenden" }).click();
  await expect(hint).toHaveCount(0);

  await page.getByTestId("hints-open").click();
  await expect(page.getByTestId("hints-settings")).toBeVisible();
  await page.getByTestId("rule-largest").getByRole("button", { name: "Wieder einblenden" }).click();
  await page.keyboard.press("Escape");
  await expect(page.getByTestId("hint-rule-largest")).toBeVisible();
});

test("with every rule off the card disappears", async ({ page, request }) => {
  await simulation(page);
  await page.getByLabel("Menge").fill("60");
  await page.getByRole("button", { name: "Kaufen" }).click();
  await expect(page.getByTestId("hints")).toBeVisible();
  const id = (await (await request.get("/api/simulations")).json())[0].id;
  for (const rule of ["largest", "top3", "sector", "usd", "cashLow", "cashHigh", "fees", "drawdown", "losingStreak", "data"]) {
    await request.put(`/api/simulations/${id}/hints/${rule}`, { data: { enabled: false } });
  }
  await page.reload();
  await expect(page.getByTestId("hints")).toHaveCount(0);
});
