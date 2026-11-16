import { loadProject } from "@holdback/core";
import { EXIT, explainFailure, ledgerLog, openHumanIO, parseKaneCap, refuseInsideClaudeCode, snapshot, withCheckLock, type Ctx } from "./context.js";

export type SpecOptions = { answers?: string; dashboard?: boolean; port?: string; kaneCap?: string };

/** Kane designs acceptance criteria from the spec; the human answers and approves; then the seal. */
export async function specCmd(ctx: Ctx, o: SpecOptions = {}): Promise<number> {
  if (refuseInsideClaudeCode(ctx, "holdback spec")) return EXIT.error;
  const p = await loadProject(ctx.cwd);
  const io = await openHumanIO(ctx, p, o.answers, o);
  try {
    const locked = await withCheckLock(ctx, p, async () => {
      const kaneCap = parseKaneCap(o.kaneCap);
      await ctx.deps.runSpecStage(p, io, ledgerLog(p), { balance: ctx.deps.balance, warn: ctx.err, ...(kaneCap === undefined ? {} : { kaneCap }) });
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
    // rehearsal issue 7: criteria sealed with no test, and why: Kane's design cap, or nothing in the spec to test them by
    const bare = Object.values(s.state.acs).filter((a) => a.status === "needs-spec");
    if (bare.length > 0) {
      const byWhy = new Map<string, string[]>();
      for (const a of bare) byWhy.set(a.reason ?? "", [...(byWhy.get(a.reason ?? "") ?? []), a.id]);
      for (const [why, ids] of byWhy) {
        const what = !why
          ? `Kane designed no test for ${ids.length === 1 ? "it" : "them"}.`
          : why.startsWith("no test designed (design cap")
            ? `${why}. kane.designMax caps the tests Kane designs per use case.`
            : `${why}.`;
        ctx.out(`${ids.length} sealed without a test (${ids.join(", ")}): ${what}`);
      }
      ctx.out("They stay unproved: `holdback run` ends held back while a criterion has no test.");
    }
    return EXIT.ok;
  } catch (e) {
    return await explainFailure(ctx, e, p);
  } finally {
    io.close();
  }
}
