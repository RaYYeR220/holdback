import { appMovedFrom, appPinOnDisk, appSealKey, holdbackGitOptions, isAppKeyOf, loadProject, readEvents, specChangeEvent, type Project } from "@holdback/core";
import { EXIT, explainFailure, humanView, ledgerLog, refuseInsideClaudeCode, snapshot, withCheckLock, type Ctx } from "./context.js";

/**
 * The human re-seal: accepts what is on disk now as the sealed state, which lifts a tamper. A spec
 * edit is never re-sealed here: alone it is drift (refused: `holdback drift`), and next to a tamper
 * the spec keeps its old hash, so Kane still re-plans it. The config and spec are sealed as they were
 * when the differences were listed (I-1): one that moves while the human decides is not re-sealed.
 */
export async function resealCmd(caller: Ctx, o: { yes?: boolean }): Promise<number> {
  // the marker carries hook tool names and the entries are file names others wrote (N-m7)
  const ctx = humanView(caller);
  if (refuseInsideClaudeCode(ctx, "holdback reseal")) return EXIT.error;
  const p = await loadProject(ctx.cwd);
  return withCheckLock(ctx, p, () => reseal(ctx, p, o));
}

/**
 * What the re-seal pins (I-1, n-1): the config as read now, a spec file the listing showed as
 * changed as read now (it keeps its old seal either way), and every other spec file at the hash the
 * manifest holds: a spec edit that landed after the snapshot is then seen as moved, never sealed.
 */
export function pinForReseal(onDisk: Record<string, string>, manifest: Record<string, string>, specKeys: string[], specChanged: string[]): Record<string, string> {
  const pin = { ...onDisk };
  for (const k of specKeys) if (!specChanged.includes(k)) pin[k] = manifest[k] ?? "absent";
  return pin;
}

async function reseal(ctx: Ctx, p: Project, o: { yes?: boolean }): Promise<number> {
  try {
    const s = await snapshot(p);
    if (!s.manifest) {
      ctx.err("Nothing is sealed yet: run `holdback spec` first.");
      return EXIT.error;
    }
    // I-1: the app-side files as they are now, while the human reads the list, are what the seal holds
    const pin = pinForReseal(await appPinOnDisk(p), s.manifest, p.config.spec.map((f) => appSealKey(f)), s.specChanged);
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
    const moved = await appMovedFrom(p, pin);
    if (moved.length > 0) {
      // a spec edited meanwhile is recorded as an unverified change; a config is a tamper already on record
      const specs = moved.filter((k) => p.config.spec.some((f) => isAppKeyOf(k, f))).map((k) => appSealKey(k).slice("app:".length));
      if (specs.length > 0) {
        const e = await specChangeEvent(p, await readEvents(p.ledgerFile), s.manifest, specs, true);
        if (e) await ledgerLog(p)({ at: new Date().toISOString(), ...e });
      }
      ctx.err(`${moved.join(", ")} changed while you decided: nothing was re-sealed. Look at it, then run \`holdback reseal\` again.`);
      return EXIT.unfinished;
    }
    // the spec's old hash stays: the edit still reads as drift, for Kane to re-plan
    const keep = Object.fromEntries(s.specChanged.map((k) => [k, s.manifest![k]!]));
    await ctx.deps.reseal(p, ledgerLog(p), await holdbackGitOptions(p.home), { keep, app: { ...pin, ...keep } });
    if (s.specChanged.length > 0) ctx.out(`The spec changed too (${s.specChanged.join(", ")}): it keeps its old seal, so \`holdback drift\` (or \`holdback run\`) re-plans it with Kane.`);
    ctx.out("Re-sealed. The gate reopens when Kane proves the criteria again: run `holdback run`.");
    return EXIT.ok;
  } catch (e) {
    return await explainFailure(ctx, e, p);
  }
}
