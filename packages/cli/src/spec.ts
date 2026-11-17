import { loadProject, type LedgerEvent } from "@holdback/core";
import { EXIT, explainFailure, humanView, ledgerLog, openHumanIO, parseKaneCap, refuseInsideClaudeCode, snapshot, withCheckLock, type Ctx } from "./context.js";

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
    printDesignNotes(humanView(ctx), s.events);
    return EXIT.ok;
  } catch (e) {
    return await explainFailure(ctx, e, p);
  } finally {
    io.close();
  }
}

const oneLine = (t: string) => t.replace(/\s+/g, " ").trim();

/**
 * What the human should know about the design they sealed, beyond the criteria: the gaps Kane left
 * in it (its latest design of each use case; kind, header and question), the imports Holdback
 * repaired in Kane's tests, and the test variables they filled (names only).
 */
function printDesignNotes(ctx: Ctx, events: LedgerEvent[]): void {
  const latest = new Map<string, Extract<LedgerEvent, { t: "design" }>>();
  for (const e of events) if (e.t === "design") latest.set(e.useCase, e);
  const gaps = new Map<string, string>();
  for (const d of latest.values()) {
    // a gap Kane's store said nothing about (its id alone, as in the first live run) is left out
    for (const g of d.gaps) {
      if (!g.question) continue;
      const what = `${g.question.header || g.title}${g.question.prompt ? `: ${g.question.prompt}` : ""}`;
      gaps.set(g.id, `  ${g.id} [${g.kind}] ${oneLine(what)}`);
    }
  }
  if (gaps.size > 0) {
    ctx.out(`Kane left ${gaps.size} ${gaps.size === 1 ? "gap" : "gaps"} in its design (nothing tests ${gaps.size === 1 ? "it" : "them"}):`);
    for (const line of gaps.values()) ctx.out(line);
  }
  const repaired = events.filter((e): e is Extract<LedgerEvent, { t: "spec.repaired" }> => e.t === "spec.repaired");
  if (repaired.length > 0) {
    const where = repaired.map((r) => `${r.file} line ${r.line} (${r.to})`).join("; ");
    ctx.out(`Holdback repaired ${repaired.length} broken ${repaired.length === 1 ? "import" : "imports"} Kane wrote: ${where}.`);
  }
  const filled = [...new Set(events.flatMap((e) => (e.t === "spec.variables" ? e.names : [])))];
  if (filled.length > 0) ctx.out(`You filled ${filled.length} test ${filled.length === 1 ? "variable" : "variables"} Kane left empty: ${filled.join(", ")}.`);
}
