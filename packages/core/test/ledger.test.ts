import { mkdtempSync, readFileSync, writeFileSync, appendFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { describe, expect, it } from "vitest";
import { appendEvent, gate, readEvents, reduce, type LedgerEvent, type RunKind } from "../src/index.js";
import type { TestRunResult } from "../src/kane/testmd.js";

const at = "2026-11-15T00:00:00.000Z";
const acNode = (id: string, useCase = "uc-1") => ({
  id,
  text: `text ${id}`,
  useCase,
  cites: [{ source: "spec.md", anchor: "a", quote: "q" }],
  trust: "high",
});
const testNode = (id: string, verifies: string[]) => ({ id, title: id, file: `${id}.md`, verifies });
const design = (
  acs: string[],
  tests: [string, string[]][],
  opts: { useCase?: string; credits?: number } = {},
): LedgerEvent => ({
  t: "design",
  at,
  useCase: opts.useCase ?? "uc-1",
  acs: acs.map((a) => acNode(a, opts.useCase ?? "uc-1")),
  tests: tests.map(([id, v]) => testNode(id, v)),
  gaps: [],
  credits: opts.credits ?? 0,
});
const result = (
  testId: string | null,
  passed: string[],
  failed: string[],
  extra: Partial<TestRunResult> = {},
): TestRunResult => ({
  testFile: `${testId}.md`,
  testId,
  status: failed.length ? "failed" : "passed",
  steps: [],
  criteriaPassed: passed,
  criteriaFailed: failed,
  credits: 0,
  replayDecisions: 0,
  authorDecisions: 0,
  healTriggered: false,
  durationS: 1,
  ...extra,
});
const run = (r: TestRunResult, kind: RunKind = "build", turn?: number): LedgerEvent => ({
  t: "run",
  at,
  kind,
  turn,
  result: r,
});
const mutant = (
  ac: string,
  verdict: "killed" | "survived" | "survived-by-heal" | "invalid",
  usd = 0,
): LedgerEvent => ({ t: "mutant", at, id: `m-${ac}-${verdict}`, ac, patch: "p", model: "m", usd, verdict });
const status = (events: LedgerEvent[], ac: string) => reduce(events).acs[ac]?.status;

describe("design", () => {
  it.each([
    ["AC with >=1 test is owed", design(["ac-1"], [["t-1", ["ac-1"]]]), "owed"],
    ["AC with 0 tests is needs-spec", design(["ac-1"], [["t-1", ["ac-2"]]]), "needs-spec"],
    ["AC with no tests at all is needs-spec", design(["ac-1"], []), "needs-spec"],
  ])("%s", (_n, ev, expected) => {
    expect(status([ev], "ac-1")).toBe(expected);
  });

  it("tests = every TestNode whose verifies includes the AC id", () => {
    const s = reduce([
      design(["ac-1", "ac-2"], [["t-1", ["ac-1"]], ["t-2", ["ac-1", "ac-2"]], ["t-3", ["ac-9"]]]),
    ]);
    expect(s.acs["ac-1"]!.tests).toEqual(["t-1", "t-2"]);
    expect(s.acs["ac-2"]!.tests).toEqual(["t-2"]);
    expect(s.acs["ac-1"]!.text).toBe("text ac-1");
    expect(s.acs["ac-1"]!.cites).toHaveLength(1);
  });

  it("latest design for a use case replaces its ACs and tests; other use cases untouched", () => {
    const s = reduce([
      design(["ac-1", "ac-2"], [["t-1", ["ac-1", "ac-2"]]], { useCase: "uc-1" }),
      design(["ac-5"], [["t-5", ["ac-5"]]], { useCase: "uc-2" }),
      design(["ac-1"], [["t-9", ["ac-1"]]], { useCase: "uc-1" }),
    ]);
    expect(Object.keys(s.acs).sort()).toEqual(["ac-1", "ac-5"]);
    expect(s.acs["ac-1"]!.tests).toEqual(["t-9"]);
  });

  it("a later design replacing an AC's tests resets it to owed (even proved)", () => {
    const base: LedgerEvent[] = [
      design(["ac-1"], [["t-1", ["ac-1"]]]),
      run(result("t-1", ["ac-1"], [])),
      mutant("ac-1", "killed"),
    ];
    expect(status(base, "ac-1")).toBe("proved");
    const redesigned = [...base, design(["ac-1"], [["t-2", ["ac-1"]]])];
    expect(status(redesigned, "ac-1")).toBe("owed");
    // old results for t-1 must not count; t-2 has not run
    expect(status([...redesigned, run(result("t-1", ["ac-1"], []))], "ac-1")).toBe("owed");
    expect(status([...redesigned, run(result("t-2", ["ac-1"], []))], "ac-1")).toBe("passing");
  });

  it("redesign that reuses the same test id still resets to owed", () => {
    const evs = [
      design(["ac-1"], [["t-1", ["ac-1"]]]),
      run(result("t-1", ["ac-1"], [])),
      design(["ac-1"], [["t-1", ["ac-1"]]]),
    ];
    expect(status(evs, "ac-1")).toBe("owed");
  });
});

describe("build runs", () => {
  const d = design(["ac-1"], [["t-1", ["ac-1"]]]);

  it("passing run -> passing", () => {
    expect(status([d, run(result("t-1", ["ac-1"], []))], "ac-1")).toBe("passing");
  });

  it("AC verified by 2 tests stays owed until both pass", () => {
    const d2 = design(["ac-1"], [["t-1", ["ac-1"]], ["t-2", ["ac-1"]]]);
    expect(status([d2, run(result("t-1", ["ac-1"], []))], "ac-1")).toBe("owed");
    expect(status([d2, run(result("t-1", ["ac-1"], [])), run(result("t-2", ["ac-1"], []))], "ac-1")).toBe(
      "passing",
    );
  });

  it("one of two tests later fails -> passing AC becomes regressed", () => {
    const d2 = design(["ac-1"], [["t-1", ["ac-1"]], ["t-2", ["ac-1"]]]);
    const evs = [
      d2,
      run(result("t-1", ["ac-1"], [])),
      run(result("t-2", ["ac-1"], [])),
      run(result("t-2", [], ["ac-1"])),
    ];
    expect(status(evs, "ac-1")).toBe("regressed");
  });

  it("failure on owed AC stays owed with lastFailure (stepText from failedStepText)", () => {
    const r = result("t-1", [], ["ac-1"], {
      failedStep: 3,
      failedStepText: "click Buy",
      screenshot: "s.png",
      verdict: { bugTitle: "b" },
    });
    const s = reduce([d, run(r, "build", 4)]);
    expect(s.acs["ac-1"]!.status).toBe("owed");
    expect(s.acs["ac-1"]!.lastFailure).toEqual({
      test: "t-1",
      step: 3,
      stepText: "click Buy",
      verdict: { bugTitle: "b" },
      screenshot: "s.png",
      turn: 4,
    });
  });

  it("passing AC failing a build run -> regressed", () => {
    expect(status([d, run(result("t-1", ["ac-1"], [])), run(result("t-1", [], ["ac-1"]))], "ac-1")).toBe(
      "regressed",
    );
  });

  it("proved AC failing a build run -> regressed", () => {
    const evs = [d, run(result("t-1", ["ac-1"], [])), mutant("ac-1", "killed"), run(result("t-1", [], ["ac-1"]))];
    expect(status(evs, "ac-1")).toBe("regressed");
  });

  it("regressed AC recovers to passing when all tests pass again", () => {
    const evs = [
      d,
      run(result("t-1", ["ac-1"], [])),
      run(result("t-1", [], ["ac-1"])),
      run(result("t-1", ["ac-1"], [])),
    ];
    expect(status(evs, "ac-1")).toBe("passing");
  });

  it("run matched by (ac, test): unrelated test id / null id / unknown AC is ignored", () => {
    expect(status([d, run(result("t-99", ["ac-1"], []))], "ac-1")).toBe("owed");
    expect(status([d, run(result(null, ["ac-1"], []))], "ac-1")).toBe("owed");
    expect(() => reduce([d, run(result("t-1", ["ac-ghost"], ["ac-ghost2"]))])).not.toThrow();
  });

  it("failed AC does not affect other ACs of the same run", () => {
    const d2 = design(["ac-1", "ac-2"], [["t-1", ["ac-1", "ac-2"]]]);
    const s = reduce([d2, run(result("t-1", ["ac-1"], ["ac-2"]))]);
    expect(s.acs["ac-1"]!.status).toBe("passing");
    expect(s.acs["ac-2"]!.status).toBe("owed");
  });

  it("vacuous AC failing a build run -> owed", () => {
    const evs = [d, run(result("t-1", ["ac-1"], [])), mutant("ac-1", "survived"), run(result("t-1", [], ["ac-1"]))];
    expect(status(evs, "ac-1")).toBe("owed");
  });

  it.each(["falsify", "exam", "bisect"] as RunKind[])("%s run never changes AC status", (kind) => {
    const base = [d, run(result("t-1", ["ac-1"], []))];
    expect(status([...base, run(result("t-1", [], ["ac-1"]), kind)], "ac-1")).toBe("passing");
    expect(status([d, run(result("t-1", ["ac-1"], []), kind)], "ac-1")).toBe("owed");
    expect(reduce([d, run(result("t-1", [], ["ac-1"]), kind)]).acs["ac-1"]!.lastFailure).toBeUndefined();
  });
});

describe("build runs without coverage lists (fallback to test verifies)", () => {
  const d = design(["ac-1", "ac-2"], [["t-1", ["ac-1", "ac-2"]]]);
  it("timeout result on a passing AC -> regressed with reason", () => {
    const evs = [
      d,
      run(result("t-1", ["ac-1", "ac-2"], [])),
      run(result("t-1", [], [], { status: "error", reason: "timeout" }), "build", 2),
    ];
    const s = reduce(evs);
    expect(s.acs["ac-1"]!.status).toBe("regressed");
    expect(s.acs["ac-2"]!.status).toBe("regressed");
    expect(s.acs["ac-1"]!.lastFailure).toMatchObject({ test: "t-1", reason: "timeout", turn: 2 });
  });
  it("passed with empty lists -> passing via fallback", () => {
    const s = reduce([d, run(result("t-1", [], [], { status: "passed" }))]);
    expect(s.acs["ac-1"]!.status).toBe("passing");
    expect(s.acs["ac-2"]!.status).toBe("passing");
  });
  it.each(["failed", "broken", "error"] as const)("%s with empty lists on owed AC -> owed + lastFailure", (st) => {
    const s = reduce([d, run(result("t-1", [], [], { status: st, failedStep: 2, failedStepText: "x", screenshot: "s.png" }))]);
    expect(s.acs["ac-1"]!.status).toBe("owed");
    expect(s.acs["ac-1"]!.lastFailure).toMatchObject({ test: "t-1", step: 2, stepText: "x", screenshot: "s.png" });
  });
  it("non-empty lists keep precise behaviour (no fallback)", () => {
    const s = reduce([d, run(result("t-1", ["ac-1"], [], { status: "failed" }))]);
    expect(s.acs["ac-1"]!.status).toBe("passing");
    expect(s.acs["ac-2"]!.status).toBe("owed");
  });
  it("AC moving between use cases drops stale results", () => {
    const evs = [
      design(["ac-1"], [["t-1", ["ac-1"]]], { useCase: "uc-1" }),
      run(result("t-1", ["ac-1"], [])),
      design(["ac-1"], [["t-1", ["ac-1"]]], { useCase: "uc-2" }),
    ];
    expect(status(evs, "ac-1")).toBe("owed");
  });
});

describe("mutants", () => {
  const d = design(["ac-1"], [["t-1", ["ac-1"]]]);
  const green = [d, run(result("t-1", ["ac-1"], []))];

  it.each([
    ["killed", "proved"],
    ["survived", "vacuous"],
    ["survived-by-heal", "vacuous"],
    ["invalid", "passing"],
  ] as const)("%s on passing AC -> %s", (verdict, expected) => {
    expect(status([...green, mutant("ac-1", verdict)], "ac-1")).toBe(expected);
  });

  it("killed only promotes from passing (owed stays owed)", () => {
    expect(status([d, mutant("ac-1", "killed")], "ac-1")).toBe("owed");
  });

  it("survived never masks owed/regressed", () => {
    expect(status([d, mutant("ac-1", "survived")], "ac-1")).toBe("owed");
    const reg = [...green, run(result("t-1", [], ["ac-1"]))];
    expect(status([...reg, mutant("ac-1", "survived")], "ac-1")).toBe("regressed");
  });

  it("proved: invalid unchanged, survived -> vacuous", () => {
    const proved = [...green, mutant("ac-1", "killed")];
    expect(status([...proved, mutant("ac-1", "invalid")], "ac-1")).toBe("proved");
    expect(status([...proved, mutant("ac-1", "survived")], "ac-1")).toBe("vacuous");
  });

  it("vacuous stays vacuous on later passing run", () => {
    expect(status([...green, mutant("ac-1", "survived"), run(result("t-1", ["ac-1"], []))], "ac-1")).toBe(
      "vacuous",
    );
  });

  it("mutant for unknown AC is ignored for status but counted", () => {
    const s = reduce([mutant("nope", "killed", 0.5)]);
    expect(s.mutants.killed).toBe(1);
    expect(s.breakerUsd).toBe(0.5);
  });
});

describe("aggregates", () => {
  it("credits sum across design + run events (all run kinds)", () => {
    const s = reduce([
      design(["ac-1"], [["t-1", ["ac-1"]]], { credits: 3 }),
      design(["ac-2"], [], { useCase: "uc-2", credits: 2 }),
      run(result("t-1", ["ac-1"], [], { credits: 1.5 })),
      run(result("t-1", ["ac-1"], [], { credits: 4 }), "falsify"),
    ]);
    expect(s.credits).toBe(10.5);
  });

  it("credits of a replaced design still count", () => {
    const s = reduce([design(["ac-1"], [], { credits: 3 }), design(["ac-1"], [], { credits: 2 })]);
    expect(s.credits).toBe(5);
  });

  it("breakerUsd = sum of mutant.usd; mutant counters", () => {
    const s = reduce([
      mutant("a", "killed", 0.1),
      mutant("a", "survived", 0.2),
      mutant("a", "survived-by-heal", 0.3),
      mutant("a", "invalid", 0.4),
    ]);
    expect(s.breakerUsd).toBeCloseTo(1.0);
    expect(s.mutants).toEqual({ killed: 1, survived: 2, invalid: 1 });
  });

  it("runs counts run events of every kind; turn = highest turn.start.n", () => {
    const s = reduce([
      { t: "turn.start", at, n: 2, owed: [] },
      { t: "turn.start", at, n: 5, owed: [] },
      { t: "turn.start", at, n: 3, owed: [] },
      design(["ac-1"], [["t-1", ["ac-1"]]]),
      run(result("t-1", [], [])),
      run(result("t-1", [], []), "exam"),
    ]);
    expect(s.runs).toBe(2);
    expect(s.turn).toBe(5);
  });

  it("empty ledger -> zero state; unrelated events ignored", () => {
    const s = reduce([
      { t: "spec.approved", at, refs: [] },
      { t: "regression", at, ac: "ac-1", turn: 1 },
      { t: "recordings", at, manifest: { ".testmuai/tests/output-a/r.json": "h" } },
    ]);
    expect(s).toEqual({
      acs: {},
      turn: 0,
      credits: 0,
      breakerUsd: 0,
      runs: 0,
      mutants: { killed: 0, survived: 0, invalid: 0 },
      tampered: false,
    });
  });

  it("a tamper stays on record until a later seal", () => {
    const seal: LedgerEvent = { t: "seal", at, manifest: {} };
    const tamper: LedgerEvent = { t: "tamper", at, detail: "x" };
    expect(reduce([seal, tamper]).tampered).toBe(true);
    expect(reduce([seal, tamper, { t: "recordings", at, manifest: {} }, run(result("t-1", [], []))]).tampered).toBe(true);
    expect(reduce([seal, tamper, seal]).tampered).toBe(false);
    expect(reduce([tamper, seal, tamper]).tampered).toBe(true);
  });

  it("reduce does not mutate input events", () => {
    const evs = [design(["ac-1"], [["t-1", ["ac-1"]]]), run(result("t-1", ["ac-1"], []))];
    const copy = JSON.stringify(evs);
    reduce(evs);
    expect(JSON.stringify(evs)).toBe(copy);
  });
});

describe("gate", () => {
  const d = design(["ac-1", "ac-2", "ac-3"], [["t-1", ["ac-1"]], ["t-2", ["ac-2"]]]);
  const green = [d, run(result("t-1", ["ac-1"], [])), run(result("t-2", ["ac-2"], []))];

  it.each([
    ["owed blocks stop", [d], false],
    ["all passing, needs-spec only -> allow", green, true],
    ["regressed blocks stop", [...green, run(result("t-1", [], ["ac-1"]))], false],
    ["vacuous alone does not block", [...green, mutant("ac-1", "survived")], true],
    ["no ACs -> allow", [], true],
  ] as [string, LedgerEvent[], boolean][])("%s", (_n, evs, allow) => {
    expect(gate(reduce(evs)).allowStop).toBe(allow);
  });

  it("stays shut after a tamper, even with every AC green, until a fresh seal", () => {
    const tamper: LedgerEvent = { t: "tamper", at, detail: "sealed files changed: x" };
    const g = gate(reduce([...green, tamper]));
    expect(g).toMatchObject({ allowStop: false, tampered: true, owed: [], regressed: [] });
    // more green runs do not clear it
    expect(gate(reduce([...green, tamper, run(result("t-1", ["ac-1"], []))])).allowStop).toBe(false);
    const resealed = gate(reduce([...green, tamper, { t: "seal", at, manifest: {} }]));
    expect(resealed).toMatchObject({ allowStop: true, tampered: false });
    expect(gate(reduce(green)).tampered).toBe(false);
  });

  it("buckets ACs by status", () => {
    const g = gate(reduce([d, run(result("t-1", ["ac-1"], [])), mutant("ac-1", "survived")]));
    expect(g.owed.map((a) => a.id)).toEqual(["ac-2"]);
    expect(g.vacuous.map((a) => a.id)).toEqual(["ac-1"]);
    expect(g.needsSpec.map((a) => a.id)).toEqual(["ac-3"]);
    expect(g.regressed).toEqual([]);
  });
});

describe("store", () => {
  const tmp = () => join(mkdtempSync(join(tmpdir(), "holdback-ledger-")), "nested", "dir", "ledger.jsonl");

  it("returns [] for a missing file", async () => {
    expect(await readEvents(join(tmpdir(), "definitely-missing-holdback.jsonl"))).toEqual([]);
  });

  it("appendEvent creates parent dirs and writes one JSON line per event", async () => {
    const f = tmp();
    const e1: LedgerEvent = { t: "tamper", at, detail: "a" };
    const e2: LedgerEvent = { t: "spec.approved", at, refs: ["r"] };
    await appendEvent(f, e1);
    await appendEvent(f, e2);
    expect(readFileSync(f, "utf8")).toBe(JSON.stringify(e1) + "\n" + JSON.stringify(e2) + "\n");
    expect(await readEvents(f)).toEqual([e1, e2]);
  });

  it("skips blank and corrupt lines without throwing", async () => {
    const f = tmp();
    await appendEvent(f, { t: "tamper", at, detail: "a" });
    appendFileSync(f, '\n   \n{not json\n{"t":"tamper","at":"x","detail":"torn\n');
    await appendEvent(f, { t: "tamper", at, detail: "b" });
    const got = await readEvents(f);
    expect(got.map((e) => (e as { detail: string }).detail)).toEqual(["a", "b"]);
  });

  it("rethrows non-ENOENT read errors (directory path) instead of returning an empty ledger", async () => {
    await expect(readEvents(mkdtempSync(join(tmpdir(), "holdback-dir-")))).rejects.toThrow();
  });

  it("handles CRLF line endings", async () => {
    const f = tmp();
    await appendEvent(f, { t: "tamper", at, detail: "a" });
    writeFileSync(f, readFileSync(f, "utf8").replace(/\n/g, "\r\n"));
    expect(await readEvents(f)).toHaveLength(1);
  });

  it("concurrent appends all land as intact lines", async () => {
    const f = tmp();
    await Promise.all(
      Array.from({ length: 25 }, (_, i) => appendEvent(f, { t: "tamper", at, detail: String(i) })),
    );
    expect(await readEvents(f)).toHaveLength(25);
  });
});
