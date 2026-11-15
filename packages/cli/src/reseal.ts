import { checkSeal, holdbackGitOptions, loadProject } from "@holdback/core";
import { EXIT, explainFailure, ledgerLog, snapshot, type Ctx } from "./context.js";

/** The human re-seal: accepts what is on disk now as the sealed state, which lifts a tamper. */
export async function resealCmd(ctx: Ctx, o: { yes?: boolean }): Promise<number> {
  const p = await loadProject(ctx.cwd);
  try {
    const s = await snapshot(p);
    if (!s.manifest) {
      ctx.err("Nothing is sealed yet: run `holdback spec` first.");
      return EXIT.error;
    }
    const differ = await checkSeal(p.verifierDir, s.manifest, p.appDir);
    if (s.marker !== null) ctx.out(`Tamper on record: ${s.marker}`);
    ctx.out(differ.length > 0 ? `Sealed entries that differ from the last seal:\n${differ.map((d) => `  ${d}`).join("\n")}` : "No sealed entry differs from the last seal.");
    ctx.out("Before you re-seal, inspect those files and restore anything you did not change yourself, including .git/config and any changed test or spec files.");
    ctx.out("Re-sealing accepts what is on disk now as the sealed state.");
    if (!o.yes && !(await ctx.deps.confirm("Re-seal now? [y/N] "))) {
      ctx.err("Not re-sealed.");
      return EXIT.error;
    }
    await ctx.deps.reseal(p, ledgerLog(p), await holdbackGitOptions(p.home));
    ctx.out("Re-sealed. The gate reopens when Kane proves the criteria again: run `holdback run`.");
    return EXIT.ok;
  } catch (e) {
    return await explainFailure(ctx, e, p);
  }
}
