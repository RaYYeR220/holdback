import type { LedgerEvent } from "./types.js";

/** Ledger text -> events; blank, corrupt or untyped lines are skipped. Pure (no node APIs): the dashboard parses with it too. */
export function parseEvents(raw: string): LedgerEvent[] {
  const out: LedgerEvent[] = [];
  for (const line of raw.split("\n")) {
    const s = line.trim();
    if (!s) continue;
    try {
      const v: unknown = JSON.parse(s);
      if (v && typeof v === "object" && typeof (v as { t?: unknown }).t === "string") out.push(v as LedgerEvent);
    } catch {
      // corrupt line (e.g. torn write): skip
    }
  }
  return out;
}
