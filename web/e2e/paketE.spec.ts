import { expect, test, type Page } from "@playwright/test";

test.beforeEach(async ({ request }) => {
  for (const s of await (await request.get("/api/simulations")).json()) await request.delete(`/api/simulations/${s.id}`);
});

async function createSimulation(page: Page, name = "Paket E") {
  await page.goto("/");
  await page.getByRole("button", { name: "Neue Simulation" }).click();
  await page.getByLabel("Name").fill(name);
  await page.getByLabel("Datum").fill("2026-10-23");
  await page.getByLabel("Uhrzeit").fill("10:00");
  await page.getByRole("button", { name: "Anlegen" }).click();
  await expect(page.getByTestId("sim-time")).toHaveText("23.10.2026, 10:00:00");
  await expect(page.getByLabel("Menge")).toBeEnabled();
}

async function addSimulation(page: Page, name: string) {
  await page.getByRole("button", { name: "Neue Simulation" }).click();
  const dialog = page.getByRole("dialog");
  await dialog.getByLabel("Name").fill(name);
  await dialog.getByLabel("Datum").fill("2026-10-23");
  await dialog.getByLabel("Uhrzeit").fill("10:00");
  await dialog.getByRole("button", { name: "Anlegen" }).click();
  await expect(page.getByTestId("sim-list").getByText(name)).toBeVisible();
}

async function buy(page: Page) {
  await page.getByLabel("Menge").fill("1");
  await expect(page.getByTestId("cost-total")).toBeVisible();
  await page.getByRole("button", { name: "Kaufen" }).click();
  await expect(page.getByTestId("position-SAP.DE")).toBeVisible();
}

test.describe("backfill dialog", () => {
  test("is blocked while a market is open: reason shown, start disabled, venues with notes", async ({ page }) => {
    await createSimulation(page);
    await page.getByTestId("backfill-open").click();
    const dialog = page.getByRole("dialog", { name: "Fehlende Kurse nachladen" });
    await expect(dialog.getByTestId("backfill-blocked")).toContainText("geöffnet");
    await expect(dialog.getByRole("button", { name: "Nachladen starten" })).toBeDisabled();
    await expect(dialog.getByTestId("backfill-assumption")).toContainText("Annahme");
    const venues = dialog.getByTestId("venue-list");
    await expect(venues).toContainText("Tradegate");
    await expect(venues).toContainText("gettex");
    await expect(venues).toContainText("keine Kursquelle");
  });

  test("runs: progress while running, then the report with counts and the 429 stop", async ({ page }) => {
    let polls = 0;
    const items = [
      { symbol: "SAP.DE", day: "2026-10-20", dayStart: 1, status: "loaded", label: "geladen", bars: 510 },
      { symbol: "SIE.DE", day: "2026-10-20", dayStart: 1, status: "error", label: "Fehler", reason: "429" },
      { symbol: "AAPL", day: "2026-10-20", dayStart: 1, status: "skipped", label: "übersprungen" },
    ];
    await page.route("**/api/archive/missing", (r) => r.fulfill({ json: {
      days: 7, daysIsAssumption: true, reachDays: 29, blocked: null,
      items: [{ symbol: "SAP.DE", day: "2026-10-20", dayStart: 1, state: "never", inReach: true }],
    } }));
    await page.route("**/api/archive/backfill", async (route) => {
      const idle = { running: false, startedAt: null, finishedAt: null, done: 0, total: 0, report: null };
      if (route.request().method() === "POST") {
        return route.fulfill({ status: 202, json: { ...idle, running: true, startedAt: 5, total: 3 } });
      }
      polls++;
      if (polls === 1 && !(await route.request().headerValue("x-started"))) return route.fulfill({ json: idle });
      const running = polls < 3;
      return route.fulfill({ json: running
        ? { ...idle, running: true, startedAt: 5, done: 1, total: 3 }
        : { ...idle, startedAt: 5, finishedAt: 9, done: 3, total: 3, report: {
          days: 7, daysIsAssumption: true, stoppedByRateLimit: true,
          counts: { loaded: 1, empty: 0, error: 1, skipped: 1, outOfRange: 0 }, items,
        } } });
    });
    await createSimulation(page);
    await page.getByTestId("backfill-open").click();
    const dialog = page.getByRole("dialog", { name: "Fehlende Kurse nachladen" });
    await expect(dialog.getByTestId("backfill-missing")).toContainText("1");
    await dialog.getByRole("button", { name: "Nachladen starten" }).click();
    await expect(dialog.getByTestId("backfill-progress")).toContainText("von 3");
    await expect(dialog.getByTestId("backfill-report")).toBeVisible({ timeout: 10_000 });
    await expect(dialog.getByTestId("backfill-429")).toContainText("429");
    await expect(dialog.getByTestId("backfill-counts")).toContainText("geladen 1");
    await expect(dialog.getByTestId("backfill-report").getByRole("row")).toHaveCount(4);
  });

  test("is reachable from the palette", async ({ page }) => {
    await createSimulation(page);
    await page.keyboard.press("Control+k");
    await page.getByTestId("palette-input").fill("nachladen");
    await page.getByRole("option", { name: /Fehlende Kurse nachladen/ }).click();
    await expect(page.getByRole("dialog", { name: "Fehlende Kurse nachladen" })).toBeVisible();
  });
});

