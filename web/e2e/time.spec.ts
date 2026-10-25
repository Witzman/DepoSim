import { expect, test, type Page } from "@playwright/test";

test.beforeEach(async ({ request }) => {
  for (const s of await (await request.get("/api/simulations")).json()) await request.delete(`/api/simulations/${s.id}`);
});

async function create(page: Page, extra: (p: Page) => Promise<void> = async () => {}) {
  await page.goto("/");
  await page.getByRole("button", { name: "Neue Simulation" }).click();
  await page.getByLabel("Name").fill("Zeit");
  await page.getByLabel("Datum").fill("2026-10-22");
  await page.getByLabel("Uhrzeit").fill("10:00");
  await extra(page);
  await page.getByRole("button", { name: "Anlegen" }).click();
  await expect(page.getByTestId("sim-time")).toHaveText("22.10.2026, 10:00:00");
}

test("a jump ends exactly at its target, one candle and one hour on", async ({ page }) => {
  await create(page);
  await page.getByTestId("jump-candle").click();
  await expect(page.getByTestId("sim-time")).toHaveText("22.10.2026, 10:01:00");
  await page.getByTestId("jump-hour").click();
  await expect(page.getByTestId("sim-time")).toHaveText("22.10.2026, 11:01:00");
  await page.keyboard.press(".");
  await expect(page.getByTestId("sim-time")).toHaveText("22.10.2026, 11:02:00");
  await expect(page.getByRole("button", { name: "Start" })).toBeVisible(); // a jump leaves the clock stopped
});

test("a jump to the close of trading ends at the close, to the opening at the next opening", async ({ page }) => {
  await create(page);
  await page.getByTestId("jump-close").click();
  await expect(page.getByTestId("sim-time")).toHaveText("22.10.2026, 17:30:00"); // Xetra closes at 17:30 Berlin time
  await page.getByTestId("jump-open").click();
  await expect(page.getByTestId("sim-time")).toHaveText("23.10.2026, 09:00:00"); // the next trading day is Friday
});

test("an order that executes on the way stops the jump and is carried out", async ({ page }) => {
  await create(page);
  await page.getByLabel("Menge").fill("1");
  await page.getByLabel("Art").selectOption("limit");
  const last = Number((await page.getByTestId("last-price").textContent())!.replace(/[^\d,]/g, "").replace(",", "."));
  await page.getByRole("spinbutton", { name: /^Limit/ }).fill((last * 1.5).toFixed(2)); // a buy limit far above: reached at once
  await page.getByRole("button", { name: "Kaufen" }).click();
  await page.getByTestId("jump-close").click();
  await expect(page.getByTestId("position-SAP.DE")).toBeVisible();
  await expect(page.getByRole("status").filter({ hasText: "Angehalten: Kauf 1 SAP.DE ausgeführt" })).toBeVisible();
  await expect(page.getByTestId("sim-time")).not.toHaveText("22.10.2026, 17:30:00");
});

test("auto-pause stops the clock by itself on an execution and says why", async ({ page }) => {
  await create(page);
  await page.getByTestId("autopause").locator("summary").click();
  await page.getByLabel("Bei Orderausführung").check();
  await expect(page.getByTestId("autopause").locator("summary")).toContainText("(an)");
  await page.getByLabel("Menge").fill("1");
  await page.getByLabel("Art").selectOption("limit");
  const last = Number((await page.getByTestId("last-price").textContent())!.replace(/[^\d,]/g, "").replace(",", "."));
  await page.getByRole("spinbutton", { name: /^Limit/ }).fill((last * 1.5).toFixed(2));
  await page.getByRole("button", { name: "Kaufen" }).click();
  await page.getByRole("button", { name: "60x" }).click();
  await page.getByRole("button", { name: "Start" }).click();
  await expect(page.getByRole("status").filter({ hasText: "Automatisch angehalten: Kauf 1 SAP.DE ausgeführt" })).toBeVisible({ timeout: 10_000 });
  await expect(page.getByRole("button", { name: "Start" })).toBeVisible();
});

test("time lapse is offered only without an open order and falls back to 60x when an order is placed", async ({ page }) => {
  await create(page);
  await page.getByTestId("lapse-300").click();
  await expect(page.getByTestId("lapse-300")).toHaveAttribute("aria-pressed", "true");
  await page.getByLabel("Menge").fill("1");
  await page.getByLabel("Art").selectOption("limit");
  await page.getByRole("spinbutton", { name: /^Limit/ }).fill("1.00"); // far below: stays open
  await page.getByRole("button", { name: "Kaufen" }).click();
  await expect(page.getByRole("button", { name: "60x" })).toHaveAttribute("aria-pressed", "true");
  await expect(page.getByTestId("lapse-120")).toBeDisabled();
});

test("Hardcore has no jumps and no auto-pause", async ({ page }) => {
  await create(page, async (p) => { await p.getByRole("radio", { name: /Hardcore/ }).check(); });
  await expect(page.getByTestId("jumps")).toHaveCount(0);
  await expect(page.getByTestId("autopause")).toHaveCount(0);
});

test("the API refuses a jump for a simulation without a pause", async ({ request }) => {
  const sim = await (await request.post("/api/simulations", { data: { name: "H", startAt: Date.parse("2026-10-23T08:00:00Z") / 1000, preset: "hardcore" } })).json();
  const r = await request.post(`/api/simulations/${sim.id}/jump`, { data: { to: "hour" } });
  expect(r.status()).toBe(409);
  expect((await r.json()).error).toMatch(/keine Sprünge/);
  const p = await request.patch(`/api/simulations/${sim.id}`, { data: { autoPause: { onFill: true } } });
  expect(p.status()).toBe(409);
});
