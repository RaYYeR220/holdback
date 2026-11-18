import { cpSync, mkdirSync, mkdtempSync, readFileSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join, dirname } from "node:path";
import { fileURLToPath } from "node:url";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import {
  balance,
  designTests,
  evolve,
  extractResume,
  ingest,
  readGraph,
  reconcile,
  resumeSession,
  review,
} from "../src/kane/assurance.js";

const here = dirname(fileURLToPath(import.meta.url));
const fakeBin = join(here, "fake-kane.mjs");
const fx = (n: string) => join(here, "fixtures", "kane", n);

const saved = { ...process.env };
let cwd: string;
let argvLog: string;

beforeEach(() => {
  cwd = mkdtempSync(join(tmpdir(), "holdback-assurance-"));
  argvLog = join(cwd, "argv.log");
  process.env.HOLDBACK_KANE_BIN = fakeBin;
  process.env.FAKE_KANE_ARGV_LOG = argvLog;
  delete process.env.FAKE_KANE_EXIT;
});
afterEach(() => {
  for (const k of ["HOLDBACK_KANE_BIN", "FAKE_KANE_FIXTURE", "FAKE_KANE_ARGV_LOG", "FAKE_KANE_EXIT"]) {
    if (saved[k] === undefined) delete process.env[k];
    else process.env[k] = saved[k];
  }
});

const useFixture = (p: string) => {
  process.env.FAKE_KANE_FIXTURE = p;
};
const argvs = (): string[][] =>
  readFileSync(argvLog, "utf8")
    .split("\n")
    .filter(Boolean)
    .map((l) => JSON.parse(l) as string[]);
const textFixture = (text: string) => {
  const p = join(cwd, "stdout.txt");
  writeFileSync(p, text);
  return p;
};

describe("ingest / extractResume", () => {
  it("returns Paused with the pending questions", async () => {
    useFixture(fx("01-ingest.ndjson"));
    const r = await ingest(cwd, ["prd.md"]);
    expect(r.status).toBe("paused");
    if (r.status !== "paused") throw new Error("unreachable");
    expect(r.sid).toBe("ext-20261115T023959-a05ab3e0-prd");
    expect(r.resume).toContain("--resume");
    expect(r.questions).toHaveLength(2);
    // the call that paused was billed too (3.63 + 0.86 in its usage events)
    expect(r.credits).toBe(4.49);
    const q1 = r.questions[0]!;
    expect(q1.id).toBe("q1");
    expect(q1.risk).toBe("med");
    expect(q1.recommendedIndex).toBe(0);
    expect(q1.allowFreeText).toBe(false);
    expect(q1.options[0]).toMatchObject({ label: "Leave unspecified" });
    expect(q1.options.length).toBeGreaterThanOrEqual(2);
    expect(argvs()[0]).toEqual(["context", "ingest", "prd.md", "--mode", "agent"]);
  });

  it("resume completes with minted use cases and summed credits", async () => {
    useFixture(fx("02-extract.ndjson"));
    const r = await extractResume(cwd, "ext-1", { q1: "1", q2: "free text" });
    expect(r.status).toBe("complete");
    if (r.status !== "complete") throw new Error("unreachable");
    expect(r.minted).toEqual(["uc-1"]);
    expect(r.credits).toBeCloseTo(1.41, 2);
    expect(argvs()[0]).toEqual([
      "context", "extract", "--resume", "ext-1", "--mode", "agent",
      "--answer", "q1=1", "--answer", "q2=free text",
    ]);
  });

  it("maps an error event to status error", async () => {
    useFixture(
      textFixture(
        '{"type":"error","v":1,"verb":"extract","code":"E_AUTH","message":"not logged in"}\n' +
          '{"type":"done","v":1,"verb":"extract","status":"error","exit_code":1}\n',
      ),
    );
    process.env.FAKE_KANE_EXIT = "1";
    const r = await ingest(cwd, ["a.md"]);
    expect(r).toEqual({ status: "error", message: "not logged in", code: "E_AUTH", sources: [] });
  });

  it("maps a bare nonzero exit with no events to status error", async () => {
    useFixture(textFixture("boom\n"));
    process.env.FAKE_KANE_EXIT = "2";
    const r = await ingest(cwd, ["a.md"]);
    expect(r.status).toBe("error");
  });
});

