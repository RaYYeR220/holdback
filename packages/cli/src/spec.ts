import { loadProject } from "@holdback/core";
import { EXIT, explainFailure, ledgerLog, refuseInsideClaudeCode, snapshot, withCheckLock, type Ctx } from "./context.js";

/** Kane designs acceptance criteria from the spec; the human answers and approves; then the seal. */
export async function specCmd(ctx: Ctx): Promise<number> {
  if (refuseInsideClaudeCode(ctx, "holdback spec")) return EXIT.error;
  const p = await loadProject(ctx.cwd);
  const io = ctx.deps.humanIO();
  try {
    const locked = await withCheckLock(ctx, p, async () => {
      await ctx.deps.runSpecStage(p, io, ledgerLog(p));
      return EXIT.ok;
    });
    if (locked !== EXIT.ok) return locked;
    const s = await snapshot(p);
    if (!s.manifest) {
      ctx.err("Spec stage ended without a seal — nothing to build yet.");
      return EXIT.error;
    }
    const n = Object.keys(s.state.acs).length;
    ctx.out(`Sealed ${n} acceptance ${n === 1 ? "criterion" : "criteria"}. Next: \`holdback run\`.`);
    return EXIT.ok;
  } catch (e) {
    return await explainFailure(ctx, e, p);
  } finally {
    io.close();
  }
}
