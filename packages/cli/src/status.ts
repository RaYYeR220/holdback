import { loadProject, retiredTests, type LedgerState } from "@holdback/core";
import { EXIT, explainFailure, humanView, jsonForTerminal, insideClaudeCode, readerView, snapshot, type Ctx } from "./context.js";
import { disputedLines, inconclusiveLine, kaneCreditsText, unsureLines } from "./messages.js";

/**
 * The ledger state as the coding agent may read it (`status --json` inside Claude Code): which tests
 * proved nothing, and why, reduced to counts, a stall's groups too, and no stop detail (it names them).
 */
function agentState(state: LedgerState): Record<string, unknown> {
  const { detail: _detail, ...stopped } = state.stopped ?? ({} as NonNullable<LedgerState["stopped"]>);
  return {
    ...state,
    inconclusive: state.inconclusive.length,
    ...(state.stopped ? { stopped } : {}),
    ...(state.stalled ? { stalled: { turns: state.stalled.turns, disputed: state.stalled.disputed.length, inconclusive: state.stalled.inconclusive.length } } : {}),
  };
}

const pad = (s: string, n: number) => s + " ".repeat(Math.max(0, n - s.length));
const oneLine = (s: string) => s.replace(/\s+/g, " ").trim();

export async function statusCmd(caller: Ctx, o: { json?: boolean }): Promise<number> {
  const p = await loadProject(caller.cwd);
  const reader = readerView(caller, p);
  // JSON escapes its own strings; every other line is for a human to read
  const ctx = o.json ? reader : humanView(reader);
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
  // R40: Kane's evolves of a use case. What slipped through (the because) is the target of the hidden
  // test: it is never printed here, whoever runs this (the agent may unset CLAUDECODE), only on the
  // token-gated dashboard (I-4)
  // the tests an evolve retired stay sealed (Holdback never deletes Kane's files): ids only, never run again
  const retired = retiredTests(s.events).map((t) => t.id);
  const evolved = s.events.flatMap((e) =>
    e.t === "falsify.evolved" ? [{ uc: e.uc, minted: e.minted, retired: e.retired, credits: e.credits, ...(e.followUp ? { followUp: true } : {}) }] : [],
  );

  if (o.json) {
    ctx.out(
      jsonForTerminal(
        JSON.stringify(
        {
          state: agent ? agentState(s.state) : s.state,
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
          verdict: s.verdict,
          specChanged: s.specChanged,
          evolved,
          retired,
        },
        null,
        2,
        ),
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
      failure: a.lastFailure ? oneLine(a.lastFailure.verdict?.bugTitle ?? a.lastFailure.reason ?? `${a.lastFailure.test} failed`) : oneLine(a.reason ?? ""),
    }));
    const w = (k: "id" | "status" | "tests", h: string) => Math.max(h.length, ...rows.map((r) => r[k].length));
    const [wi, ws, wt] = [w("id", "AC"), w("status", "STATUS"), w("tests", "TESTS")];
    ctx.out(`${pad("AC", wi)}  ${pad("STATUS", ws)}  ${pad("TESTS", wt)}  LAST FAILURE`);
    for (const r of rows) ctx.out(`${pad(r.id, wi)}  ${pad(r.status, ws)}  ${pad(r.tests, wt)}  ${r.failure}`.trimEnd());
  }
  ctx.out("");
  // the one verdict (R44): what `holdback run` would exit with and what the dashboard says
  ctx.out(`Verdict: ${s.verdict.headline}`);
  ctx.out(`Gate: ${open ? "open" : "closed"} | owed ${s.gate.owed.length + s.gate.regressed.length} | turn ${s.state.turn} | Kane credits ${kaneCreditsText(s.state)} | breaker $${s.state.breakerUsd.toFixed(4)}`);
  // the agent's count is what keeps the gate shut
  const unsure = agent ? inconclusiveLine(s.gate.inconclusive, true) : inconclusiveLine(s.state.inconclusive);
  if (unsure) ctx.out(unsure);
  // a stalled loop (R48): Kane's reports the agent did not act on (what its brief carried) and the runs that
  // proved nothing (for the agent, how many: never which or why)
  const st = s.state.stalled;
  if (st && s.state.stopped?.reason === "stalled") {
    const groups: string[] = [];
    if (st.disputed.length > 0) groups.push(`disputed, review them: ${disputedLines(st).join("; ")}`);
    if (st.inconclusive.length > 0) groups.push(`inconclusive: ${agent ? `${st.inconclusive.length} test${st.inconclusive.length === 1 ? "" : "s"}` : unsureLines(st).join("; ")}`);
    ctx.out(`Stalled: ${groups.join("; ") || `the agent changed nothing for ${st.turns.length} turns`}`);
  }
  const tests = (n: number) => `${n} test${n === 1 ? "" : "s"}`;
  for (const e of evolved) {
    ctx.out(`${e.uc} evolved${e.followUp ? " again, to cover criteria its tests had lost" : ""}: ${tests(e.minted.length)} minted, ${e.retired.length} retired (${e.credits} credits)`);
  }
  if (retired.length > 0) ctx.out(`Retired by Kane's evolve (still sealed, never run): ${retired.join(", ")}`);
  if (s.specChanged.length > 0) ctx.out(`The spec changed since the last seal (${s.specChanged.join(", ")}): \`holdback run\` runs drift first.`);
  if (s.tamper !== null) {
    ctx.err(s.tamper);
    return EXIT.tamper;
  }
  return EXIT.ok;
}
