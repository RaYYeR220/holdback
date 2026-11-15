import { appendFile, mkdir, readFile } from "node:fs/promises";
import { dirname } from "node:path";
import type { LedgerEvent } from "./types.js";

export async function appendEvent(file: string, e: LedgerEvent): Promise<void> {
  await mkdir(dirname(file), { recursive: true });
  await appendFile(file, JSON.stringify(e) + "\n", "utf8");
}

export async function readEvents(file: string): Promise<LedgerEvent[]> {
  let raw: string;
  try {
    raw = await readFile(file, "utf8");
  } catch (err) {
    // only "no ledger yet" is empty; any other error must not look like an empty (all-clear) ledger
    if ((err as NodeJS.ErrnoException).code === "ENOENT") return [];
    throw err;
  }
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
