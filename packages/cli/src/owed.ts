import { buildBrief, loadProject } from "@holdback/core";
import { EXIT, explainFailure, readerView, snapshot, type Ctx } from "./context.js";

/** Prints the brief the coding agent would get next. */
export async function owedCmd(caller: Ctx): Promise<number> {
  const p = await loadProject(caller.cwd);
  const ctx = readerView(caller, p);
  let s: Awaited<ReturnType<typeof snapshot>>;
  try {
    s = await snapshot(p);
  } catch (e) {
    return await explainFailure(ctx, e);
  }
  ctx.out(buildBrief(s.state, { notes: p.config.agentNotes }));
  if (s.tamper !== null) {
    ctx.err(s.tamper);
    return EXIT.tamper;
  }
  return EXIT.ok;
}
