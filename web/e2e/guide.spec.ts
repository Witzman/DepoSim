import { expect, test } from "@playwright/test";

// A new person: nothing stored.
test.use({ storageState: { cookies: [], origins: [] } });

test.beforeEach(async ({ request }) => {
  for (const s of await (await request.get("/api/simulations")).json()) await request.delete(`/api/simulations/${s.id}`);
});

const step = (page: import("@playwright/test").Page, id: string) => page.getByTestId(`guide-step-${id}`);

test("a new person is led through the eight steps, each recognised by itself", async ({ page }) => {
  await page.goto("/");
  await expect(page.getByTestId("guide")).toBeVisible();
  await expect(page.getByTestId("guide-progress")).toHaveText("0/8");
  await expect(page.getByRole("button", { name: "Neue Simulation" })).toHaveClass(/guide-pulse/);

  await page.getByRole("button", { name: "Neue Simulation" }).click();
  await page.getByLabel("Datum").fill("2026-10-23");
  await page.getByLabel("Uhrzeit").fill("10:00");
  await page.getByRole("button", { name: "Anlegen" }).click();
  await expect(page.getByLabel("Menge")).toBeEnabled();
  await page.getByRole("button", { name: "Start" }).click();
  await expect(step(page, "start")).toHaveClass(/done/, { timeout: 15_000 });
  await page.getByRole("button", { name: "Pause" }).click();

  await page.getByLabel("Menge").fill("2");
  await page.getByRole("button", { name: "Kaufen" }).click();
  await expect(step(page, "buy")).toHaveClass(/done/);

  await page.getByLabel("Art").selectOption("limit");
  await page.getByLabel(/Limit \(/).fill("1");
  await page.getByRole("button", { name: "Kaufen" }).click();
  await expect(step(page, "limit")).toHaveClass(/done/);

  await page.getByRole("button", { name: "Waagerechte Linie" }).click();
  await expect(page.getByRole("button", { name: "Waagerechte Linie" })).toHaveAttribute("aria-pressed", "true");
  const box = (await page.getByTestId("chart").boundingBox())!;
  await page.mouse.click(box.x + box.width * 0.9, box.y + box.height * 0.3);
  await expect(page.getByTestId("chart")).toHaveAttribute("data-drawings", "1");
  await expect(step(page, "drawing")).toHaveClass(/done/);

  await page.locator("summary", { hasText: "Indikatoren" }).click();
  await page.getByRole("checkbox").first().check();
  await expect(step(page, "indicator")).toHaveClass(/done/);
  await page.locator("summary", { hasText: "Indikatoren" }).click(); // fold the menu so it does not cover the chart

  await page.getByRole("button", { name: "Verkauf", exact: true }).click();
  await page.getByLabel("Art").selectOption("market");
  await page.getByLabel("Menge").fill("2");
  await page.getByRole("button", { name: "Verkaufen" }).click();
  await expect(step(page, "sell")).toHaveClass(/done/);

  await page.getByTestId("tf-15m").click();
  await expect(step(page, "timeframe")).toHaveClass(/done/);

  await page.getByRole("tab", { name: "Auswertung" }).click();
  await expect(step(page, "evaluation")).not.toHaveClass(/done/);
  await page.getByLabel("Maßstab").selectOption({ index: 1 });
  await expect(step(page, "evaluation")).toHaveClass(/done/);
  await expect(page.getByTestId("guide-finished")).toBeVisible();
  await expect(page.getByTestId("guide-progress")).toHaveText("8/8");
});

test("it can be hidden, stays hidden after a reload, and comes back from the palette", async ({ page }) => {
  await page.goto("/");
  await page.getByTestId("guide-hide").click();
  await expect(page.getByTestId("guide")).toHaveCount(0);
  await page.reload();
  await expect(page.getByTestId("guide")).toHaveCount(0);
  await page.keyboard.press("Control+k");
  await page.getByTestId("palette-input").fill("lernpfad");
  await page.getByRole("option", { name: /Lernpfad starten/ }).click();
  await expect(page.getByTestId("guide")).toBeVisible();
  await expect(page.getByTestId("guide-progress")).toHaveText("0/8");
});

test("someone who already has a simulation does not get it by themselves", async ({ page, request }) => {
  await request.post("/api/simulations", { data: { name: "Alt", startAt: 1792656000 } });
  await page.goto("/");
  await expect(page.getByTestId("sim-list")).toBeVisible();
  await expect(page.getByTestId("guide")).toHaveCount(0);
});
