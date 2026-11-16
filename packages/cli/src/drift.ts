import { loadProject } from "@holdback/core";
import { EXIT, explainFailure, humanView, ledgerLog, openHumanIO, parseKaneCap, refuseInsideClaudeCode, snapshot, withCheckLock, type Ctx } from "./context.js";
import { reviewSpecChange, specMovedStop } from "./specchange.js";

/**
 * After a spec edit: Kane plans what changed, the human approves, the new criteria are owed. The
 * human always sees the diff from the sealed spec first; a change not known to be theirs must be
 * accepted in the terminal, whatever `--answers` says (R37, R38). Kane re-plans, and the seal holds,
 * exactly the spec bytes whose diff the human saw: a spec that moves meanwhile stops drift (exit 3)
 * as an unverified change (N-I2).
 */
export async function driftCmd(caller: Ctx, o: { answers?: string; dashboard?: boolean; port?: string; kaneCap?: string } = {}): Promise<number> {
  const ctx = humanView(caller); // the diff and Kane's plan are text others wrote
  if (refuseInsideClaudeCode(ctx, "holdback drift")) return EXIT.error;
  const p = await loadProject(ctx.cwd);
  const io = await openHumanIO(ctx, p, o.answers, o);
  try {
    let r!: Awaited<ReturnType<typeof ctx.deps.runDrift>>;
    const locked = await withCheckLock(ctx, p, async () => {
      const s = await snapshot(p);
      let reviewed: Record<string, string> | undefined;
      let confirmed = false;
      if (s.tamper === null && s.specChanged.length > 0) {
        const review = await reviewSpecChange(ctx, p, { allowUnverified: true });
        if ("stop" in review) return review.stop === EXIT.unfinished ? EXIT.error : review.stop;
        reviewed = review.reviewed;
        confirmed = review.confirmed === true;
      }
      const kaneCap = parseKaneCap(o.kaneCap);
      r = await ctx.deps.runDrift(p, io, ledgerLog(p), {
        balance: ctx.deps.balance,
        warn: ctx.err,
        ...(kaneCap === undefined ? {} : { kaneCap }),
        // what the human reviewed, an empty review when nothing was shown: a spec that changed after
        // the check is never re-planned unseen (m-6)
        reviewed: reviewed ?? {},
        ...(confirmed ? { confirmed } : {}),
      });
      return EXIT.ok;
    });
    if (locked !== EXIT.ok) return locked;
    if (!r.changed) ctx.out("The spec has not changed since the last seal.");
    else if (r.applied) ctx.out("Spec change applied and sealed. Run `holdback run` to build what is now owed.");
    else if (r.specMoved) return specMovedStop(ctx, r.specMoved, r.reason);
    else {
      ctx.err(`Spec change not applied: ${r.reason}`);
      return EXIT.error;
    }
    return EXIT.ok;
  } catch (e) {
    return await explainFailure(ctx, e, p);
  } finally {
    io.close();
  }
}
