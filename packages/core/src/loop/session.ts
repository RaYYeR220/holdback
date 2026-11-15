import { reduce } from "../ledger/reduce.js";
import { parseEvents } from "../ledger/store.js";
import type { LedgerEvent } from "../ledger/types.js";
import { readLedger } from "../ledger/vouched.js";
import type { Project } from "../project.js";
import { markTampered } from "../tamper.js";

/**
 * The fail-closed steps every Kane session shares (the build loop's and the hooks' `VerifySession`,
 * and falsify), kept in one place so the two cannot drift apart (M2).
 */

const errText = (e: unknown) => (e instanceof Error ? e.message : String(e));

/**
 * Records a tamper: the marker first (it must survive a ledger that cannot take the event), then
 * the event through `emit`. A marker that cannot be written must not keep the event out either.
 */
export async function recordTamperIn(p: Pick<Project, "home">, emit: (e: { t: "tamper"; detail: string }) => Promise<void>, detail: string): Promise<void> {
  let logged = detail;
  try {
    await markTampered(p, detail);
  } catch (e) {
    logged = `${detail} (tamper marker not written: ${errText(e)})`;
  }
  await emit({ t: "tamper", detail: logged });
}

/**
 * A tamper only the marker knows (the ledger could not take it) goes into the ledger once, so
 * whatever seal comes next drops the results from before it; later starts find it there. Best
 * effort: the marker blocks either way.
 */
export async function logMarkedTamper(p: Pick<Project, "ledgerFile">, log: (e: LedgerEvent) => Promise<void>, marker: string): Promise<void> {
  try {
    if (!reduce(parseEvents((await readLedger(p.ledgerFile)).toString("utf8"))).tampered) await log({ at: new Date().toISOString(), t: "tamper", detail: marker });
  } catch {
    /* the marker blocks either way */
  }
}
