import { readFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { describe, expect, it } from "vitest";
import { parseEvents } from "../src/ledger/parse.js";
import { reduce } from "../src/ledger/reduce.js";
import type { AcState, LedgerEvent, LedgerState } from "../src/ledger/types.js";
import { verdict } from "../src/ledger/verdict.js";
import { setAside } from "../src/ledger/setaside.js";

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

  it("a stalled run says which of Kane's reports are disputed and which runs proved nothing, and what falsify did with the gate shut; Kane's own seal keeps the stall, a turn that changes code ends it (R48, live demo)", () => {
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
      { at, t: "build.stalled", turns: [2, 3], disputed: [{ ac: "ac-2", test: "t-2", title: "No volunteer link" }], inconclusive: [{ test: "t-9", reason: "timeout" }] },
      // Kane's seal after an evolve in the falsify pass that follows keeps the stall's names (M2)
      { at, t: "seal", manifest: {}, by: "kane" },
      {
        at,
        t: "run.end",
        stop: "stalled",
        exit: 3,
        detail: "Falsified 1 passing criterion (1 proved, 0 vacuous, 0 skipped on budget); the gate stays shut: …",
        falsified: { criteria: 1, proved: 1, vacuous: 0, skipped: 0 },
      },
    ];
    const v = verdict(reduce(events));
    const stall = "the run stalled after 2 unchanged turns: Kane's report on ac-2 disputed, review it; 1 Kane run inconclusive";
    expect(v).toMatchObject({ released: false, exit: 3, headline: `Held back — 1/2 green, 1 owed, falsified 1 passing criterion (1 proved, 0 vacuous, 0 skipped on budget), ${stall}` });
    expect(v.stops).toEqual([stall]);
    // a human re-seal or a drift's seal re-plans the tests: the stall is over; so is a turn that changes code
    expect(reduce([...events, { at, t: "seal", manifest: {} }]).stalled).toBeUndefined();
    const after = reduce([...events, { at, t: "turn.start", n: 4, owed: ["ac-2"] }, { at, t: "turn.end", n: 4, commit: "def", filesChanged: ["src/app.js"], durationMs: 1, appUp: true, agentExit: 0 }]);
    expect(after.stalled).toBeUndefined();
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

describe("planted bugs set aside (the referee, the no-op filter, Kane's dispute)", () => {
  const at = "2026-11-18T10:00:00.000Z";
  const crit = (id: string) => ({ id, text: id, useCase: "uc-1", cites: [], trust: "derived" });
  const events = (): LedgerEvent[] => {
    const ids = ["ac-1", "ac-2", "ac-3", "ac-4"];
    const out: LedgerEvent[] = [{ at, t: "design", useCase: "uc-1", acs: ids.map(crit), tests: ids.map((id, i) => ({ id: `t-${i + 1}`, title: id, file: `t${i + 1}.md`, verifies: [id] })), gaps: [], credits: 0 }];
    for (const [i, id] of ids.entries()) {
      const r = { testFile: `t${i + 1}.md`, testId: `t-${i + 1}`, status: "passed" as const, steps: [], criteriaPassed: [id], criteriaFailed: [], credits: 0, replayDecisions: 0, authorDecisions: 0, healTriggered: false, durationS: 1 };
      out.push({ at, t: "run", kind: "build", turn: 1, result: r });
    }
    const m = (id: string, ac: string, extra: object) => ({ at, t: "mutant", id, ac, patch: "p", model: "m", usd: 0.0003, ...extra }) as LedgerEvent;
    const referee = (confirmed: boolean) => ({ confirmed, input: confirmed ? "size 1" : "", expected: confirmed ? "Eligible." : "", observed: confirmed ? "Not eligible." : "", reason: "r", usd: 0.0001 });
    out.push(m("m-ac-1-1", "ac-1", { verdict: "invalid", refuted: "no-op", note: "changes no code: every line it changes is the same line once whitespace is normalised" }));
    out.push(m("m-ac-2-1", "ac-2", { verdict: "invalid", refuted: "referee", note: "off target: it breaks another rule", referee: referee(false) }));
    out.push(m("m-ac-3-1", "ac-3", { verdict: "survived", referee: referee(true) }));
    out.push(m("m-ac-4-1", "ac-4", { verdict: "survived", referee: referee(true) }));
    out.push({ at, t: "falsify.disputed", uc: "uc-1", ac: "ac-4", mutant: "m-ac-4-1", question: "Is size 1 at the limit Eligible.?", credits: 11.25 });
    return out;
  };

  it("the verdict counts only the confirmed survivor Kane did not dispute as vacuous", () => {
    const s = reduce(events());
    expect(Object.fromEntries(Object.values(s.acs).map((a) => [a.id, a.status]))).toEqual({ "ac-1": "passing", "ac-2": "passing", "ac-3": "vacuous", "ac-4": "passing" });
    expect(s.mutants).toEqual({ killed: 0, survived: 1, invalid: 3 });
    expect(s.credits).toBe(11.25);
    expect(verdict(s)).toMatchObject({ headline: "Held back — 3/4 green, 1 criterion unproved: a planted bug survived", counts: { vacuous: 1, green: 3 } });
  });

  it("lists each criterion's latest planted bug that was set aside, with its reason or Kane's question", () => {
    expect(setAside(events())).toEqual([
      { ac: "ac-1", mutant: "m-ac-1-1", by: "no-op", why: "changes no code: every line it changes is the same line once whitespace is normalised" },
      { ac: "ac-2", mutant: "m-ac-2-1", by: "referee", why: "off target: it breaks another rule" },
      { ac: "ac-4", mutant: "m-ac-4-1", by: "kane", why: "Is size 1 at the limit Eligible.?", uc: "uc-1" },
    ]);
    // a later planted bug of the criterion that counts replaces it
    const later = [...events(), { at, t: "mutant", id: "m-ac-2-2", ac: "ac-2", patch: "p", model: "m", usd: 0, verdict: "killed" } as LedgerEvent];
    expect(setAside(later).map((a) => a.ac)).toEqual(["ac-1", "ac-4"]);
  });

  describe("a survivor logged before the referee existed, judged by it later (`mutant.referee`)", () => {
    const ids = ["ac-1", "ac-2", "ac-3"];
    const pass = (i: number, id: string, kind: "build" | "replay" = "build", failed = false): LedgerEvent => ({
      at,
      t: "run",
      kind,
      turn: 1,
      result: {
        testFile: `t${i + 1}.md`,
        testId: `t-${i + 1}`,
        status: failed ? "failed" : "passed",
        steps: [],
        criteriaPassed: failed ? [] : [id],
        criteriaFailed: failed ? [id] : [],
        credits: 0,
        replayDecisions: 0,
        authorDecisions: 0,
        healTriggered: false,
        durationS: 1,
      },
    });
    const m = (id: string, ac: string, extra: object = {}) => ({ at, t: "mutant", id, ac, patch: "p", model: "m", usd: 0.0003, verdict: "survived", ...extra }) as LedgerEvent;
    const rejudged = (mutant: string, ac: string, confirmed: boolean | undefined, note?: string): LedgerEvent => ({
      at,
      t: "mutant.referee",
      mutant,
      ac,
      usd: 0.0002,
      ...(confirmed === undefined ? {} : { referee: { confirmed, input: confirmed ? "size 1" : "", expected: confirmed ? "Eligible." : "", observed: confirmed ? "Not eligible." : "", reason: "r", usd: 0.0002 } }),
      ...(note !== undefined ? { note } : {}),
    });
    /** ac-1 proved, then a survivor; ac-2 and ac-3 passing, then a survivor each (ac-2's evolve added no test): all three vacuous, as an old ledger left them. */
    const old = (): LedgerEvent[] => [
      { at, t: "design", useCase: "uc-1", acs: ids.map(crit), tests: ids.map((id, i) => ({ id: `t-${i + 1}`, title: id, file: `t${i + 1}.md`, verifies: [id] })), gaps: [], credits: 0 },
      ...ids.map((id, i) => pass(i, id)),
      m("m-ac-1-1", "ac-1", { verdict: "killed" }),
      m("m-ac-1-2", "ac-1"),
      m("m-ac-2-1", "ac-2"),
      m("m-ac-3-1", "ac-3"),
      { at, t: "redesign.dropped", useCases: ["uc-1"], detail: "d", credits: 0, acs: ["ac-2"], reason: "Kane could not add a test that catches this planted bug" },
      // the pass's closing replay, its end, and the next pass's start: the referee's records come after all of it
      ...ids.map((id, i) => pass(i, id, "replay")),
      { at, t: "run.end" },
      { at, t: "recordings", digest: "d", gitConfig: "g" },
    ];
    const statuses = (ev: LedgerEvent[]) => Object.fromEntries(Object.values(reduce(ev).acs).map((a) => [a.id, a.status]));

    it("rejected, it is set aside exactly as one the referee rejected in its own pass: never vacuous, counted invalid, its criterion back to what its tests say; confirmed, it stands", () => {
      expect(statuses(old())).toEqual({ "ac-1": "vacuous", "ac-2": "vacuous", "ac-3": "vacuous" });
      const ev = [...old(), rejudged("m-ac-1-2", "ac-1", false, "no observable change: r"), rejudged("m-ac-2-1", "ac-2", false, "off target: r"), rejudged("m-ac-3-1", "ac-3", true)];
      const s = reduce(ev);
      expect(statuses(ev)).toEqual({ "ac-1": "proved", "ac-2": "passing", "ac-3": "vacuous" });
      // why it was vacuous goes with it
      expect(s.acs["ac-2"]!.reason).toBeUndefined();
      expect(s.mutants).toEqual({ killed: 1, survived: 1, invalid: 2 });
      expect(s.breakerUsd).toBeCloseTo(4 * 0.0003 + 3 * 0.0002, 12);
      expect(verdict(s)).toMatchObject({ headline: "Held back — 2/3 green, 1 criterion unproved: a planted bug survived", counts: { vacuous: 1, proved: 1, passing: 1 } });
      expect(setAside(ev)).toEqual([
        { ac: "ac-1", mutant: "m-ac-1-2", by: "referee", why: "no observable change: r", rejudged: true },
        { ac: "ac-2", mutant: "m-ac-2-1", by: "referee", why: "off target: r", rejudged: true },
      ]);
    });

    it("the referee's record, appended in a later pass, reduces the same however much of the old ledger came between", () => {
      const tail = [rejudged("m-ac-1-2", "ac-1", false, "no observable change: r"), rejudged("m-ac-2-1", "ac-2", false, "off target: r")];
      // right after the survivors, or after the old pass's replay, its end and the next pass's start
      const early = [...old().slice(0, 8), ...tail, ...old().slice(8)];
      expect(statuses(early)).toEqual(statuses([...old(), ...tail]));
      expect(reduce(early).mutants).toEqual(reduce([...old(), ...tail]).mutants);
      // a test that failed since already took the criterion out of vacuous: the record leaves it at what its tests say
      expect(statuses([...old(), pass(1, "ac-2", "build", true), ...tail])["ac-2"]).toBe("owed");
    });

    it("no usable answer leaves the survivor as logged, its cost on record", () => {
      const ev = [...old(), rejudged("m-ac-3-1", "ac-3", undefined, "the referee gave no usable answer: Venice unreachable: timeout")];
      expect(statuses(ev)["ac-3"]).toBe("vacuous");
      expect(reduce(ev).breakerUsd).toBeCloseTo(4 * 0.0003 + 0.0002, 12);
      expect(setAside(ev).map((a) => a.ac)).toEqual([]);
    });

    it("a re-check from before the referee that got past the new tests too, rejected later, gives its criterion back its status", () => {
      const ev: LedgerEvent[] = [
        ...old().slice(0, 4),
        m("m-ac-3-1", "ac-3"),
        { at, t: "falsify.evolved", uc: "uc-1", because: "b", minted: ["t-4"], retired: ["t-3"], credits: 1, mutants: ["m-ac-3-1"] },
        { at, t: "design", useCase: "uc-1", acs: ids.map(crit), tests: [...ids.slice(0, 2).map((id, i) => ({ id: `t-${i + 1}`, title: id, file: `t${i + 1}.md`, verifies: [id] })), { id: "t-4", title: "t-4", file: "t4.md", verifies: ["ac-3"] }], gaps: [], credits: 0 },
        ...ids.slice(0, 2).map((id, i) => pass(i, id)),
        pass(3, "ac-3"),
        m("m-ac-3-2", "ac-3", { recheck: "m-ac-3-1" }),
      ];
      expect(reduce(ev).acs["ac-3"]).toMatchObject({ status: "vacuous", reason: "the planted bug that got past the old tests got past the new tests too" });
      const s = reduce([...ev, rejudged("m-ac-3-2", "ac-3", false, "off target: r")]);
      expect(s.acs["ac-3"]!.status).toBe("passing");
      expect(s.acs["ac-3"]!.reason).toBeUndefined();
    });
  });
});
