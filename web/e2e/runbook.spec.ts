import { expect, test } from "@playwright/test";

test.beforeEach(async ({ request }) => {
  for (const s of await (await request.get("/api/simulations")).json()) await request.delete(`/api/simulations/${s.id}`);
});

test("ending a round shows its card with a grade, and the round book shows the same card later", async ({ page }) => {
  page.on("dialog", (d) => void d.accept());
  await page.goto("/");
  await page.getByRole("button", { name: "Neue Simulation" }).click();
  await page.getByLabel("Name").fill("Meine Runde");
  await page.getByTestId("by-day").check();
  await page.getByLabel("Datum").fill("2026-09-01");
  await page.getByRole("button", { name: "Anlegen" }).click();
  await expect(page.getByTestId("sim-time")).toHaveText("01.09.2026");

  await page.getByLabel("Menge").fill("1");
  await page.getByRole("button", { name: "Kaufen" }).click();
  await page.getByTestId("day-step").click();
  await expect(page.getByTestId("position-SAP.DE")).toBeVisible();
  await page.getByTestId("day-step").click();

  await expect(page.getByTestId("runbook")).toContainText("Noch keine beendete Runde");
  await page.getByRole("button", { name: "Beenden" }).click();

  const card = page.getByTestId("run-card");
  await expect(card).toBeVisible();
  await expect(card.getByRole("heading", { name: "Meine Runde" })).toBeVisible();
  const grade = await card.getByTestId("run-grade").textContent();
  expect(grade).toMatch(/^[A-E]$/);
  await expect(card.getByTestId("grade-parts").locator("li")).toHaveCount(3); // too few closed trades for the hit rate
  await card.getByText("So entsteht die Note").click();
  await expect(card.getByTestId("grade-formula")).toContainText("Risiko (30 %)");
  await expect(card.getByTestId("card-text")).toHaveValue(/DepoSim · Meine Runde\nNote [A-E] \(/);

  // the picture is drawn, not blank
  const inked = await card.getByTestId("card-canvas").evaluate((c: HTMLCanvasElement) => {
    const d = c.getContext("2d")!.getImageData(0, 0, c.width, c.height).data;
    let n = 0;
    for (let i = 0; i < d.length; i += 4) if (d[i] < 250 || d[i + 1] < 250 || d[i + 2] < 250) n++;
    return n;
  });
  expect(inked).toBeGreaterThan(2000);

  const download = page.waitForEvent("download");
  await card.getByTestId("card-png").click();
  expect((await download).suggestedFilename()).toBe("deposim-meine-runde.png");
  await card.getByRole("button", { name: "Schließen" }).click();
  await expect(card).toBeHidden();

  const row = page.getByTestId("runbook-list").locator("li").first();
  await expect(row).toContainText("Meine Runde");
  await expect(row.getByLabel(/^Note /)).toHaveText(grade!);
  await row.click();
  await expect(card).toBeVisible();
  await expect(card.getByTestId("run-grade")).toHaveText(grade!); // the same grade from the book
});

test("the round book sorts, filters and marks the best round of a scenario; the card works on a phone", async ({ page, request }) => {
  const end = async (body: object) => {
    const sim = await (await request.post("/api/simulations", { data: body })).json();
    await request.post(`/api/simulations/${sim.id}/end`, { data: {} });
    return sim;
  };
  await end({ name: "Frei A", startAt: Date.parse("2026-09-01T00:00:00Z") / 1000, resolution: "day" });
  await end({ name: "Szenario B", scenarioId: "rallye-2023" });
  await end({ name: "Frei C", startAt: Date.parse("2026-09-01T00:00:00Z") / 1000, resolution: "day", preset: "hardcore" });

  await page.setViewportSize({ width: 375, height: 740 });
  await page.goto("/");
  await page.getByText("Rundenbuch", { exact: true }).first().click();
  const list = page.getByTestId("runbook-list");
  await expect(list.locator("li")).toHaveCount(3);

  await page.getByTestId("runbook-kind").selectOption("scenario");
  await expect(list.locator("li")).toHaveCount(1);
  await expect(list).toContainText("Szenario B");
  await page.getByTestId("runbook-kind").selectOption("free");
  await expect(list.locator("li")).toHaveCount(2);
  await page.getByTestId("runbook-preset").selectOption("hardcore");
  await expect(list.locator("li")).toHaveCount(1);
  await expect(list).toContainText("Frei C");
  await page.getByTestId("runbook-preset").selectOption("all");
  await page.getByTestId("runbook-sort").selectOption("grade");
  await expect(list.locator("li")).toHaveCount(2);

  await list.locator("li").first().click();
  const card = page.getByTestId("run-card");
  await expect(card).toBeVisible();
  const box = await card.boundingBox();
  expect(box!.width).toBeLessThanOrEqual(375);
  const download = page.waitForEvent("download");
  await card.getByTestId("card-png").click();
  expect((await download).suggestedFilename()).toMatch(/^deposim-.+\.png$/);
  expect(await page.evaluate(() => document.documentElement.scrollWidth <= window.innerWidth)).toBe(true);
});

test("a pasted card starts the same scenario round; anything else is turned away", async ({ page }) => {
  await page.goto("/");
  await page.getByText("Karte einfügen").click();
  await page.getByTestId("runbook-paste").fill("hallo");
  await page.getByTestId("runbook-import").click();
  await expect(page.getByRole("alert").filter({ hasText: "kein JSON" })).toBeVisible();

  const card = { app: "deposim", v: 1, kind: "run", name: "Nachgespielt", scenarioId: null, preset: "relaxed", startAt: 1, endAt: 2, grade: "B", score: 70, stars: null, totalReturn: 0.1, benchmarkSymbol: null, benchmarkReturn: null, maxDrawdown: -0.1, feeShare: 0, trades: 1 };
  await page.getByTestId("runbook-paste").fill(JSON.stringify(card));
  await page.getByTestId("runbook-import").click();
  await expect(page.getByRole("alert").filter({ hasText: "kein Szenario" })).toBeVisible();

  await page.getByTestId("runbook-paste").fill(JSON.stringify({ ...card, scenarioId: "rallye-2023", stars: 2 }));
  await page.getByTestId("runbook-import").click();
  await expect(page.getByTestId("sim-time")).toHaveText("02.01.2023");
  await expect(page.getByTestId("scenario-goals")).toContainText("Rallye 2023");
  await expect(page.getByTestId("sim-list")).toContainText("Nachgespielt");
});