describe("review", () => {
  it("approves refs and uses --json, no --mode", async () => {
    useFixture(textFixture("review: committed record 8 - 2 approved\n"));
    await expect(review(cwd, ["ac-1", "ac-2"])).resolves.toBeUndefined();
    expect(argvs()[0]).toEqual(["context", "review", "--approve", "ac-1", "ac-2", "--json"]);
  });
  it("throws on nonzero exit", async () => {
    useFixture(textFixture("nope\n"));
    process.env.FAKE_KANE_EXIT = "1";
    await expect(review(cwd, ["ac-1"])).rejects.toThrow(/review/);
  });
});

describe("designTests", () => {
  it("collects tests, acs, gaps, variables, credits, next", async () => {
    useFixture(fx("03-design.ndjson"));
    const r = await designTests(cwd, "uc-1", { max: 3, force: true });
    expect(r.status).toBe("complete");
    if (r.status === "paused") throw new Error("unreachable");
    expect(r.tests).toEqual(["t-1", "t-2", "t-3"]);
    expect(r.acs).toHaveLength(9);
    expect(r.acs[0]).toBe("ac-1");
    expect(r.gaps.length).toBeGreaterThan(0);
    expect(r.variables).toEqual([
      { name: "start_url", description: expect.stringContaining("Food pantry"), secret: false },
    ]);
    expect(r.credits).toBeGreaterThan(19.43);
    expect(r.credits).toBeLessThan(19.45);
    expect(r.next[0]).toBe("kane-cli context review --approve ac-1 --mode agent");
    expect(argvs()[0]).toEqual([
      "design", "tests", "--use-case", "uc-1", "--mode", "agent", "--max", "3", "--force",
    ]);
  });
  it("omits optional flags", async () => {
    useFixture(fx("03-design.ndjson"));
    await designTests(cwd, "uc-1", {});
    expect(argvs()[0]).toEqual(["design", "tests", "--use-case", "uc-1", "--mode", "agent"]);
  });
});

describe("reconcile", () => {
  it("plan mode returns rows, plan path, summary, credits", async () => {
    useFixture(fx("07-reconcile-plan.ndjson"));
    const r = await reconcile(cwd, "prd-v2.md", "prd", "plan");
    if (r.status === "paused") throw new Error("unexpected pause");
    expect(r.rows).toEqual([{ kind: "MODIFY", ref: "uc-1", why: expect.stringContaining("updated") }]);
    expect(r.planPath).toContain("reconcile");
    expect(r.summary).toMatchObject({ applied: 0, failed: 0 });
    expect(r.credits).toBeCloseTo(4.99, 2);
    expect(argvs()[0]).toEqual([
      "maintain", "reconcile", "--from", "prd-v2.md", "--source-id", "prd", "--plan", "--mode", "agent",
    ]);
  });
  it("apply mode passes --apply", async () => {
    useFixture(fx("07-reconcile-plan.ndjson"));
    await reconcile(cwd, "prd-v2.md", "prd", "apply");
    expect(argvs()[0]).toContain("--apply");
    expect(argvs()[0]).not.toContain("--plan");
  });
});

describe("balance", () => {
  it("parses Available credits after a noise line", async () => {
    useFixture(textFixture("Skill update available: not installed\nAvailable credits: 11089.1683\n"));
    expect(await balance()).toBeCloseTo(11089.1683, 4);
  });
  it("throws when no balance line", async () => {
    useFixture(textFixture("hello\n"));
    await expect(balance()).rejects.toThrow(/balance/);
  });
});

