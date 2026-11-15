import { buildBrief, evidenceScreenshot, loadProject } from "@holdback/core";
import { EXIT, explainFailure, humanView, readerView, snapshot, type Ctx } from "./context.js";

/** Prints the brief the coding agent would get next. */
export async function owedCmd(caller: Ctx): Promise<number> {
  const p = await loadProject(caller.cwd);
  const ctx = humanView(readerView(caller, p));
  let s: Awaited<ReturnType<typeof snapshot>>;
  try {
    s = await snapshot(p);
  } catch (e) {
    return await explainFailure(ctx, e);
  }
  // the brief as the agent gets it: a screenshot is its kane-evidence copy, never Kane's temp file (M15)
  ctx.out(buildBrief(s.state, { notes: p.config.agentNotes, spec: p.config.spec, start: p.config.start.cmd, screenshot: evidenceScreenshot(p.appDir) }));
  if (s.tamper !== null) {
    ctx.err(s.tamper);
    return EXIT.tamper;
  }
  return EXIT.ok;
}
