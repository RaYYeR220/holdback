import { gate } from "./gate.js";
import type { LedgerState, RunStop } from "./types.js";

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
  /** The reasons among `parts` that are not about the criteria: the last run's stop, a spec change, the cap. */
  stops: string[];
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
  /**
   * The exit code `holdback run` ends with here: 0 released, 2 tampered, the last run's own code when
   * it stopped short (3, 1 or 130), else 3 held back.
   */
  exit: number;
};

/** The last run's stop, in plain words. */
const STOPPED: Record<RunStop, string> = {
  disputed: "the agent disputes Kane's report: review it",
  "kane-budget": "the last run stopped: the Kane credit cap was reached",
  drift: "the last run stopped: the spec changed",
  inconclusive: "the last run stopped: Kane could not finish checking a test",
  "max-turns": "the last run stopped at the turn limit",
  aborted: "the last run was interrupted",
  error: "the last run stopped on an error",
};

const n = (k: number, one: string, many: string) => `${k} ${k === 1 ? one : many}`;

/** The last run's stop in plain words; a dispute names the criteria whose report the agent disputes. */
const stopText = (state: LedgerState, stop: RunStop): string =>
  stop === "disputed" && state.disputed && state.disputed.acs.length > 0 ? `the agent disputes Kane's report on ${state.disputed.acs.join(", ")}: review it` : STOPPED[stop];

/**
 * The verdict on `state`, from the same facts that pick `holdback run`'s exit code (N-1). What the
 * ledger alone does not show comes in `opts`: `tampered` (the TAMPERED marker, sealed files changed on
 * disk; the ledger's own tamper always counts), `specChanged` (a spec file differs from its seal: the
 * next run re-plans it first) and `capReached` (the project's Kane credit cap is spent). The last run's
 * stop (`state.stopped`) holds it back with that run's exit code.
 */
export function verdict(state: LedgerState, opts: { tampered?: boolean; specChanged?: boolean; capReached?: boolean } = {}): Verdict {
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
  const stops: string[] = [];
  let state_: VerdictState;
  if (tampered) {
    state_ = "tampered";
    parts.push("tampered: nothing counts until a human re-seals");
  } else if (counts.criteria === 0) {
    state_ = "empty";
    parts.push("no criteria yet");
    if (state.stopped) stops.push(stopText(state, state.stopped.reason));
    parts.push(...stops);
  } else {
    parts.push(`${counts.green}/${counts.criteria} green`);
    const owed = counts.owed + counts.regressed;
    if (owed > 0) parts.push(`${owed} owed${counts.regressed > 0 ? ` (${counts.regressed} regressed)` : ""}`);
    if (counts.vacuous > 0) parts.push(`${n(counts.vacuous, "criterion", "criteria")} unproved: a planted bug survived`);
    if (counts.needsSpec > 0) parts.push(`${n(counts.needsSpec, "criterion", "criteria")} with no test`);
    if (counts.inconclusive > 0) parts.push(`${n(counts.inconclusive, "test", "tests")} proved nothing on the last run`);
    const stop = state.stopped?.reason;
    if (stop) stops.push(stopText(state, stop));
    if (opts.specChanged && stop !== "drift") stops.push("the spec changed since the last seal");
    if (opts.capReached && stop !== "kane-budget") stops.push("the Kane credit cap is reached");
    parts.push(...stops);
    state_ = gateOpen && counts.green === counts.criteria && !stop && !opts.specChanged && !opts.capReached ? "released" : "held-back";
    if (state_ === "released") parts.push(`${counts.proved}/${counts.criteria} proved`);
  }
  const released = state_ === "released";
  const word = released ? "Released" : "Held back";
  const exit = released ? 0 : tampered ? 2 : (state.stopped?.exit ?? 3);
  return { state: state_, released, word, headline: `${word} — ${parts.join(", ")}`, parts, stops, counts, gateOpen, exit };
}
