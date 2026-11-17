import { describe, expect, it } from "vitest";
import type { LedgerEvent, TestRunResult } from "@holdback/core/browser";
import { parseEvents } from "@holdback/core/browser";
import { board, COLUMNS, driftRows, lede, runVerdict, fmtCredits, fmtDuration, fmtUsd, gateLabel, meters, parseEvalSummary, patchOneLiner, retiredLine, stateFromLedger, timeline } from "../src/model";
import { artifactUrl } from "../src/source";
import { fixtureText, REHEARSAL } from "./helpers";
import { readFileSync } from "node:fs";

const at = "2026-11-15T10:00:00.000Z";
const ev = (e: object) => ({ at, ...e }) as LedgerEvent;
const design = (acs: string[], tests: [string, string[]][]) =>
  ev({
    t: "design",
    useCase: "uc-1",
    acs: acs.map((id) => ({ id, text: `text ${id}`, useCase: "uc-1", cites: [{ source: "prd", anchor: "L3-L3", quote: `quote ${id}` }, { source: "prd", anchor: "L1-L9", quote: "wide" }], trust: "derived" })),
    tests: tests.map(([id, verifies]) => ({ id, title: `title ${id}`, file: `${id}.md`, verifies })),
    gaps: [],
    credits: 10,
  });
const result = (testId: string, status: TestRunResult["status"], extra: Partial<TestRunResult> = {}): TestRunResult => ({
  testFile: `${testId}.md`,
  testId,
  status,
  steps: [],
  criteriaPassed: [],
  criteriaFailed: [],
  credits: 2,
  replayDecisions: 0,
  authorDecisions: 0,
  healTriggered: false,
  durationS: 30,
  ...extra,
});
const run = (turn: number, r: TestRunResult, kind = "build", mutantId?: string) => ev({ t: "run", kind, turn, ...(mutantId ? { mutantId } : {}), result: r });

