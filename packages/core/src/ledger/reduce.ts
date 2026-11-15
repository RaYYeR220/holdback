import type { AcState, LedgerEvent, LedgerState } from "./types.js";

/** Pure reducer: ledger events -> state of every AC. Single source of truth for AC status. */
export function reduce(events: LedgerEvent[]): LedgerState {
  const state: LedgerState = {
    acs: {},
    turn: 0,
    credits: 0,
    breakerUsd: 0,
    runs: 0,
    mutants: { killed: 0, survived: 0, invalid: 0 },
  };
  // latest build result per (ac, test): true = passed, false = failed
  const latest = new Map<string, Map<string, boolean>>();

  const allPass = (ac: AcState): boolean => {
    const m = latest.get(ac.id);
    return ac.tests.length > 0 && !!m && ac.tests.every((t) => m.get(t) === true);
  };

  for (const e of events) {
    switch (e.t) {
      case "design": {
        state.credits += e.credits;
        for (const old of Object.values(state.acs)) {
          if (old.useCase === e.useCase) {
            delete state.acs[old.id];
            latest.delete(old.id);
          }
        }
        for (const ac of e.acs) {
          const tests = e.tests.filter((t) => t.verifies.includes(ac.id)).map((t) => t.id);
          state.acs[ac.id] = {
            id: ac.id,
            text: ac.text,
            useCase: ac.useCase,
            cites: ac.cites,
            tests,
            status: tests.length > 0 ? "owed" : "needs-spec",
          };
        }
        break;
      }
      case "turn.start":
        state.turn = Math.max(state.turn, e.n);
        break;
      case "run": {
        state.runs += 1;
        const r = e.result;
        state.credits += r.credits;
        if (e.kind !== "build" || r.testId == null) break;
        const testId = r.testId;
        const mark = (acId: string, passed: boolean) => {
          const ac = state.acs[acId];
          if (!ac || !ac.tests.includes(testId)) return;
          let m = latest.get(acId);
          if (!m) latest.set(acId, (m = new Map()));
          m.set(testId, passed);
          if (!passed) {
            ac.status = ac.status === "passing" || ac.status === "proved" ? "regressed" : "owed";
            ac.lastFailure = {
              test: testId,
              step: r.failedStep,
              stepText: r.failedStepText,
              verdict: r.verdict,
              screenshot: r.screenshot,
              turn: e.turn,
            };
          } else if ((ac.status === "owed" || ac.status === "regressed") && allPass(ac)) {
            ac.status = "passing";
            delete ac.lastFailure;
          }
        };
        // passes first so a contradictory result listing an AC in both lists ends up failed
        for (const id of r.criteriaPassed) mark(id, true);
        for (const id of r.criteriaFailed) mark(id, false);
        break;
      }
      case "mutant": {
        state.breakerUsd += e.usd;
        if (e.verdict === "killed") state.mutants.killed += 1;
        else if (e.verdict === "invalid") state.mutants.invalid += 1;
        else state.mutants.survived += 1;
        const ac = state.acs[e.ac];
        if (!ac) break;
        if (e.verdict === "killed") {
          if (ac.status === "passing") ac.status = "proved";
        } else if (e.verdict !== "invalid") {
          // only a green AC can be vacuous; never mask owed/regressed (would open the gate)
          if (ac.status === "passing" || ac.status === "proved") ac.status = "vacuous";
        }
        break;
      }
      default:
        break;
    }
  }
  return state;
}
