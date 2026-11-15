import { loadProject } from "@holdback/core";
import { EXIT, explainFailure, type Ctx } from "./context.js";

/** The safe way to clear falsify and bisect worktrees: their node_modules links get unlinked first. */
export async function cleanCmd(ctx: Ctx): Promise<number> {
  const p = await loadProject(ctx.cwd);
  try {
    await ctx.deps.sweepStaleWorktrees(p);
    ctx.out("Cleared leftover mutant and bisect worktrees.");
    return EXIT.ok;
  } catch (e) {
    return await explainFailure(ctx, e, p);
  }
}