test.describe("ghost depot", () => {
  test("is refused without a position, then frozen, labelled, read-only and deletable", async ({ page }) => {
    await createSimulation(page);
    const create = page.getByRole("button", { name: "Geisterdepot anlegen" });
    await expect(create).toBeDisabled();
    await expect(page.getByTestId("ghost-reason")).toContainText("Position");

    await buy(page);
    await expect(create).toBeEnabled();
    await create.click();
    const tab = page.getByRole("tab", { name: /Geist von Depot 1/ });
    await expect(tab).toHaveAttribute("aria-selected", "true");
    await expect(tab).toContainText("Geist");
    await expect(page.getByTestId("ghost-no-ticket")).toBeVisible();
    await expect(page.getByLabel("Menge")).toHaveCount(0);
    await expect(page.getByRole("button", { name: "Aufbau nach Prozent" })).toBeDisabled();
    await expect(page.getByRole("button", { name: "Geisterdepot anlegen" })).toBeDisabled();
    await expect(page.getByTestId("position-SAP.DE")).toBeVisible();

    await page.getByRole("tab", { name: "Auswertung" }).click();
    await expect(page.getByTestId("curves")).toHaveAttribute("data-series", "2");
    await expect(page.getByLabel("Legende")).toContainText("Geist");
    await expect(page.getByTestId("metrics")).toContainText("Geist");
    await expect(page.getByTestId("journal")).toContainText("kein Journal");

    await page.getByRole("button", { name: "Depot verwalten" }).click();
    const dialog = page.getByRole("dialog", { name: "Depot verwalten" });
    await expect(dialog.getByRole("button", { name: "Depot löschen" })).toBeEnabled();
    await dialog.getByRole("button", { name: "Depot löschen" }).click();
    await expect(page.getByRole("tab", { name: /Geist von/ })).toHaveCount(0);
    await expect(page.getByRole("tab", { name: "Depot 1" })).toHaveAttribute("aria-selected", "true");
  });
});

test.describe("journal", () => {
  test("shows a closed trade with figures and keeps an edited note after a reload", async ({ page }) => {
    await createSimulation(page);
    await buy(page);
    await page.getByRole("button", { name: "Verkauf", exact: true }).click();
    await page.getByLabel("Menge").fill("1");
    await expect(page.getByTestId("cost-total")).toBeVisible();
    await page.getByRole("button", { name: "Verkaufen" }).click();
    await expect(page.getByTestId("position-SAP.DE")).toHaveCount(0);

    await page.getByRole("tab", { name: "Auswertung" }).click();
    const journal = page.getByTestId("journal");
    await expect(journal.getByTestId("few-data")).toHaveText("wenig Daten");
    await expect(journal.getByTestId("hit-rate")).toContainText("n = 1");
    await expect(journal.getByTestId("journal-note")).toHaveText("Beobachtung, keine Prognose.");
    await expect(journal.getByTestId("too-early-1")).toBeVisible();
    await expect(journal.getByTestId("too-early-5")).toBeVisible();
    const row = journal.getByTestId("journal-trades").getByRole("row").nth(1);
    await expect(row).toContainText(/[▲▼•]/);

    const note = row.getByRole("textbox");
    await note.fill("zu nervös");
    await note.blur();
    await expect(row.getByRole("status")).toContainText("gespeichert");

    await page.reload();
    await page.getByRole("tab", { name: "Auswertung" }).click();
    await expect(page.getByTestId("journal").getByRole("textbox").first()).toHaveValue("zu nervös");
  });
});