describe("board", () => {
  it("puts a regressed criterion in the owed column, flagged and first, with Kane's failure", () => {
    const events = [
      design(["ac-1", "ac-2", "ac-3"], [["t-1", ["ac-1", "ac-2"]], ["t-2", ["ac-3"]]]),
      ev({ t: "turn.start", n: 1, owed: ["ac-1", "ac-2", "ac-3"] }),
      run(1, result("t-1", "passed", { criteriaPassed: ["ac-1", "ac-2"] })),
      run(2, result("t-1", "failed", { criteriaPassed: ["ac-1"], criteriaFailed: ["ac-2"], failedStep: 3, screenshot: "artifacts/a.png", verdict: { bugTitle: "Total is wrong", observed: "Total: $4", oneLiner: "The total is off by one." } })),
    ];
    const api = stateFromLedger(events, null);
    const cols = board(api, events);
    expect(cols.owed.map((c) => c.ac.id)).toEqual(["ac-2", "ac-3"]);
    const c = cols.owed[0]!;
    expect(c.regressed).toBe(true);
    expect(c.observation).toMatchObject({ kind: "build", test: "t-1", status: "failed", step: 3, observed: "Total: $4", title: "Total is wrong", screenshot: "artifacts/a.png", turn: 2 });
    expect(c.quote).toEqual({ text: "quote ac-2", source: "prd", anchor: "L3-L3" });
    expect(c.tests).toEqual([{ id: "t-1", title: "title t-1", mark: "fail", turn: 2 }]);
    expect(cols.passing.map((x) => x.ac.id)).toEqual(["ac-1"]);
    expect(gateLabel(api)).toEqual({ word: "Held back", open: false, parts: ["1/3 green", "2 owed (1 regressed)"] });
  });

  it("shows a criterion the human turned down in its own column, never owed (I3)", () => {
    const events = [ev({ ...design(["ac-1", "ac-2"], [["t-1", ["ac-1"]], ["t-2", ["ac-2"]]]), rejected: ["ac-2"] })];
    const api = stateFromLedger(events, null);
    const cols = board(api, events);
    expect(cols.rejected.map((c) => c.ac.id)).toEqual(["ac-2"]);
    expect(cols.owed.map((c) => c.ac.id)).toEqual(["ac-1"]);
    expect(api.gate.rejected).toEqual(["ac-2"]);
  });

  it("flags a criterion whose test proved nothing, and marks that test inconclusive until it runs conclusively", () => {
    const base = [design(["ac-1"], [["t-1", ["ac-1"]]]), run(1, result("t-1", "error", { reason: "timeout" }))];
    const cards = board(stateFromLedger(base, null), base).owed;
    expect(cards[0]!.inconclusive).toEqual([{ test: "t-1", turn: 1, reason: "timeout" }]);
    expect(cards[0]!.tests[0]!.mark).toBe("inconclusive");
    expect(gateLabel(stateFromLedger(base, null)).parts).toEqual(["0/1 green", "1 owed", "1 test proved nothing on the last run"]);
    const later = [...base, run(2, result("t-1", "passed", { criteriaPassed: ["ac-1"] }))];
    const after = board(stateFromLedger(later, null), later);
    expect(after.passing[0]!.inconclusive).toEqual([]);
    expect(after.passing[0]!.tests[0]!.mark).toBe("pass");
  });

  it("a proved criterion shows the replay that caught the planted bug, and the bug in one line", () => {
    const patch = "--- a/server.js\n+++ b/server.js\n@@ -1 +1 @@\n-  if (income <= limit) ok();\n+  if (income >= limit) ok();\n";
    const events = [
      design(["ac-1"], [["t-1", ["ac-1"]]]),
      run(1, result("t-1", "passed", { criteriaPassed: ["ac-1"] })),
      ev({ t: "mutant", id: "m-ac-1-1", ac: "ac-1", patch, model: "m", usd: 0.0004, verdict: "killed" }),
      ev({ t: "run", kind: "falsify", mutantId: "m-ac-1-1", result: result("t-1", "failed", { failedStep: 2, criteriaFailed: ["ac-1"], verdict: { bugTitle: "Eligible above limit", observed: "Eligible." } }) }),
    ];
    const cols = board(stateFromLedger(events, null), events);
    const c = cols.proved[0]!;
    expect(c.mutant).toMatchObject({ id: "m-ac-1-1", verdict: "killed", file: "server.js", removed: "if (income <= limit) ok();", added: "if (income >= limit) ok();" });
    expect(c.observation).toMatchObject({ kind: "falsify", mutantId: "m-ac-1-1", step: 2, observed: "Eligible." });
  });

  it("a proved criterion shows the second replay that confirmed the kill (R44)", () => {
    const failed = result("t-1", "failed", { failedStep: 2, criteriaFailed: ["ac-1"], verdict: { bugTitle: "Eligible above limit", family: "application_issue" } });
    const events = [
      design(["ac-1"], [["t-1", ["ac-1"]]]),
      run(1, result("t-1", "passed", { criteriaPassed: ["ac-1"] })),
      ev({ t: "mutant", id: "m-ac-1-1", ac: "ac-1", patch: "", model: "m", usd: 0.0004, verdict: "killed" }),
      ev({ t: "run", kind: "falsify", mutantId: "m-ac-1-1", result: failed }),
      ev({ t: "run", kind: "falsify", mutantId: "m-ac-1-1", result: failed, confirm: true }),
    ];
    const c = board(stateFromLedger(events, null), events).proved[0]!;
    expect(c.observation).toMatchObject({ kind: "falsify", mutantId: "m-ac-1-1", again: true });
    const runs = timeline(events).flatMap((sg) => sg.items).filter((i) => i.kind === "run");
    expect(runs.map((i) => (i.kind === "run" ? i.run.again ?? false : null))).toEqual([false, false, true]);
  });

  it("on the fixture: the owed criteria point at t-3, the run that has not passed them", () => {
    const events = parseEvents(fixtureText());
    const cols = board(stateFromLedger(events, null), events);
    expect(cols.owed.map((c) => c.ac.id)).toEqual(["ac-1", "ac-4", "ac-5", "ac-6", "ac-7"]);
    expect(cols.proved.map((c) => c.ac.id)).toEqual(["ac-2", "ac-3"]);
    for (const c of cols.owed) expect(c.observation).toMatchObject({ test: "t-3", turn: 2, status: "failed" });
    expect(cols.owed.find((c) => c.ac.id === "ac-5")!.tests.map((t) => t.mark)).toEqual(["pass", "pass", "none"]);
    expect(cols.proved[0]!.observation?.screenshot).toBe("artifacts/m-ac-2-1-step_007.png");
  });
});

