import { expect, test } from "@playwright/test";

test.beforeEach(async ({ request }) => {
  for (const s of await (await request.get("/api/simulations")).json()) await request.delete(`/api/simulations/${s.id}`);
});

test("an ex-day shows up under the chart when the clock passes it, with a message, and not before", async ({ page }) => {
  await page.goto("/");
  await page.getByRole("button", { name: "Neue Simulation" }).click();
  await page.getByLabel("Name").fill("Ereignisse");
  await page.getByTestId("by-day").check();
  await page.getByLabel("Datum").fill("2026-09-15");
  await page.getByRole("button", { name: "Anlegen" }).click();
  await expect(page.getByTestId("sim-time")).toHaveText("15.09.2026");

  const strip = page.getByTestId("event-strip");
  await expect(strip).toBeVisible();
  // the history before the start has its own distributions; the ex-day of 17 September is still ahead
  const ex17 = page.getByTestId("event-dividend").filter({ hasText: "17.09." });
  await expect(page.getByTestId("event-dividend")).not.toHaveCount(0);
  await expect(ex17).toHaveCount(0);

  await page.getByTestId("day-step").click(); // plays the 15th
  await page.getByTestId("day-step").click(); // the 16th
  await expect(ex17).toHaveCount(0);
  await page.getByTestId("day-step").click(); // the 17th
  await expect(page.getByTestId("sim-time")).toHaveText("18.09.2026");
  await expect(ex17).toHaveCount(1);
  await expect(ex17).toContainText("Ausschüttung 17.09.");
  await expect(page.getByRole("status").filter({ hasText: "Ausschüttung SAP.DE" })).toBeVisible();

  await strip.getByText(/^Ereignisliste \(\d+\)$/).click();
  await expect(page.getByTestId("event-list")).toContainText("17.09.2026 Ausschüttung SAP.DE");
  await expect(page.getByTestId("event-list")).toContainText("(Ex-Tag)");
});

test("the events endpoint needs symbols and shows nothing past the clock", async ({ request }) => {
  const sim = await (await request.post("/api/simulations", { data: { name: "E", startAt: Date.parse("2026-09-10T00:00:00Z") / 1000, resolution: "day" } })).json();
  expect((await request.get(`/api/simulations/${sim.id}/events`)).status()).toBe(400);
  const events = await (await request.get(`/api/simulations/${sim.id}/events?symbols=SAP.DE,NOPE`)).json();
  expect(events.every((e: { day: string }) => e.day < "2026-09-10")).toBe(true);
});