test.describe("simulation comparison", () => {
  test("needs two simulations, then compares two with curves, the server note and figures", async ({ page }) => {
    await createSimulation(page, "Erste");
    await page.getByRole("tab", { name: "Auswertung" }).click();
    await expect(page.getByTestId("compare-hint")).toContainText("mindestens zwei");

    await addSimulation(page, "Zweite");
    await page.getByRole("tab", { name: "Auswertung" }).click();
    const compare = page.getByTestId("compare");
    await expect(compare.getByTestId("compare-pick")).toBeVisible();
    await compare.getByLabel("Erste").check();
    await compare.getByLabel("Zweite").check();
    await expect(compare.getByTestId("compare-note")).toContainText("keine gemeinsame Zeitachse");
    await expect(compare.getByTestId("compare-chart")).toHaveAttribute("data-series", "2");
    const table = compare.getByTestId("compare-table");
    await expect(table.getByRole("row")).toHaveCount(3);
    await expect(table).toContainText("Erste");
    await expect(table).toContainText("Zweite");
    await expect(table).toContainText("Trades");
  });
});

test.describe("order book", () => {
  test("is closed at first, then shows the simulated label prominently", async ({ page }) => {
    await createSimulation(page);
    await expect(page.getByTestId("orderbook")).toHaveCount(0);
    await page.getByTestId("orderbook-toggle").click();
    const label = page.getByTestId("orderbook-label");
    await expect(label).toContainText("SIMULIERT, keine echten Tiefendaten, aus der Kerze abgeleitet");
    await expect(page.getByTestId("orderbook").getByRole("row").nth(1)).toBeVisible();
    await page.getByTestId("orderbook-toggle").click();
    await expect(page.getByTestId("orderbook")).toHaveCount(0);
  });

  test("says 'kein Orderbuch' with the reason when there is none", async ({ page }) => {
    await page.route("**/api/simulations/*/orderbook**", (r) => r.fulfill({ json: {
      available: false, simulated: true, symbol: "SAP.DE",
      label: "SIMULIERT, keine echten Tiefendaten, aus der Kerze abgeleitet", reason: "Der Markt ist geschlossen.",
    } }));
    await createSimulation(page);
    await page.keyboard.press("Control+k");
    await page.getByTestId("palette-input").fill("orderbuch");
    await page.getByRole("option", { name: /Orderbuch/ }).click();
    await expect(page.getByTestId("orderbook-unavailable")).toContainText("kein Orderbuch");
    await expect(page.getByTestId("orderbook-unavailable")).toContainText("geschlossen");
    await expect(page.getByTestId("orderbook-label")).toBeVisible();
  });
});

test.describe("phone, 390 x 844", () => {
  test.use({ viewport: { width: 390, height: 844 } });

  test("the new sections fit without sideways scrolling", async ({ page }) => {
    await createSimulation(page);
    await page.getByTestId("orderbook-toggle").click();
    await expect(page.getByTestId("orderbook-label")).toBeVisible();
    await page.getByRole("tab", { name: "Auswertung" }).click();
    await expect(page.getByTestId("journal")).toBeVisible();
    expect(await page.evaluate(() => document.documentElement.scrollWidth <= window.innerWidth)).toBe(true);
    // The page hides sideways overflow, so check the boxes themselves: no card reaches past the screen edge.
    const wide = await page.evaluate(() => [...document.querySelectorAll("main .card")]
      .filter((e) => e.getBoundingClientRect().right > window.innerWidth + 1 || e.getBoundingClientRect().left < -1).length);
    expect(wide).toBe(0);
  });

  test("Auswertung tables stack instead of scrolling sideways", async ({ page }) => {
    await createSimulation(page);
    await page.getByLabel("Menge").fill("1");
    await expect(page.getByTestId("cost-total")).toBeVisible();
    await page.getByRole("form", { name: "Orderticket" }).getByRole("button", { name: "Kaufen" }).click();
    await expect(page.getByTestId("position-SAP.DE")).toBeVisible();
    await page.keyboard.press("Control+k");
    await page.getByTestId("palette-input").fill("geist");
    await page.getByRole("option", { name: /Geist/ }).first().click();
    await page.getByRole("tab", { name: "Auswertung" }).click();
    await expect(page.getByTestId("metrics")).toBeVisible();
    await expect(page.getByTestId("fees")).toBeVisible();
    const clipped = await page.evaluate(() => [...document.querySelectorAll("main .scroll")]
      .filter((e) => e.scrollWidth > e.clientWidth).map((e) => e.querySelector("table")?.getAttribute("data-testid")));
    expect(clipped).toEqual([]);
    await expect(page.getByTestId("metrics").locator("td[data-label='Rendite']").first()).toBeVisible();
  });

  test("backfill button is reachable with the Watchlist folded", async ({ page }) => {
    await createSimulation(page);
    await expect(page.locator("details.fold", { hasText: "Watchlist" })).not.toHaveAttribute("open", "");
    await page.getByTestId("backfill-open").click();
    await expect(page.getByRole("dialog", { name: "Fehlende Kurse nachladen" })).toBeVisible();
  });
});