describe("readGraph", () => {
  const seed = () => {
    mkdirSync(join(cwd, ".context"), { recursive: true });
    cpSync(fx("context-commits"), join(cwd, ".context", "commits"), { recursive: true });
    // one file per test id, as Kane leaves them (the fixture folder holds two runs' worth)
    mkdirSync(join(cwd, ".testmuai", "tests"), { recursive: true });
    for (const f of ["snap-household-qualifies-despite-above-limit-income_test.md", "nine-person-household-qualifies-at-9-467_test.md", "non-snap-household-above-2-461-is-not-eligible_test.md"])
      cpSync(join(fx("tests"), f), join(cwd, ".testmuai", "tests", f));
  };

  it("maps nodes, test files, verifies and citations", async () => {
    seed();
    useFixture(fx("context-view.json"));
    const g = await readGraph(cwd);
    expect(g.useCases.map((u) => u.id)).toEqual(["uc-1"]);
    expect(g.acs).toHaveLength(9);
    const ac4 = g.acs.find((a) => a.id === "ac-4")!;
    expect(ac4.text.startsWith("The reported applied monthly limit")).toBe(true);
    expect(ac4.useCase).toBe("uc-1");
    expect(ac4.trust).toBe("trusted");
    expect(ac4.cites.length).toBeGreaterThan(0);
    expect(ac4.cites.length).toBeLessThanOrEqual(2);
    expect(ac4.cites[0]).toMatchObject({ source: "prd" });
    expect(ac4.cites[0]!.anchor).toMatch(/^L\d+-L\d+$/);
    expect(ac4.cites[0]!.quote.length).toBeGreaterThan(0);
    expect(g.tests.map((t) => t.id)).toEqual(["t-1", "t-2", "t-3"]);
    const t3 = g.tests.find((t) => t.id === "t-3")!;
    expect(t3.title).toBe("Non-SNAP household above $2,461 is not eligible");
    expect(t3.verifies).toContain("ac-3");
    expect(t3.file.replaceAll("\\", "/")).toMatch(/\.testmuai\/tests\/non-snap-.*_test\.md$/);
    expect(g.gaps.map((x) => x.id)).toEqual(["gap-1", "gap-2", "gap-3", "gap-4"]);
    expect(argvs()[0]).toEqual(["context", "view", "--json"]);
  });

  it("reads each gap's kind and question from Kane's store, not the view's \"[object Object]\" title", async () => {
    seed();
    useFixture(fx("context-view.json"));
    const g = await readGraph(cwd);
    expect(g.gaps[0]).toEqual({
      id: "gap-1",
      title: "Missing inputs",
      kind: "incomplete",
      acs: [],
      useCase: "uc-1",
      question: {
        header: "Missing inputs",
        prompt: "What should happen when household size or monthly income is missing or invalid, including when SNAP is selected?",
        options: [
          { label: "Specify validation", detail: "Supply the validation and SNAP-path required-field rules before adding negative-input scenarios." },
          expect.objectContaining({ label: "Valid inputs only" }),
        ],
      },
    });
    expect(g.gaps.map((x) => [x.kind, x.title])).toEqual([
      ["incomplete", "Missing inputs"],
      ["budget-evicted", "Eight-person equality"],
      ["budget-evicted", "Below-limit household"],
      ["incomplete", "Pantry page URL"],
    ]);
  });

  it("takes a gap from Kane's derived node file too, options given as plain strings (the second live run)", async () => {
    // no commits: the view's gap-1 cid, as Kane 0.10.4 keeps it under .context/derived/nodes/<2>/<rest>.json
    const cid = "26a26591d65020433b9456f3a967330333a1f11640c7c1d00e26189a3884d46d";
    mkdirSync(join(cwd, ".context", "derived", "nodes", cid.slice(0, 2)), { recursive: true });
    writeFileSync(
      join(cwd, ".context", "derived", "nodes", cid.slice(0, 2), `${cid.slice(2)}.json`),
      JSON.stringify({
        label: "gap",
        content: {
          kind: "budget-evicted",
          question: { header: "today end availability", prompt: "Raise the six-pair ceiling?", options: ["Keep the six-pair limit", "Raise the ceiling"], recommended_index: 0 },
        },
      }),
    );
    useFixture(fx("context-view.json"));
    const g = await readGraph(cwd);
    expect(g.gaps[0]).toEqual({
      id: "gap-1",
      title: "today end availability",
      kind: "budget-evicted",
      acs: [],
      question: { header: "today end availability", prompt: "Raise the six-pair ceiling?", options: [{ label: "Keep the six-pair limit" }, { label: "Raise the ceiling" }] },
    });
    // a gap Kane keeps nothing for keeps the old shape
    expect(g.gaps[1]).toEqual({ id: "gap-2", title: "gap-2", kind: "gap", acs: [] });
  });

  it("refuses two test files that claim one test id: a stale file must never shadow a re-designed one (M5)", async () => {
    seed();
    cpSync(join(fx("tests"), "inclusive-limits-and-published-household-size-schedule_test.md"), join(cwd, ".testmuai", "tests", "inclusive-limits-and-published-household-size-schedule_test.md"));
    useFixture(fx("context-view.json"));
    await expect(readGraph(cwd)).rejects.toThrow(/two test files claim t-3: .*inclusive-limits.*non-snap-household/);
  });

  it("never throws when the context store is missing: cites are empty", async () => {
    useFixture(fx("context-view.json"));
    const g = await readGraph(cwd);
    expect(g.acs).toHaveLength(9);
    expect(g.acs.every((a) => a.cites.length === 0)).toBe(true);
    expect(g.tests.every((t) => t.file === "")).toBe(true);
    expect(g.tests.find((t) => t.id === "t-3")!.verifies).toContain("ac-3");
  });
});

