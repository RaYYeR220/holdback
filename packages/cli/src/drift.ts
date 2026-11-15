import { loadProject } from "@holdback/core";
import { EXIT, explainFailure, ledgerLog, refuseInsideClaudeCode, withCheckLock, type Ctx } from "./context.js";

/** After a spec edit: Kane plans what changed, the human approves, the new criteria are owed. */
export async function driftCmd(ctx: Ctx): Promise<number> {
  if (refuseInsideClaudeCode(ctx, "holdback drift")) return EXIT.error;
  const p = await loadProject(ctx.cwd);
  const io = ctx.deps.humanIO();
  try {
    let r!: Awaited<ReturnType<typeof ctx.deps.runDrift>>;
    const locked = await withCheckLock(ctx, p, async () => {
      r = await ctx.deps.runDrift(p, io, ledgerLog(p));
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
