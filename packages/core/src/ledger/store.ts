import { appendFile, mkdir, readFile } from "node:fs/promises";
import { dirname } from "node:path";
import { parseEvents } from "./parse.js";
import type { LedgerEvent } from "./types.js";

export { parseEvents };

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
  return parseEvents(raw);
}
