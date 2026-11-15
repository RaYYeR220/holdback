import { holdbackGitOptions, loadProject, type Project } from "@holdback/core";
import { EXIT, explainFailure, ledgerLog, refuseInsideClaudeCode, snapshot, withCheckLock, type Ctx } from "./context.js";

/**
 * The human re-seal: accepts what is on disk now as the sealed state, which lifts a tamper. A spec
 * edit is never re-sealed here: alone it is drift (refused: `holdback drift`), and next to a tamper
 * the spec keeps its old hash, so Kane still re-plans it.
 */
export async function resealCmd(ctx: Ctx, o: { yes?: boolean }): Promise<number> {
  if (refuseInsideClaudeCode(ctx, "holdback reseal")) return EXIT.error;
  const p = await loadProject(ctx.cwd);
  return withCheckLock(ctx, p, () => reseal(ctx, p, o));
}

async function reseal(ctx: Ctx, p: Project, o: { yes?: boolean }): Promise<number> {
  try {
    const s = await snapshot(p);
    if (!s.manifest) {
      ctx.err("Nothing is sealed yet: run `holdback spec` first.");
      return EXIT.error;
    }
    const differ = [...s.specChanged, ...s.changed].sort();
    if (s.tamper === null && s.specChanged.length > 0) {
      ctx.err(`Only the spec changed since the last seal (${s.specChanged.join(", ")}): that is drift, not a tamper, and a re-seal would skip Kane's re-plan.`);
      ctx.err("Run `holdback drift` (or `holdback run`, which runs it first) so Kane re-plans the criteria with you.");
      return EXIT.error;
    }
    if (s.marker !== null) ctx.out(`Tamper on record: ${s.marker}`);
    ctx.out(differ.length > 0 ? `Sealed entries that differ from the last seal:\n${differ.map((d) => `  ${d}`).join("\n")}` : "No sealed entry differs from the last seal.");
    ctx.out("Before you re-seal, inspect those files and restore anything you did not change yourself, including .git/config and any changed test or spec files.");
    ctx.out("Re-sealing accepts what is on disk now as the sealed state.");
    if (!o.yes && !(await ctx.deps.confirm("Re-seal now? [y/N] "))) {
      ctx.err("Not re-sealed.");
      return EXIT.error;
    }
    // the spec's old hash stays: the edit still reads as drift, for Kane to re-plan
    const keep = Object.fromEntries(s.specChanged.map((k) => [k, s.manifest![k]!]));
    await ctx.deps.reseal(p, ledgerLog(p), await holdbackGitOptions(p.home), { keep });
    if (s.specChanged.length > 0) ctx.out(`The spec changed too (${s.specChanged.join(", ")}): it keeps its old seal, so \`holdback drift\` (or \`holdback run\`) re-plans it with Kane.`);
    ctx.out("Re-sealed. The gate reopens when Kane proves the criteria again: run `holdback run`.");
    return EXIT.ok;
  } catch (e) {
    return await explainFailure(ctx, e, p);
  }
}
