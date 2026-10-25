import type { BackupStatus } from "./types.js";

/** The line for the status bar: when the last daily backup was made, or what went wrong. */
export function backupLine(status: BackupStatus, nowS: number): { text: string; bad: boolean } {
  if (status.error) return { text: "Sicherung fehlgeschlagen", bad: true };
  if (!status.enabled) return { text: "Keine Tagessicherung", bad: false };
  if (status.lastAt === null) return { text: "Noch keine Sicherung", bad: false };
  const hours = Math.max(0, Math.floor((nowS - status.lastAt) / 3600));
  if (hours < 1) return { text: "Sicherung: vor wenigen Minuten", bad: false };
  if (hours < 48) return { text: `Sicherung: vor ${hours} Std.`, bad: hours >= 36 };
  return { text: `Sicherung: vor ${Math.floor(hours / 24)} Tagen`, bad: true };
}
