import { createHash } from "node:crypto";
import { readFile } from "node:fs/promises";
import type { LedgerEvent } from "./types.js";

/** A ledger event without its timestamp. */
export type EventBody = LedgerEvent extends infer E ? (E extends { at: string } ? Omit<E, "at"> : never) : never;

/** Byte length + sha256 of the ledger as Holdback last wrote it. */
export type LedgerMark = { size: number; sha256: string };

const sha256 = (b: Buffer): string => createHash("sha256").update(b).digest("hex");
const errText = (e: unknown) => (e instanceof Error ? e.message : String(e));

export class LedgerTampered extends Error {
  constructor(detail = "ledger modified outside Holdback") {
    super(detail);
  }
}

export function markOf(raw: Buffer): LedgerMark {
  return { size: raw.length, sha256: sha256(raw) };
}

export async function readLedger(file: string): Promise<Buffer> {
  try {
    return await readFile(file);
  } catch (e) {
    // only "no ledger yet" is empty; any other error must not look like an empty (all-clear) ledger
    if ((e as NodeJS.ErrnoException).code !== "ENOENT") throw e;
    return Buffer.alloc(0);
  }
}

/** Once Holdback vouches for the ledger, failing to read it is as bad as finding it changed. */
async function readVouched(file: string): Promise<Buffer> {
  try {
    return await readLedger(file);
  } catch (e) {
    throw new LedgerTampered(`ledger unreadable: ${errText(e)}`);
  }
}

/** Throws LedgerTampered unless the file is byte-for-byte what `mark` vouches for. */
export async function verifiedLedger(file: string, mark: LedgerMark): Promise<Buffer> {
  const raw = await readVouched(file);
  if (raw.length !== mark.size || sha256(raw) !== mark.sha256) throw new LedgerTampered();
  return raw;
}

/** After appending `e`: the file must be the vouched-for bytes plus exactly that one event. Returns the new mark. */
async function markAfterAppend(file: string, mark: LedgerMark, e: LedgerEvent): Promise<LedgerMark> {
  const raw = await readVouched(file);
  if (raw.length <= mark.size || sha256(raw.subarray(0, mark.size)) !== mark.sha256) throw new LedgerTampered();
  const tail = raw.subarray(mark.size).toString("utf8").trim();
  let added: unknown;
  try {
    added = JSON.parse(tail); // more than one line fails to parse
  } catch {
    throw new LedgerTampered();
  }
  if (JSON.stringify(added) !== JSON.stringify(e)) throw new LedgerTampered();
  return markOf(raw);
}

/**
 * Append one event through `log` (which must append to `file`): the ledger must be untouched
 * since Holdback's last append, before and after. Returns the mark that vouches for the result.
 */
export async function appendVouched(
  file: string,
  mark: LedgerMark,
  log: (e: LedgerEvent) => Promise<void>,
  e: LedgerEvent,
): Promise<LedgerMark> {
  await verifiedLedger(file, mark);
  try {
    await log(e);
  } catch (err) {
    throw new LedgerTampered(`ledger append failed: ${errText(err)}`);
  }
  return markAfterAppend(file, mark, e);
}
