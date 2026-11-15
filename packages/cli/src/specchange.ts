import { settleSpecChange, type Project } from "@holdback/core";
import { EXIT, ledgerLog, showSpecDiff, snapshot, type Ctx } from "./context.js";
import { driftNotice, tamperMessage, unverifiedDrift } from "./messages.js";

/**
 * Before a drift re-plans a spec change (`run`, `watch`, `drift`): Holdback classes it and logs what
 * it found (R38). A write at the spec the guard logged since the seal makes it a tamper (exit 2). The
 * human always sees the diff from the sealed spec. One not known to be theirs (an agent turn ran
 * since the seal, or it was ever seen as unverified) goes ahead only on their explicit yes in the
 * terminal; an answers file or a flag never gives it. `allowUnverified: false` (`run`) stops with
 * exit 3 instead of asking. Returns the exit code to stop with, or undefined to go on.
 */
export async function reviewSpecChange(ctx: Ctx, p: Project, opts: { allowUnverified: boolean }): Promise<number | undefined> {
  const c = await settleSpecChange(p, ledgerLog(p));
  if (c.kind === "none") return undefined;
  if (c.kind === "tamper") {
    ctx.err(tamperMessage(c.detail));
    return EXIT.tamper;
  }
  ctx.out(driftNotice(c.files));
  await showSpecDiff(ctx, p, await snapshot(p));
  if (!c.unverified) return undefined;
  ctx.err(unverifiedDrift(c.files));
  if (!opts.allowUnverified) return EXIT.unfinished;
  if (!(await ctx.deps.confirm("Is this change yours, for Kane to re-plan the criteria from? [y/N] "))) {
    ctx.err("Nothing applied. Undo the change if it is not yours, then save the spec again (or run `holdback drift` once you have reviewed it).");
    return EXIT.unfinished;
  }
  return undefined;
}
