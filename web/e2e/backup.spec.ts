import { expect, test, type Page } from "@playwright/test";
import { readFileSync, writeFileSync } from "node:fs";

test.beforeEach(async ({ request }) => {
  for (const s of await (await request.get("/api/simulations")).json()) await request.delete(`/api/simulations/${s.id}`);
});

async function createSimulation(page: Page, name = "Sicherung") {
  await page.goto("/");
  await page.getByRole("button", { name: "Neue Simulation" }).click();
  await page.getByLabel("Name").fill(name);
  await page.getByLabel("Datum").fill("2026-10-23");
  await page.getByLabel("Uhrzeit").fill("10:00");
  await page.getByRole("button", { name: "Anlegen" }).click();
  await expect(page.getByTestId("sim-time")).toHaveText("23.10.2026, 10:00:00");
}

test.describe("Sicherung", () => {
  test("status line opens the dialog; backup, simulation export and CSV download", async ({ page }, info) => {
    await createSimulation(page);
    await expect(page.getByTestId("backup-status")).toBeVisible();
    await page.getByTestId("backup-status").click();
    const dialog = page.getByTestId("backup-dialog");
    await expect(dialog.getByTestId("backup-state")).toContainText("Tagessicherung");

    const [backup] = await Promise.all([page.waitForEvent("download"), dialog.getByTestId("backup-download").click()]);
    expect(backup.suggestedFilename()).toMatch(/^deposim-sicherung-.*\.sqlite$/);
    const backupPath = info.outputPath("backup.sqlite");
    await backup.saveAs(backupPath);
    expect(readFileSync(backupPath).subarray(0, 15).toString()).toBe("SQLite format 3");

    const [exported] = await Promise.all([page.waitForEvent("download"), dialog.getByTestId("export-sim").click()]);
    const jsonPath = info.outputPath("sim.json");
    await exported.saveAs(jsonPath);
    expect(JSON.parse(readFileSync(jsonPath, "utf8"))).toMatchObject({ format: "deposim-simulation", version: 1 });

    const [csv] = await Promise.all([page.waitForEvent("download"), dialog.getByTestId("export-values").click()]);
    expect(csv.suggestedFilename()).toMatch(/depotwerte\.csv$/);
  });

  test("imports an export as a new simulation and refuses an unknown version", async ({ page }, info) => {
    await createSimulation(page);
    const list = await (await page.request.get("/api/simulations")).json();
    const file = await (await page.request.get(`/api/simulations/${list[0].id}/export`)).json();
    await page.getByTestId("backup-status").click();
    const dialog = page.getByTestId("backup-dialog");

    const good = info.outputPath("gut.json");
    writeFileSync(good, JSON.stringify(file));
    await dialog.getByTestId("import-file").setInputFiles(good);
    await expect(dialog.getByTestId("backup-message")).toContainText("Sicherung (Import)");

    const bad = info.outputPath("neu.json");
    writeFileSync(bad, JSON.stringify({ ...file, version: 99 }));
    await dialog.getByTestId("import-file").setInputFiles(bad);
    await expect(dialog.getByTestId("backup-error")).toContainText("Schemaversion");
    expect((await (await page.request.get("/api/simulations")).json())).toHaveLength(2);
  });

  test("restoring asks first, saves the current state and brings the old simulations back", async ({ page }, info) => {
    await createSimulation(page, "Vorher");
    const saved = await page.request.get("/api/backup");
    const path = info.outputPath("alt.sqlite");
    writeFileSync(path, await saved.body());
    await page.request.post("/api/simulations/1/end").catch(() => {});
    for (const s of await (await page.request.get("/api/simulations")).json()) await page.request.delete(`/api/simulations/${s.id}`);
    await page.reload();

    await page.getByTestId("backup-status").click();
    const dialog = page.getByTestId("backup-dialog");
    await dialog.getByTestId("restore-file").setInputFiles(path);
    await dialog.getByTestId("restore-start").click();
    await expect(dialog.getByTestId("restore-confirm")).toContainText("ersetzt");
    await dialog.getByTestId("restore-confirm-yes").click();
    await expect(dialog.getByTestId("backup-message")).toContainText("Wiederhergestellt");
    expect((await (await page.request.get("/api/simulations")).json()).map((s: { name: string }) => s.name)).toEqual(["Vorher"]);
  });
});
