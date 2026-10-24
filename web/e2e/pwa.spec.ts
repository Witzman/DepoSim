import { expect, test } from "@playwright/test";

test("the manifest is linked, valid, and its icons load", async ({ page, request }) => {
  await page.goto("/");
  const link = page.locator('link[rel="manifest"]');
  await expect(link).toHaveAttribute("crossorigin", "use-credentials");
  await expect(page.locator('meta[name="theme-color"]').first()).toHaveAttribute("content", /#/);
  await expect(page.locator('link[rel="apple-touch-icon"]')).toHaveCount(1);

  const href = (await link.getAttribute("href"))!;
  const res = await request.get(href);
  expect(res.ok()).toBe(true);
  const manifest = await res.json();
  expect(manifest.name).toBe("DepoSim");
  expect(manifest.display).toBe("standalone");
  expect(manifest.start_url).toBe("/");
  const sizes = manifest.icons.map((i: { sizes: string }) => i.sizes);
  expect(sizes).toContain("192x192");
  expect(sizes).toContain("512x512");
  for (const icon of manifest.icons) expect((await request.get(icon.src)).ok()).toBe(true);
});

test("the service worker takes over, never caches the API, and is not cached for long", async ({ page, request }) => {
  const sw = await request.get("/sw.js");
  expect(sw.ok()).toBe(true);
  expect(sw.headers()["cache-control"] ?? "").not.toMatch(/max-age=[1-9]/);

  await page.goto("/");
  await page.evaluate(() => navigator.serviceWorker.ready);
  await page.reload();
  await expect.poll(() => page.evaluate(() => !!navigator.serviceWorker.controller)).toBe(true);

  await page.evaluate(() => fetch("/api/watchlist").then((r) => r.json()));
  const keys = await page.evaluate(async () => {
    const out: string[] = [];
    for (const name of await caches.keys()) for (const r of await (await caches.open(name)).keys()) out.push(new URL(r.url).pathname);
    return out;
  });
  expect(keys.length).toBeGreaterThan(0);
  expect(keys.filter((k) => k.startsWith("/api") || k.startsWith("/ws") || k === "/healthz")).toEqual([]);
});
