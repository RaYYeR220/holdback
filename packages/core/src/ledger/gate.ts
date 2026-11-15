import type { AcState, LedgerState } from "./types.js";

export function gate(state: LedgerState): {
  allowStop: boolean;
  owed: AcState[];
  regressed: AcState[];
  vacuous: AcState[];
  needsSpec: AcState[];
} {
  const all = Object.values(state.acs);
  const by = (s: AcState["status"]) => all.filter((a) => a.status === s);
  const owed = by("owed");
  const regressed = by("regressed");
  return { allowStop: owed.length === 0 && regressed.length === 0, owed, regressed, vacuous: by("vacuous"), needsSpec: by("needs-spec") };
}
