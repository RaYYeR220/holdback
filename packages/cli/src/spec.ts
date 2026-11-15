import { loadProject } from "@holdback/core";
import { EXIT, explainFailure, ledgerLog, snapshot, type Ctx } from "./context.js";

/** Kane designs acceptance criteria from the spec; the human answers and approves; then the seal. */
export async function specCmd(ctx: Ctx): Promise<number> {
  const p = await loadProject(ctx.cwd);
  const io = ctx.deps.humanIO();
  try {
    await ctx.deps.runSpecStage(p, io, ledgerLog(p));
    const s = await snapshot(p);
    const n = Object.keys(s.state.acs).length;
    ctx.out(`Sealed ${n} acceptance ${n === 1 ? "criterion" : "criteria"}. Next: \`holdback run\`.`);
    return EXIT.ok;
  } catch (e) {
    return await explainFailure(ctx, e, p);
  } finally {
    io.close();
  }
}
