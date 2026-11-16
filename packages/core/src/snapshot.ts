import { checkSeal, isAppKeyOf } from "./seal.js";
import { readEvents } from "./ledger/store.js";
import { reduce } from "./ledger/reduce.js";
import { gate } from "./ledger/gate.js";
import { verdict, type Verdict } from "./ledger/verdict.js";
import { lastSeal } from "./loop/build.js";
import { tamperMarker } from "./tamper.js";
import type { LedgerEvent, LedgerState } from "./ledger/types.js";
import { kaneCapCredits, type Project } from "./project.js";

export type Snapshot = {
  events: LedgerEvent[];
  state: LedgerState;
  gate: ReturnType<typeof gate>;
  manifest: Record<string, string> | undefined;
  /** Text of the TAMPERED marker, when one is on record. */
  marker: string | null;
  /** Sealed entries that differ from the last seal, spec files apart. */
  changed: string[];
  /** The spec files edited since the last seal (`app:<file>` entries): drift, not a tamper. */
  specChanged: string[];
  /** Why the gate is shut by a tamper (marker, ledger record or changed files); null when there is none. */
  tamperDetail: string | null;
  /** The one verdict (R44): what `holdback run` would exit with, `status` and the dashboard say, with the disk's tamper counted. */
  verdict: Verdict;
};

/** The project's Kane credit cap (`kane.capCredits`) is spent, as the ledger measures it; false with no cap or an invalid one. */
function capReached(p: Project, state: LedgerState): boolean {
  let cap: number | undefined;
  try {
    cap = kaneCapCredits(p.config);
  } catch {
    return false;
  }
  return cap !== undefined && state.kaneCredits >= cap;
}

/**
 * The ledger as the CLI and the dashboard see it. A ledger that cannot be read throws: a read
 * error is never "no criteria yet", it is a failure that stops the caller.
 */
export async function snapshot(p: Project): Promise<Snapshot> {
  const events = await readEvents(p.ledgerFile);
  const state = reduce(events);
  const marker = await tamperMarker(p);
  const manifest = lastSeal(events);
  const broken = manifest ? await checkSeal(p.verifierDir, manifest, p.appDir) : [];
  const isSpec = (k: string) => p.config.spec.some((f) => isAppKeyOf(k, f));
  const specChanged = broken.filter(isSpec);
  const changed = broken.filter((k) => !isSpec(k));
  const lastTamper = events.findLast((e) => e.t === "tamper");
  const fromLedger = state.tampered && lastTamper?.t === "tamper" ? lastTamper.detail : null;
  const fromDisk = changed.length > 0 ? `sealed files changed: ${changed.join(", ")}` : null;
  const detail = marker ?? fromLedger ?? fromDisk;
  const tampered = state.tampered || marker !== null || changed.length > 0;
  return {
    events,
    state,
    gate: gate(state),
    manifest,
    marker,
    changed,
    specChanged,
    tamperDetail: tampered ? (detail ?? "the ledger records a tamper") : null,
    verdict: verdict(state, { tampered, specChanged: specChanged.length > 0, capReached: capReached(p, state) }),
  };
}
