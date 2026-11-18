import type { LedgerEvent } from "./types.js";

/**
 * A planted bug set aside before it could count against a criterion's tests: `no-op`, its patch
 * changes no code; `referee`, it got past the tests but the referee did not confirm it visibly breaks
 * the criterion (`rejudged`: a survivor from before the referee, rejected by it in a later pass);
 * `kane`, Kane disputed it (its evolve paused on `why`, Kane's question, in use case `uc`).
 */
export type SetAside = { ac: string; mutant: string; by: "no-op" | "referee" | "kane"; why: string; uc?: string; rejudged?: true };

/**
 * Per criterion, its latest planted bug when that one was set aside, by criterion id. None of them
 * is vacuous for it (the verdict counts only a confirmed survivor). Their reasons never name what a
 * confirmed survivor slipped past (the target of a hidden test, I-4), so `status` may print them. Pure.
 */
export function setAside(events: LedgerEvent[]): SetAside[] {
  const latest = new Map<string, Extract<LedgerEvent, { t: "mutant" }>>();
  const disputed = new Map<string, Extract<LedgerEvent, { t: "falsify.disputed" }>>();
  /** The referee's latest judgment of a survivor, logged after it (`mutant.referee`), by mutant id. */
  const judged = new Map<string, Extract<LedgerEvent, { t: "mutant.referee" }>>();
  for (const e of events) {
    if (e.t === "mutant") latest.set(e.ac, e);
    else if (e.t === "falsify.disputed") disputed.set(e.mutant, e);
    else if (e.t === "mutant.referee" && e.referee) judged.set(e.mutant, e);
  }
  const out: SetAside[] = [];
  for (const [ac, m] of latest) {
    const d = disputed.get(m.id);
    const j = judged.get(m.id);
    if (d) out.push({ ac, mutant: m.id, by: "kane", why: d.question, uc: d.uc });
    else if (m.refuted) out.push({ ac, mutant: m.id, by: m.refuted, why: m.note ?? "" });
    else if (j?.referee && !j.referee.confirmed) out.push({ ac, mutant: m.id, by: "referee", why: j.note ?? "", rejudged: true });
  }
  return out.sort((a, b) => a.ac.localeCompare(b.ac, undefined, { numeric: true }));
}
