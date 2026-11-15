import { latestSpecChange, loadProject } from "@holdback/core";
import { EXIT, explainFailure, ledgerLog, openHumanIO, refuseInsideClaudeCode, showSpecDiff, snapshot, withCheckLock, type Ctx } from "./context.js";
import { driftNotice, unverifiedDrift } from "./messages.js";

/**
 * After a spec edit: Kane plans what changed, the human approves, the new criteria are owed. The
 * human always sees the diff from the sealed spec first; a change Holdback first saw while the coding
 * agent was working must be accepted in the terminal, whatever `--answers` says (R37).
 */
export async function driftCmd(ctx: Ctx, o: { answers?: string; dashboard?: boolean; port?: string } = {}): Promise<number> {
  if (refuseInsideClaudeCode(ctx, "holdback drift")) return EXIT.error;
  const p = await loadProject(ctx.cwd);
  const io = await openHumanIO(ctx, p, o.answers, o);
  try {
    let r!: Awaited<ReturnType<typeof ctx.deps.runDrift>>;
    const locked = await withCheckLock(ctx, p, async () => {
      const s = await snapshot(p);
      if (s.tamper === null && s.specChanged.length > 0) {
        ctx.out(driftNotice(s.specChanged));
        await showSpecDiff(ctx, p, s);
        if (latestSpecChange(s.events)?.duringAgentTurn) {
          ctx.err(unverifiedDrift(s.specChanged));
          if (!(await ctx.deps.confirm("Is this change yours, for Kane to re-plan the criteria from? [y/N] "))) {
            ctx.err("Nothing applied. Undo the change, or run `holdback drift` again once you have reviewed it.");
            return EXIT.error;
          }
        }
      }
      r = await ctx.deps.runDrift(p, io, ledgerLog(p), { balance: ctx.deps.balance, warn: ctx.err });
      return EXIT.ok;
    });
    if (locked !== EXIT.ok) return locked;
    if (!r.changed) ctx.out("The spec has not changed since the last seal.");
    else if (r.applied) ctx.out("Spec change applied and sealed. Run `holdback run` to build what is now owed.");
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
