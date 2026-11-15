import type { AcState, LedgerState } from "./types.js";

export function gate(state: LedgerState): {
  allowStop: boolean;
  /** A tamper is on record with no fresh seal after it: the gate stays shut whatever the ACs say. */
  tampered: boolean;
  owed: AcState[];
  regressed: AcState[];
  vacuous: AcState[];
  needsSpec: AcState[];
} {
  const all = Object.values(state.acs);
  const by = (s: AcState["status"]) => all.filter((a) => a.status === s);
  const owed = by("owed");
  const regressed = by("regressed");
  const tampered = state.tampered === true;
  return {
    allowStop: !tampered && owed.length === 0 && regressed.length === 0,
    tampered,
    owed,
    regressed,
    vacuous: by("vacuous"),
    needsSpec: by("needs-spec"),
  };
}
