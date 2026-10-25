import { describe, expect, it } from "vitest";
import { backupLine } from "../src/backup.js";
import type { BackupStatus } from "../src/types.js";

const status = (over: Partial<BackupStatus>): BackupStatus =>
  ({ enabled: true, dir: "/b", keep: 7, lastAt: null, lastName: null, lastBytes: null, error: null, log: [], ...over });

describe("backupLine", () => {
  it("says when the last backup was", () => {
    expect(backupLine(status({ lastAt: 1000 }), 1000 + 600)).toEqual({ text: "Sicherung: vor wenigen Minuten", bad: false });
    expect(backupLine(status({ lastAt: 1000 }), 1000 + 5 * 3600)).toEqual({ text: "Sicherung: vor 5 Std.", bad: false });
    expect(backupLine(status({ lastAt: 1000 }), 1000 + 3 * 86400)).toEqual({ text: "Sicherung: vor 3 Tagen", bad: true });
  });
  it("shows a failure first, and says so when there is no backup or no folder", () => {
    expect(backupLine(status({ lastAt: 1000, error: { at: 5, message: "x" } }), 2000)).toEqual({ text: "Sicherung fehlgeschlagen", bad: true });
    expect(backupLine(status({}), 2000).text).toBe("Noch keine Sicherung");
    expect(backupLine(status({ enabled: false }), 2000).text).toBe("Keine Tagessicherung");
  });
});