describe("timeline", () => {
  it("splits the ledger into the spec stage and one segment per turn, with the agent turn first", () => {
    const events = parseEvents(fixtureText());
    const segs = timeline(events);
    expect(segs.map((s) => s.label)).toEqual(["Spec", "Turn 1", "Turn 2"]);
    expect(segs[1]!.items[0]).toMatchObject({ kind: "agent", turn: 1, owedIn: 11, done: true, commit: "8ff9f9b", durationMs: 71732 });
    expect(segs[2]!.items[0]).toMatchObject({ kind: "agent", turn: 2, done: false });
    const runs = segs[1]!.items.filter((i) => i.kind === "run");
    expect(runs.map((r) => (r.kind === "run" ? [r.run.test, r.run.status, r.run.inconclusive ?? null] : null))).toEqual([
      ["t-3", "error", "timeout"],
      ["t-1", "passed", null],
      ["t-2", "passed", null],
    ]);
    expect(segs.reduce((s, x) => s + x.credits, 0)).toBeCloseTo(stateFromLedger(events, null).state.credits, 4);
    expect(segs[2]!.items.filter((i) => i.kind === "mutant")).toHaveLength(2);
  });

  it("shows tamper, re-seal, regression, drift and metered batches", () => {
    const events = [
      design(["ac-1"], [["t-1", ["ac-1"]]]),
      ev({ t: "seal", manifest: { a: "1" } }),
      ev({ t: "turn.start", n: 1, owed: ["ac-1"] }),
      ev({ t: "regression", ac: "ac-1", turn: 1, blamedTurn: 1, blamedCommit: "abc" }),
      ev({ t: "tamper", detail: "sealed files changed: t-1.md" }),
      ev({ t: "seal", manifest: { a: "2" } }),
      ev({ t: "drift", rows: [{ kind: "ADD", ref: "ac-2", why: "new rule" }], applied: true, credits: 3 }),
      ev({ t: "credits", source: "build", delta: null, perRunSum: 4, error: "balance: offline" }),
    ];
    const kinds = timeline(events).flatMap((s) => s.items.map((i) => i.kind));
    expect(kinds).toEqual(["spec", "seal", "agent", "regression", "tamper", "seal", "drift", "meter"]);
    const reseal = timeline(events)[1]!.items.find((i) => i.kind === "seal");
    expect(reseal).toMatchObject({ reseal: true });
    expect(driftRows(events)).toEqual([{ at, kind: "ADD", ref: "ac-2", why: "new rule", applied: true }]);
    const tampered = stateFromLedger(events.slice(0, 5), null);
    expect(tampered.tamper?.detail).toBe("sealed files changed: t-1.md");
    expect(gateLabel(tampered).parts[0]).toBe("tampered: nothing counts until a human re-seals");
    const m = meters(stateFromLedger(events, null), events);
    expect(m).toMatchObject({ metered: 1, unmeasured: 1 });
  });

  it("shows where a spec change was first seen, and flags one of unverified origin (R37)", () => {
    const events = [
      ev({ t: "turn.start", n: 1, owed: [] }),
      ev({ t: "spec.changed", files: ["PRD.md"], duringAgentTurn: true, before: { "PRD.md": "a" }, after: { "PRD.md": "b" } }),
      ev({ t: "spec.changed", files: ["PRD.md"], duringAgentTurn: false, before: { "PRD.md": "a" }, after: { "PRD.md": "c" } }),
    ];
    const items = timeline(events).flatMap((s) => s.items).filter((i) => i.kind === "spec");
    expect(items).toMatchObject([
      { title: "The spec changed after an agent turn: origin unverified", detail: "PRD.md" },
      { title: "The spec changed", detail: "PRD.md" },
    ]);
  });

  it("shows Kane's design gaps with their kind and question, an import Holdback repaired, and the variables a human filled (names only)", () => {
    const events = [
      ev({
        ...design(["ac-1"], [["t-1", ["ac-1"]]]),
        gaps: [
          { id: "gap-1", title: "Pantry page URL", kind: "incomplete", acs: [], question: { header: "Pantry page URL", prompt: "What product URL should {{start_url}} contain?", options: [] } },
          { id: "gap-2", title: "Eight-person equality", kind: "budget-evicted", acs: [], question: { header: "Eight-person equality", prompt: "Raise the ceiling?", options: [] } },
          { id: "gap-3", title: "gap-3", kind: "gap", acs: [] },
        ],
      }),
      ev({ t: "spec.repaired", file: ".testmuai/tests/t2_test.md", line: 12, from: "@import ./C:\\x\\t1_test.md", to: "@import ./t1_test.md" }),
      ev({ t: "spec.variables", names: ["primary_phone", "proxy_name"], filledBy: "human" }),
    ];
    const items = timeline(events).flatMap((s) => s.items).filter((i) => i.kind === "spec");
    expect(items).toMatchObject([
      { title: "Kane designed uc-1: 1 criterion, 1 test" },
      {
        title: "Kane left 2 gaps in uc-1's design",
        detail: "gap-1 [incomplete] Pantry page URL: What product URL should {{start_url}} contain? · gap-2 [budget-evicted] Eight-person equality: Raise the ceiling?",
      },
      { title: "Holdback repaired a broken import Kane wrote", detail: ".testmuai/tests/t2_test.md line 12: @import ./C:\\x\\t1_test.md -> @import ./t1_test.md" },
      { title: "A human filled 2 test variables Kane left empty", detail: "primary_phone, proxy_name" },
    ]);
    // a design whose gaps carry nothing but an id (the first live run's) adds no row
    expect(timeline([design(["ac-1"], [["t-1", ["ac-1"]]])]).flatMap((s) => s.items)).toHaveLength(1);
    // with no human there (Kane's evolve), Holdback's own suggestions filled them (R46)
    expect(timeline([ev({ t: "spec.variables", names: ["guest_phone"], filledBy: "suggested" })]).flatMap((s) => s.items)).toMatchObject([
      { kind: "spec", title: "Holdback filled 1 test variable Kane's new tests left empty with its suggestion", detail: "guest_phone" },
    ]);
  });

  it("shows a dispute: the agent changed nothing for two turns while Kane's report on the app stood (live demo)", () => {
    const events = [
      ev({ t: "turn.start", n: 2, owed: ["ac-5"] }),
      ev({ t: "build.disputed", acs: ["ac-5"], tests: ["t-7"], turns: [2, 3], titles: { "ac-5": "Volunteer list link missing" } }),
    ];
    expect(timeline(events).flatMap((s) => s.items).filter((i) => i.kind === "disputed")).toEqual([
      { kind: "disputed", at, acs: ["ac-5"], tests: ["t-7"], turns: [2, 3], titles: { "ac-5": "Volunteer list link missing" } },
    ]);
  });

  it("shows Kane's evolve after a surviving planted bug as a loop event: minted, retired, the because and its credits (R40)", () => {
    const because = "A planted bug got past every test of this use case. ac-3: a household of 9 is held to the 8-person limit.";
    const events = [
      ev({ t: "turn.start", n: 1, owed: [] }),
      ev({ t: "falsify.evolved", uc: "uc-1", because, minted: ["t-4"], retired: ["t-1", "t-2", "t-3"], credits: 11.39, mutants: ["m-ac-3-1"] }),
      ev({ t: "falsify.evolved", uc: "uc-1", because: 'cover ac-2 ("x") again', minted: ["t-5"], retired: [], credits: 7.33, mutants: ["m-ac-3-1"], followUp: true }),
      ev({ t: "redesign.dropped", useCases: ["uc-2"], detail: "Kane added no test to uc-2", credits: 5.69, acs: ["ac-9"], reason: "Kane could not add a test that catches this planted bug" }),
    ];
    const segs = timeline(events);
    expect(segs.flatMap((s) => s.items).filter((i) => i.kind === "evolved" || i.kind === "dropped")).toMatchObject([
      { kind: "evolved", uc: "uc-1", minted: ["t-4"], retired: ["t-1", "t-2", "t-3"], because, credits: 11.39, followUp: false },
      { kind: "evolved", uc: "uc-1", minted: ["t-5"], retired: [], credits: 7.33, followUp: true },
      { kind: "dropped", useCases: ["uc-2"], detail: "Kane added no test to uc-2", credits: 5.69 },
    ]);
    expect(segs.at(-1)!.credits).toBeCloseTo(11.39 + 7.33 + 5.69, 9);
  });

  it("shows an evolve that touched sealed files outside its use case as a tamper, and the next seal as a re-seal", () => {
    const detail = "Kane's evolve of uc-1 changed sealed verifier files it did not mint or retire: .testmuai/variables/assurance.json";
    const events = [
      ev({ t: "turn.start", n: 1, owed: [] }),
      ev({ t: "falsify.evolve.stray", uc: "uc-1", paths: [".testmuai/variables/assurance.json"], credits: 11.39, detail }),
      ev({ t: "seal", manifest: { a: "1" } }),
    ];
    const items = timeline(events).flatMap((s) => s.items);
    expect(items.filter((i) => i.kind === "tamper" || i.kind === "seal")).toMatchObject([
      { kind: "tamper", detail },
      { kind: "seal", reseal: true },
    ]);
  });
});

