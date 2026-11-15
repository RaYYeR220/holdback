import { loadProject } from "@holdback/core";
import { EXIT, explainFailure, insideClaudeCode, readerView, snapshot, type Ctx } from "./context.js";
import { inconclusiveLine, kaneCreditsText } from "./messages.js";

const pad = (s: string, n: number) => s + " ".repeat(Math.max(0, n - s.length));
const oneLine = (s: string) => s.replace(/\s+/g, " ").trim();

export async function statusCmd(caller: Ctx, o: { json?: boolean }): Promise<number> {
  const p = await loadProject(caller.cwd);
  const ctx = readerView(caller, p);
  let s: Awaited<ReturnType<typeof snapshot>>;
  try {
    s = await snapshot(p);
  } catch (e) {
    return await explainFailure(ctx, e);
  }
  // no criteria is not an open gate: nothing has been proved
  const open = s.gate.allowStop && Object.keys(s.state.acs).length > 0;
  // the coding agent learns how many runs proved nothing, never which test or Kane's reason
  const agent = insideClaudeCode(caller);
  const ids = (l: { id: string }[]) => l.map((a) => a.id);

  if (o.json) {
    ctx.out(
      JSON.stringify(
        {
          state: agent ? { ...s.state, inconclusive: s.state.inconclusive.length } : s.state,
          gate: {
            open,
            tampered: s.gate.tampered,
            owed: ids(s.gate.owed),
            regressed: ids(s.gate.regressed),
            vacuous: ids(s.gate.vacuous),
            needsSpec: ids(s.gate.needsSpec),
            rejected: ids(s.gate.rejected),
            inconclusive: agent ? s.gate.inconclusive.length : s.gate.inconclusive.map((u) => u.test),
          },
          tamper: s.tamper === null ? null : { marker: s.marker, changed: s.changed },
          specChanged: s.specChanged,
        },
        null,
        2,
      ),
    );
    if (s.tamper !== null) ctx.err(s.tamper);
    return s.tamper === null ? EXIT.ok : EXIT.tamper;
  }

  const acs = Object.values(s.state.acs);
  if (acs.length === 0) {
    ctx.out("No acceptance criteria yet. Write your spec, then run `holdback spec`.");
  } else {
    const rows = acs.map((a) => ({
      id: a.id,
      status: a.status,
      tests: a.tests.join(", "),
      failure: a.lastFailure ? oneLine(a.lastFailure.verdict?.bugTitle ?? a.lastFailure.reason ?? `${a.lastFailure.test} failed`) : "",
    }));
    const w = (k: "id" | "status" | "tests", h: string) => Math.max(h.length, ...rows.map((r) => r[k].length));
    const [wi, ws, wt] = [w("id", "AC"), w("status", "STATUS"), w("tests", "TESTS")];
    ctx.out(`${pad("AC", wi)}  ${pad("STATUS", ws)}  ${pad("TESTS", wt)}  LAST FAILURE`);
    for (const r of rows) ctx.out(`${pad(r.id, wi)}  ${pad(r.status, ws)}  ${pad(r.tests, wt)}  ${r.failure}`.trimEnd());
  }
  ctx.out("");
  ctx.out(`Gate: ${open ? "open" : "closed"} | owed ${s.gate.owed.length + s.gate.regressed.length} | turn ${s.state.turn} | Kane credits ${kaneCreditsText(s.state)} | breaker $${s.state.breakerUsd.toFixed(4)}`);
  // the agent's count is what keeps the gate shut
  const unsure = agent ? inconclusiveLine(s.gate.inconclusive, true) : inconclusiveLine(s.state.inconclusive);
  if (unsure) ctx.out(unsure);
  if (s.specChanged.length > 0) ctx.out(`The spec changed since the last seal (${s.specChanged.join(", ")}): \`holdback run\` runs drift first.`);
  if (s.tamper !== null) {
    ctx.err(s.tamper);
    return EXIT.tamper;
  }
  return EXIT.ok;
}