describe("design tests --force on an unchanged use case (live, 2026-11-15)", () => {
  it("is complete with nothing new: Kane keeps the design, its ids and its tests", async () => {
    useFixture(fx("13-design-force-nothing-to-change.ndjson"));
    const d = await designTests(cwd, "uc-1", { force: true, max: 3 });
    expect(d).toMatchObject({ status: "complete", tests: [], acs: [], credits: 11.03 });
    expect(argvs()[0]).toEqual(["design", "tests", "--use-case", "uc-1", "--mode", "agent", "--max", "3", "--force"]);
  });
});

describe("design error details and resumeSession", () => {
  it("designTests error carries message and code", async () => {
    useFixture(
      textFixture(
        '{"type":"error","v":1,"verb":"design","code":"E_NOCREDIT","message":"out of credits"}\n' +
          '{"type":"done","v":1,"verb":"design","status":"error","exit_code":1}\n',
      ),
    );
    process.env.FAKE_KANE_EXIT = "1";
    const r = await designTests(cwd, "uc-1", {});
    expect(r).toMatchObject({ status: "error", message: "out of credits", code: "E_NOCREDIT", tests: [] });
  });

  const pausedStream = (verb: string, resume: string) =>
    `{"type":"session_paused","v":1,"verb":"${verb}","sid":"s-1","resume":"${resume}","pending_questions":[{"id":"q1","text":"t","risk":"low","rationale":"r","options":[{"label":"a"}],"recommended_index":0}]}\n` +
    `{"type":"done","v":1,"verb":"${verb}","status":"paused","exit_code":3}\n`;

  it("design pause resumes with the verb's own command", async () => {
    useFixture(textFixture(pausedStream("design", "kane-cli design tests --resume s-1 --mode agent")));
    const p = await designTests(cwd, "uc-1", {});
    if (p.status !== "paused") throw new Error("expected pause");
    expect(p.verb).toBe("design");
    useFixture(fx("03-design.ndjson"));
    const r = await resumeSession(cwd, p, { q1: "1" });
    expect(r.status).toBe("complete");
    expect(argvs()[1]).toEqual(["design", "tests", "--resume", "s-1", "--mode", "agent", "--answer", "q1=1"]);
  });

  it("reconcile pause resumes and parses the plan", async () => {
    useFixture(textFixture(pausedStream("reconcile", "kane-cli maintain reconcile --resume s-1 --mode agent")));
    const p = await reconcile(cwd, "a.md", "prd", "plan");
    if (p.status !== "paused") throw new Error("expected pause");
    useFixture(fx("07-reconcile-plan.ndjson"));
    const r = await resumeSession(cwd, p, { q1: "free text" });
    expect(r).toMatchObject({ status: "complete", rows: [{ kind: "MODIFY", ref: "uc-1" }] });
    expect(argvs()[1]).toEqual(["maintain", "reconcile", "--resume", "s-1", "--mode", "agent", "--answer", "q1=free text"]);
  });

  it("tokenizes quoted resume args", async () => {
    useFixture(textFixture(pausedStream("extract", "kane-cli context extract --resume s-1 --message 'a b' --mode agent")));
    const p = await ingest(cwd, ["a.md"]);
    if (p.status !== "paused") throw new Error("expected pause");
    useFixture(fx("02-extract.ndjson"));
    await resumeSession(cwd, p, {});
    expect(argvs()[1]).toEqual(["context", "extract", "--resume", "s-1", "--message", "a b", "--mode", "agent"]);
  });
});

