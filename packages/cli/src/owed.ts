import { buildBrief, loadProject } from "@holdback/core";
import { EXIT, snapshot, type Ctx } from "./context.js";

/** Prints the brief the coding agent would get next. */
export async function owedCmd(ctx: Ctx): Promise<number> {
  const p = await loadProject(ctx.cwd);
  const s = await snapshot(p);
  ctx.out(buildBrief(s.state, { notes: p.config.agentNotes }));
  if (s.tamper !== null) {
    ctx.err(s.tamper);
    return EXIT.tamper;
  }
  return EXIT.ok;
}
