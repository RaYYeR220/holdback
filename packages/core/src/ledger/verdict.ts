import { gate } from "./gate.js";
import type { LedgerState } from "./types.js";

/**
 * `released`: every criterion a human did not turn down is proved or passing, the gate is open and
 * nothing is tampered. `held-back`: anything else on an untampered ledger. `tampered`: a tamper is on
 * record (or, for the CLI and the server, seen on disk). `empty`: no criteria yet.
 */
export type VerdictState = "released" | "held-back" | "tampered" | "empty";

/**
 * The one verdict on a ledger (R44): the CLI's summary and exit code, `status` and the dashboard's
 * headline all read it, so they can never disagree. Nothing is released while a criterion is owed,
 * regressed, vacuous (a planted bug survived), without a test (needs-spec) or depends on a test that
 * proved nothing on its last run.
 */
export type Verdict = {
  state: VerdictState;
  /** True exactly when `holdback run` ends with exit 0. */
  released: boolean;
  word: "Released" | "Held back";
  /** `Held back — 8/10 green, 2 criteria unproved: a planted bug survived`. */
  headline: string;
  /** What follows the word: the green count first, then why it is held back. */
  parts: string[];
  /** Criteria a human did not turn down (the denominator), and how they stand. */
  counts: {
    criteria: number;
    green: number;
    proved: number;
    passing: number;
    owed: number;
    regressed: number;
    vacuous: number;
    needsSpec: number;
    rejected: number;
    /** Tests a criterion depends on whose latest run proved nothing. */
    inconclusive: number;
  };
  /** The build loop's gate (what the coding agent works toward): open is not released. */
  gateOpen: boolean;
  /** The exit code of a `holdback run` that ends here with no other stop: 0 released, 2 tampered, 3 held back. */
  exit: 0 | 2 | 3;
};

const n = (k: number, one: string, many: string) => `${k} ${k === 1 ? one : many}`;

/**
 * The verdict on `state`. `tampered`: a tamper the ledger alone does not show (the TAMPERED marker,
 * sealed files changed on disk); the ledger's own tamper always counts.
 */
export function verdict(state: LedgerState, opts: { tampered?: boolean } = {}): Verdict {
  const g = gate(state);
  const all = Object.values(state.acs);
  const count = (s: string) => all.filter((a) => a.status === s).length;
  const rejected = count("rejected");
  const counts: Verdict["counts"] = {
    criteria: all.length - rejected,
    green: count("proved") + count("passing"),
    proved: count("proved"),
    passing: count("passing"),
    owed: count("owed"),
    regressed: count("regressed"),
    vacuous: count("vacuous"),
    needsSpec: count("needs-spec"),
    rejected,
    inconclusive: g.inconclusive.length,
  };
  const tampered = g.tampered || opts.tampered === true;
  const gateOpen = g.allowStop && all.length > 0 && !tampered;
  const parts: string[] = [];
  let state_: VerdictState;
  if (tampered) {
    state_ = "tampered";
    parts.push("tampered: nothing counts until a human re-seals");
  } else if (counts.criteria === 0) {
    state_ = "empty";
    parts.push("no criteria yet");
  } else {
    parts.push(`${counts.green}/${counts.criteria} green`);
    const owed = counts.owed + counts.regressed;
    if (owed > 0) parts.push(`${owed} owed${counts.regressed > 0 ? ` (${counts.regressed} regressed)` : ""}`);
    if (counts.vacuous > 0) parts.push(`${n(counts.vacuous, "criterion", "criteria")} unproved: a planted bug survived`);
    if (counts.needsSpec > 0) parts.push(`${n(counts.needsSpec, "criterion", "criteria")} with no test`);
    if (counts.inconclusive > 0) parts.push(`${n(counts.inconclusive, "test", "tests")} proved nothing on the last run`);
    state_ = gateOpen && counts.green === counts.criteria ? "released" : "held-back";
    if (state_ === "released") parts.push(`${counts.proved}/${counts.criteria} proved`);
  }
  const released = state_ === "released";
  const word = released ? "Released" : "Held back";
  return { state: state_, released, word, headline: `${word} — ${parts.join(", ")}`, parts, counts, gateOpen, exit: released ? 0 : tampered ? 2 : 3 };
}
