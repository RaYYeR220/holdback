import { loadProject } from "@holdback/core";
import { EXIT, snapshot, type Ctx } from "./context.js";

const pad = (s: string, n: number) => s + " ".repeat(Math.max(0, n - s.length));
const oneLine = (s: string) => s.replace(/\s+/g, " ").trim();

export async function statusCmd(ctx: Ctx, o: { json?: boolean }): Promise<number> {
  const p = await loadProject(ctx.cwd);
  const s = await snapshot(p);
  // no criteria is not an open gate: nothing has been proved
  const open = s.gate.allowStop && Object.keys(s.state.acs).length > 0;
  const ids = (l: { id: string }[]) => l.map((a) => a.id);

  if (o.json) {
    ctx.out(
      JSON.stringify(
        {
          state: s.state,
          gate: {
            open,
            tampered: s.gate.tampered,
            owed: ids(s.gate.owed),
            regressed: ids(s.gate.regressed),
            vacuous: ids(s.gate.vacuous),
            needsSpec: ids(s.gate.needsSpec),
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
  ctx.out(`Gate: ${open ? "open" : "closed"} | owed ${s.gate.owed.length + s.gate.regressed.length} | turn ${s.state.turn} | Kane credits ${s.state.credits} | breaker $${s.state.breakerUsd.toFixed(4)}`);
  if (s.specChanged.length > 0) ctx.out(`The spec changed since the last seal (${s.specChanged.join(", ")}): \`holdback run\` runs drift first.`);
  if (s.tamper !== null) {
    ctx.err(s.tamper);
    return EXIT.tamper;
  }
  return EXIT.ok;
}
