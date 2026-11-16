import { EventEmitter } from "node:events";
import { createHash } from "node:crypto";
import { PassThrough } from "node:stream";
import { mkdirSync, mkdtempSync, readFileSync, realpathSync, rmSync, symlinkSync, writeFileSync, existsSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import {
  acquireCheckLock,
  appendEvent,
  appSealFiles,
  CliHumanIO,
  KaneCapReached,
  loadProject,
  logSpecAttempt,
  readEvents,
  ScriptedHumanIO,
  seal,
  type BuildResult,
  type DriftResult,
  type FalsifyResult,
  type LedgerEvent,
  type Project,
  type TestRunResult,
} from "@holdback/core";
import { defaultCtx, terminalConfirm } from "../src/context.js";
import { EXIT, installSignals, main, scrubAgentEnv, type Deps } from "../src/index.js";

const at = "2026-11-15T00:00:00.000Z";
const saved = { ...process.env };
let root: string;
let appDir: string;
let p: Project;

beforeEach(() => {
  root = mkdtempSync(join(tmpdir(), "hb-cli-"));
  process.env.HOLDBACK_HOME = join(root, "home");
  appDir = join(root, "app");
  mkdirSync(appDir);
});
afterEach(() => {
  for (const k of ["HOLDBACK_HOME", "VENICE_API_KEY"]) {
    if (saved[k] === undefined) delete process.env[k];
    else process.env[k] = saved[k];
  }
  rmSync(root, { recursive: true, force: true });
});

const log = (e: LedgerEvent) => appendEvent(p.ledgerFile, e);
const readEventsOf = () => readEvents(p.ledgerFile);

const result = (testId: string, status: "passed" | "failed", extra: Partial<TestRunResult> = {}): TestRunResult => ({
  testFile: `${testId}.md`,
  testId,
  status,
  steps: [],
  criteriaPassed: [],
  criteriaFailed: [],
  credits: 1.5,
  replayDecisions: 0,
  authorDecisions: 0,
  healTriggered: false,
  durationS: 1,
  ...extra,
});

/** An app with a spec, a verifier with one sealed test, and a ledger: ac-1 passing, ac-2 owed with a failure. */
async function fixture(opts: { seal?: boolean } = {}) {
  writeFileSync(join(appDir, "PRD.md"), "# Pantry\n\nSNAP households are eligible.\n");
  writeFileSync(join(appDir, "holdback.config.json"), "{}");
  p = await loadProject(appDir);
  const tests = join(p.verifierDir, ".testmuai", "tests");
  mkdirSync(tests, { recursive: true });
  writeFileSync(join(tests, "t1_test.md"), "# t1\n");
  const ac = (id: string) => ({ id, text: `criterion ${id}`, useCase: "uc-1", cites: [], trust: "derived" as const });
  await log({
    at,
    t: "design",
    useCase: "uc-1",
    acs: [ac("ac-1"), ac("ac-2")],
    tests: [
      { id: "t-1", title: "one", file: ".testmuai/tests/t1_test.md", verifies: ["ac-1"] },
      { id: "t-2", title: "two", file: ".testmuai/tests/t1_test.md", verifies: ["ac-2"] },
    ],
    gaps: [],
    credits: 12,
  });
  if (opts.seal !== false) await log({ at, t: "seal", manifest: await seal(p.verifierDir, { appDir, files: appSealFiles(p) }) });
  await log({ at, t: "turn.start", n: 1, owed: ["ac-1", "ac-2"] });
  await log({ at, t: "run", kind: "build", turn: 1, result: result("t-1", "passed") });
  await log({ at, t: "run", kind: "build", turn: 1, result: result("t-2", "failed", { failedStep: 2, verdict: { bugTitle: "Limit off by one" } }) });
}

/** A seal of the app as it is now (a drift approval, say): no agent turn has started since. */
/** The seal after a drift the human approved interactively: no agent turn before it counts any more (I-2). */
async function resealNow() {
  await log({ at, t: "seal", manifest: await seal(p.verifierDir, { appDir, files: appSealFiles(p) }), checkpoint: true });
}

/** Like `fixture`, but ac-2 has passed too: every criterion is green. */
async function greenFixture() {
  await fixture();
  await log({ at, t: "run", kind: "build", turn: 2, result: result("t-2", "passed") });
}

type Out = { code: number; out: string; err: string };
type Fakes = Partial<Deps>;

async function cli(args: string[], deps: Fakes = {}, extra: Record<string, unknown> = {}): Promise<Out> {
  const out: string[] = [];
  const err: string[] = [];
  // a clean environment: the suite itself may run inside a Claude Code session (CLAUDECODE is set there)
  const code = await main(args, { cwd: appDir, out: (l) => out.push(l), err: (l) => err.push(l), deps: { env: {}, ...deps }, ...extra });
  return { code, out: out.join("\n"), err: err.join("\n") };
}

const buildOk: BuildResult = { allowStop: true, turns: 2, reason: "gate-open" };
const falsifyOk: FalsifyResult = { killed: [], survived: [], invalid: [], redesigned: [], vacuous: [], skipped: [], usd: 0, reason: "done" };
const notCalled = (name: string) => async () => {
  throw new Error(`${name} must not be called`);
};

/** Fake IO that records `close`. */
function fakeIO() {
  const io = { closed: 0, answer: async () => ({}), approve: async () => [], close() { io.closed++; } };
  return io;
}

describe("init", () => {
  it("writes holdback.config.json with the defaults, creates the verifier folder and prints its path", async () => {
    const r = await cli(["init"]);
    expect(r.code).toBe(0);
    const cfg = JSON.parse(readFileSync(join(appDir, "holdback.config.json"), "utf8"));
    expect(cfg.spec).toEqual(["PRD.md"]);
    expect(cfg.start).toEqual({ cmd: "npm start", port: 3100, readyPath: "/" });
    expect(cfg.breaker).toEqual({ model: "deepseek-v4-flash", capUsd: 2 });
    p = await loadProject(appDir);
    expect(existsSync(p.verifierDir)).toBe(true);
    expect(r.out).toContain(p.verifierDir);
  });

  it("takes --spec, --url, --start and --port", async () => {
    const r = await cli(["init", "--spec", "docs/SPEC.md", "--url", "https://example.com/a", "--url", "https://example.com/b", "--start", "node server.js", "--port", "4100"]);
    expect(r.code).toBe(0);
    const cfg = JSON.parse(readFileSync(join(appDir, "holdback.config.json"), "utf8"));
    expect(cfg.spec).toEqual(["docs/SPEC.md"]);
    expect(cfg.specUrls).toEqual(["https://example.com/a", "https://example.com/b"]);
    expect(cfg.start).toMatchObject({ cmd: "node server.js", port: 4100 });
    expect(r.err).toContain("docs/SPEC.md does not exist yet");
  });

  it("refuses to overwrite an existing config without --force, and rejects a bad port", async () => {
    writeFileSync(join(appDir, "holdback.config.json"), '{"start":{"port":1}}');
    const r = await cli(["init"]);
    expect(r.code).toBe(1);
    expect(r.err).toContain("already exists");
    expect(readFileSync(join(appDir, "holdback.config.json"), "utf8")).toBe('{"start":{"port":1}}');
    expect((await cli(["init", "--force", "--port", "abc"])).code).toBe(1);
    expect((await cli(["init", "--force"])).code).toBe(0);
  });
});

describe("init --force", () => {
  it("keeps spec, specUrls and start from the old config unless a flag overrides them", async () => {
    writeFileSync(
      join(appDir, "holdback.config.json"),
      JSON.stringify({ spec: ["docs/A.md"], specUrls: ["https://example.com/x"], start: { cmd: "node a.js", port: 4000, readyPath: "/health" } }),
    );
    await cli(["init", "--force"]);
    let cfg = JSON.parse(readFileSync(join(appDir, "holdback.config.json"), "utf8"));
    expect(cfg.spec).toEqual(["docs/A.md"]);
    expect(cfg.specUrls).toEqual(["https://example.com/x"]);
    expect(cfg.start).toEqual({ cmd: "node a.js", port: 4000, readyPath: "/health" });
    await cli(["init", "--force", "--port", "4500", "--spec", "B.md"]);
    cfg = JSON.parse(readFileSync(join(appDir, "holdback.config.json"), "utf8"));
    expect(cfg.spec).toEqual(["B.md"]);
    expect(cfg.specUrls).toEqual(["https://example.com/x"]);
    expect(cfg.start).toEqual({ cmd: "node a.js", port: 4500, readyPath: "/health" });
  });
});

describe("unknown command", () => {
  it("exits 1", async () => {
    const r = await cli(["frobnicate"]);
    expect(r.code).toBe(1);
    expect(r.err).toContain("unknown command");
  });
});

describe("status and owed", () => {
  it("status --json prints the reduced state and the gate", async () => {
    await fixture();
    const r = await cli(["status", "--json"]);
    expect(r.code).toBe(0);
    const doc = JSON.parse(r.out);
    expect(doc.state.acs["ac-1"].status).toBe("passing");
    expect(doc.state.acs["ac-2"]).toMatchObject({ status: "owed", lastFailure: { test: "t-2", verdict: { bugTitle: "Limit off by one" } } });
    expect(doc.state.credits).toBe(15);
    expect(doc.gate).toMatchObject({ open: false, owed: ["ac-2"], tampered: false });
  });

  it("status shows Kane's evolve as a loop event (tests minted and retired) and why a criterion is vacuous or needs the spec, never the because, with or without CLAUDECODE (R40, I-4)", async () => {
    await greenFixture();
    const because = "A planted bug got past every test of this use case. ac-2 (\"criterion ac-2\"): a household of 9 is held to the 8-person limit.";
    await log({ at, t: "mutant", id: "m-ac-2-1", ac: "ac-2", patch: "p", model: "m", usd: 0, verdict: "survived" });
    await log({ at, t: "falsify.evolved", uc: "uc-1", because, minted: ["t-4"], retired: ["t-1", "t-2"], credits: 11.39, mutants: ["m-ac-2-1"] });
    await log({
      at,
      t: "design",
      useCase: "uc-1",
      acs: ["ac-1", "ac-2"].map((id) => ({ id, text: `criterion ${id}`, useCase: "uc-1", cites: [], trust: "derived" })),
      tests: [{ id: "t-4", title: "four", file: ".testmuai/tests/t1_test.md", verifies: ["ac-2"] }],
      gaps: [],
      credits: 0,
      notes: { "ac-1": "Kane's evolved tests no longer cover it" },
    });
    await log({ at, t: "falsify.evolved", uc: "uc-1", because: "cover ac-1 again: a household of 9", minted: ["t-5", "t-6"], retired: [], credits: 4, mutants: ["m-ac-2-1"], followUp: true });
    // `env -u CLAUDECODE holdback status` is open to the agent: the because (the target of the hidden test) is never printed
    for (const env of [{}, { CLAUDECODE: "1" }]) {
      const human = await cli(["status"], { env });
      expect(human.out).toMatch(/ac-1\s+needs-spec\s+Kane's evolved tests no longer cover it/);
      expect(human.out).toContain("uc-1 evolved: 1 test minted, 2 retired (11.39 credits)");
      expect(human.out).toContain("uc-1 evolved again, to cover criteria its tests had lost: 2 tests minted, 0 retired (4 credits)");
      expect(human.out).not.toContain("household of 9");
      expect(human.out).not.toMatch(/because/i);
      const doc = JSON.parse((await cli(["status", "--json"], { env })).out);
      expect(doc.evolved).toEqual([
        { uc: "uc-1", minted: ["t-4"], retired: ["t-1", "t-2"], credits: 11.39 },
        { uc: "uc-1", minted: ["t-5", "t-6"], retired: [], credits: 4, followUp: true },
      ]);
      expect(JSON.stringify(doc)).not.toContain("household of 9");
    }
  });

  it("status keeps the gate closed while every criterion passes but a test's latest run proved nothing (R34)", async () => {
    await greenFixture();
    await log({ at, t: "run", kind: "build", turn: 3, result: result("t-1", "failed", { status: "error", reason: "timeout", inconclusive: "timeout" }) });
    const r = await cli(["status"]);
    expect(r.out).toMatch(/ac-1\s+passing/);
    expect(r.out).toContain("Gate: closed | owed 0 |");
    expect(r.out).toContain("t-1 turn 3: timeout");
    const doc = JSON.parse((await cli(["status", "--json"])).out);
    expect(doc.gate).toMatchObject({ open: false, owed: [], inconclusive: ["t-1"] });
  });

  it("status shows Kane credits by balance beside the per-run sum, and the runs that proved nothing (R34)", async () => {
    await fixture();
    // the fixture's two runs (1.5 each) as one metered batch: the balance dropped 4.5
    await log({ at, t: "credits", source: "build", delta: 4.5, perRunSum: 3 });
    await log({ at, t: "run", kind: "build", turn: 2, result: result("t-2", "failed", { status: "error", reason: "timeout", inconclusive: "timeout", credits: 0 }) });
    const r = await cli(["status"]);
    expect(r.code).toBe(0);
    expect(r.out).toContain("| Kane credits 16.5 (per-run sum 15) |");
    expect(r.out).toContain("Inconclusive Kane runs (not counted; their criteria kept their status): t-2 turn 2: timeout");
    expect(r.out).toMatch(/ac-2\s+owed\s+t-2\s+Limit off by one/); // its last real failure still shows
    const doc = JSON.parse((await cli(["status", "--json"])).out);
    expect(doc.state).toMatchObject({ credits: 15, kaneCredits: 16.5, kaneUnmeasured: 0, inconclusive: [{ test: "t-2", turn: 2, reason: "timeout" }] });

    // inside Claude Code the agent sees how many, never which test or why
    const agent = await cli(["status"], { env: { CLAUDECODE: "1" } });
    expect(agent.out).toContain("Inconclusive Kane runs: 1");
    expect(agent.out).not.toMatch(/t-2 turn 2|timeout/);
    const agentJson = JSON.parse((await cli(["status", "--json"], { env: { CLAUDECODE: "1" } })).out);
    expect(agentJson.state.inconclusive).toBe(1);
    expect(JSON.stringify(agentJson)).not.toContain("timeout");

    await log({ at, t: "credits", source: "check", delta: null, perRunSum: 0, error: "balance: offline" });
    expect((await cli(["status"])).out).toContain("Kane credits 16.5 (per-run sum 15; 1 batch without a balance reading)");
  });

  it("status prints a table with each criterion's status, tests and last failure", async () => {
    await fixture();
    const r = await cli(["status"]);
    expect(r.code).toBe(0);
    expect(r.out).toMatch(/AC\s+STATUS\s+TESTS\s+LAST FAILURE/);
    expect(r.out).toMatch(/ac-1\s+passing\s+t-1\s*$/m);
    expect(r.out).toMatch(/ac-2\s+owed\s+t-2\s+Limit off by one/);
    expect(r.out).toContain("Gate: closed");
  });

  it("owed points at Kane's screenshot as the agent sees it (kane-evidence/), never at Kane's temp file (M15)", async () => {
    await fixture();
    const temp = join(root, "tmp", "v16-run-1", "screenshots", "step_002.png");
    await log({ at, t: "run", kind: "build", turn: 2, result: result("t-2", "failed", { failedStep: 2, screenshot: temp, verdict: { bugTitle: "Limit off by one" } }) });
    const none = await cli(["owed"]);
    expect(none.out).not.toContain("step_002.png");
    expect(none.out).not.toContain("Screenshot:");
    mkdirSync(join(appDir, "kane-evidence", "turn-2"), { recursive: true });
    writeFileSync(join(appDir, "kane-evidence", "turn-2", "t-2-step-2.png"), "png");
    const r = await cli(["owed"]);
    expect(r.out).toContain("Screenshot: kane-evidence/turn-2/t-2-step-2.png");
    expect(r.out).not.toContain("step_002.png");
  });

  it("owed prints the brief for the criteria still owed", async () => {
    await fixture();
    const r = await cli(["owed"]);
    expect(r.code).toBe(0);
    expect(r.out).toContain("1 criterion still owed");
    expect(r.out).toContain("## ac-2");
    expect(r.out).not.toContain("## ac-1");
  });

  it("fails closed on a ledger it cannot read: non-zero, a message, never an empty gate", async () => {
    await fixture();
    // a folder where the ledger file should be: EISDIR, not ENOENT
    rmSync(p.ledgerFile);
    mkdirSync(p.ledgerFile);
    for (const args of [["status"], ["status", "--json"], ["owed"], ["run"]]) {
      const r = await cli(args, { runBuildLoop: notCalled("build") as never, humanIO: fakeIO as never, env: { VENICE_API_KEY: "k" } });
      expect(r.code, args.join(" ")).toBe(1);
      expect(r.err).toMatch(/error: .*(EISDIR|illegal operation)/i);
      expect(r.out).not.toMatch(/No acceptance criteria/);
    }
  });

  it("exits 2 with the tamper explanation when the ledger records a tamper", async () => {
    await fixture();
    await log({ at, t: "tamper", detail: "sealed files changed: .testmuai/tests/t1_test.md" });
    const r = await cli(["status"]);
    expect(r.code).toBe(2);
    expect(r.err).toContain("sealed files changed: .testmuai/tests/t1_test.md");
    expect(r.err).toContain("gate stays closed");
    expect(r.err).toContain("holdback reseal");
    expect(r.err).toContain(".git/config");
    expect((await cli(["status", "--json"])).code).toBe(2);
  });

  it("exits 2 on a tamper marker with no ledger event, and on a sealed file that changed on disk", async () => {
    await fixture();
    writeFileSync(join(p.home, "TAMPERED"), "2026 marker only\n");
    const marked = await cli(["status"]);
    expect(marked.code).toBe(2);
    expect(marked.err).toContain("marker only");
    rmSync(join(p.home, "TAMPERED"));
    writeFileSync(join(p.verifierDir, ".testmuai", "tests", "t1_test.md"), "# forged\n");
    const forged = await cli(["status"]);
    expect(forged.code).toBe(2);
    expect(forged.err).toContain(".testmuai/tests/t1_test.md");
  });

  it("status and owed escape control and bidi characters in what Kane and the agent wrote (addendum 3)", async () => {
    await fixture();
    await log({ at, t: "run", kind: "build", turn: 2, result: result("t-2", "failed", { failedStep: 2, verdict: { bugTitle: "Limit\u001b[2J off‮by one", observed: "Total​: $4\u009b31m" } }) });
    for (const cmd of ["status", "owed"]) {
      const r = await cli([cmd]);
      expect(r.out, cmd).toMatch(/\\x1b\[2J|\\u200B/);
      expect(/[\u0000-\u0008\u000b-\u001f\u007f-\u009f]|\p{Cf}/u.test(r.out + r.err), cmd).toBe(false);
    }
  });

  it("status --json escapes C1 and format characters as \\u escapes: still valid JSON, the same strings (addendum 4)", async () => {
    await fixture();
    const title = "Limit\u009b31m off\u202Eby one\u200B";
    await log({ at, t: "run", kind: "build", turn: 2, result: result("t-2", "failed", { verdict: { bugTitle: title } }) });
    const r = await cli(["status", "--json"]);
    expect(/[\u007f-\u009f]|\p{Cf}/u.test(r.out)).toBe(false);
    expect(r.out).toContain("\\u009b");
    expect(r.out).toContain("\\u202e");
    expect(JSON.parse(r.out).state.acs["ac-2"].lastFailure.verdict.bugTitle).toBe(title);
  });

  it("reports an edited spec as drift, not a tamper", async () => {
    await fixture();
    writeFileSync(join(appDir, "PRD.md"), "# Pantry\n\nSNAP households are eligible.\nPlus a new rule.\n");
    const r = await cli(["status"]);
    expect(r.code).toBe(0);
    expect(r.out).toContain("spec changed since the last seal");
  });

  it("says so when nothing has been designed yet", async () => {
    writeFileSync(join(appDir, "holdback.config.json"), "{}");
    const r = await cli(["status"]);
    expect(r.code).toBe(0);
    expect(r.out).toContain("No acceptance criteria yet");
    expect(r.out).toContain("Gate: closed");
    expect(JSON.parse((await cli(["status", "--json"])).out).gate.open).toBe(false);
  });
});

describe("spec", () => {
  it("runs the spec stage with a vouched log, and always closes the human IO", async () => {
    await fixture({ seal: false });
    const io = fakeIO();
    let calls = 0;
    const r = await cli(["spec"], {
      humanIO: () => io as never,
      runSpecStage: async (_p, got, logFn) => {
        calls++;
        expect(got).toBe(io);
        await logFn({ at, t: "seal", manifest: await seal(p.verifierDir, { appDir, files: appSealFiles(p) }) });
      },
    });
    expect(calls).toBe(1);
    expect(r.code).toBe(0);
    expect(r.out).toContain("Sealed 2 acceptance criteria");
    expect(io.closed).toBe(1);
  });

  it("--dashboard answers through the in-process server: a pending approval shows in /api/state and a POST resolves the stage", async () => {
    await fixture({ seal: false });
    let approved: string[] | undefined;
    const out: string[] = [];
    const run = main(["spec", "--dashboard", "--port", "0"], {
      cwd: appDir,
      out: (l) => out.push(l),
      err: () => {},
      deps: {
        env: {},
        runSpecStage: async (_p, io, logFn) => {
          approved = await io.approve([{ ref: "ac-1", title: "t", kind: "ac" }, { ref: "ac-2", title: "u", kind: "ac" }]);
          await logFn({ at, t: "seal", manifest: await seal(p.verifierDir, { appDir, files: appSealFiles(p) }) });
        },
      },
    });
    let m: RegExpExecArray | null = null;
    for (let i = 0; i < 200 && !m; i++) {
      for (const l of out) m ??= /http:\/\/127\.0\.0\.1:(\d+)\/#token=([0-9a-f]+)/.exec(l);
      if (!m) await new Promise((r) => setTimeout(r, 25));
    }
    expect(m).not.toBeNull();
    const base = `http://127.0.0.1:${m![1]}`;
    const headers = { "x-holdback-token": m![2]! };
    let state: { pending: { kind: string }[] } = { pending: [] };
    for (let i = 0; i < 200 && state.pending.length === 0; i++) {
      state = (await (await fetch(`${base}/api/state`, { headers })).json()) as typeof state;
      if (state.pending.length === 0) await new Promise((r) => setTimeout(r, 25));
    }
    expect(state.pending[0]?.kind).toBe("approve");
    const res = await fetch(`${base}/api/approve`, { method: "POST", headers, body: JSON.stringify({ refs: ["ac-2"] }) });
    expect(res.status).toBe(200);
    expect(await run).toBe(0);
    expect(approved).toEqual(["ac-2"]);
  });

  it("--dashboard and --answers together are refused", async () => {
    await fixture({ seal: false });
    const r = await cli(["spec", "--dashboard", "--answers", "x.json"], { runSpecStage: notCalled("spec") });
    expect(r.code).toBe(1);
    expect(r.err).toContain("alternatives");
  });

  it("serve rejects a --port that is not all digits", async () => {
    await fixture();
    const r = await cli(["serve", "--port", "12abc"]);
    expect(r.code).toBe(1);
    expect(r.err).toContain("--port");
  });

  it("exits 1 when the stage ends without a seal, and does not claim one", async () => {
    await fixture({ seal: false });
    const r = await cli(["spec"], { humanIO: () => fakeIO() as never, runSpecStage: async () => {} });
    expect(r.code).toBe(1);
    expect(r.err).toContain("Spec stage ended without a seal — nothing to build yet.");
    expect(r.out).not.toContain("Sealed");
  });

  it("closes the human IO when the spec stage fails, and exits 1 with the reason", async () => {
    await fixture({ seal: false });
    const io = fakeIO();
    const r = await cli(["spec"], {
      humanIO: () => io as never,
      runSpecStage: async () => {
        throw new Error("spec ingest failed: Kane is not logged in");
      },
    });
    expect(r.code).toBe(1);
    expect(r.err).toContain("Kane is not logged in");
    expect(io.closed).toBe(1);
  });
});

describe("--answers", () => {
  const script = { answers: {}, default: "recommended", approve: "all" };
  const q = { id: "q1", text: "?", risk: "med" as const, rationale: "", options: [{ label: "A" }, { label: "B" }], recommendedIndex: 1, allowFreeText: false };

  it("spec, run, drift and watch hand the answers file to the human IO; without it the terminal answers", async () => {
    await fixture();
    const seen: (string | undefined)[] = [];
    const humanIO = ((file?: string) => (seen.push(file), fakeIO())) as never;
    const answers = join(root, "answers.json");
    writeFileSync(answers, JSON.stringify(script));
    await cli(["spec", "--answers", answers], { humanIO, runSpecStage: async () => {} });
    await cli(["run", "--answers", answers, "--no-falsify"], { humanIO, runBuildLoop: async () => buildOk });
    await cli(["drift", "--answers", answers], { humanIO, runDrift: async () => ({ changed: false }) });
    const ctl = new AbortController();
    ctl.abort();
    await cli(["watch", "--answers", answers], { humanIO, watchSpec: (() => () => {}) as Deps["watchSpec"] }, { signals: () => ({ signal: ctl.signal, dispose() {} }) });
    await cli(["drift"], { humanIO, runDrift: async () => ({ changed: false }) });
    const real = realpathSync.native(answers);
    expect(seen).toEqual([real, real, real, real, undefined]);
  });

  it("the default human IO reads a scripted answers file, the terminal otherwise", async () => {
    const file = join(root, "answers.json");
    writeFileSync(file, JSON.stringify(script));
    const io = await defaultCtx().deps.humanIO(file);
    expect(io).toBeInstanceOf(ScriptedHumanIO);
    expect(await io.answer([q])).toEqual({ q1: "B" });
    io.close();
    const tty = await defaultCtx().deps.humanIO();
    expect(tty).toBeInstanceOf(CliHumanIO);
    tty.close();
  });

  it("one stdin reader per process: a terminal yes is consumed once, and the next prompt reads the next line (N-C1)", async () => {
    const stdin = new PassThrough();
    const stdout = new PassThrough();
    stdout.resume();
    const confirm = terminalConfirm(stdin, stdout);
    const io = new CliHumanIO(stdin, stdout);
    const items = [
      { ref: "r1", title: "one", kind: "test" },
      { ref: "r2", title: "two", kind: "test" },
    ];
    // watch, pass 1: an approval opens the session's reader
    stdin.write("\n");
    expect(await io.approve(items)).toEqual(["r1", "r2"]);
    // pass 2: the human says the spec change is theirs, then rejects r2 in drift's approval
    const yes = confirm("Is this change yours? [y/N] ");
    stdin.write("y\n");
    expect(await yes).toBe(true);
    expect(stdin.isPaused()).toBe(false); // the session's reader still listens
    const approved = io.approve(items);
    stdin.write("r2\n");
    expect(await approved).toEqual(["r1"]); // the yes was not taken as an approval too
    // typed ahead in one chunk: each line goes to one prompt, in order
    stdin.write("n\nr1\n");
    expect(await confirm("Again? [y/N] ")).toBe(false);
    expect(await io.approve(items)).toEqual(["r2"]);
    io.close();
    // no session left: a confirm of its own still reads its line, then lets stdin go
    const last = confirm("Re-seal now? [y/N] ");
    stdin.write("yes\n");
    expect(await last).toBe(true);
    expect(stdin.isPaused()).toBe(true);
  }, 10_000);

  it("refuses an answers file inside the app folder, also through a linked folder, before anything runs", async () => {
    // the coding agent can edit anything in the app folder: its approvals must not come from there
    await fixture();
    mkdirSync(join(appDir, "notes"));
    writeFileSync(join(appDir, "notes", "answers.json"), JSON.stringify(script));
    const outside = join(root, "linked");
    symlinkSync(join(appDir, "notes"), outside, "junction");
    mkdirSync(join(appDir, "..answers"));
    writeFileSync(join(appDir, "..answers", "x.json"), JSON.stringify(script));
    for (const args of [
      ["spec", "--answers", "..answers/x.json"],
      ["spec", "--answers", join(appDir, "..answers", "x.json")],
      ["spec", "--answers", "notes/answers.json"],
      ["spec", "--answers", join(outside, "answers.json")],
      ["run", "--answers", join(outside, "answers.json")],
      ["drift", "--answers", join(appDir, "notes", "answers.json")],
    ]) {
      const r = await cli(args, { runSpecStage: notCalled("spec"), runBuildLoop: notCalled("build"), runDrift: notCalled("drift") });
      expect(r.code).toBe(1);
      expect(r.err).toContain("the answers file must be outside the app folder");
    }
  });

  it("reads and checks the answers file when the command starts, and answers from that snapshot only", async () => {
    await fixture({ seal: false });
    const file = join(root, "answers.json");
    writeFileSync(file, "{ not json");
    const broken = await cli(["spec", "--answers", file], { runSpecStage: notCalled("spec") });
    expect(broken.code).toBe(1);
    expect(broken.err).toContain("not valid JSON");
    expect((await cli(["spec", "--answers", join(root, "missing.json")], { runSpecStage: notCalled("spec") })).err).toContain("cannot read the answers file");

    writeFileSync(file, JSON.stringify({ answers: { q1: "A" }, approve: ["ac-1"] }));
    let got: unknown;
    const r = await cli(["spec", "--answers", file], {
      runSpecStage: async (_p, io, logFn) => {
        // an edit after the command started (by anyone) changes nothing
        writeFileSync(file, JSON.stringify({ answers: { q1: "B" }, approve: "all" }));
        got = { answers: await io.answer([q]), approved: await io.approve([{ ref: "ac-1", title: "", kind: "ac" }, { ref: "ac-2", title: "", kind: "ac" }]) };
        await logFn({ at, t: "seal", manifest: await seal(p.verifierDir, { appDir, files: appSealFiles(p) }) });
      },
    });
    expect(r.code).toBe(0);
    expect(got).toEqual({ answers: { q1: "A" }, approved: ["ac-1"] });
  });
});

describe("run", () => {
  /** Records the order of the stages a run calls. */
  function stages(plan: { build?: BuildResult[]; falsify?: FalsifyResult[]; drift?: DriftResult; onBuild?: (n: number) => Promise<void> | void } = {}) {
    const calls: string[] = [];
    const seen = { build: [] as { opts: unknown; deps: unknown }[], falsify: [] as unknown[], log: undefined as undefined | ((e: LedgerEvent) => Promise<void>) };
    const io = fakeIO();
    const builds = [...(plan.build ?? [buildOk])];
    const falsifies = [...(plan.falsify ?? [falsifyOk])];
    const deps: Fakes = {
      env: { VENICE_API_KEY: "test-key" }, // falsify's breaker needs it: run checks before it builds (M3)
      humanIO: () => io as never,
      runDrift: async () => {
        calls.push("drift");
        return plan.drift ?? { changed: true, applied: true };
      },
      runBuildLoop: async (_p, d, logFn, opts) => {
        calls.push("build");
        seen.log = logFn;
        seen.build.push({ opts, deps: d });
        await plan.onBuild?.(seen.build.length);
        return builds.shift() ?? buildOk;
      },
      runFalsify: async (_p, _d, _io, _log, opts) => {
        calls.push("falsify");
        seen.falsify.push(opts);
        return falsifies.shift() ?? falsifyOk;
      },
    };
    return { calls, seen, io, deps };
  }

  it("refuses to start, before any build, when falsify will need VENICE_API_KEY and it is not set (M3)", async () => {
    await greenFixture();
    const s = stages();
    const r = await cli(["run"], { ...s.deps, env: {} });
    expect(r.code).toBe(1);
    expect(r.err).toContain("VENICE_API_KEY is not set");
    expect(r.err).toContain("--no-falsify");
    expect(s.calls).toEqual([]);
    expect((await cli(["run", "--no-falsify"], { ...s.deps, env: {} })).code).toBe(0);
  });

  it("asks for `holdback spec` first when nothing is sealed, and builds nothing", async () => {
    await fixture({ seal: false });
    const s = stages();
    const r = await cli(["run"], s.deps);
    expect(r.code).toBe(1);
    expect(r.err).toContain("run `holdback spec` first");
    expect(s.calls).toEqual([]);
    expect(s.io.closed).toBe(1);
  });

  it("stops with exit 3 and names the tests when only Kane's own failures keep the gate shut, never suggesting more turns", async () => {
    await greenFixture();
    const s = stages();
    const inconclusive = [{ test: "t-1", turn: 3, reason: "environment_issue: Browser target closed" }];
    const r = await cli(["run"], { ...s.deps, runBuildLoop: async () => ({ allowStop: false, turns: 0, reason: "inconclusive", inconclusive }) });
    expect(r.code).toBe(3);
    expect(r.err).toContain("t-1 (turn 3): environment_issue: Browser target closed");
    expect(r.err).toContain("holdback status");
    expect(r.err).not.toMatch(/max-turns|maxTurns/);
    expect(r.out).toContain("Gate: ");
  });

  it("builds, falsifies, and prints the one-screen summary", async () => {
    await greenFixture();
    const s = stages();
    const r = await cli(["run"], s.deps);
    expect(r.code).toBe(0);
    expect(s.calls).toEqual(["build", "falsify"]);
    expect(r.out).toMatch(/Gate: open/);
    expect(r.out).toContain("Criteria: 0 owed, 2 passing, 0 proved, 0 vacuous, 0 needs-spec");
    expect(r.out).toContain("Turns this run: 2");
    expect(r.out).toContain("Kane credits: 16.5\n"); // no metered batch: the per-run sum is all there is
    expect(r.out).toContain("Breaker spend: $0.0000 of $2");
    expect(s.io.closed).toBe(1);
  });

  it("exits 3 when the run finishes with the gate not fully green (owed, vacuous or needs-spec left)", async () => {
    await fixture(); // ac-2 is still owed (after falsify it would go back to building: I5)
    const owed = await cli(["run", "--no-falsify"], stages().deps);
    expect(owed.code).toBe(3);
    expect(owed.out).toContain("Criteria: 1 owed");
    expect(owed.err).toContain("not fully green");
    await log({ at, t: "run", kind: "build", turn: 2, result: result("t-2", "passed") });
    await log({ at, t: "mutant", id: "m-1", ac: "ac-1", patch: "", model: "m", usd: 0, verdict: "survived" });
    const vacuous = await cli(["run"], stages().deps);
    expect(vacuous.code).toBe(3);
    expect(vacuous.out).toContain("1 vacuous");
  });

  it("counts criteria the human turned down apart, and they never keep the run from finishing green (I3)", async () => {
    await greenFixture();
    const ac = (id: string) => ({ id, text: `criterion ${id}`, useCase: "uc-2", cites: [], trust: "derived" as const });
    await log({ at, t: "design", useCase: "uc-2", acs: [ac("ac-9")], tests: [{ id: "t-9", title: "nine", file: ".testmuai/tests/t1_test.md", verifies: ["ac-9"] }], gaps: [], credits: 0, rejected: ["ac-9", "t-9"] });
    const r = await cli(["run"], stages().deps);
    expect(r.code).toBe(0);
    expect(r.out).toContain("1 rejected");
  });

  it("passes --kane-cap to the build loop, falsify and drift, and stops with exit 3 when the cap is reached (I6)", async () => {
    await greenFixture();
    const s = stages({ build: [{ allowStop: false, turns: 1, reason: "budget", error: "Kane credit cap reached: 31 of 30 credits spent on this project" }] });
    const r = await cli(["run", "--kane-cap", "30"], s.deps);
    expect(r.code).toBe(3);
    expect(r.err).toContain("Kane credit cap reached");
    expect(s.seen.build[0]!.opts).toMatchObject({ kaneCap: 30 });
    const f = stages({ falsify: [{ ...falsifyOk, reason: "kane-budget", error: "Kane credit cap reached: 40 of 30" }] });
    const fr = await cli(["run", "--kane-cap", "30"], f.deps);
    expect(fr.code).toBe(3);
    expect(f.seen.falsify[0]).toMatchObject({ kaneCap: 30 });
    expect((await cli(["run", "--kane-cap", "lots"], stages().deps)).code).toBe(1);
  });

  it("a spec stage stopped by the Kane credit cap exits 3, not as an error (I6)", async () => {
    writeFileSync(join(appDir, "PRD.md"), "# PRD\n");
    const seen: unknown[] = [];
    const r = await cli(["spec", "--kane-cap", "12.5"], {
      humanIO: () => fakeIO() as never,
      runSpecStage: async (_p, _io, _log, deps) => {
        seen.push(deps?.kaneCap);
        throw new KaneCapReached(13, 12.5);
      },
    });
    expect(seen).toEqual([12.5]);
    expect(r.code).toBe(3);
    expect(r.err).toContain("Kane credit cap reached: 13 of 12.5");
  });

  it("a spec stage that finds the spec changed under it exits 3 (n-3)", async () => {
    writeFileSync(join(appDir, "PRD.md"), "# PRD\n");
    const r = await cli(["spec"], {
      humanIO: () => fakeIO() as never,
      runSpecStage: async () => {
        throw Object.assign(new Error("the spec changed during the spec stage — run `holdback spec` again"), { name: "SpecChangedDuringStage" });
      },
    });
    expect(r.code).toBe(3);
    expect(r.err).toContain("run `holdback spec` again");
  });

  it("skips falsify with --no-falsify and passes --max-turns on", async () => {
    await greenFixture();
    const s = stages();
    const r = await cli(["run", "--no-falsify", "--max-turns", "7"], s.deps);
    expect(r.code).toBe(0);
    expect(s.calls).toEqual(["build"]);
    expect(s.seen.build[0]!.opts).toMatchObject({ maxTurnsOverride: 7 });
    expect((await cli(["run", "--max-turns", "lots"], s.deps)).code).toBe(1);
  });

  it("goes back to the build loop while falsify re-opens criteria, with one count of Kane's evolves for the whole run (R40)", async () => {
    await greenFixture();
    const evolved = [{ uc: "uc-1", because: "A planted bug got past every test. ac-2 (\"limit\"): a household of 9\u001b[31m." }];
    const s = stages({ falsify: [{ ...falsifyOk, redesigned: ["uc-1"], evolved }, falsifyOk] });
    const r = await cli(["run"], s.deps);
    expect(r.code).toBe(0);
    expect(s.calls).toEqual(["build", "falsify", "build", "falsify"]);
    expect(r.out).toContain("Kane evolved the tests of uc-1 after a planted bug got past them: building again");
    // the human sees what Kane was told (I-4: here and on the dashboard, never in `status`), escaped
    expect(r.out).toContain('  uc-1, Kane was told: A planted bug got past every test. ac-2 ("limit"): a household of 9\\x1b[31m.');
    // the bound of two evolves per use case holds across the run's falsify passes
    const [first, second] = s.seen.falsify as { evolves?: Map<string, number> }[];
    expect(first!.evolves).toBeInstanceOf(Map);
    expect(second!.evolves).toBe(first!.evolves);
  });

  it("stops with exit 3 and the unverified-change message when the spec moved while Kane evolved the tests (N-I2)", async () => {
    await greenFixture();
    const s = stages({ falsify: [{ ...falsifyOk, reason: "drift", error: "the spec changed", specChange: { files: ["PRD.md"], duringAgentTurn: true } }] });
    const r = await cli(["run"], s.deps);
    expect(r.code).toBe(3);
    expect(r.err).toContain("SPEC CHANGED — origin unverified (PRD.md)");
    expect(s.calls).toEqual(["build", "falsify"]);
  });

  it("goes back to the build loop when falsify's closing replay leaves a criterion owed or regressed (I5)", async () => {
    await greenFixture();
    let falsifies = 0;
    const s = stages();
    s.deps.runFalsify = async () => {
      s.calls.push("falsify");
      // the closing replay against the real build: t-2 fails now
      if (falsifies++ === 0) await log({ at, t: "run", kind: "build", turn: 2, result: result("t-2", "failed", { verdict: { bugTitle: "Limit off by one" } }) });
      return falsifyOk;
    };
    const build = s.deps.runBuildLoop!;
    s.deps.runBuildLoop = async (...a) => {
      if (s.calls.includes("falsify")) await log({ at, t: "run", kind: "build", turn: 3, result: result("t-2", "passed") });
      return build(...a);
    };
    const r = await cli(["run"], s.deps);
    expect(s.calls).toEqual(["build", "falsify", "build", "falsify"]);
    expect(r.out).toContain("building again");
    expect(r.code).toBe(0);
  });

  it("does not go back to the build loop when only vacuous, needs-spec or inconclusive criteria keep the gate shut (I5)", async () => {
    await greenFixture();
    const s = stages();
    s.deps.runFalsify = async () => {
      s.calls.push("falsify");
      await log({ at, t: "mutant", id: "m-1", ac: "ac-1", patch: "", model: "m", usd: 0, verdict: "survived" });
      return { ...falsifyOk, survived: ["ac-1"], vacuous: ["ac-1"] };
    };
    const r = await cli(["run"], s.deps);
    expect(s.calls).toEqual(["build", "falsify"]);
    expect(r.code).toBe(3);
  });

  it("names every planted bug that got past the tests, in plain words, and why Kane did not evolve its use case (R44)", async () => {
    await greenFixture();
    const s = stages();
    s.deps.runFalsify = async () => {
      s.calls.push("falsify");
      await log({ at, t: "mutant", id: "m-ac-1-1", ac: "ac-1", patch: "", model: "m", usd: 0, verdict: "survived" });
      return {
        ...falsifyOk,
        survived: ["ac-1"],
        vacuous: ["ac-1"],
        survivors: [{ ac: "ac-1", mutant: "m-ac-1-1", slip: "A one-person household at exactly $2,461 is told it is not eligible\u001b[31m." }],
        notEvolved: [{ uc: "uc-1", acs: ["ac-1"], why: "Kane already evolved this use case twice in this run: the next `holdback run` tries again" }],
      };
    };
    const r = await cli(["run"], s.deps);
    expect(r.code).toBe(3);
    expect(r.out).toContain("A planted bug got past the tests: ac-1 (m-ac-1-1): A one-person household at exactly $2,461 is told it is not eligible\\x1b[31m.");
    expect(r.out).toContain("Not sent to Kane: ac-1 (uc-1): Kane already evolved this use case twice in this run: the next `holdback run` tries again");
  });

  it("runs drift before the build loop when the spec changed since the seal (R32)", async () => {
    await greenFixture();
    await resealNow();
    writeFileSync(join(appDir, "PRD.md"), "# Pantry\n\nA new rule.\n");
    const s = stages();
    const r = await cli(["run"], s.deps);
    expect(r.code).toBe(0);
    expect(r.out).toContain("spec changed since the last seal — running drift");
    expect(s.calls).toEqual(["drift", "build", "falsify"]);
  });

  it("tells the human the spec change may not be theirs before drift asks them to approve it (M9)", async () => {
    await greenFixture();
    writeFileSync(join(appDir, "PRD.md"), "# Pantry\n\nA new rule.\n");
    const r = await cli(["run"], stages().deps);
    expect(r.out).toContain("PRD.md");
    expect(r.out).toMatch(/may not be yours/);
    expect(r.out).toContain("git diff -- PRD.md");
  });

  it("stops with exit 3 and points at `holdback drift` when the spec changed while the build loop ran, without falsifying", async () => {
    await greenFixture();
    const s = stages({ build: [{ allowStop: false, turns: 1, reason: "drift", error: "the spec changed since the last seal (PRD.md): run `holdback drift`" }] });
    const r = await cli(["run"], s.deps);
    expect(r.code).toBe(3);
    expect(r.err).toContain("Spec changed");
    expect(r.err).toContain("holdback drift");
    expect(r.err).not.toContain("TAMPER");
    expect(s.calls).toEqual(["build"]);
  });

  it("a spec change seen right after the agent's turn stops the run loudly: origin unverified, for the human to review (R37)", async () => {
    await greenFixture();
    const s = stages({ build: [{ allowStop: false, turns: 1, reason: "drift", error: "x", specChange: { files: ["PRD.md"], duringAgentTurn: true } }] });
    const r = await cli(["run"], s.deps);
    expect(r.code).toBe(3);
    expect(r.err).toContain("SPEC CHANGED — origin unverified (PRD.md)");
    // it says what Holdback knows, never more: an agent turn ran since the seal, not that the agent made it (N-m8)
    expect(r.err).toContain("an agent turn has run since the spec was last approved");
    expect(r.err).not.toMatch(/while the agent was working/i);
    expect(r.err).toContain("holdback drift");
  });

  it("a spec change after the guard logged a write at the spec since the seal is a tamper at the start of a run (R38)", async () => {
    await greenFixture();
    writeFileSync(join(appDir, "PRD.md"), "# Pantry\n\nA new rule.\n");
    logSpecAttempt(p.home, { tool: "Bash", how: "shell" });
    const s = stages();
    const r = await cli(["run"], s.deps);
    expect(r.code).toBe(2);
    expect(s.calls).toEqual([]);
    expect(r.err).toContain("tried to write");
  });

  it("a spec change with no record of its own counts as unverified once an agent turn ran since the seal (R38)", async () => {
    await greenFixture(); // a turn after the seal, no spec.changed on record
    writeFileSync(join(appDir, "PRD.md"), "# Pantry\n\nA new rule.\n");
    const s = stages();
    const r = await cli(["run"], s.deps);
    expect(r.code).toBe(3);
    expect(s.calls).toEqual([]);
    expect((await readEventsOf()).filter((e) => e.t === "spec.changed")).toEqual([expect.objectContaining({ duringAgentTurn: true })]);
  });

  it("never auto-drifts a spec change of unverified origin at the start of a run (R37)", async () => {
    await greenFixture();
    writeFileSync(join(appDir, "PRD.md"), "# Pantry\n\nA new rule.\n");
    await log({ at, t: "spec.changed", files: ["PRD.md"], duringAgentTurn: true, before: {}, after: {} });
    const s = stages();
    const r = await cli(["run"], s.deps);
    expect(r.code).toBe(3);
    expect(s.calls).toEqual([]);
    expect(r.err).toContain("origin unverified");
  });

  it("shows the diff from the sealed spec before an automatic drift", async () => {
    await greenFixture();
    mkdirSync(join(p.home, "sealed"), { recursive: true });
    writeFileSync(join(p.home, "sealed", "PRD.md"), readFileSync(join(appDir, "PRD.md")));
    writeFileSync(join(appDir, "PRD.md"), "# Pantry\n\nA new rule.\n");
    const r = await cli(["run"], stages().deps);
    expect(r.out).toContain("--- PRD.md (sealed)");
    expect(r.out).toContain("-SNAP households are eligible.");
    expect(r.out).toContain("+A new rule.");
  });

  it("stops with exit 3 the same way when the spec changed during falsify", async () => {
    await greenFixture();
    const s = stages({ falsify: [{ ...falsifyOk, reason: "drift", error: "the spec changed since the last seal (PRD.md): run `holdback drift`" }] });
    const r = await cli(["run"], s.deps);
    expect(r.code).toBe(3);
    expect(r.err).toContain("holdback drift");
    expect(s.calls).toEqual(["build", "falsify"]);
  });

  it("does not run drift when the spec still matches the seal", async () => {
    await greenFixture();
    const s = stages();
    await cli(["run"], s.deps);
    expect(s.calls).not.toContain("drift");
  });

  it("stops with drift's reason, never starting the build loop, when drift applied nothing", async () => {
    await greenFixture();
    await resealNow();
    writeFileSync(join(appDir, "PRD.md"), "# Pantry\n\nA new rule.\n");
    const s = stages({ drift: { changed: true, applied: false, reason: "the human declined the plan" } });
    const r = await cli(["run"], s.deps);
    expect(r.code).toBe(1);
    expect(r.err).toContain("the human declined the plan");
    expect(s.calls).toEqual(["drift"]);
    expect(s.io.closed).toBe(1);
  });

  it("stops on a tamper with the explanation and exit 2, without falsifying", async () => {
    await greenFixture();
    const s = stages({
      build: [{ allowStop: false, turns: 1, reason: "tamper" }],
      onBuild: () => appendEvent(p.ledgerFile, { at, t: "tamper", detail: "sealed files changed: PRD.md" }),
    });
    const r = await cli(["run"], s.deps);
    expect(r.code).toBe(2);
    expect(s.calls).toEqual(["build"]);
    expect(r.err).toContain("sealed files changed: PRD.md");
    expect(r.err).toContain("holdback reseal");
  });

  it("refuses to start while a tamper is on record", async () => {
    await greenFixture();
    await log({ at, t: "tamper", detail: "recordings changed" });
    const s = stages();
    const r = await cli(["run"], s.deps);
    expect(r.code).toBe(2);
    expect(s.calls).toEqual([]);
  });

  it("stops on max-turns and on a build error, non-zero, with the reason", async () => {
    await greenFixture();
    const turns = await cli(["run"], stages({ build: [{ allowStop: false, turns: 3, reason: "max-turns" }] }).deps);
    expect(turns.code).toBe(1);
    expect(turns.err).toContain("turn limit reached after 3 turns");
    const fail = await cli(["run"], stages({ build: [{ allowStop: false, turns: 0, reason: "error", error: "claude exited with code 1" }] }).deps);
    expect(fail.code).toBe(1);
    expect(fail.err).toContain("claude exited with code 1");
    const s = stages({ falsify: [{ ...falsifyOk, reason: "error", error: "VENICE_API_KEY is not set" }] });
    const nokey = await cli(["run"], s.deps);
    expect(nokey.code).toBe(1);
    expect(nokey.err).toContain("VENICE_API_KEY is not set");
  });

  it("reports a falsify budget stop as done, listing what was not attacked", async () => {
    await greenFixture();
    const r = await cli(["run"], stages({ falsify: [{ ...falsifyOk, reason: "budget", skipped: ["ac-1"] }] }).deps);
    expect(r.code).toBe(0);
    expect(r.out).toContain("Not attacked (breaker budget): ac-1");
  });

  it("passes one AbortSignal to the build loop and falsify, and exits 130 when it fires", async () => {
    await greenFixture();
    const ctl = new AbortController();
    let disposed = 0;
    const s = stages({ build: [{ allowStop: false, turns: 1, reason: "aborted" }] });
    const r = await cli(["run"], s.deps, { signals: () => ({ signal: ctl.signal, dispose: () => disposed++ }) });
    expect((s.seen.build[0]!.opts as { signal: AbortSignal }).signal).toBe(ctl.signal);
    expect(r.code).toBe(130);
    expect(s.calls).toEqual(["build"]);
    expect(disposed).toBe(1);
    const s2 = stages();
    await cli(["run"], s2.deps, { signals: () => ({ signal: ctl.signal, dispose() {} }) });
    expect((s2.seen.falsify[0] as { signal: AbortSignal }).signal).toBe(ctl.signal);
  });

  it("closes the human IO and the signal handlers when a stage throws", async () => {
    await greenFixture();
    const io = fakeIO();
    let disposed = 0;
    const r = await cli(
      ["run"],
      {
        env: { VENICE_API_KEY: "k" },
        humanIO: () => io as never,
        runBuildLoop: async () => {
          throw new Error("kaboom");
        },
      },
      { signals: () => ({ signal: new AbortController().signal, dispose: () => disposed++ }) },
    );
    expect(r.code).toBe(1);
    expect(r.err).toContain("kaboom");
    expect(io.closed).toBe(1);
    expect(disposed).toBe(1);
  });

  it("hands the build loop deps whose agent turns run without VENICE_API_KEY", async () => {
    await greenFixture();
    process.env.VENICE_API_KEY = "secret";
    const envs: (NodeJS.ProcessEnv | undefined)[] = [];
    const s = stages();
    await cli(["run", "--no-falsify"], {
      ...s.deps,
      buildDeps: { claude: async (o) => (envs.push(o.env), { exitCode: 0, resultText: "", durationMs: 1, timedOut: false, stderrTail: "" }), tests: notCalled("tests") as never, app: notCalled("app") as never },
    });
    const given = s.seen.build[0]!.deps as { claude: (o: { env?: NodeJS.ProcessEnv }) => Promise<unknown> };
    await given.claude({ env: { FOO: "1" } });
    expect(envs[0]).toEqual({ FOO: "1", VENICE_API_KEY: "" });
    // the breaker still gets it: falsify's key comes from the process environment
    expect(process.env.VENICE_API_KEY).toBe("secret");
  });

  it("scrubAgentEnv also drops every HOLDBACK_* variable but the headless mark (I8)", async () => {
    process.env.HOLDBACK_KANE_BIN = "kane.js";
    try {
      const seen: (NodeJS.ProcessEnv | undefined)[] = [];
      const deps = scrubAgentEnv({ claude: async (o) => (seen.push(o.env), {} as never), tests: notCalled("t") as never, app: notCalled("a") as never });
      await deps.claude({ env: { HOLDBACK_GUARD_LOG: "g.log", FOO: "1" } } as never);
      const env = seen[0]!;
      expect(env.FOO).toBe("1");
      for (const k of ["HOLDBACK_HOME", "HOLDBACK_KANE_BIN", "HOLDBACK_GUARD_LOG"]) {
        expect(k in env, k).toBe(true);
        expect(env[k], k).toBeUndefined();
      }
    } finally {
      delete process.env.HOLDBACK_KANE_BIN;
    }
  });

  it("scrubAgentEnv blanks the key even when no env was given", async () => {
    const seen: (NodeJS.ProcessEnv | undefined)[] = [];
    const deps = scrubAgentEnv({ claude: async (o) => (seen.push(o.env), {} as never), tests: notCalled("t") as never, app: notCalled("a") as never });
    await deps.claude({} as never);
    expect(seen[0]).toEqual({ VENICE_API_KEY: "" });
  });

  it("gives the loops a log that appends exactly one JSON line per event to the ledger", async () => {
    await greenFixture();
    const s = stages();
    await cli(["run", "--no-falsify"], s.deps);
    const before = readFileSync(p.ledgerFile, "utf8");
    await s.seen.log!({ at, t: "turn.start", n: 9, owed: ["ac-2"] });
    const added = readFileSync(p.ledgerFile, "utf8").slice(before.length);
    expect(added.endsWith("\n")).toBe(true);
    expect(added.split("\n").filter(Boolean)).toHaveLength(1);
    expect(JSON.parse(added)).toEqual({ at, t: "turn.start", n: 9, owed: ["ac-2"] });
  });
});

describe("installSignals", () => {
  it("aborts on the first SIGINT and quits hard on the second", () => {
    const proc = Object.assign(new EventEmitter(), { exited: [] as number[], exit(c: number) { this.exited.push(c); } });
    const lines: string[] = [];
    const sig = installSignals(proc, (l) => lines.push(l));
    expect(sig.signal.aborted).toBe(false);
    proc.emit("SIGINT");
    expect(sig.signal.aborted).toBe(true);
    expect(lines[0]).toContain("Ctrl-C again");
    expect(proc.exited).toEqual([]);
    proc.emit("SIGINT");
    expect(proc.exited).toEqual([130]);
    sig.dispose();
    expect(proc.listenerCount("SIGINT")).toBe(0);
    expect(proc.listenerCount("SIGTERM")).toBe(0);
  });

  it("on the second Ctrl-C kills every child Holdback started (app, kane-cli, claude) before it quits (I7)", () => {
    const order: string[] = [];
    const proc = Object.assign(new EventEmitter(), { exit(c: number) { order.push(`exit ${c}`); } });
    installSignals(proc, () => {}, () => void order.push("kill children"));
    proc.emit("SIGINT");
    expect(order).toEqual([]);
    proc.emit("SIGINT");
    expect(order).toEqual(["kill children", "exit 130"]);
  });

  it("treats SIGTERM like the first Ctrl-C", () => {
    const proc = Object.assign(new EventEmitter(), { exit() {} });
    const sig = installSignals(proc, () => {});
    proc.emit("SIGTERM");
    expect(sig.signal.aborted).toBe(true);
  });
});

describe("drift and watch", () => {
  it("drift shows the diff from the sealed spec, and asks the human in the terminal before it re-plans a change of unverified origin, answers file or not (R37)", async () => {
    await fixture();
    mkdirSync(join(p.home, "sealed"), { recursive: true });
    writeFileSync(join(p.home, "sealed", "PRD.md"), readFileSync(join(appDir, "PRD.md")));
    writeFileSync(join(appDir, "PRD.md"), "# Pantry\n\nSNAP households are eligible.\nPlus a rule the agent wrote.\n");
    await log({ at, t: "spec.changed", files: ["PRD.md"], duringAgentTurn: true, before: {}, after: {} });
    const answers = join(root, "answers.json");
    writeFileSync(answers, JSON.stringify({ answers: {}, approve: "all" }));
    let drifts = 0;
    const asked: string[] = [];
    const deps = (yes: boolean): Fakes => ({ runDrift: async () => (drifts++, { changed: true, applied: true }), confirm: async (q) => (asked.push(q), yes) });
    const no = await cli(["drift", "--answers", answers], deps(false));
    expect(no.code).toBe(1);
    expect(no.out).toContain("+Plus a rule the agent wrote.");
    expect(no.err).toContain("origin unverified");
    expect(asked).toHaveLength(1);
    expect(drifts).toBe(0);
    const yes = await cli(["drift", "--answers", answers], deps(true));
    expect(yes.code).toBe(0);
    expect(drifts).toBe(1);
  });

  it("a re-seal after a tamper never launders the spec change: drift --answers still needs a yes typed in the terminal (N-I1)", async () => {
    await fixture();
    await resealNow(); // no agent turn since this seal
    // the agent tries the spec, the spec changes, a run records the tamper
    logSpecAttempt(p.home, { tool: "Bash", how: "shell" });
    writeFileSync(join(appDir, "PRD.md"), "# Pantry\n\nSNAP households are eligible.\nA rule nobody vouches for.\n");
    expect((await cli(["run", "--no-falsify"], { runBuildLoop: notCalled("build") as never })).code).toBe(2);
    // the human re-seals the rest; the spec keeps its old seal
    const resealed = await cli(["reseal", "--yes"]);
    expect(resealed.code).toBe(0);
    const after = (await readEventsOf()).slice((await readEventsOf()).findLastIndex((e) => e.t === "seal"));
    expect(after.find((e) => e.t === "spec.changed")).toMatchObject({ files: ["PRD.md"], duringAgentTurn: true });
    // no turn and no attempt since that seal: the change still counts as unverified
    const answers = join(root, "answers.json");
    writeFileSync(answers, JSON.stringify({ answers: {}, approve: "all" }));
    const asked: string[] = [];
    const r = await cli(["drift", "--answers", answers], { runDrift: notCalled("drift") as never, confirm: async (q) => (asked.push(q), false) });
    expect(r.code).toBe(1);
    expect(asked).toHaveLength(1);
    expect(r.err).toContain("origin unverified");
  });

  it("a spec change after Kane's evolve seal still counts as unverified when agent turns ran since the last human approval: run --answers stops, drift asks the terminal (I-2)", async () => {
    await greenFixture(); // the agent's turns ran after the spec stage's seal
    await log({ at, t: "falsify.evolved", uc: "uc-1", because: "b", minted: ["t-4"], retired: ["t-1"], credits: 11, mutants: [] });
    await log({ at, t: "seal", manifest: await seal(p.verifierDir, { appDir, files: appSealFiles(p) }), by: "kane" });
    writeFileSync(join(appDir, "PRD.md"), "# Pantry\n\nSNAP households are eligible.\nA rule nobody vouched for.\n");
    const answers = join(root, "answers.json");
    writeFileSync(answers, JSON.stringify({ answers: {}, approve: "all" }));
    const run = await cli(["run", "--no-falsify", "--answers", answers], { runDrift: notCalled("drift") as never, runBuildLoop: notCalled("build") as never, confirm: notCalled("confirm") as never });
    expect(run.code).toBe(3);
    expect(run.err).toContain("origin unverified");
    const asked: string[] = [];
    const drift = await cli(["drift", "--answers", answers], { runDrift: notCalled("drift") as never, confirm: async (q) => (asked.push(q), false) });
    expect(drift.code).toBe(1);
    expect(asked).toHaveLength(1);
  });

  it("drift always hands core what it reviewed, an empty review when it showed nothing: a spec that changes after the check is never re-planned unseen (m-6)", async () => {
    await fixture();
    await resealNow();
    const seen: (Record<string, string> | undefined)[] = [];
    const runDrift = (async (_p: unknown, _io: unknown, _l: unknown, d: { reviewed?: Record<string, string> }) => (seen.push(d.reviewed), { changed: false })) as never;
    expect((await cli(["drift"], { runDrift })).code).toBe(0);
    expect(seen).toEqual([{}]);
  });

  it("a yes typed in the terminal to an unverified change tells drift so: its seal starts a fresh provenance window (I-2)", async () => {
    await fixture();
    writeFileSync(join(appDir, "PRD.md"), "# Pantry\n\nA rule after a turn.\n");
    const answers = join(root, "answers.json");
    writeFileSync(answers, JSON.stringify({ answers: {}, approve: "all" }));
    const seen: { confirmed?: boolean }[] = [];
    const runDrift = (async (_p: unknown, _io: unknown, _l: unknown, d: { confirmed?: boolean }) => (seen.push(d), { changed: true, applied: true })) as never;
    expect((await cli(["drift", "--answers", answers], { runDrift, confirm: async () => true })).code).toBe(0);
    expect(seen.map((d) => d.confirmed)).toEqual([true]);
  });

  it("drift of a change made with no agent turn since the seal shows the diff and asks nothing more (R38)", async () => {
    await fixture();
    await resealNow();
    writeFileSync(join(appDir, "PRD.md"), "# Pantry\n\nA rule.\n");
    const r = await cli(["drift"], { humanIO: () => fakeIO() as never, runDrift: async () => ({ changed: true, applied: true }), confirm: notCalled("confirm") as never });
    expect(r.code).toBe(0);
    expect(r.out).toContain("PRD.md");
  });

  it.each([["drift"], ["run"]])("%s hands drift the hash of the spec bytes whose diff it showed, and a spec that moved after that review stops it with exit 3 (N-I2)", async (cmd) => {
    await greenFixture();
    await resealNow();
    const edited = "# Pantry\n\nSNAP households are eligible.\nA reviewed rule.\n";
    writeFileSync(join(appDir, "PRD.md"), edited);
    const seen: (Record<string, string> | undefined)[] = [];
    const runDrift = (async (_p: Project, _io: unknown, _l: unknown, d: { reviewed?: Record<string, string> }) => {
      seen.push(d.reviewed);
      return { changed: true, applied: false, reason: "the spec changed again after you reviewed it (PRD.md): nothing was re-planned; review it again", specMoved: ["PRD.md"] };
    }) as never;
    const r = await cli([cmd, ...(cmd === "run" ? ["--no-falsify"] : [])], { humanIO: () => fakeIO() as never, runDrift, runBuildLoop: notCalled("build") as never });
    expect(seen).toEqual([{ "PRD.md": createHash("sha256").update(edited).digest("hex") }]);
    expect(r.code).toBe(3);
    expect(r.err).toContain("SPEC CHANGED — origin unverified (PRD.md)");
    expect(r.err).toContain("after you reviewed it");
  });

  it.each([
    [false, ["build"]],
    [true, ["build", "drift", "build"]],
  ])("watch takes a change of unverified origin into the drift review: only a yes typed in the terminal re-plans it, --answers never does (R38; yes: %s)", async (yes, expected) => {
    await greenFixture();
    mkdirSync(join(p.home, "sealed"), { recursive: true });
    writeFileSync(join(p.home, "sealed", "PRD.md"), readFileSync(join(appDir, "PRD.md")));
    const answers = join(root, "answers.json");
    writeFileSync(answers, JSON.stringify({ answers: {}, approve: "all" }));
    const ctl = new AbortController();
    let onChange: () => void = () => {};
    let watching = false;
    const calls: string[] = [];
    const asked: string[] = [];
    let builds = 0;
    const run = cli(
      ["watch", "--no-falsify", "--answers", answers],
      {
        humanIO: () => fakeIO() as never,
        confirm: async (q) => (asked.push(q), yes),
        watchSpec: ((_p, cb) => {
          onChange = cb;
          watching = true;
          return () => {};
        }) as Deps["watchSpec"],
        runDrift: async () => {
          calls.push("drift");
          await resealNow();
          return { changed: true, applied: true };
        },
        runBuildLoop: async () => {
          calls.push("build");
          if (builds++ > 0) return buildOk;
          writeFileSync(join(appDir, "PRD.md"), "# Pantry\n\nA rule the agent wrote.\n");
          return { allowStop: false, turns: 1, reason: "drift", error: "x", specChange: { files: ["PRD.md"], duringAgentTurn: true } };
        },
      },
      { signals: () => ({ signal: ctl.signal, dispose() {} }) },
    );
    await vi.waitFor(() => expect(watching).toBe(true), { timeout: 10_000 });
    onChange();
    await vi.waitFor(() => expect(asked).toHaveLength(1), { timeout: 10_000 });
    await vi.waitFor(() => expect(calls).toEqual(expected), { timeout: 10_000 });
    ctl.abort();
    const r = await run;
    expect(r.code).toBe(130);
    expect(r.err).toContain("origin unverified");
    expect(r.out).toContain("+A rule the agent wrote.");
  });

  it("drift reports applied, unchanged and declined, and closes the IO", async () => {
    await fixture();
    const io = fakeIO();
    const ran = async (d: DriftResult) => cli(["drift"], { humanIO: () => io as never, runDrift: async () => d });
    expect((await ran({ changed: false })).out).toContain("has not changed");
    expect((await ran({ changed: true, applied: true })).out).toContain("applied and sealed");
    const declined = await ran({ changed: true, applied: false, reason: "declined" });
    expect(declined.code).toBe(1);
    expect(declined.err).toContain("declined");
    expect(io.closed).toBe(3);
  });

  it("watch runs the drift-then-build pipeline on each spec edit and stops on abort", async () => {
    await fixture();
    const io = fakeIO();
    const ctl = new AbortController();
    let onChange: () => void = () => {};
    let stopped = 0;
    let watching = false;
    const calls: string[] = [];
    const run = cli(
      ["watch", "--no-falsify"],
      {
        humanIO: () => io as never,
        watchSpec: ((_p, cb) => {
          onChange = cb;
          watching = true;
          return () => void stopped++;
        }) as Deps["watchSpec"],
        runBuildLoop: async () => (calls.push("build"), buildOk),
      },
      { signals: () => ({ signal: ctl.signal, dispose() {} }) },
    );
    await vi.waitFor(() => expect(watching).toBe(true), { timeout: 10_000 });
    onChange();
    await vi.waitFor(() => expect(calls).toEqual(["build"]), { timeout: 10_000 });
    ctl.abort();
    const r = await run;
    expect(r.code).toBe(130);
    expect(stopped).toBe(1);
    expect(io.closed).toBe(1);
  });

  it("watch routes a spec edit made mid-build into drift: the next pass re-plans with the human, then builds", async () => {
    await greenFixture();
    const io = fakeIO();
    const ctl = new AbortController();
    let onChange: () => void = () => {};
    let watching = false;
    const calls: string[] = [];
    const builds: BuildResult[] = [{ allowStop: false, turns: 1, reason: "drift", error: "the spec changed since the last seal (PRD.md): run `holdback drift`" }, buildOk];
    const run = cli(
      ["watch", "--no-falsify"],
      {
        humanIO: () => io as never,
        watchSpec: ((_p, cb) => {
          onChange = cb;
          watching = true;
          return () => {};
        }) as Deps["watchSpec"],
        confirm: async () => true, // an agent turn ran since the seal: the change needs the human's yes (R38)
        runDrift: async () => {
          calls.push("drift");
          // drift applied: the edit is sealed
          await log({ at, t: "seal", manifest: await seal(p.verifierDir, { appDir, files: appSealFiles(p) }) });
          return { changed: true, applied: true };
        },
        runBuildLoop: async () => {
          calls.push("build");
          const b = builds.shift() ?? buildOk;
          // the human edits the spec while this build runs (the watcher's own event is not relied on)
          if (b.reason === "drift") writeFileSync(join(appDir, "PRD.md"), "# Pantry\n\nA new rule.\n");
          return b;
        },
      },
      { signals: () => ({ signal: ctl.signal, dispose() {} }) },
    );
    await vi.waitFor(() => expect(watching).toBe(true), { timeout: 10_000 });
    onChange();
    await vi.waitFor(() => expect(calls).toEqual(["build", "drift", "build"]), { timeout: 10_000 });
    ctl.abort();
    expect((await run).code).toBe(130);
  });
});

describe("reseal", () => {
  it("lists the sealed entries that differ, warns about .git/config, and does nothing without a yes", async () => {
    await fixture();
    writeFileSync(join(p.verifierDir, ".testmuai", "tests", "t1_test.md"), "# forged\n");
    let resealed = 0;
    const r = await cli(["reseal"], { reseal: (async () => void resealed++) as never, confirm: async () => false });
    expect(r.code).toBe(1);
    expect(resealed).toBe(0);
    expect(r.out).toContain(".testmuai/tests/t1_test.md");
    expect(r.out).toContain(".git/config");
    expect(r.err).toContain("Not re-sealed");
  });

  it("refuses when only the spec changed: that is drift for Kane to re-plan, never a re-seal", async () => {
    await fixture();
    writeFileSync(join(appDir, "PRD.md"), "# edited\n");
    let resealed = 0;
    const r = await cli(["reseal", "--yes"], { reseal: (async () => void resealed++) as never });
    expect(r.code).toBe(1);
    expect(resealed).toBe(0);
    expect(r.err).toContain("app:PRD.md");
    expect(r.err).toContain("holdback drift");
  });

  it("after a tamper, re-seals everything but a changed spec, whose old hash it keeps so drift still re-plans it", async () => {
    await fixture();
    const sealed = (await readEventsOf()).findLast((e) => e.t === "seal")!;
    await log({ at, t: "tamper", detail: "sealed files changed: .testmuai/tests/t1_test.md" });
    writeFileSync(join(appDir, "PRD.md"), "# edited\n");
    const kept: unknown[] = [];
    const reseal = (async (_p: Project, _l: unknown, _g: unknown, o?: { keep?: Record<string, string> }) => void kept.push(o?.keep)) as never;
    const r = await cli(["reseal", "--yes"], { reseal });
    expect(r.code).toBe(0);
    expect(kept).toEqual([{ "app:PRD.md": (sealed as { manifest: Record<string, string> }).manifest["app:PRD.md"] }]);
    expect(r.out).toContain("holdback drift");
  });

  it("re-seals after an interactive yes, and with --yes", async () => {
    await fixture();
    const calls: string[] = [];
    const reseal = (async (_p: Project, logFn: (e: LedgerEvent) => Promise<void>) => {
      calls.push("reseal");
      await logFn({ at, t: "seal", manifest: await seal(p.verifierDir, { appDir, files: appSealFiles(p) }) });
    }) as never;
    const asked: string[] = [];
    const yes = await cli(["reseal"], { reseal, confirm: async (q) => (asked.push(q), true) });
    expect(yes.code).toBe(0);
    expect(asked).toHaveLength(1);
    const flag = await cli(["reseal", "--yes"], { reseal, confirm: notCalled("confirm") as never });
    expect(flag.code).toBe(0);
    expect(calls).toEqual(["reseal", "reseal"]);
  });

  it("prints the tamper marker and the differing entries with control and format characters escaped (N-m7)", async () => {
    await fixture();
    writeFileSync(join(p.home, "TAMPERED"), "hook tool_name Bash\u001b[2J‮x\n");
    writeFileSync(join(p.verifierDir, ".testmuai", "tests", "evil​_test.md"), "# planted\n");
    const r = await cli(["reseal"], { reseal: notCalled("reseal") as never, confirm: async () => false });
    expect(r.code).toBe(1);
    expect(r.out).toContain("\\x1b[2J");
    expect(r.out.toLowerCase()).toContain("\\u202e");
    expect(r.out.toLowerCase()).toContain("evil\\u200b_test.md");
    expect(/[\u0000-\u0008\u000b-\u001f\u007f-\u009f]|\p{Cf}/u.test(r.out + r.err)).toBe(false);
  });

  it("seals the config and spec as they were when it listed the differences: one that moves while the human decides is not re-sealed (I-1)", async () => {
    await fixture();
    await log({ at, t: "tamper", detail: "sealed files changed: .testmuai/tests/t1_test.md" });
    writeFileSync(join(p.verifierDir, ".testmuai", "tests", "t1_test.md"), "# changed\n");
    const sealsBefore = (await readEventsOf()).filter((e) => e.t === "seal").length;
    // the config moves while the human reads the list
    const confirm = async () => (writeFileSync(join(appDir, "holdback.config.json"), '{"start":{"cmd":"evil"}}'), true);
    const r = await cli(["reseal"], { confirm });
    expect(r.code).toBe(3);
    expect(r.err).toContain("holdback.config.json");
    expect((await readEventsOf()).filter((e) => e.t === "seal")).toHaveLength(sealsBefore);
    // and a spec edited then is recorded as an unverified change, never sealed
    writeFileSync(join(appDir, "holdback.config.json"), "{}");
    const spec = async () => (writeFileSync(join(appDir, "PRD.md"), "# Pantry\n\nWritten while the human decided.\n"), true);
    const s = await cli(["reseal"], { confirm: spec });
    expect(s.code).toBe(3);
    expect((await readEventsOf()).filter((e) => e.t === "seal")).toHaveLength(sealsBefore);
    expect((await readEventsOf()).findLast((e) => e.t === "spec.changed")).toMatchObject({ files: ["PRD.md"], duringAgentTurn: true });
    // the pin reaches core's re-seal: every app-side file as listed
    writeFileSync(join(appDir, "PRD.md"), "# Pantry\n\nSNAP households are eligible.\n");
    const seen: unknown[] = [];
    const reseal = (async (_p: Project, _l: unknown, _g: unknown, o?: { app?: Record<string, string> }) => void seen.push(o?.app)) as never;
    expect((await cli(["reseal", "--yes"], { reseal })).code).toBe(0);
    expect(Object.keys(seen[0] as object).sort()).toEqual(["app:PRD.md", "app:holdback.config.json"]);
  });

  it("refuses when nothing is sealed yet", async () => {
    await fixture({ seal: false });
    const r = await cli(["reseal", "--yes"], { reseal: notCalled("reseal") as never });
    expect(r.code).toBe(1);
    expect(r.err).toContain("Nothing is sealed yet");
  });
});

describe("clean, serve and help", () => {
  it("clean sweeps stale worktrees through core", async () => {
    await fixture();
    let swept: Project | undefined;
    const r = await cli(["clean"], { sweepStaleWorktrees: (async (pr: Project) => void (swept = pr)) as never });
    expect(r.code).toBe(0);
    expect(swept?.appDir).toBe(p.appDir);
  });

  it("clean waits for the check lock: it never removes a worktree a falsify pass or a check is using (M12)", async () => {
    await fixture();
    const lock = await acquireCheckLock(p.home, { waitMs: 0 });
    let swept = 0;
    try {
      const r = await cli(["clean"], { sweepStaleWorktrees: (async () => void swept++) as never, lockWaitMs: 50 });
      expect(r.code).toBe(1);
      expect(r.err).toContain("still running");
      expect(swept).toBe(0);
    } finally {
      await lock!.release();
    }
    expect((await cli(["clean"], { sweepStaleWorktrees: (async () => void swept++) as never })).code).toBe(0);
    expect(swept).toBe(1);
  });

  it("reports a tamper marker in an odd state when a command fails, instead of swallowing it", async () => {
    await fixture();
    mkdirSync(join(p.home, "TAMPERED")); // a directory where the marker file belongs
    const r = await cli(["clean"], {
      sweepStaleWorktrees: (async () => {
        throw new Error("git went away");
      }) as never,
    });
    expect(r.code).toBe(2);
    expect(r.err).toContain("git went away");
    expect(r.err).toContain("tamper marker is a directory");
  });

  it("help warns against deleting mut/ and bisect/ by hand and points to `holdback clean`", async () => {
    const r = await cli(["--help"]);
    expect(r.code).toBe(0);
    expect(r.out).toMatch(/Never delete the mut\/ or bisect\//);
    expect(r.out).toContain("`holdback clean`");
    expect(r.out).toMatch(/3 `run` finished but the gate is not fully green/);
    for (const c of ["init", "spec", "run", "drift", "watch", "status", "owed", "reseal", "clean"]) expect(r.out).toContain(c);
  });

  it("serve starts the core server on 4317 by default, prints the URL and token, and closes on Ctrl-C", async () => {
    await fixture();
    const calls: { port: number; staticDir?: string }[] = [];
    let closed = 0;
    const serve = (async (_p: Project, o: { port: number; staticDir?: string }) => {
      calls.push(o);
      return { host: "127.0.0.1", port: o.port, token: "tok123", human: {}, close: async () => void closed++ };
    }) as never;
    const ctl = new AbortController();
    const signals = () => ({ signal: ctl.signal, dispose() {} });
    const run = cli(["serve", "--static", "dash"], { serve }, { signals });
    await new Promise((r) => setTimeout(r, 50));
    ctl.abort();
    const r = await run;
    expect(r.code).toBe(0);
    expect(calls).toEqual([{ port: 4317, staticDir: join(appDir, "dash") }]);
    expect(r.out).toContain("http://127.0.0.1:4317/");
    expect(r.out).toContain("tok123");
    expect(closed).toBe(1);
  });

  it("serve without --static serves the built dashboard, and says so when there is none", async () => {
    await fixture();
    const ctl = new AbortController();
    ctl.abort();
    const calls: { port: number; staticDir?: string }[] = [];
    const serve = (async (_p: Project, o: { port: number; staticDir?: string }) => (calls.push(o), { host: "127.0.0.1", port: o.port, token: "tok", human: {}, close: async () => {} })) as never;
    const signals = () => ({ signal: ctl.signal, dispose() {} });
    const built = join(root, "dashboard-dist");
    const withBuild = await cli(["serve"], { serve, dashboardDir: () => built }, { signals });
    expect(withBuild.code).toBe(0);
    expect(calls).toEqual([{ port: 4317, staticDir: built }]);
    expect(withBuild.out).toContain("http://127.0.0.1:4317/#token=tok");
    const none = await cli(["serve"], { serve, dashboardDir: () => undefined }, { signals });
    expect(none.code).toBe(0);
    expect(calls[1]).toEqual({ port: 4317, staticDir: undefined });
    expect(none.out).toContain("API only: no dashboard build found");
    expect(none.out).not.toContain("#token=");
  });

  it("serve takes --port, rejects a bad one, and refuses inside Claude Code", async () => {
    await fixture();
    const ctl = new AbortController();
    ctl.abort();
    const ports: number[] = [];
    const serve = (async (_p: Project, o: { port: number }) => (ports.push(o.port), { host: "127.0.0.1", port: o.port, token: "t", human: {}, close: async () => {} })) as never;
    const signals = () => ({ signal: ctl.signal, dispose() {} });
    expect((await cli(["serve", "--port", "5000"], { serve }, { signals })).code).toBe(0);
    expect(ports).toEqual([5000]);
    const bad = await cli(["serve", "--port", "nope"], { serve }, { signals });
    expect(bad.code).toBe(1);
    expect(bad.err).toContain("--port");
    const agent = await cli(["serve"], { serve, env: { CLAUDECODE: "1" } }, { signals });
    expect(agent.code).toBe(1);
    expect(ports).toEqual([5000]);
  });
});

describe("exit codes", () => {
  it("keeps 2 for tampers only", () => {
    expect(EXIT).toEqual({ ok: 0, error: 1, tamper: 2, unfinished: 3, aborted: 130 });
  });
});

describe("reseal's pin (n-1)", () => {
  it("pins every spec file the listing did not show as changed at the manifest's hash, so an edit after the snapshot is caught", async () => {
    const { pinForReseal } = await import("../src/reseal.js");
    const manifest = { "app:holdback.config.json": "c0", "app:PRD.md": "old", "app:rules.md": "r0" };
    const onDisk = { "app:holdback.config.json": "c1", "app:PRD.md": "new", "app:rules.md": "r1" };
    const pin = pinForReseal(onDisk, manifest, ["app:PRD.md", "app:rules.md"], ["app:rules.md"]);
    // the config as read after the listing; the unchanged spec as the seal holds it; the already changed one as read
    expect(pin).toEqual({ "app:holdback.config.json": "c1", "app:PRD.md": "old", "app:rules.md": "r1" });
    expect(pinForReseal({ "app:PRD.md": "x" }, {}, ["app:PRD.md"], [])).toEqual({ "app:PRD.md": "absent" });
  });
});
