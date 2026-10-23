import { describe, expect, it } from "vitest";
import { buildApp } from "../src/app.js";

describe("healthz", () => {
  it("answers 200 and ok", async () => {
    const app = buildApp({ dbPath: ":memory:" });
    const res = await app.inject({ url: "/healthz" });
    expect(res.statusCode).toBe(200);
    expect(res.body).toBe("ok");
    await app.close();
  });
});