describe("maintain evolve (R40)", () => {
  /** One fixture per kane-cli call, in order. */
  const sequence = (...files: string[]) => {
    const seq = join(cwd, "seq.txt");
    writeFileSync(seq, files.join("\n"));
    process.env.FAKE_KANE_SEQUENCE = seq;
  };
  afterEach(() => {
    delete process.env.FAKE_KANE_SEQUENCE;
  });
  const BECAUSE = "A version of the app where household size 9 is checked against the 8-person limit passed every test.";

  it("live (Kane 0.10.4): pauses for its re-design question, which Holdback answers itself with the same argv, then reports what it minted and retired", async () => {
    sequence(fx("14-evolve-paused.ndjson"), fx("15-evolve-complete.ndjson"));
    const r = await evolve(cwd, "uc-1", BECAUSE);
    const argv = ["maintain", "evolve", "uc-1", "--because", BECAUSE, "--mode", "agent"];
    expect(argvs()).toEqual([argv, [...argv, "--answer", "evolve:uc-1=1"]]);
    expect(r).toMatchObject({
      status: "complete",
      minted: [{ scenario: "sc-4", test: "t-4" }],
      superseded: [
        { scenario: "sc-1", test: "t-1" },
        { scenario: "sc-2", test: "t-2" },
        { scenario: "sc-3", test: "t-3" },
      ],
      retained: [],
      testsCommitted: 1,
      credits: 11.39, // the sum of its usage events (Kane's own running total says 11.38)
    });
    if (r.status !== "complete") throw new Error("unreachable");
    // Kane's own map: three criteria are left with no test after the evolve
    expect(r.moves.filter((m) => m.after.length === 0).map((m) => m.ac)).toEqual(["ac-2", "ac-3", "ac-4"]);
  });

  it("a re-design that finds nothing to change is a no-op, never a success", async () => {
    sequence(fx("14-evolve-paused.ndjson"), fx("16-evolve-nothing-to-change.ndjson"));
    const r = await evolve(cwd, "uc-1", BECAUSE);
    expect(r).toEqual({ status: "nothing", note: expect.stringContaining("no requested change"), credits: 5.69 });
  });

  it("a follow-up evolve that covers criteria again reports its own minted and retired pairs", async () => {
    sequence(fx("14-evolve-paused.ndjson"), fx("17-evolve-cover-again.ndjson"));
    const r = await evolve(cwd, "uc-1", 'cover ac-2 ("x") again');
    expect(r).toMatchObject({
      status: "complete",
      minted: [
        { scenario: "sc-5", test: "t-5" },
        { scenario: "sc-6", test: "t-6" },
      ],
      superseded: [{ scenario: "sc-4", test: "t-4" }],
      testsCommitted: 2,
      credits: 7.33,
    });
  });

  it("an evolve that minted no test, or one whose run failed, is not a success", async () => {
    const noTests = textFixture(
      '{"type":"commit","v":1,"verb":"design","acs":0,"scenarios":1,"tests":0,"minted":[{"logical_id":"sc-4"}]}\n' +
        '{"type":"evolve_diff","v":1,"verb":"evolve","use_case":"uc-1","superseded":[],"minted":[],"retained":[],"moves":[]}\n' +
        '{"type":"done","v":1,"verb":"evolve","status":"complete","exit_code":0}\n',
    );
    sequence(fx("14-evolve-paused.ndjson"), noTests);
    expect(await evolve(cwd, "uc-1", BECAUSE)).toMatchObject({ status: "nothing", note: expect.stringMatching(/no new test/) });

    writeFileSync(join(cwd, "seq.txt.count"), "0");
    const failed = textFixture('{"type":"error","v":1,"verb":"evolve","code":"E_NOCREDIT","message":"out of credits"}\n{"type":"done","v":1,"verb":"evolve","status":"error","exit_code":1}\n');
    sequence(fx("14-evolve-paused.ndjson"), failed);
    expect(await evolve(cwd, "uc-1", BECAUSE)).toMatchObject({ status: "error", message: "out of credits", code: "E_NOCREDIT" });
  });

  it("live: told to keep every existing test and add one, Kane's evolve still retires every old test of the use case", async () => {
    sequence(fx("14-evolve-paused.ndjson"), fx("18-evolve-told-to-keep.ndjson"));
    const r = await evolve(cwd, "uc-1", "Keep every existing scenario and test exactly as is; ADD one new scenario and test");
    expect(r).toMatchObject({
      status: "complete",
      minted: [{ scenario: "sc-4", test: "t-4" }],
      superseded: [
        { scenario: "sc-1", test: "t-1" },
        { scenario: "sc-2", test: "t-2" },
        { scenario: "sc-3", test: "t-3" },
      ],
      retained: [],
    });
  });

  it("live: a finished design session cannot be resumed (SESSION_MISSING), and a fresh one takes no steering message", async () => {
    useFixture(fx("19-design-resume-finished-session.ndjson"));
    const resumed = await resumeSession(cwd, { status: "paused", verb: "design", sid: "design-x", resume: "kane-cli design tests --resume design-x --mode agent", questions: [], credits: 0 }, {});
    expect(resumed).toMatchObject({ status: "refused", code: "SESSION_MISSING", message: expect.stringContaining("no session") });
    useFixture(fx("20-design-message-without-resume.ndjson"));
    expect(await designTests(cwd, "uc-1", {})).toMatchObject({ status: "refused", message: expect.stringContaining("--message only rides a resume") });
  });

  it("never answers a question other than its own re-design gate: the evolve is paused, with Kane's question", async () => {
    const other = textFixture(
      '{"type":"evolve_paused","v":1,"verb":"evolve","pending_questions":[{"id":"q-scope","header":"Scope?","text":"Also re-design uc-2?","risk":"high","options":[{"label":"yes"},{"label":"no"}],"recommended_index":0,"allow_free_text":false}]}\n' +
        '{"type":"usage","v":1,"verb":"evolve","credits":2.5}\n' +
        '{"type":"done","v":1,"verb":"evolve","status":"paused","exit_code":3}\n',
    );
    sequence(other);
    const r = await evolve(cwd, "uc-1", BECAUSE);
    expect(r).toMatchObject({ status: "paused", questions: [{ id: "q-scope", text: "Also re-design uc-2?" }], credits: 2.5 });
    expect(argvs()).toHaveLength(1);
  });

  it("live (pantry run, uc-1): after its re-design gate, the evolve's design session paused on Kane's own questions: paused, with them, never answered", async () => {
    sequence(fx("14-evolve-paused.ndjson"), fx("21-evolve-design-paused.ndjson"));
    const r = await evolve(cwd, "uc-1", BECAUSE);
    expect(argvs()).toHaveLength(2); // the gate's answer, and nothing after it
    expect(argvs()[1]!.slice(-2)).toEqual(["--answer", "evolve:uc-1=1"]);
    expect(r).toMatchObject({
      status: "paused",
      questions: [
        { id: "q1", text: expect.stringMatching(/^For a household of one with no benefit and \$568 weekly income, should the result be Eligible\./) },
        { id: "q2", text: expect.stringContaining("truncated") },
      ],
    });
    // the paused design session's usage (the gate's call reports none)
    expect(r.credits).toBe(11.25);
  });

  it("a gate asked again after Holdback answered it is an error, never answered twice", async () => {
    sequence(fx("14-evolve-paused.ndjson"), fx("14-evolve-paused.ndjson"));
    expect(await evolve(cwd, "uc-1", BECAUSE)).toMatchObject({ status: "error", message: expect.stringMatching(/paused the evolve again/) });
    expect(argvs()).toHaveLength(2);
  });
});
