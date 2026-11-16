import { notAnAppFailure } from "../kane/outcome.js";
import { eventCredits } from "./credits.js";
import type { AcState, LedgerEvent, LedgerState, RunKind } from "./types.js";

const round = (n: number) => Math.round(n * 1e4) / 1e4;

/** A run of this kind decides its criteria's status: a build check, or falsify's closing replay of the real build. */
export const decidesStatus = (kind: RunKind): boolean => kind === "build" || kind === "replay";

/** Pure reducer: ledger events -> state of every AC. Single source of truth for AC status. */
export function reduce(events: LedgerEvent[]): LedgerState {
  const state: LedgerState = {
    acs: {},
    turn: 0,
    credits: 0,
    kaneCredits: 0,
    kaneUnmeasured: 0,
    breakerUsd: 0,
    runs: 0,
    mutants: { killed: 0, survived: 0, invalid: 0 },
    inconclusive: [],
    tampered: false,
  };
  // latest build result per (ac, test): true = passed, false = failed
  const latest = new Map<string, Map<string, boolean>>();
  // per test, its latest build run when that run proved nothing
  const unsure = new Map<string, LedgerState["inconclusive"][number]>();
  // metered batches: balance drops (per-run sums where unreadable), and the per-run credits they cover
  let metered = 0;
  let covered = 0;

  const allPass = (ac: AcState): boolean => {
    const m = latest.get(ac.id);
    return ac.tests.length > 0 && !!m && ac.tests.every((t) => m.get(t) === true);
  };

  for (const e of events) {
    state.credits += eventCredits(e);
    switch (e.t) {
      // fail closed: a tamper blocks the gate until a fresh seal (spec stage or a human re-seal)
      case "tamper":
      case "falsify.evolve.stray":
        state.tampered = true;
        break;
      case "seal":
        if (state.tampered) {
          // results from before the tamper (possibly forged) do not survive the re-seal: verify again
          latest.clear();
          unsure.clear();
          for (const ac of Object.values(state.acs)) {
            if (ac.status !== "rejected") ac.status = ac.tests.length > 0 ? "owed" : "needs-spec";
            if (ac.status === "owed") delete ac.reason;
            delete ac.lastFailure;
          }
        }
        state.tampered = false;
        break;
      case "design": {
        for (const t of e.tests) unsure.delete(t.id); // a re-designed test starts over
        for (const ac of e.acs) latest.delete(ac.id); // AC may move between use cases: drop stale results
        for (const old of Object.values(state.acs)) {
          if (old.useCase === e.useCase) {
            delete state.acs[old.id];
            latest.delete(old.id);
          }
        }
        // I3: what the human turned down is never owed (a criterion) and never run (a test); a
        // criterion whose every test was turned down needs a better spec
        const rejected = new Set(e.rejected ?? []);
        for (const ac of e.acs) {
          const turnedDown = rejected.has(ac.id);
          const tests = turnedDown ? [] : e.tests.filter((t) => t.verifies.includes(ac.id) && !rejected.has(t.id)).map((t) => t.id);
          const note = e.notes?.[ac.id];
          state.acs[ac.id] = {
            id: ac.id,
            text: ac.text,
            useCase: ac.useCase,
            cites: ac.cites,
            tests,
            status: turnedDown ? "rejected" : tests.length > 0 ? "owed" : "needs-spec",
            ...(note !== undefined ? { reason: note } : {}),
          };
        }
        break;
      }
      case "credits":
        covered += e.perRunSum;
        if (typeof e.delta === "number") metered += e.delta;
        else {
          metered += e.perRunSum;
          state.kaneUnmeasured += 1;
        }
        break;
      case "turn.start":
        state.turn = Math.max(state.turn, e.n);
        break;
      case "run": {
        state.runs += 1;
        const r = e.result;
        if (!decidesStatus(e.kind) || r.testId == null) break;
        const testId = r.testId;
        // R34: a run that failed for a reason other than the app proves nothing either way, passes
        // included: every criterion keeps its status (and its last real failure, for the brief)
        const why = notAnAppFailure(r);
        if (why !== undefined) {
          unsure.set(testId, { test: testId, ...(e.turn !== undefined ? { turn: e.turn } : {}), reason: why });
          break;
        }
        unsure.delete(testId);
        const mark = (acId: string, passed: boolean) => {
          const ac = state.acs[acId];
          if (!ac || !ac.tests.includes(testId)) return;
          let m = latest.get(acId);
          if (!m) latest.set(acId, (m = new Map()));
          m.set(testId, passed);
          if (!passed) {
            ac.status = ac.status === "passing" || ac.status === "proved" ? "regressed" : "owed";
            delete ac.reason;
            ac.lastFailure = {
              test: testId,
              step: r.failedStep,
              stepText: r.failedStepText,
              verdict: r.verdict,
              screenshot: r.screenshot,
              turn: e.turn,
              ...(r.reason !== undefined ? { reason: r.reason } : {}),
            };
          } else if ((ac.status === "owed" || ac.status === "regressed") && allPass(ac)) {
            ac.status = "passing";
            delete ac.lastFailure;
            delete ac.reason;
          }
        };
        if (r.criteriaPassed.length === 0 && r.criteriaFailed.length === 0) {
          // no coverage info (timeout, crash, skipped coverage): fall back to the test's own verifies
          const verified = Object.values(state.acs)
            .filter((a) => a.tests.includes(testId))
            .map((a) => a.id);
          for (const id of verified) mark(id, r.status === "passed");
        } else {
          // passes first so a contradictory result listing an AC in both lists ends up failed
          for (const id of r.criteriaPassed) mark(id, true);
          for (const id of r.criteriaFailed) mark(id, false);
        }
        break;
      }
      case "mutant": {
        state.breakerUsd += e.usd;
        if (e.verdict === "killed") state.mutants.killed += 1;
        else if (e.verdict === "invalid") state.mutants.invalid += 1;
        else state.mutants.survived += 1;
        const ac = state.acs[e.ac];
        if (!ac) break;
        const green = ac.status === "passing" || ac.status === "proved";
        if (e.verdict === "killed") {
          if (ac.status === "passing") ac.status = "proved";
          delete ac.reason;
        } else if (e.recheck !== undefined) {
          // R40: the planted bug that got past the old tests, re-planted against Kane's evolved ones,
          // must now be killed; anything else (it survived, or it proved nothing) fails closed
          if (green) {
            ac.status = "vacuous";
            ac.reason =
              e.verdict === "invalid"
                ? `the planted bug that got past the old tests could not be re-checked against the new ones${e.note ? ` (${e.note})` : ""}`
                : "the planted bug that got past the old tests got past the new tests too";
          }
        } else if (e.verdict !== "invalid") {
          // only a green AC can be vacuous; never mask owed/regressed (would open the gate)
          if (green) ac.status = "vacuous";
        }
        break;
      }
      case "run.end":
        if (e.stop) state.stopped = { reason: e.stop, exit: e.exit ?? 1, ...(e.detail !== undefined ? { detail: e.detail } : {}) };
        else delete state.stopped;
        break;
      case "redesign.dropped":
        // an evolve that added no test: its survivors stay vacuous, and the human is told why
        for (const id of e.acs ?? []) {
          const ac = state.acs[id];
          if (ac?.status === "vacuous") ac.reason = e.reason ?? e.detail;
        }
        break;
      default:
        break;
    }
  }
  state.credits = round(state.credits);
  // per-run credits logged outside any metered batch (an older ledger) count as they are
  state.kaneCredits = round(metered + Math.max(0, state.credits - covered));
  // only tests some criterion still runs
  const live = new Set(Object.values(state.acs).flatMap((a) => a.tests));
  state.inconclusive = [...unsure.values()].filter((u) => live.has(u.test));
  return state;
}
