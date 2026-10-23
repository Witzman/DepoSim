import { existsSync, mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { describe, expect, it } from "vitest";
import { buildApp } from "../src/app.js";

describe("buildApp", () => {
  it("creates the folder of the database file when it does not exist yet", async () => {
    const dir = mkdtempSync(join(tmpdir(), "deposim-"));
    try {
      const path = join(dir, "not", "yet", "deposim.sqlite");
      const app = buildApp({ dbPath: path });
      await app.ready();
      expect(existsSync(path)).toBe(true);
      await app.close();
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });
});
