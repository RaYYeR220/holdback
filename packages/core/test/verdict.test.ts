import { readFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { describe, expect, it } from "vitest";
import { parseEvents } from "../src/ledger/parse.js";
import { reduce } from "../src/ledger/reduce.js";
import type { AcState, LedgerEvent, LedgerState } from "../src/ledger/types.js";
import { verdict } from "../src/ledger/verdict.js";

const here = dirname(fileURLToPath(import.meta.url));
/** The live rehearsal's ledger (2026-11-16), sanitized: 10 criteria, 5 proved, 3 passing, 2 vacuous, exit 3. */
const REHEARSAL = join(here, "fixtures", "rehearsal", "ledger.jsonl");

const ac = (id: string, status: AcState["status"], tests = ["t-1"]): AcState => ({ id, text: id, useCase: "uc-1", cites: [], tests, status });
const state = (acs: AcState[], extra: Partial<LedgerState> = {}): LedgerState => ({
  ...reduce([]),
  acs: Object.fromEntries(acs.map((a) => [a.id, a])),
  ...extra,
});

describe("verdict", () => {
  it("the rehearsal's ledger is held back with exit 3, though the build loop's gate is open", () => {
    const v = verdict(reduce(parseEvents(readFileSync(REHEARSAL, "utf8"))));
    expect(v).toMatchObject({
      state: "held-back",
      released: false,
      word: "Held back",
      headline: "Held back — 8/10 green, 2 criteria unproved: a planted bug survived",
      gateOpen: true,
      exit: 3,
      counts: { criteria: 10, green: 8, proved: 5, passing: 3, vacuous: 2, owed: 0, regressed: 0, needsSpec: 0, rejected: 0, inconclusive: 0 },
    });
  });

  it("a run stopped because the agent disputes Kane's report says so, names the criteria, and holds back with its exit code; a later turn that changes code ends the dispute (live demo)", () => {
    const at = "2026-11-17T10:00:00.000Z";
    const design: LedgerEvent = {
      at,
      t: "design",
      useCase: "uc-1",
      acs: ["ac-1", "ac-2"].map((id) => ({ id, text: id, useCase: "uc-1", cites: [], trust: "derived" })),
      tests: [
        { id: "t-1", title: "one", file: "t1.md", verifies: ["ac-1"] },
        { id: "t-2", title: "two", file: "t2.md", verifies: ["ac-2"] },
      ],
      gaps: [],
      credits: 0,
    };
    const run = (test: string, status: "passed" | "failed"): LedgerEvent => ({
      at,
      t: "run",
      kind: "build",
      turn: 1,
      result: { testFile: `${test}.md`, testId: test, status, steps: [], criteriaPassed: [], criteriaFailed: [], credits: 0, replayDecisions: 0, authorDecisions: 0, healTriggered: false, durationS: 1, ...(status === "failed" ? { verdict: { bugTitle: "No volunteer link" } } : {}) },
    });
    const events: LedgerEvent[] = [
      design,
      { at, t: "seal", manifest: {} },
      run("t-1", "passed"),
      run("t-2", "failed"),
      { at, t: "build.disputed", acs: ["ac-2"], tests: ["t-2"], turns: [2, 3], titles: { "ac-2": "No volunteer link" } },
      { at, t: "run.end", stop: "disputed", exit: 3, detail: "Falsified the 1 passing criterion; the gate stays shut: the agent disputes Kane's report on ac-2" },
    ];
    const v = verdict(reduce(events));
    expect(v).toMatchObject({ released: false, exit: 3, headline: "Held back — 1/2 green, 1 owed, the agent disputes Kane's report on ac-2: review it" });
    expect(v.stops).toEqual(["the agent disputes Kane's report on ac-2: review it"]);
    // the next turn changes code: no dispute any more
    const after = reduce([...events, { at, t: "turn.start", n: 4, owed: ["ac-2"] }, { at, t: "turn.end", n: 4, commit: "def", filesChanged: ["src/app.js"], durationMs: 1, appUp: true, agentExit: 0 }]);
    expect(after.disputed).toBeUndefined();
  });

  it("is released only when every criterion not turned down is proved or passing and the gate is open", () => {
    const v = verdict(state([ac("ac-1", "proved"), ac("ac-2", "passing"), ac("ac-3", "rejected", [])]));
    expect(v).toMatchObject({ state: "released", released: true, word: "Released", headline: "Released — 2/2 green, 1/2 proved", exit: 0 });
  });

  it("names every reason it is held back", () => {
    const v = verdict(
      state([ac("ac-1", "owed"), ac("ac-2", "regressed"), ac("ac-3", "vacuous"), ac("ac-4", "needs-spec", []), ac("ac-5", "proved", ["t-5"])], {
        inconclusive: [{ test: "t-5", turn: 2, reason: "environment_issue: browser closed" }],
      }),
    );
    expect(v.headline).toBe("Held back — 1/5 green, 2 owed (1 regressed), 1 criterion unproved: a planted bug survived, 1 criterion with no test, 1 test proved nothing on the last run");
    expect(v).toMatchObject({ released: false, gateOpen: false, exit: 3 });
    // a needs-spec criterion alone holds it back too, with the gate open
    expect(verdict(state([ac("ac-1", "passing"), ac("ac-2", "needs-spec", [])]))).toMatchObject({ released: false, gateOpen: true, headline: "Held back — 1/2 green, 1 criterion with no test", exit: 3 });
  });

  it("never releases a run that stopped, a spec changed since the seal, or a reached Kane credit cap, and takes the stop's exit code (N-1)", () => {
    const green = [ac("ac-1", "proved"), ac("ac-2", "passing")];
    expect(verdict(state(green))).toMatchObject({ released: true, exit: 0 });
    const stopped = verdict(state(green, { stopped: { reason: "kane-budget", exit: 3, detail: "Kane credit cap reached: 40 of 30" } }));
    expect(stopped).toMatchObject({ state: "held-back", released: false, exit: 3, headline: "Held back — 2/2 green, the last run stopped: the Kane credit cap was reached" });
    expect(verdict(state(green, { stopped: { reason: "aborted", exit: 130 } }))).toMatchObject({ released: false, exit: 130, headline: "Held back — 2/2 green, the last run was interrupted" });
    expect(verdict(state(green, { stopped: { reason: "error", exit: 1 } }))).toMatchObject({ exit: 1, headline: "Held back — 2/2 green, the last run stopped on an error" });
    expect(verdict(state(green), { specChanged: true })).toMatchObject({ released: false, exit: 3, headline: "Held back — 2/2 green, the spec changed since the last seal" });
    expect(verdict(state(green), { capReached: true })).toMatchObject({ released: false, exit: 3, headline: "Held back — 2/2 green, the Kane credit cap is reached" });
    // one reason said once: a drift stop with the spec still changed, a cap stop with the cap still reached
    expect(verdict(state(green, { stopped: { reason: "drift", exit: 3 } }), { specChanged: true }).parts).toEqual(["2/2 green", "the last run stopped: the spec changed"]);
    expect(verdict(state(green, { stopped: { reason: "kane-budget", exit: 3 } }), { capReached: true }).parts).toEqual(["2/2 green", "the last run stopped: the Kane credit cap was reached"]);
    // a tamper still wins, with exit 2
    expect(verdict(state(green, { stopped: { reason: "error", exit: 1 } }), { tampered: true })).toMatchObject({ state: "tampered", exit: 2 });
  });

  it("the reducer keeps the last run's stop until a run finishes without one", () => {
    const d: LedgerEvent = { at: "x", t: "design", useCase: "uc-1", acs: [{ id: "ac-1", text: "t", useCase: "uc-1", cites: [], trust: "derived" }], tests: [{ id: "t-1", title: "t", file: "t.md", verifies: ["ac-1"] }], gaps: [], credits: 0 };
    const stop: LedgerEvent = { at: "x", t: "run.end", stop: "kane-budget", exit: 3, detail: "Kane credit cap reached" };
    expect(reduce([d, stop]).stopped).toEqual({ reason: "kane-budget", exit: 3, detail: "Kane credit cap reached" });
    expect(reduce([d, stop, { at: "x", t: "run.end" }]).stopped).toBeUndefined();
  });

  it("a tamper, in the ledger or seen on disk, holds it back with exit 2; no criteria is never released", () => {
    const green = [ac("ac-1", "proved")];
    expect(verdict(state(green, { tampered: true }))).toMatchObject({ state: "tampered", released: false, gateOpen: false, exit: 2, headline: "Held back — tampered: nothing counts until a human re-seals" });
    expect(verdict(state(green), { tampered: true })).toMatchObject({ state: "tampered", exit: 2 });
    expect(verdict(state([]))).toMatchObject({ state: "empty", released: false, exit: 3, headline: "Held back — no criteria yet" });
  });
});
