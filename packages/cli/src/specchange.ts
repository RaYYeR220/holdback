import { settleSpecChange, type Project } from "@holdback/core";
import { EXIT, ledgerLog, showSpecDiff, snapshot, type Ctx } from "./context.js";
import { driftNotice, tamperMessage, unverifiedDrift } from "./messages.js";

/**
 * What the review before a drift decided: `stop` with an exit code, or go on with `reviewed`, the
 * sha256 of each changed spec file as its diff was shown (N-I2): drift re-plans and seals only those
 * bytes. `reviewed` is undefined when the spec is not what changed.
 */
export type SpecReview = { stop: number } | { reviewed?: Record<string, string> };

/**
 * Before a drift re-plans a spec change (`run`, `watch`, `drift`): Holdback classes it and logs what
 * it found (R38). A write at the spec the guard logged since the seal makes it a tamper (exit 2). The
 * human always sees the diff from the sealed spec. One not known to be theirs (an agent turn ran
 * since the seal, or it was ever seen as unverified) goes ahead only on their explicit yes in the
 * terminal; an answers file or a flag never gives it. `allowUnverified: false` (`run`) stops with
 * exit 3 instead of asking.
 */
export async function reviewSpecChange(ctx: Ctx, p: Project, opts: { allowUnverified: boolean }): Promise<SpecReview> {
  const c = await settleSpecChange(p, ledgerLog(p));
  if (c.kind === "none") return {};
  if (c.kind === "tamper") {
    ctx.err(tamperMessage(c.detail));
    return { stop: EXIT.tamper };
  }
  ctx.out(driftNotice(c.files));
  const reviewed = await showSpecDiff(ctx, p, await snapshot(p));
  if (!c.unverified) return { reviewed };
  ctx.err(unverifiedDrift(c.files));
  if (!opts.allowUnverified) return { stop: EXIT.unfinished };
  if (!(await ctx.deps.confirm("Is this change yours, for Kane to re-plan the criteria from? [y/N] "))) {
    ctx.err("Nothing applied. Undo the change if it is not yours, then save the spec again (or run `holdback drift` once you have reviewed it).");
    return { stop: EXIT.unfinished };
  }
  return { reviewed };
}

/**
 * Drift found the spec moved away from the bytes the human reviewed (N-I2): nothing was re-planned
 * or sealed, and the change is on record as unverified. Says so; exit 3.
 */
export function specMovedStop(ctx: Ctx, files: string[], reason: string): number {
  ctx.err(unverifiedDrift(files, reason));
  return EXIT.unfinished;
}
