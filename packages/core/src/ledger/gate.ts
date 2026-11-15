import type { AcState, LedgerState } from "./types.js";

export function gate(state: LedgerState): {
  allowStop: boolean;
  /** A tamper is on record with no fresh seal after it: the gate stays shut whatever the ACs say. */
  tampered: boolean;
  owed: AcState[];
  regressed: AcState[];
  vacuous: AcState[];
  needsSpec: AcState[];
  /** Criteria a human turned down when approving the design: never owed, never in the way of the gate. */
  rejected: AcState[];
  /**
   * Tests a criterion (other than a needs-spec one) depends on whose latest build run proved
   * nothing: the gate stays shut until Kane runs them conclusively, whatever the criteria's status.
   * For the human; the agent's brief never names them.
   */
  inconclusive: LedgerState["inconclusive"];
} {
  const all = Object.values(state.acs);
  const by = (s: AcState["status"]) => all.filter((a) => a.status === s);
  const owed = by("owed");
  const regressed = by("regressed");
  const tampered = state.tampered === true;
  const depended = new Set(all.filter((a) => a.status !== "needs-spec" && a.status !== "rejected").flatMap((a) => a.tests));
  const inconclusive = (state.inconclusive ?? []).filter((u) => depended.has(u.test));
  return {
    allowStop: !tampered && owed.length === 0 && regressed.length === 0 && inconclusive.length === 0,
    tampered,
    owed,
    regressed,
    vacuous: by("vacuous"),
    needsSpec: by("needs-spec"),
    rejected: by("rejected"),
    inconclusive,
  };
}