describe("meters and labels", () => {
  it("splits Kane credits by stage and holds the breaker against its cap", () => {
    const events = parseEvents(fixtureText());
    const api = stateFromLedger(events, { spec: ["PRD.md"], start: { port: 1, readyPath: "/" }, agent: { model: null }, kane: { parallel: 2, timeoutS: 1, designMax: 1 }, breaker: { model: "b", capUsd: 0.25 }, loop: { maxTurns: 6 } });
    const m = meters(api, events);
    expect(m.kaneCredits).toBe(349.8881);
    expect(m.metered).toBe(0);
    expect(m.split.map((s) => s.key)).toEqual(["spec", "design", "build", "falsify"]);
    expect(m.split.reduce((s, x) => s + x.credits, 0)).toBeCloseTo(349.8881, 3);
    expect(m.capUsd).toBe(0.25);
    expect(m.turns).toBe(2);
    expect(m.maxTurns).toBe(6);
  });

  it("an empty ledger and an all-green one", () => {
    expect(gateLabel(stateFromLedger([], null))).toEqual({ word: "Held back", open: false, parts: ["no criteria yet"] });
    const green = [design(["ac-1"], [["t-1", ["ac-1"]]]), run(1, result("t-1", "passed", { criteriaPassed: ["ac-1"] }))];
    expect(gateLabel(stateFromLedger(green, null))).toEqual({ word: "Released", open: true, parts: ["1/1 green"] });
  });

  it("a criterion with no test because of Kane's design cap says so on its card, and its column no longer blames the spec alone (rehearsal issue 7)", () => {
    const events = [ev({ ...design(["ac-1", "ac-2"], [["t-1", ["ac-1"]]]), notes: { "ac-2": "no test designed (design cap 1)" } })];
    const card = board(stateFromLedger(events, null), events)["needs-spec"][0]!;
    expect(card.ac).toMatchObject({ id: "ac-2", status: "needs-spec", reason: "no test designed (design cap 1)" });
    expect(COLUMNS.find((c) => c.key === "needs-spec")!.note).toBe("No test verifies it: Kane's design cap left it out, or the spec gives Kane nothing to test");
  });

  it("shows falsify's closing replay as a replay, on the board, the timeline and the spend split (rehearsal issue 10b)", () => {
    const events = [
      design(["ac-1"], [["t-1", ["ac-1"]]]),
      run(1, result("t-1", "passed", { criteriaPassed: ["ac-1"] })),
      run(1, result("t-1", "failed", { criteriaFailed: ["ac-1"], verdict: { bugTitle: "Off by one" }, credits: 22.33 }), "replay"),
    ];
    const api = stateFromLedger(events, null);
    expect(api.state.acs["ac-1"]!.status).toBe("regressed"); // it passed in turn 1, then failed the replay
    const card = board(api, events).owed[0]!;
    expect(card.observation).toMatchObject({ kind: "replay", test: "t-1", status: "failed" });
    expect(card.tests[0]).toMatchObject({ mark: "fail" });
    const runs = timeline(events).flatMap((sg) => sg.items).filter((i) => i.kind === "run");
    expect(runs.map((i) => (i.kind === "run" ? i.run.kind : null))).toEqual(["build", "replay"]);
    expect(meters(api, events).split).toContainEqual({ key: "replay", label: "Closing replays", credits: 22.33 });
  });

  it("words a planted bug's replays by whether they caught it: a kill the second replay did not confirm never reads as missed (m-1)", () => {
    const appFail = (extra: Partial<TestRunResult> = {}) => result("t-1", "failed", { failedStep: 2, criteriaFailed: ["ac-1"], verdict: { bugTitle: "b", family: "application_issue" }, ...extra });
    const base = [design(["ac-1"], [["t-1", ["ac-1"]]]), run(1, result("t-1", "passed", { criteriaPassed: ["ac-1"] }))];
    const words = (events: LedgerEvent[]) => timeline(events).flatMap((s) => s.items).flatMap((i) => (i.kind === "run" && i.run.kind === "falsify" ? [runVerdict(i.run).word] : []));
    // confirmed
    const confirmed = [
      ...base,
      ev({ t: "mutant", id: "m-ac-1-1", ac: "ac-1", patch: "", model: "m", usd: 0, verdict: "killed" }),
      ev({ t: "run", kind: "falsify", mutantId: "m-ac-1-1", result: appFail() }),
      ev({ t: "run", kind: "falsify", mutantId: "m-ac-1-1", result: appFail(), confirm: true }),
    ];
    expect(words(confirmed)).toEqual(["Caught at step 2", "Caught again"]);
    // not confirmed: the second replay passed
    const unconfirmed = [
      ...base,
      ev({ t: "mutant", id: "m-ac-1-1", ac: "ac-1", patch: "", model: "m", usd: 0, verdict: "invalid", note: "inconclusive: the kill did not reproduce: t-1 passed on a second replay of the same mutant" }),
      ev({ t: "run", kind: "falsify", mutantId: "m-ac-1-1", result: appFail() }),
      ev({ t: "run", kind: "falsify", mutantId: "m-ac-1-1", result: result("t-1", "passed", { criteriaPassed: ["ac-1"] }), confirm: true }),
    ];
    expect(words(unconfirmed)).toEqual(["Caught at step 2", "Not confirmed — Kane disagreed with itself"]);
    const card = board(stateFromLedger(unconfirmed, null), unconfirmed).passing[0]!;
    expect(runVerdict(card.mutant!.run!).word).toBe("Not confirmed — Kane disagreed with itself");
    // a failure Kane did not blame on the app, or on another criterion, is no catch
    const unblamed = [
      ...base,
      ev({ t: "mutant", id: "m-ac-1-1", ac: "ac-1", patch: "", model: "m", usd: 0, verdict: "invalid" }),
      ev({ t: "run", kind: "falsify", mutantId: "m-ac-1-1", result: appFail({ verdict: { bugTitle: "b" } }) }),
    ];
    expect(words(unblamed)).toEqual(["Failed, not a catch"]);
    const other = [
      ...base,
      ev({ t: "mutant", id: "m-ac-1-1", ac: "ac-1", patch: "", model: "m", usd: 0, verdict: "invalid" }),
      ev({ t: "run", kind: "falsify", mutantId: "m-ac-1-1", result: appFail({ criteriaFailed: ["ac-9"] }) }),
    ];
    expect(words(other)).toEqual(["Failed, not a catch"]);
    // an older ledger's kill, with no verdict family, still reads as the catch it was recorded as
    expect(words(parseEvents(fixtureText()))).toEqual(["Caught at step 2", "Caught at step 2"]);
  });

  it("lists the tests Kane's evolve retired: still sealed, never run (the rehearsal's t-1)", () => {
    const events = parseEvents(readFileSync(REHEARSAL, "utf8"));
    expect(retiredLine(events)).toBe("Retired by Kane's evolve, still sealed, never run again: t-1 Reject non-SNAP income above the two-person limit (uc-1).");
    expect(retiredLine(parseEvents(fixtureText()))).toBeUndefined();
  });

  it("never says Released after a stopped run, or with the Kane credit cap reached, and says why in the headline, the lede and the timeline (N-1)", () => {
    const green = [design(["ac-1"], [["t-1", ["ac-1"]]]), run(1, result("t-1", "passed", { criteriaPassed: ["ac-1"] }))];
    expect(gateLabel(stateFromLedger(green, null)).word).toBe("Released");
    const stopped = [...green, ev({ t: "run.end", stop: "kane-budget", exit: 3, detail: "Kane credit cap reached: 40 of 30" })];
    const api = stateFromLedger(stopped, null);
    expect(api.verdict).toMatchObject({ released: false, exit: 3 });
    expect(gateLabel(api)).toEqual({ word: "Held back", open: false, parts: ["1/1 green", "the last run stopped: the Kane credit cap was reached"] });
    expect(lede(api)).toBe("1 of 1 criteria pass in a real browser, but done is held back: the last run stopped: the Kane credit cap was reached.");
    const items = timeline(stopped).flatMap((s) => s.items);
    expect(items.at(-1)).toMatchObject({ kind: "stopped", reason: "kane-budget", exit: 3, detail: "Kane credit cap reached: 40 of 30" });
    // a clean end clears it
    expect(gateLabel(stateFromLedger([...stopped, ev({ t: "run.end" })], null)).word).toBe("Released");
    // the cap, from the config the dashboard is given: spent is spent
    const cfg = { spec: ["PRD.md"], start: { port: 1, readyPath: "/" }, agent: { model: null }, kane: { parallel: 1, timeoutS: 1, designMax: 1, capCredits: 1 }, breaker: { model: "b", capUsd: 1 }, loop: { maxTurns: 6 } };
    expect(gateLabel(stateFromLedger(green, cfg)).parts).toEqual(["1/1 green", "the Kane credit cap is reached"]);
  });

  it("the lede never garbles: every criterion turned down reads as such (m-4)", () => {
    const events = [ev({ ...design(["ac-1"], [["t-1", ["ac-1"]]]), rejected: ["ac-1", "t-1"] })];
    const api = stateFromLedger(events, null);
    expect(api.verdict).toMatchObject({ state: "empty" });
    expect(lede(api)).toBe("Every criterion was turned down in the design approval: there is nothing to prove, so done stays held back.");
  });

  it("never says Released while a planted bug survived or a criterion has no test, though the gate is open: the CLI's verdict (R44)", () => {
    const events = parseEvents(readFileSync(REHEARSAL, "utf8"));
    const api = stateFromLedger(events, null);
    expect(api.gate.open).toBe(true);
    expect(api.verdict).toMatchObject({ released: false, exit: 3, headline: "Held back — 8/10 green, 2 criteria unproved: a planted bug survived" });
    expect(gateLabel(api)).toEqual({ word: "Held back", open: false, parts: ["8/10 green", "2 criteria unproved: a planted bug survived"] });
    const noTest = [design(["ac-1", "ac-2"], [["t-1", ["ac-1"]]]), run(1, result("t-1", "passed", { criteriaPassed: ["ac-1"] }))];
    expect(gateLabel(stateFromLedger(noTest, null))).toEqual({ word: "Held back", open: false, parts: ["1/2 green", "1 criterion with no test"] });
  });

  it("formats credits, dollars and durations", () => {
    expect([fmtCredits(349.8881), fmtCredits(22.55), fmtCredits(1.4), fmtCredits(0)]).toEqual(["349.9", "22.55", "1.4", "0"]);
    expect([fmtUsd(0.000795), fmtUsd(0.25), fmtUsd(0)]).toEqual(["$0.0008", "$0.25", "$0"]);
    expect([fmtDuration(26.6), fmtDuration(450.9), fmtDuration(3725)]).toEqual(["27s", "7m 31s", "1h 02m"]);
    expect(patchOneLiner("+++ b/a.js\n-x\n+y\n")).toEqual({ file: "a.js", removed: "x", added: "y" });
  });

  it("reads summary.json only in the scorer's shape", () => {
    expect(parseEvalSummary(null)).toBeNull();
    expect(parseEvalSummary({ A: { examPassed: "x" } })).toBeNull();
    expect(parseEvalSummary({ C: { examPassed: 21, examTotal: 22 }, Z: {} })).toEqual({ C: { examPassed: 21, examTotal: 22 } });
  });
});

describe("artifact URLs", () => {
  it("replay shows only artifacts/<file> next to the page", () => {
    expect(artifactUrl("replay", "artifacts/m-ac-2-1-step_007.png", null)).toBe("./artifacts/m-ac-2-1-step_007.png");
    for (const p of ["artifacts/../ledger.jsonl", "../x.png", "/etc/x.png", "C:\\x.png", "artifacts/a/b.png", "artifacts/x.svg", "https://e.com/x.png"]) expect(artifactUrl("replay", p, null)).toBeNull();
  });

  it("live sends an absolute path through /api/artifact with the token, and nothing without one", () => {
    expect(artifactUrl("live", "C:\\Users\\dev\\.testmuai\\s\\step 1.png", "tok12345")).toBe("/api/artifact?path=C%3A%5CUsers%5Cdev%5C.testmuai%5Cs%5Cstep%201.png&token=tok12345");
    expect(artifactUrl("live", "/home/dev/x.png", "tok12345")).toBe("/api/artifact?path=%2Fhome%2Fdev%2Fx.png&token=tok12345");
    expect(artifactUrl("live", "relative/x.png", "tok12345")).toBeNull();
    expect(artifactUrl("live", "/home/dev/x.png", null)).toBeNull();
  });
});
