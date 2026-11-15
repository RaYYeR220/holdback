import { execFileSync } from "node:child_process";
import { appendFileSync, chmodSync, copyFileSync, existsSync, mkdirSync, mkdtempSync, readdirSync, readFileSync, rmSync, symlinkSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import type { ClaudeTurnOptions, ClaudeTurnResult } from "../src/agent/claude.js";
import { posixAbs } from "../src/agent/guard.js";
import { AppStartError, PortInUse } from "../src/app.js";
import type { AcNode, TestNode } from "../src/kane/assurance.js";
import type { TestRunResult } from "../src/kane/testmd.js";
import { gate } from "../src/ledger/gate.js";
import { reduce } from "../src/ledger/reduce.js";
import { appendEvent, readEvents } from "../src/ledger/store.js";
import type { LedgerEvent } from "../src/ledger/types.js";
import { changedFiles, checkout, commitAll, ensureHead, git as runGit, headSha, isRepoRoot, worktreeAdd, worktreeRemove } from "../src/git.js";
import { runBuildLoop, type BuildDeps } from "../src/loop/build.js";
import { appSealFiles, reseal } from "../src/loop/spec.js";
import { loadProject, type Project } from "../src/project.js";
import { seal, sealRecordings } from "../src/seal.js";
import { clearTamper, manifestDigest, markTampered, tamperMarker } from "../src/tamper.js";
import { logSpecAttempt } from "../src/agent/attempts.js";
import { createHash } from "node:crypto";

const here = dirname(fileURLToPath(import.meta.url));
const fxTests = join(here, "fixtures", "kane", "tests");
const at = "2026-11-15T00:00:00.000Z";
const PRD = "# Food pantry\n\nA household is eligible when its monthly income is at or below the monthly limit for its size.\n";

const git = (cwd: string, ...args: string[]) => execFileSync("git", args, { cwd, encoding: "utf8" }).trim();
/** POSIX root ignores a 0o444 mode: the read-only ledger tests cannot fail an append there. */
const asRoot = process.getuid?.() === 0;

const AC1: AcNode = {
  id: "ac-1",
  text: "When someone in the household receives SNAP, the household's eligibility result is “Eligible.” regardless of monthly income.",
  useCase: "uc-1",
  cites: [{ source: "prd", anchor: "L12-L12", quote: "A household where someone receives SNAP is eligible regardless of income." }],
  trust: "derived",
};
const AC3: AcNode = {
  id: "ac-3",
  text: "For a household without SNAP, monthly income above the applicable limit produces “Not eligible.”",
  useCase: "uc-1",
  cites: [{ source: "prd", anchor: "L10-L10", quote: "A household is eligible when its monthly income is at or below the monthly limit for its size." }],
  trust: "derived",
};

const saved = { ...process.env };
let root: string;
let appDir: string;
let p: Project;
let T1: string;
let T3: string;
let VARS: string;
const log = (e: LedgerEvent) => appendEvent(p.ledgerFile, e);

beforeEach(() => {
  root = mkdtempSync(join(tmpdir(), "hb-build-"));
  process.env.HOLDBACK_HOME = join(root, "home");
});
afterEach(() => {
  if (saved.HOLDBACK_HOME === undefined) delete process.env.HOLDBACK_HOME;
  else process.env.HOLDBACK_HOME = saved.HOLDBACK_HOME;
  rmSync(root, { recursive: true, force: true });
});

/** App repo (unborn HEAD) + verifier with t-1/t-3 + ledger with a design and a seal. */
async function setup(opts: { config?: Record<string, unknown>; gitInit?: boolean } = {}) {
  appDir = join(root, "app");
  mkdirSync(appDir);
  writeFileSync(join(appDir, "PRD.md"), PRD);
  writeFileSync(join(appDir, "holdback.config.json"), JSON.stringify(opts.config ?? {}));
  if (opts.gitInit !== false) {
    git(appDir, "init", "-q");
    git(appDir, "config", "user.name", "Test");
    git(appDir, "config", "user.email", "test@example.com");
    git(appDir, "config", "commit.gpgsign", "false");
  }
  p = await loadProject(appDir);
  const testsDir = join(p.verifierDir, ".testmuai", "tests");
  mkdirSync(testsDir, { recursive: true });
  T1 = join(testsDir, "t1_test.md");
  T3 = join(testsDir, "t3_test.md");
  copyFileSync(join(fxTests, "snap-household-qualifies-despite-above-limit-income_test.md"), T1);
  copyFileSync(join(fxTests, "non-snap-household-above-2-461-is-not-eligible_test.md"), T3);
  VARS = join(p.verifierDir, ".testmuai", "variables", "assurance.json");
  mkdirSync(dirname(VARS), { recursive: true });
  writeFileSync(VARS, JSON.stringify({ start_url: { value: "http://127.0.0.1:3100/" } }));
  const tests: TestNode[] = [
    // Kane's graph gives absolute paths; a relative one must resolve against the verifier dir.
    { id: "t-1", title: "SNAP household qualifies despite above-limit income", file: ".testmuai/tests/t1_test.md", verifies: ["ac-1"] },
    { id: "t-3", title: "Non-SNAP household above $2,461 is not eligible", file: T3, verifies: ["ac-3"] },
  ];
  await log({ at, t: "design", useCase: "uc-1", acs: [AC1, AC3], tests, gaps: [], credits: 12 });
  await log({ at, t: "seal", manifest: await seal(p.verifierDir, { appDir, files: appSealFiles(p) }) });
}

const idOf = (file: string) => (file.endsWith("t1_test.md") ? "t-1" : "t-3");
const pass = (file: string): TestRunResult => ({
  testFile: file,
  testId: idOf(file),
  status: "passed",
  steps: [],
  criteriaPassed: [],
  criteriaFailed: [],
  credits: 0,
  replayDecisions: 2,
  authorDecisions: 0,
  healTriggered: false,
  durationS: 12,
});
// The real failing replay of t-3 (fixtures/kane/06-mutant-t3.ndjson).
const fail = (file: string): TestRunResult => ({
  ...pass(file),
  status: "failed",
  failedStep: 2,
  failedStepText: "On the “Food pantry eligibility check” page, set Household size to 1 and Monthly household income ($) to 2462.",
  verdict: {
    bugTitle: "Eligibility check approves income above displayed limit",
    rootCause: "The eligibility decision is using the wrong boundary for income at the stated monthly limit.",
    suggestion: "Correct the income comparison so an income of $2,462 is not eligible when the displayed limit is $2,461.",
    observed: "Eligible. Monthly limit for a household of 1 is $2461.",
  },
  screenshot: "step_008.png",
  credits: 2.63,
});

type Plan = {
  /** Agent side effect per turn. Default: writes app.js. */
  edit?: (turn: number) => void;
  /** Default: the app starts every turn. */
  appUp?: (turn: number) => boolean;
  /** Kane results for one runTests call. */
  kane: (turn: number, files: string[]) => TestRunResult[];
  claude?: (turn: number, o: ClaudeTurnOptions) => Promise<ClaudeTurnResult> | undefined;
};

function fakes(plan: Plan) {
  const calls = {
    claude: [] as ClaudeTurnOptions[],
    tests: [] as { turn: number; cwd: string; files: string[]; opts: unknown }[],
    starts: 0,
    stops: 0,
    appEnv: [] as (Record<string, string> | undefined)[],
  };
  let turn = 0;
  const deps: BuildDeps = {
    guardCommand: "node guard.js --home h --verifier v",
    claude: async (o) => {
      turn++;
      calls.claude.push(o);
      const custom = plan.claude?.(turn, o);
      if (custom) return custom;
      if (plan.edit) plan.edit(turn);
      else writeFileSync(join(appDir, "app.js"), `// turn ${turn}\n`);
      return { exitCode: 0, resultText: "done", subtype: "success", isError: false, durationMs: 1234, timedOut: false, stderrTail: "" };
    },
    app: async (o) => {
      calls.starts++;
      calls.appEnv.push(o.env);
      if (plan.appUp && !plan.appUp(turn)) throw new AppStartError("app exited before becoming ready", "> node app.js\nError: Cannot find module 'express'");
      return { url: `http://127.0.0.1:${o.port}`, logs: () => "", stop: async () => void calls.stops++ };
    },
    tests: async (cwd, files, opts) => {
      calls.tests.push({ turn, cwd, files: [...files], opts });
      return plan.kane(turn, files);
    },
  };
  return { deps, calls };
}

const loopEvents = async () =>
  (await readEvents(p.ledgerFile)).filter((e) => ["turn.start", "turn.end", "run", "regression", "tamper"].includes(e.t));

// every test spawns git a dozen times; Windows process spawns are slow under a parallel suite
describe("runBuildLoop", { timeout: 60_000 }, () => {
  it("fails ac-3 on turn 1, briefs it with Kane's verdict on turn 2, then opens the gate", async () => {
    await setup();
    const { deps, calls } = fakes({
      kane: (turn, files) => files.map((f) => (turn === 1 && idOf(f) === "t-3" ? fail(f) : pass(f))),
    });
    const r = await runBuildLoop(p, deps, log);
    expect(r).toEqual({ allowStop: true, turns: 2, reason: "gate-open" });

    // briefs
    expect(calls.claude).toHaveLength(2);
    expect(calls.claude[0]!.prompt.startsWith("# Holdback — 2 criteria still owed\n")).toBe(true);
    expect(calls.claude[0]!.prompt).not.toContain("Kane saw:");
    const second = calls.claude[1]!.prompt;
    expect(second.startsWith("# Holdback — 1 criterion still owed\n")).toBe(true);
    expect(second).toContain("## ac-3 — ");
    expect(second).toContain("Kane saw: Eligible. Monthly limit for a household of 1 is $2461.");
    expect(second).toContain("Kane's diagnosis: Eligibility check approves income above displayed limit — The eligibility decision");
    expect(second).not.toContain("## ac-1");

    // agent invocation
    const c = calls.claude[0]!;
    expect(c.cwd).toBe(appDir);
    expect(c.settingsFile).toBe(join(p.home, "agent-settings.json"));
    expect(c.contractFile.endsWith("contract.md")).toBe(true);
    expect(c.maxTurns).toBe(60);
    expect(c.timeoutMs).toBe(30 * 60_000);
    const settings = JSON.parse(readFileSync(c.settingsFile, "utf8"));
    expect(settings.hooks.PreToolUse[0].hooks[0].command).toBe("node guard.js --home h --verifier v");
    expect(settings.permissions.deny).toEqual(
      expect.arrayContaining([
        "Edit(./holdback.config.json)",
        "Edit(./PRD.md)",
        `Edit(${posixAbs(appDir)}/holdback.config.json)`,
        `Edit(${posixAbs(appDir)}/PRD.md)`,
        "Edit(./.git/**)",
        `Edit(${posixAbs(appDir)}/.git/**)`,
      ]),
    );
    expect(settings.permissions.deny).not.toContain("WebFetch");

    // Kane runs: owed tests each turn; on the turn that empties the owed list, a replay of the passing ACs' tests
    expect(calls.tests.map((t) => [t.turn, t.files])).toEqual([
      [1, [T1, T3]],
      [2, [T3]],
      [2, [T1]],
    ]);
    expect(calls.tests[0]!.cwd).toBe(p.verifierDir);
    expect(calls.tests[0]!.opts).toEqual({ startUrl: "http://127.0.0.1:3100/", timeoutS: 420, parallel: 3 });
    expect(calls.starts).toBe(2);
    expect(calls.stops).toBe(2);
    // the breaker's key never reaches the app; every start gets its own data dir
    expect(calls.appEnv).toEqual([
      { DATA_DIR: expect.any(String), VENICE_API_KEY: "" },
      { DATA_DIR: expect.any(String), VENICE_API_KEY: "" },
    ]);

    // ledger
    const ev = await loopEvents();
    expect(ev.map((e) => (e.t === "run" ? `run:${e.kind}:${e.turn}:${e.result.testId}:${e.result.status}` : `${e.t}`))).toEqual([
      "turn.start",
      "turn.end",
      "run:build:1:t-1:passed",
      "run:build:1:t-3:failed",
      "turn.start",
      "turn.end",
      "run:build:2:t-3:passed",
      "run:build:2:t-1:passed",
    ]);
    expect(ev[0]).toMatchObject({ t: "turn.start", n: 1, owed: ["ac-1", "ac-3"] });
    expect(ev[4]).toMatchObject({ t: "turn.start", n: 2, owed: ["ac-3"] });
    const subjects = git(appDir, "log", "--format=%s").split("\n");
    expect(subjects).toEqual(["holdback turn 2: 1 owed", "holdback turn 1: 2 owed", "holdback: initial commit"]);
    expect(git(appDir, "log", "--format=%B")).not.toMatch(/co-authored|generated with/i);
    expect(git(appDir, "show", "--name-only", "--format=", "HEAD~2").split("\n").sort()).toEqual(["PRD.md", "holdback.config.json"]);
    expect(ev[1]).toEqual({
      at: expect.any(String),
      t: "turn.end",
      n: 1,
      commit: git(appDir, "rev-parse", "--short", "HEAD~1"),
      filesChanged: ["app.js"],
      durationMs: 1234,
      appUp: true,
      agentExit: 0,
    });
    const state = reduce(await readEvents(p.ledgerFile));
    expect(state.turn).toBe(2);
    expect(Object.values(state.acs).map((a) => a.status)).toEqual(["passing", "passing"]);
  });

  it("starts the app on a new, empty DATA_DIR under the home every time: rows a Kane run wrote never reach the next batch", async () => {
    // a stateful app: start.env's own DATA_DIR (inside the agent's repo) loses to Holdback's
    await setup({ config: { start: { env: { DATA_DIR: "./data", HOLDBACK_TODAY: "2026-11-19" } } } });
    const dirs: { dir: string; emptyAtStart: boolean }[] = [];
    const { deps, calls } = fakes({ kane: (turn, files) => files.map((f) => (turn === 1 && idOf(f) === "t-3" ? fail(f) : pass(f))) });
    const app = deps.app;
    deps.app = async (o) => {
      const dir = o.env!.DATA_DIR!;
      dirs.push({ dir, emptyAtStart: existsSync(dir) && readdirSync(dir).length === 0 });
      writeFileSync(join(dir, "pantry.db"), "a booking"); // what a Kane run leaves behind
      return app(o);
    };
    const r = await runBuildLoop(p, deps, log);
    expect(r.reason).toBe("gate-open");
    expect(dirs).toHaveLength(2);
    expect(new Set(dirs.map((d) => d.dir)).size).toBe(2);
    for (const d of dirs) {
      expect(d.emptyAtStart).toBe(true);
      expect(d.dir.startsWith(join(p.home, "data"))).toBe(true);
    }
    expect(calls.appEnv.every((e) => e?.HOLDBACK_TODAY === "2026-11-19" && e?.VENICE_API_KEY === "")).toBe(true);
    expect(existsSync(join(appDir, "data"))).toBe(false);
  });

  it("a re-run whose app does not come back leaves the test inconclusive and runs nothing more against the dead app", async () => {
    await setup({ config: { loop: { maxTurns: 3 } } });
    const envFail = (file: string): TestRunResult => ({ ...fail(file), verdict: { bugTitle: "Browser target closed", family: "environment_issue" } });
    const { deps, calls } = fakes({ kane: (turn, files) => files.map((f) => (idOf(f) === "t-3" ? (turn === 3 ? envFail(f) : fail(f)) : pass(f))) });
    const app = deps.app;
    deps.app = async (o) => {
      if (calls.starts === 3) throw new AppStartError("app exited before becoming ready", "EADDRINUSE"); // the 4th start: the re-run's
      return app(o);
    };
    const r = await runBuildLoop(p, deps, log);
    expect(r.reason).toBe("max-turns");
    // turn 3 (a replay turn): the owed t-3 proved nothing, the app did not come back, so no replay batch ran
    expect(calls.tests.map((t) => [t.turn, t.files])).toEqual([
      [1, [T1, T3]],
      [2, [T3]],
      [3, [T3]],
    ]);
    const t3 = (await loopEvents()).findLast((e) => e.t === "run" && e.turn === 3);
    expect(t3).toMatchObject({ result: { inconclusive: expect.stringContaining("the app did not start again") } });
  });

  it("re-runs a test Kane blames on its own browser once, never briefs the agent with it, and leaves its criterion owed (R34)", async () => {
    await setup();
    // the live t-3: Kane's browser closed mid-authoring (environment_issue), twice in turn 1
    const envFail = (file: string): TestRunResult => ({
      ...fail(file),
      criteriaFailed: ["ac-3"],
      verdict: { bugTitle: "Browser target closed before screenshot capture", family: "environment_issue", observed: "nothing to see" },
      reason: "Screenshot failed: TargetClosedError",
      credits: 9.6,
    });
    const { deps, calls } = fakes({ kane: (turn, files) => files.map((f) => (turn === 1 && idOf(f) === "t-3" ? envFail(f) : pass(f))) });
    const r = await runBuildLoop(p, deps, log);
    expect(r).toEqual({ allowStop: true, turns: 2, reason: "gate-open" });
    expect(calls.tests.map((t) => [t.turn, t.files])).toEqual([
      [1, [T1, T3]],
      [1, [T3]], // the same test once more, against the app started again on an empty data dir
      [2, [T3]],
      [2, [T1]],
    ]);
    expect(calls.starts).toBe(3);
    expect(calls.stops).toBe(3);
    expect(new Set(calls.appEnv.map((e) => e?.DATA_DIR)).size).toBe(3);

    // turn 2's brief: ac-3 still owed, nothing of Kane's own failure
    const second = calls.claude[1]!.prompt;
    expect(second.startsWith("# Holdback — 1 criterion still owed\n")).toBe(true);
    expect(second).toContain("## ac-3 — ");
    for (const s of ["Browser target", "Kane saw", "Kane reported", "Kane's diagnosis", "Screenshot", "TargetClosedError"]) expect(second).not.toContain(s);
    expect(existsSync(join(appDir, "kane-evidence", "turn-1"))).toBe(false);

    const ev = await loopEvents();
    const t3 = ev.find((e) => e.t === "run" && e.turn === 1 && e.result.testId === "t-3");
    expect(t3).toMatchObject({ result: { inconclusive: "environment_issue: Browser target closed before screenshot capture", retried: expect.any(String), credits: 19.2 } });
    const mid = reduce((await readEvents(p.ledgerFile)).filter((e) => !(e.t === "run" && e.turn === 2)));
    expect(mid.acs["ac-3"]!.status).toBe("owed");
    expect(mid.inconclusive).toEqual([{ test: "t-3", turn: 1, reason: "environment_issue: Browser target closed before screenshot capture" }]);
    expect(reduce(await readEvents(p.ledgerFile)).inconclusive).toEqual([]);
  });

  it("stops with reason inconclusive, without another re-check, once a turn's own replay re-ran the test that proved nothing (R34)", async () => {
    await setup();
    const timeout = (file: string): TestRunResult => ({ ...pass(file), status: "error", reason: "timeout" });
    const { deps, calls } = fakes({
      kane: (turn, files) =>
        files.map((f) => {
          if (turn === 1) return idOf(f) === "t-3" ? fail(f) : pass(f);
          // turn 2: ac-3 fixed, then t-1's replay (and its re-run) time out
          return turn === 2 && idOf(f) === "t-1" ? timeout(f) : pass(f);
        }),
    });
    const r = await runBuildLoop(p, deps, log);
    expect(r).toEqual({ allowStop: false, turns: 2, reason: "inconclusive", inconclusive: [{ test: "t-1", turn: 2, reason: "timeout" }] });
    expect(calls.claude).toHaveLength(2); // nothing for the agent to fix: no third turn
    // two runs of the stuck test, not four: the replay already re-ran it, so no separate re-check
    expect(calls.tests.map((t) => [t.turn, t.files])).toEqual([
      [1, [T1, T3]],
      [2, [T3]],
      [2, [T1]],
      [2, [T1]],
    ]);
    expect(calls.starts).toBe(3); // the re-run meets the app started again on a fresh data dir
    expect(reduce(await readEvents(p.ledgerFile)).acs["ac-1"]!.status).toBe("passing");
  });

  it("re-runs a stuck test against the newest code before stopping inconclusive, after a turn that fixed the owed work", async () => {
    await setup();
    // ac-1 passed at turn 1; t-1 then proved nothing at turn 2; ac-3 is still owed
    await log({ at, t: "turn.start", n: 1, owed: ["ac-1", "ac-3"] });
    await log({ at, t: "run", kind: "build", turn: 1, result: pass(T1) });
    await log({ at, t: "turn.start", n: 2, owed: ["ac-3"] });
    await log({ at, t: "run", kind: "build", turn: 2, result: { ...pass(T1), status: "error", reason: "timeout", inconclusive: "timeout" } });
    const timeout = (file: string): TestRunResult => ({ ...pass(file), status: "error", reason: "timeout" });
    // t-1 never finishes; ac-3 fails in the run's first agent turn (ledger turn 3, a replay turn) and passes in the next
    const { deps, calls } = fakes({ kane: (turn, files) => files.map((f) => (idOf(f) === "t-1" ? timeout(f) : turn === 1 ? fail(f) : pass(f))) });
    const r = await runBuildLoop(p, deps, log);
    expect(r).toEqual({ allowStop: false, turns: 2, reason: "inconclusive", inconclusive: [{ test: "t-1", turn: 4, reason: "timeout" }] });
    expect(calls.tests.map((t) => [t.turn, t.files])).toEqual([
      [1, [T3]],
      [1, [T1]], // turn 3's replay re-ran t-1 while ac-3 was still owed
      [1, [T1]],
      [2, [T3]], // turn 4 fixed ac-3...
      [2, [T1]], // ...and t-1 ran again against that code before the run stopped
      [2, [T1]],
    ]);
  });

  it("bisects a regression the re-check finds, the same way as one a turn finds", async () => {
    await setup();
    // ac-1 green at turn 1; by turn 3 its replay timed out twice (inconclusive), nothing else owed
    await log({ at, t: "turn.start", n: 1, owed: ["ac-1", "ac-3"] });
    await log({ at, t: "run", kind: "build", turn: 1, result: pass(T1) });
    await log({ at, t: "run", kind: "build", turn: 1, result: pass(T3) });
    await log({ at, t: "turn.start", n: 2, owed: [] });
    await log({ at, t: "turn.start", n: 3, owed: [] });
    await log({ at, t: "run", kind: "build", turn: 3, result: { ...pass(T1), status: "error", reason: "timeout", inconclusive: "timeout" } });
    let t1Runs = 0;
    const { deps, calls } = fakes({ kane: (_t, files) => files.map((f) => (idOf(f) === "t-1" && t1Runs++ === 0 ? fail(f) : pass(f))) });
    const blamed: unknown[][] = [];
    deps.bisect = async (_p, ac, good, bad) => {
      blamed.push([ac, good, bad]);
      return null;
    };
    const r = await runBuildLoop(p, deps, log);
    // the re-check found a real failure: regressed and bisected, then briefed and fixed in the next agent turn
    // (ledger turn 4, this run's first and only one)
    expect(blamed).toEqual([["ac-1", 1, 3]]);
    expect(r).toEqual({ allowStop: true, turns: 1, reason: "gate-open" });
    const regressions = (await loopEvents()).filter((e) => e.t === "regression");
    expect(regressions).toMatchObject([
      { ac: "ac-1", turn: 3 },
      { ac: "ac-1", turn: 3, detail: "bisect inconclusive: no turn could be blamed" },
    ]);
    expect(calls.claude[0]!.prompt).toContain("## ac-1 — ");
  });

  it("replays a vacuous criterion's inconclusive test with the green ones, so a conclusive run can reopen the gate", async () => {
    await setup();
    // ac-1 passed, a planted bug survived it (vacuous), then its test timed out twice; ac-3 is owed
    await log({ at, t: "turn.start", n: 1, owed: ["ac-1", "ac-3"] });
    await log({ at, t: "run", kind: "build", turn: 1, result: pass(T1) });
    await log({ at, t: "mutant", id: "m-ac-1-1", ac: "ac-1", patch: "p", model: "m", usd: 0, verdict: "survived" });
    await log({ at, t: "run", kind: "build", turn: 1, result: { ...pass(T1), status: "error", reason: "timeout", inconclusive: "timeout" } });
    expect(gate(reduce(await readEvents(p.ledgerFile)))).toMatchObject({ owed: [{ id: "ac-3" }], inconclusive: [{ test: "t-1" }] });
    const { deps, calls } = fakes({ kane: (_t, files) => files.map(pass) });
    const r = await runBuildLoop(p, deps, log);
    expect(r).toEqual({ allowStop: true, turns: 1, reason: "gate-open" });
    // nothing owed after ac-3: the replay takes t-1 too, though its criterion is vacuous, not green
    expect(calls.tests.map((t) => [t.turn, t.files])).toEqual([
      [1, [T3]], // the fake counts agent calls: ledger turn 2 is the agent's first here
      [1, [T1]],
    ]);
    expect(calls.starts).toBe(1); // in the turn's own replay, not a separate re-check
    expect((await loopEvents()).filter((e) => e.t === "run" && e.turn === 2).map((e) => e.t === "run" && e.result.testId)).toEqual(["t-3", "t-1"]);
    const state = reduce(await readEvents(p.ledgerFile));
    expect(state.acs["ac-1"]!.status).toBe("vacuous");
    expect(state.inconclusive).toEqual([]);
  });

  it("re-checks only the inconclusive tests, with no agent turn, when nothing else keeps the gate shut", async () => {
    await setup();
    await log({ at, t: "turn.start", n: 1, owed: ["ac-1", "ac-3"] });
    await log({ at, t: "run", kind: "build", turn: 1, result: pass(T1) });
    await log({ at, t: "run", kind: "build", turn: 1, result: pass(T3) });
    await log({ at, t: "run", kind: "build", turn: 1, result: { ...pass(T3), status: "error", reason: "timeout", inconclusive: "timeout" } });
    const { deps, calls } = fakes({ kane: (_t, files) => files.map(pass) });
    const r = await runBuildLoop(p, deps, log);
    expect(r).toEqual({ allowStop: true, turns: 0, reason: "gate-open" });
    expect(calls.claude).toHaveLength(0);
    expect(calls.tests.map((t) => t.files)).toEqual([[T3]]);
    const ev = await loopEvents();
    expect(ev.filter((e) => e.t === "turn.start")).toHaveLength(1); // no new turn: the run is under turn 1
    expect(ev.at(-1)).toMatchObject({ t: "run", kind: "build", turn: 1, result: { testId: "t-3", status: "passed" } });
  });

  it("stops with reason inconclusive, naming the tests, when the re-check proves nothing again: never an agent turn, never max-turns", async () => {
    await setup({ config: { loop: { maxTurns: 1 } } });
    await log({ at, t: "turn.start", n: 1, owed: ["ac-1", "ac-3"] });
    await log({ at, t: "run", kind: "build", turn: 1, result: pass(T1) });
    await log({ at, t: "run", kind: "build", turn: 1, result: pass(T3) });
    const env = (file: string): TestRunResult => ({ ...fail(file), verdict: { bugTitle: "Browser target closed", family: "environment_issue" } });
    await log({ at, t: "run", kind: "build", turn: 1, result: { ...env(T3), inconclusive: "environment_issue: Browser target closed" } });
    const { deps, calls } = fakes({ kane: (_t, files) => files.map(env) });
    const r = await runBuildLoop(p, deps, log);
    expect(r).toEqual({
      allowStop: false,
      turns: 0,
      reason: "inconclusive",
      inconclusive: [{ test: "t-3", turn: 1, reason: "environment_issue: Browser target closed" }],
    });
    expect(calls.claude).toHaveLength(0);
    expect(calls.tests.map((t) => t.files)).toEqual([[T3], [T3]]); // one re-check (re-run once inside it), then stop
  });

  it("logs Kane's balance drop around each batch, and a batch whose balance cannot be read with its per-run sum (R34)", async () => {
    await setup();
    let bal = 1000;
    let reads = 0;
    const { deps } = fakes({ kane: (turn, files) => files.map((f) => ({ ...(turn === 1 && idOf(f) === "t-3" ? fail(f) : pass(f)), credits: 4 })) });
    const tests = deps.tests;
    deps.tests = async (...a) => {
      bal -= 5 * a[1].length; // Kane bills more than it reports per run
      return tests(...a);
    };
    deps.balance = async () => {
      reads++;
      if (reads === 1) throw new Error("balance: could not read credits (exit 1): offline");
      return bal;
    };
    const r = await runBuildLoop(p, deps, log);
    expect(r).toMatchObject({ allowStop: true, reason: "gate-open" });
    const credits = (await readEvents(p.ledgerFile)).filter((e) => e.t === "credits");
    expect(credits).toEqual([
      { at: expect.any(String), t: "credits", source: "build", delta: null, perRunSum: 8, error: "balance: could not read credits (exit 1): offline" },
      { at: expect.any(String), t: "credits", source: "build", delta: 5, perRunSum: 4 },
      { at: expect.any(String), t: "credits", source: "build", delta: 5, perRunSum: 4 },
    ]);
    const state = reduce(await readEvents(p.ledgerFile));
    expect(state.credits).toBe(12 + 16); // the design's 12 and four runs
    expect(state.kaneCredits).toBe(12 + 8 + 5 + 5);
    expect(state.kaneUnmeasured).toBe(1);
  });

  it("runs no Kane test on a turn where the app does not start, and briefs the start failure next", async () => {
    await setup();
    const { deps, calls } = fakes({ appUp: (turn) => turn !== 1, kane: (_turn, files) => files.map(pass) });
    const r = await runBuildLoop(p, deps, log);
    expect(r).toEqual({ allowStop: true, turns: 2, reason: "gate-open" });
    expect(calls.tests.map((t) => t.turn)).toEqual([2]);
    const ev = await loopEvents();
    expect(ev[1]).toMatchObject({ t: "turn.end", n: 1, appUp: false });
    expect(ev.filter((e) => e.t === "run" && e.turn === 1)).toHaveLength(0);
    const brief = calls.claude[1]!.prompt;
    expect(brief.startsWith("# Holdback — The app does not start\n")).toBe(true);
    expect(brief).toContain("Error: Cannot find module 'express'\napp exited before becoming ready\n");
    expect(brief).not.toContain("## ac-");
  });

  it("stops with an error naming the port when another program holds it, instead of briefing the agent", async () => {
    await setup();
    const { deps, calls } = fakes({ kane: (_turn, files) => files.map(pass) });
    deps.app = async (o) => {
      throw new PortInUse(o.port);
    };
    const r = await runBuildLoop(p, deps, log);
    expect(r).toMatchObject({ allowStop: false, turns: 1, reason: "error" });
    expect(r.error).toContain("port 3100 is already in use");
    expect(calls.claude).toHaveLength(1);
    expect(calls.tests).toHaveLength(0);
  });

  it("stops with tamper when the agent's turn changed a sealed test file, before Kane runs", async () => {
    await setup();
    const { deps, calls } = fakes({ edit: () => appendFileSync(T3, "\nAlso accept anything.\n"), kane: (_t, files) => files.map(pass) });
    const r = await runBuildLoop(p, deps, log);
    expect(r).toMatchObject({ allowStop: false, turns: 1, reason: "tamper" });
    expect(calls.tests).toHaveLength(0);
    expect(calls.stops).toBe(calls.starts);
    const tamper = (await loopEvents()).find((e) => e.t === "tamper");
    expect(tamper).toMatchObject({ t: "tamper" });
    expect(tamper && tamper.t === "tamper" && tamper.detail).toContain(".testmuai/tests/t3_test.md");
  });

  it("stops with tamper before the agent runs when a sealed test changed between runs", async () => {
    await setup();
    writeFileSync(T1, "---\nassurance:\n  id: t-1\n---\n# weakened\n");
    const { deps, calls } = fakes({ kane: (_t, files) => files.map(pass) });
    const r = await runBuildLoop(p, deps, log);
    expect(r).toMatchObject({ allowStop: false, turns: 0, reason: "tamper" });
    expect(calls.claude).toHaveLength(0);
  });

  it("stops with tamper when the agent edits the app-side holdback.config.json", async () => {
    await setup();
    const edit = () => writeFileSync(join(appDir, "holdback.config.json"), JSON.stringify({ start: { cmd: "node fake.js" } }));
    const { deps, calls } = fakes({ edit, kane: (_t, files) => files.map(pass) });
    const r = await runBuildLoop(p, deps, log);
    expect(r).toMatchObject({ allowStop: false, turns: 1, reason: "tamper" });
    expect(calls.tests).toHaveLength(0);
    const tamper = (await loopEvents()).find((e) => e.t === "tamper");
    expect(tamper && tamper.t === "tamper" && tamper.detail).toContain("app:holdback.config.json");
  });

  it("a spec edit during the agent's turn is drift: the turn is committed without it, and the run stops before Kane runs", async () => {
    await setup();
    const edit = () => {
      writeFileSync(join(appDir, "app.js"), "// turn 1\n");
      appendFileSync(join(appDir, "PRD.md"), "\nHouseholds of 9 qualify at $9,467.\n");
    };
    const { deps, calls } = fakes({ edit, kane: (_t, files) => files.map(pass) });
    const r = await runBuildLoop(p, deps, log);
    expect(r).toMatchObject({ allowStop: false, turns: 1, reason: "drift" });
    expect(r.error).toContain("holdback drift");
    expect(r.error).toContain("PRD.md");
    expect(calls.tests).toHaveLength(0);
    const ev = await readEvents(p.ledgerFile);
    expect(ev.some((e) => e.t === "tamper")).toBe(false);
    expect(await tamperMarker(p)).toBeNull();
    expect(ev.find((e) => e.t === "turn.end")).toMatchObject({ n: 1, filesChanged: ["app.js"] });
    // the edit stays out of the agent's commit, in the work tree
    expect(git(appDir, "show", "--name-only", "--format=", "HEAD")).toBe("app.js");
    expect(git(appDir, "status", "--porcelain")).toContain("PRD.md");
    // provenance (R37): seen right after the agent ran, so its origin is unverified
    const sealed = ev.find((e) => e.t === "seal");
    const change = ev.find((e) => e.t === "spec.changed");
    expect(change).toMatchObject({
      t: "spec.changed",
      files: ["PRD.md"],
      duringAgentTurn: true,
      before: { "PRD.md": sealed && sealed.t === "seal" ? sealed.manifest["app:PRD.md"] : "?" },
      after: { "PRD.md": createHash("sha256").update(readFileSync(join(appDir, "PRD.md"))).digest("hex") },
    });
    expect(r.specChange).toEqual({ files: ["PRD.md"], duringAgentTurn: true });
  });

  it("a spec change in a turn where the guard logged the agent aiming a write at the spec is a tamper, not drift (R37)", async () => {
    await setup();
    const edit = () => {
      logSpecAttempt(p.home, { tool: "Bash", how: "shell" }); // what the guard writes when it denies `echo … >> PRD.md`
      appendFileSync(join(appDir, "PRD.md"), "\nIncome limits do not apply.\n"); // and a write that got round it
    };
    const { deps, calls } = fakes({ edit, kane: (_t, files) => files.map(pass) });
    const r = await runBuildLoop(p, deps, log);
    expect(r.reason).toBe("tamper");
    expect(calls.tests).toHaveLength(0);
    const tamper = (await loopEvents()).find((e) => e.t === "tamper");
    expect(tamper && tamper.t === "tamper" && tamper.detail).toContain("PRD.md");
    expect(tamper && tamper.t === "tamper" && tamper.detail).toMatch(/tried to write/);
    expect(await tamperMarker(p)).not.toBeNull();
  });

  it("an attempt the guard logged before this turn does not make a later turn's spec change a tamper", async () => {
    await setup();
    logSpecAttempt(p.home, { tool: "Edit", how: "edit" }, new Date(Date.now() - 60_000));
    const edit = () => appendFileSync(join(appDir, "PRD.md"), "\nHouseholds of 9 qualify.\n");
    const { deps } = fakes({ edit, kane: (_t, files) => files.map(pass) });
    expect((await runBuildLoop(p, deps, log)).reason).toBe("drift");
  });

  it("a spec edit made while Kane runs is drift: Kane's results stand, nothing more runs, and nothing is marked tampered", async () => {
    await setup();
    let edited = false;
    const { deps, calls } = fakes({
      kane: (turn, files) => {
        if (turn === 1 && !edited) {
          edited = true; // the human edits the spec while Kane checks turn 1
          appendFileSync(join(appDir, "PRD.md"), "\nHouseholds of 9 qualify at $9,467.\n");
        }
        return files.map(pass);
      },
    });
    const r = await runBuildLoop(p, deps, log);
    expect(r).toMatchObject({ allowStop: false, turns: 1, reason: "drift" });
    expect(calls.tests.map((t) => t.files)).toEqual([[T1, T3]]); // no replay batch after the edit
    const ev = await readEvents(p.ledgerFile);
    expect(ev.some((e) => e.t === "tamper")).toBe(false);
    expect(ev.filter((e) => e.t === "run")).toHaveLength(2);
    expect(reduce(ev).acs["ac-1"]!.status).toBe("passing");
    expect(await tamperMarker(p)).toBeNull();
    // no agent ran while Kane did: logged once, as made outside an agent turn
    expect(ev.filter((e) => e.t === "spec.changed")).toEqual([expect.objectContaining({ files: ["PRD.md"], duringAgentTurn: false })]);
    expect(r.specChange).toEqual({ files: ["PRD.md"], duringAgentTurn: false });
  });

  it("a spec edit between runs stops at the start with drift, before any agent turn", async () => {
    await setup();
    appendFileSync(join(appDir, "PRD.md"), "\nHouseholds of 9 qualify at $9,467.\n");
    const { deps, calls } = fakes({ kane: (_t, files) => files.map(pass) });
    const r = await runBuildLoop(p, deps, log);
    expect(r).toMatchObject({ allowStop: false, turns: 0, reason: "drift" });
    expect(calls.claude).toHaveLength(0);
    expect((await readEvents(p.ledgerFile)).some((e) => e.t === "tamper")).toBe(false);
  });

  it("a spec edit next to any other sealed change is still a tamper, naming both", async () => {
    await setup();
    const edit = () => {
      appendFileSync(join(appDir, "PRD.md"), "\nIncome limits do not apply.\n");
      writeFileSync(T1, "---\nassurance:\n  id: t-1\n---\n# weakened\n");
    };
    const { deps } = fakes({ edit, kane: (_t, files) => files.map(pass) });
    const r = await runBuildLoop(p, deps, log);
    expect(r.reason).toBe("tamper");
    const tamper = (await loopEvents()).find((e) => e.t === "tamper");
    expect(tamper && tamper.t === "tamper" && tamper.detail).toContain("app:PRD.md");
    expect(tamper && tamper.t === "tamper" && tamper.detail).toContain("t1_test.md");
  });

  it("fails closed with reason error when the ledger cannot be read", async () => {
    await setup();
    rmSync(p.ledgerFile);
    mkdirSync(p.ledgerFile); // reading a directory throws EISDIR, not ENOENT
    const { deps, calls } = fakes({ kane: (_t, files) => files.map(pass) });
    const r = await runBuildLoop(p, deps, log);
    expect(r).toMatchObject({ allowStop: false, turns: 0, reason: "error" });
    expect(r.error).toMatch(/EISDIR|directory/i);
    expect(calls.claude).toHaveLength(0);
  });

  it("stops at loop.maxTurns, keeps HEAD as the turn commit when nothing changed, and attributes id-less results", async () => {
    await setup({ config: { loop: { maxTurns: 2 } } });
    const { deps, calls } = fakes({
      edit: (turn) => {
        if (turn === 1) writeFileSync(join(appDir, "app.js"), "x\n");
      },
      // Kane crashes on t-3 without ever reading the file: no test id in the result
      kane: (_t, files) => files.map((f) => (idOf(f) === "t-3" ? { ...pass(f), status: "error" as const, testId: null, reason: "timeout" } : pass(f))),
    });
    const r = await runBuildLoop(p, deps, log);
    expect(r).toEqual({ allowStop: false, turns: 2, reason: "max-turns" });
    expect(calls.claude).toHaveLength(2);
    const ev = await loopEvents();
    const ends = ev.filter((e): e is Extract<LedgerEvent, { t: "turn.end" }> => e.t === "turn.end");
    expect(ends[1]!.commit).toBe(ends[0]!.commit);
    expect(ends[1]!.filesChanged).toEqual([]);
    expect(git(appDir, "log", "--format=%s").split("\n")).toEqual(["holdback turn 1: 2 owed", "holdback: initial commit"]);
    const runs = ev.filter((e): e is Extract<LedgerEvent, { t: "run" }> => e.t === "run");
    expect(runs.filter((e) => e.result.status === "error").every((e) => e.result.testId === "t-3")).toBe(true);
    // R34: a timeout (re-run once, timed out again) proves nothing: ac-3 stays owed, the agent never hears of it
    expect(runs.filter((e) => e.result.testId === "t-3").every((e) => e.result.inconclusive === "timeout")).toBe(true);
    const state = reduce(await readEvents(p.ledgerFile));
    expect(state.acs["ac-3"]).toMatchObject({ status: "owed" });
    expect(state.acs["ac-3"]!.lastFailure).toBeUndefined();
    expect(state.inconclusive).toEqual([{ test: "t-3", turn: 2, reason: "timeout" }]);
    expect(calls.claude[1]!.prompt).not.toContain("timeout");
  });

  it("stops with reason aborted after the current step when the signal fires, leaving the turn on record", async () => {
    await setup();
    const ctl = new AbortController();
    const { deps, calls } = fakes({
      claude: (turn) => {
        if (turn === 1) ctl.abort();
        return undefined;
      },
      kane: (_t, files) => files.map(fail),
    });
    const r = await runBuildLoop(p, deps, log, { signal: ctl.signal });
    expect(r).toEqual({ allowStop: false, turns: 1, reason: "aborted" });
    expect(calls.claude).toHaveLength(1);
    expect(calls.claude[0]!.signal).toBe(ctl.signal); // the agent turn itself can be killed
    expect(calls.tests).toHaveLength(0); // no Kane batch after the abort
    expect(calls.stops).toBe(calls.starts); // the app is down
    expect((await loopEvents()).map((e) => e.t)).toEqual(["turn.start", "turn.end"]);
    // a signal already aborted never starts a turn
    expect(await runBuildLoop(p, deps, log, { signal: ctl.signal })).toEqual({ allowStop: false, turns: 0, reason: "aborted" });
    expect(calls.claude).toHaveLength(1);
  });

  it("replays passing ACs every 3rd turn and logs a regression when one breaks", async () => {
    await setup({ config: { loop: { maxTurns: 3 } } });
    const { deps, calls } = fakes({
      kane: (turn, files) => files.map((f) => (idOf(f) === "t-3" || turn === 3 ? fail(f) : pass(f))),
    });
    const r = await runBuildLoop(p, deps, log);
    expect(r).toEqual({ allowStop: false, turns: 3, reason: "max-turns" });
    expect(calls.tests.map((t) => [t.turn, t.files])).toEqual([
      [1, [T1, T3]],
      [2, [T3]],
      [3, [T3]],
      [3, [T1]],
    ]);
    const regressions = (await loopEvents()).filter((e) => e.t === "regression");
    expect(regressions).toEqual([{ at: expect.any(String), t: "regression", ac: "ac-1", turn: 3 }]);
    expect(reduce(await readEvents(p.ledgerFile)).acs["ac-1"]!.status).toBe("regressed");
  });

  it("bisects a regression only when the AC was last green two or more turns earlier, and briefs the blame", async () => {
    await setup({ config: { loop: { maxTurns: 4 } } });
    const { deps, calls } = fakes({
      kane: (turn, files) => files.map((f) => (idOf(f) === "t-3" || turn >= 3 ? fail(f) : pass(f))),
    });
    const bisected: unknown[][] = [];
    deps.bisect = async (_p, ac, good, bad, _d, lg) => {
      bisected.push([ac, good, bad]);
      const end = (await readEvents(p.ledgerFile)).find((e) => e.t === "turn.end" && e.n === 2);
      await lg({ at, t: "regression", ac, turn: bad, blamedTurn: 2, blamedCommit: end && end.t === "turn.end" ? end.commit : "?" });
      return { turn: 2, commit: "x" };
    };
    await runBuildLoop(p, deps, log);
    expect(bisected).toEqual([["ac-1", 1, 3]]);
    const ends = (await readEvents(p.ledgerFile)).filter((e) => e.t === "turn.end");
    const sha = ends[1]!.t === "turn.end" ? ends[1]!.commit : "";
    const brief = calls.claude[3]!.prompt;
    expect(brief).toContain(`Broke in turn 2 (${sha}): files app.js`);
  });

  it("records a bisect that threw or found no blame instead of dropping it", async () => {
    await setup({ config: { loop: { maxTurns: 3 } } });
    const { deps } = fakes({ kane: (turn, files) => files.map((f) => (idOf(f) === "t-3" || turn === 3 ? fail(f) : pass(f))) });
    deps.bisect = async () => {
      throw new Error("worktree boom");
    };
    await runBuildLoop(p, deps, log);
    const regs = (await loopEvents()).filter((e) => e.t === "regression");
    expect(regs).toEqual([
      { at: expect.any(String), t: "regression", ac: "ac-1", turn: 3 },
      { at: expect.any(String), t: "regression", ac: "ac-1", turn: 3, detail: "bisect failed: worktree boom" },
    ]);
  });

  it("does not bisect a regression one turn after the AC was green", async () => {
    await setup({ config: { loop: { maxTurns: 2 } } });
    const { deps } = fakes({
      // turn 1: t-3 fails; turn 2: t-3 passes, the owed list empties, the replay catches t-1 failing
      kane: (turn, files) => files.map((f) => (idOf(f) === "t-3" ? (turn === 1 ? fail(f) : pass(f)) : turn === 2 ? fail(f) : pass(f))),
    });
    let called = 0;
    deps.bisect = async () => {
      called++;
      return null;
    };
    await runBuildLoop(p, deps, log);
    expect((await loopEvents()).filter((e) => e.t === "regression")).toHaveLength(1);
    expect(called).toBe(0);
  });

  it("ignores Kane's output-* recording folders and never re-seals", async () => {
    await setup();
    const { deps } = fakes({
      kane: (turn, files) => {
        const out = join(dirname(T3), "output-t3_test");
        mkdirSync(out, { recursive: true });
        writeFileSync(join(out, `recording-${turn}.json`), "{}"); // what a Kane run leaves next to the test
        return files.map((f) => (turn === 1 && idOf(f) === "t-3" ? fail(f) : pass(f)));
      },
    });
    expect(await runBuildLoop(p, deps, log)).toEqual({ allowStop: true, turns: 2, reason: "gate-open" });
    const all = await readEvents(p.ledgerFile);
    expect(all.filter((e) => e.t === "seal")).toHaveLength(1);
    // Kane's own recordings (tier 2): a seed at loop start, then a digest after each turn's batches
    const snaps = all.filter((e): e is Extract<LedgerEvent, { t: "recordings" }> => e.t === "recordings");
    expect(snaps).toHaveLength(3);
    expect(snaps[0]!.digest).toBe(manifestDigest({}));
    expect(new Set(snaps.map((s) => s.digest)).size).toBe(3);
    expect(snaps[2]!.digest).toBe(manifestDigest(await sealRecordings(p.verifierDir)));
    expect(new Set(snaps.map((s) => s.gitConfig)).size).toBe(1);
    expect(snaps.every((s) => !("manifest" in s))).toBe(true); // only the digest is logged
  });

  it("holds Kane's recordings and the git config to the last logged baseline between runs", async () => {
    await setup();
    const rec = join(dirname(T3), "output-t3_test", "recording.json");
    const kane = (turn: number, files: string[]) => {
      mkdirSync(dirname(rec), { recursive: true });
      writeFileSync(rec, `{"turn":${turn}}`);
      return files.map((f) => (turn === 1 && idOf(f) === "t-3" ? fail(f) : pass(f)));
    };
    // run 1 stops at the turn cap with a baseline logged after its batch
    expect(await runBuildLoop(p, fakes({ kane }).deps, log, { maxTurnsOverride: 1 })).toMatchObject({ reason: "max-turns" });
    // between runs, a recording is rewritten
    writeFileSync(rec, '{"steps":"replay says pass"}');
    const second = fakes({ kane });
    const r = await runBuildLoop(p, second.deps, log);
    expect(r).toMatchObject({ allowStop: false, turns: 0, reason: "tamper" });
    expect(second.calls.claude).toHaveLength(0);
    expect((await loopEvents()).at(-1)).toMatchObject({ t: "tamper", detail: expect.stringContaining("Kane's recordings") });
    expect(existsSync(join(p.home, "TAMPERED"))).toBe(true);
  });

  it("holds the git config to the last logged baseline between runs, and a fresh seal re-seeds both", async () => {
    await setup();
    const kane = (turn: number, files: string[]) => files.map((f) => (turn === 1 && idOf(f) === "t-3" ? fail(f) : pass(f)));
    expect(await runBuildLoop(p, fakes({ kane }).deps, log, { maxTurnsOverride: 1 })).toMatchObject({ reason: "max-turns" });
    appendFileSync(join(appDir, ".git", "config"), "[alias]\n\tst = status\n");
    expect(await runBuildLoop(p, fakes({ kane }).deps, log)).toMatchObject({ turns: 0, reason: "tamper" });
    expect((await loopEvents()).at(-1)).toMatchObject({ t: "tamper", detail: expect.stringContaining(".git/config") });
    // a human re-seal: fresh seal, marker cleared; the disk as it is now becomes the baseline
    await log({ at, t: "seal", manifest: await seal(p.verifierDir, { appDir, files: appSealFiles(p) }) });
    await clearTamper(p);
    const after = fakes({ kane: (_t, files) => files.map(pass) });
    expect(await runBuildLoop(p, after.deps, log)).toEqual({ allowStop: true, turns: 1, reason: "gate-open" });
    // results from before the tamper did not survive the re-seal: both tests ran again
    expect(after.calls.tests[0]!.files).toEqual([T1, T3]);
  });

  it("flags an agent edit to one of Kane's recordings before the next Kane batch", async () => {
    await setup();
    const rec = join(dirname(T3), "output-t3_test", "recording.json");
    const { deps, calls } = fakes({
      edit: (turn) => {
        if (turn === 2) writeFileSync(rec, '{"steps":"replay says pass"}');
      },
      kane: (turn, files) => {
        mkdirSync(dirname(rec), { recursive: true });
        if (turn === 1) writeFileSync(rec, '{"steps":"recorded"}');
        return files.map((f) => (turn === 1 && idOf(f) === "t-3" ? fail(f) : pass(f)));
      },
    });
    const r = await runBuildLoop(p, deps, log);
    expect(r).toMatchObject({ allowStop: false, turns: 2, reason: "tamper" });
    expect(calls.tests.map((t) => t.turn)).toEqual([1]);
    const tamper = (await loopEvents()).at(-1)!;
    expect(tamper.t === "tamper" && tamper.detail).toContain(".testmuai/tests/output-t3_test/recording.json");
  });

  it("flags an agent edit to a test right after the agent turn, before commit or app start", async () => {
    await setup();
    const { deps, calls } = fakes({
      appUp: () => false,
      edit: () => {
        writeFileSync(join(appDir, "app.js"), "x\n");
        appendFileSync(T3, "\nweakened\n");
      },
      kane: (_t, files) => files.map(pass),
    });
    const r = await runBuildLoop(p, deps, log);
    expect(r).toMatchObject({ allowStop: false, turns: 1, reason: "tamper" });
    expect(calls.claude).toHaveLength(1);
    expect(calls.starts).toBe(0);
    expect(calls.tests).toHaveLength(0);
    const ev = await loopEvents();
    expect(ev.map((e) => e.t)).toEqual(["turn.start", "tamper"]);
    expect(git(appDir, "log", "--format=%s").split("\n")).toEqual(["holdback: initial commit"]);
  });

  it("flags a sealed variable changed while Kane ran (the app process is up then)", async () => {
    await setup();
    const { deps, calls } = fakes({
      kane: (turn, files) => {
        if (turn === 1) return files.map((f) => (idOf(f) === "t-3" ? fail(f) : pass(f)));
        writeFileSync(VARS, JSON.stringify({ start_url: { value: "http://127.0.0.1:9999/" } }));
        return files.map(pass); // this batch empties the owed list, so a replay would come next
      },
    });
    const r = await runBuildLoop(p, deps, log);
    expect(r).toMatchObject({ allowStop: false, turns: 2, reason: "tamper" });
    // stopped right after the batch that saw the change: no replay of t-1 on the same app
    expect(calls.tests.map((t) => [t.turn, t.files])).toEqual([
      [1, [T1, T3]],
      [2, [T3]],
    ]);
    expect(calls.stops).toBe(calls.starts);
    const ev = await loopEvents();
    const tamper = ev[ev.length - 1]!;
    expect(tamper.t === "tamper" && tamper.detail).toContain(".testmuai/variables/assurance.json");
    // the batch that ran against the changed variable logged nothing but the tamper
    expect(ev.filter((e) => e.t === "run" && e.turn === 2)).toEqual([]);
    expect(ev.slice(-3).map((e) => e.t)).toEqual(["turn.start", "turn.end", "tamper"]);
    expect(gate(reduce(await readEvents(p.ledgerFile)))).toMatchObject({ allowStop: false, tampered: true });
  });

  it("stops with tamper when the ledger is edited outside Holdback", async () => {
    await setup();
    const { deps, calls } = fakes({
      // forge green runs from inside the agent's turn
      edit: () => {
        for (const f of [T1, T3]) appendFileSync(p.ledgerFile, JSON.stringify({ at, t: "run", kind: "build", turn: 1, result: pass(f) }) + "\n");
      },
      kane: (_t, files) => files.map((f) => (idOf(f) === "t-3" ? fail(f) : pass(f))),
    });
    const r = await runBuildLoop(p, deps, log);
    expect(r).toMatchObject({ allowStop: false, turns: 1, reason: "tamper" });
    expect(calls.tests).toHaveLength(0);
    expect(calls.stops).toBe(calls.starts);
    const last = (await readEvents(p.ledgerFile)).at(-1)!;
    expect(last).toMatchObject({ t: "tamper", detail: "ledger modified outside Holdback" });
  });

  const forgeGreen = () => {
    for (const f of [T1, T3]) appendFileSync(p.ledgerFile, JSON.stringify({ at, t: "run", kind: "build", turn: 1, result: pass(f) }) + "\n");
  };

  it("a forged ledger is tamper even when the agent then dies without a result", async () => {
    await setup();
    const { deps } = fakes({
      claude: () => {
        forgeGreen();
        return Promise.resolve({ exitCode: 1, resultText: "", durationMs: 5, timedOut: false, stderrTail: "boom" });
      },
      kane: (_t, files) => files.map(pass),
    });
    expect(await runBuildLoop(p, deps, log)).toMatchObject({ allowStop: false, reason: "tamper" });
    expect((await readEvents(p.ledgerFile)).at(-1)).toMatchObject({ t: "tamper", detail: "ledger modified outside Holdback" });
    expect(gate(reduce(await readEvents(p.ledgerFile))).allowStop).toBe(false);
  });

  it("a forged ledger is tamper even when the turn then fails with an error (planted index.lock)", async () => {
    await setup();
    const lock = () => writeFileSync(join(appDir, ".git", "index.lock"), "");
    const plain = fakes({ edit: lock, kane: (_t, files) => files.map(pass) });
    const r1 = await runBuildLoop(p, plain.deps, log);
    expect(r1).toMatchObject({ reason: "error" });
    expect(r1.error).toMatch(/index\.lock/);
    rmSync(join(appDir, ".git", "index.lock"));

    const forged = fakes({
      edit: () => {
        lock();
        forgeGreen();
      },
      kane: (_t, files) => files.map(pass),
    });
    expect(await runBuildLoop(p, forged.deps, log)).toMatchObject({ allowStop: false, reason: "tamper" });
    expect(forged.calls.tests).toHaveLength(0);
  });

  it("refuses to build while a tamper is on record with no fresh seal after it", async () => {
    await setup();
    appendFileSync(T3, "\nweakened\n"); // still changed: checking the seal first would log a fresh tamper each run
    await log({ at, t: "tamper", detail: "sealed files changed: .testmuai/tests/t3_test.md" });
    const { deps, calls } = fakes({ kane: (_t, files) => files.map(pass) });
    const before = (await readEvents(p.ledgerFile)).length;
    for (let i = 0; i < 2; i++) {
      const r = await runBuildLoop(p, deps, log);
      expect(r).toMatchObject({ allowStop: false, turns: 0, reason: "tamper" });
      expect(r.error).toMatch(/re-seal/);
    }
    expect(calls.claude).toHaveLength(0);
    expect((await readEvents(p.ledgerFile)).length).toBe(before); // answered first: nothing new is appended
    // a fresh seal (spec stage / human re-seal) clears it
    await log({ at, t: "seal", manifest: await seal(p.verifierDir, { appDir, files: appSealFiles(p) }) });
    const again = fakes({ kane: (_t, files) => files.map(pass) });
    expect(await runBuildLoop(p, again.deps, log)).toEqual({ allowStop: true, turns: 1, reason: "gate-open" });
  });

  it("errors when a test it would run is not in the seal", async () => {
    await setup();
    const elsewhere = join(root, "elsewhere", "t3_test.md");
    mkdirSync(dirname(elsewhere), { recursive: true });
    copyFileSync(T3, elsewhere);
    const tests: TestNode[] = [
      { id: "t-1", title: "t-1", file: T1, verifies: ["ac-1"] },
      { id: "t-3", title: "t-3", file: elsewhere, verifies: ["ac-3"] },
    ];
    await log({ at, t: "design", useCase: "uc-1", acs: [AC1, AC3], tests, gaps: [], credits: 0 });
    const { deps, calls } = fakes({ kane: (_t, files) => files.map(pass) });
    const r = await runBuildLoop(p, deps, log);
    expect(r).toMatchObject({ allowStop: false, turns: 0, reason: "error" });
    expect(r.error).toMatch(/test file not sealed/);
    expect(calls.claude).toHaveLength(0);
  });

  it("copies a failure screenshot into kane-evidence/, briefs its relative path, and never commits it", async () => {
    await setup();
    const shot = join(root, "kane-session", "screenshots", "step_008.png");
    mkdirSync(dirname(shot), { recursive: true });
    writeFileSync(shot, "PNG-BYTES");
    const { deps, calls } = fakes({
      kane: (turn, files) =>
        files.map((f) => {
          if (turn !== 1 || idOf(f) === "t-1") return pass(f);
          return { ...fail(f), screenshot: shot };
        }),
    });
    const r = await runBuildLoop(p, deps, log);
    expect(r).toEqual({ allowStop: true, turns: 2, reason: "gate-open" });
    expect(readFileSync(join(appDir, "kane-evidence", "turn-1", "t-3-step-2.png"), "utf8")).toBe("PNG-BYTES");
    expect(calls.claude[1]!.prompt).toContain("\nScreenshot: kane-evidence/turn-1/t-3-step-2.png\n");
    expect(readFileSync(join(appDir, ".git", "info", "exclude"), "utf8")).toContain("\n/kane-evidence\n");
    expect(git(appDir, "ls-files")).not.toContain("kane-evidence");
    // the ledger keeps Kane's own path
    const failed = (await loopEvents()).find((e) => e.t === "run" && e.result.status === "failed");
    expect(failed && failed.t === "run" && failed.result.screenshot).toBe(shot);
  });

  it("drops the Screenshot line when the screenshot cannot be copied", async () => {
    await setup();
    const { deps, calls } = fakes({
      kane: (turn, files) => files.map((f) => (turn === 1 && idOf(f) === "t-3" ? { ...fail(f), screenshot: join(root, "gone.png") } : pass(f))),
    });
    await runBuildLoop(p, deps, log);
    expect(calls.claude[1]!.prompt).toContain("Kane saw:");
    expect(calls.claude[1]!.prompt).not.toContain("Screenshot:");
  });

  it("never writes a screenshot through a link planted at kane-evidence", async () => {
    await setup();
    const outside = join(root, "outside");
    mkdirSync(outside);
    symlinkSync(outside, join(appDir, "kane-evidence"), "junction");
    const shot = join(root, "step_008.png");
    writeFileSync(shot, "PNG");
    const { deps, calls } = fakes({
      kane: (turn, files) => files.map((f) => (turn === 1 && idOf(f) === "t-3" ? { ...fail(f), screenshot: shot } : pass(f))),
    });
    expect(await runBuildLoop(p, deps, log)).toEqual({ allowStop: true, turns: 2, reason: "gate-open" });
    expect(readdirSync(outside)).toEqual([]);
    expect(calls.claude[1]!.prompt).not.toContain("Screenshot:");
  });

  it("Holdback's git calls (add, diff, commit, rev-parse) run no repo hook, fsmonitor or signing program", async () => {
    await setup();
    const hooks = join(appDir, ".git", "hooks");
    mkdirSync(hooks, { recursive: true });
    const hook = (name: string, body: string) => writeFileSync(join(hooks, name), `#!/bin/sh\n${body}\n`, { mode: 0o755 });
    hook("post-index-change", "touch index-hook-ran");
    // a hook that fires on `git add`, not only on commit, is live for ordinary commands
    writeFileSync(join(appDir, "probe.txt"), "x");
    git(appDir, "add", "probe.txt");
    expect(existsSync(join(appDir, "index-hook-ran"))).toBe(true);
    git(appDir, "rm", "-q", "--cached", "probe.txt");
    rmSync(join(appDir, "probe.txt"));
    rmSync(join(appDir, "index-hook-ran"));
    hook("pre-commit", "exit 1");
    hook("commit-msg", "exit 1");
    hook("post-commit", "touch hook-ran");
    // the hooks are live for an ordinary commit
    expect(() => git(appDir, "commit", "-q", "--allow-empty", "-m", "x")).toThrow();
    rmSync(join(appDir, "index-hook-ran"), { force: true });
    // an fsmonitor hook and a signing program configured before the loop (so trusted as found)
    const marker = join(root, "fsmonitor-ran").replace(/\\/g, "/");
    const fsmon = join(root, "fsmon.cjs").replace(/\\/g, "/");
    writeFileSync(fsmon, `require("fs").writeFileSync(${JSON.stringify(marker)}, "x"); process.stdout.write("\\0");\n`);
    git(appDir, "config", "core.fsmonitor", `node "${fsmon}"`);
    git(appDir, "status", "--short"); // the fsmonitor hook is live for an ordinary command
    expect(existsSync(marker)).toBe(true);
    rmSync(marker);
    rmSync(join(appDir, "index-hook-ran"), { force: true }); // the probing commands above may have fired it
    git(appDir, "config", "commit.gpgsign", "true");
    git(appDir, "config", "gpg.program", join(root, "no-such-gpg").replace(/\\/g, "/"));

    const { deps } = fakes({ kane: (_t, files) => files.map(pass) });
    expect(await runBuildLoop(p, deps, log)).toEqual({ allowStop: true, turns: 1, reason: "gate-open" });
    expect(existsSync(marker)).toBe(false);
    expect(existsSync(join(appDir, "hook-ran"))).toBe(false);
    expect(existsSync(join(appDir, "index-hook-ran"))).toBe(false);
    expect(readdirSync(join(p.home, "empty-hooks"))).toEqual([]);
    expect(git(appDir, "-c", "core.fsmonitor=false", "log", "--format=%s").split("\n")).toEqual(["holdback turn 1: 2 owed", "holdback: initial commit"]);
  });

  it("stops with tamper when the agent changes the repo's git config, before any git command of Holdback's acts on it", async () => {
    await setup();
    const { deps, calls } = fakes({
      edit: () => {
        writeFileSync(join(appDir, ".gitattributes"), "* filter=x\n");
        appendFileSync(join(appDir, ".git", "config"), '[filter "x"]\n\tclean = node evil.js\n');
      },
      kane: (_t, files) => files.map(pass),
    });
    expect(await runBuildLoop(p, deps, log)).toMatchObject({ allowStop: false, turns: 1, reason: "tamper" });
    expect(calls.tests).toHaveLength(0);
    const tamper = (await loopEvents()).at(-1)!;
    expect(tamper.t === "tamper" && tamper.detail).toContain(".git/config");
    // no `git add` ran with the planted clean filter: the turn was never committed
    expect(git(appDir, "-c", "core.fsmonitor=false", "log", "--format=%s").split("\n")).toEqual(["holdback: initial commit"]);
  });

  it("never writes a screenshot through a link planted at kane-evidence/turn-N", async () => {
    await setup();
    const outside = join(root, "outside");
    mkdirSync(outside);
    mkdirSync(join(appDir, "kane-evidence"));
    symlinkSync(outside, join(appDir, "kane-evidence", "turn-1"), "junction");
    const shot = join(root, "step_008.png");
    writeFileSync(shot, "PNG");
    const { deps, calls } = fakes({
      kane: (turn, files) => files.map((f) => (turn === 1 && idOf(f) === "t-3" ? { ...fail(f), screenshot: shot } : pass(f))),
    });
    expect(await runBuildLoop(p, deps, log)).toEqual({ allowStop: true, turns: 2, reason: "gate-open" });
    expect(readdirSync(outside)).toEqual([]);
    expect(calls.claude[1]!.prompt).not.toContain("Screenshot:");
  });

  it.skipIf(asRoot)("a tamper the ledger cannot take (read-only after a forgery) still blocks the next run", async () => {
    await setup();
    const { deps } = fakes({
      edit: () => {
        forgeGreen();
        chmodSync(p.ledgerFile, 0o444);
      },
      kane: (_t, files) => files.map(pass),
    });
    try {
      expect(await runBuildLoop(p, deps, log)).toMatchObject({ allowStop: false, turns: 1, reason: "tamper" });
      expect(readFileSync(join(p.home, "TAMPERED"), "utf8")).toMatch(/ledger/);
      // the ledger alone (no tamper event made it in) would now open the gate
      expect(gate(reduce(await readEvents(p.ledgerFile))).allowStop).toBe(true);
      const next = fakes({ kane: (_t, files) => files.map(pass) });
      const r = await runBuildLoop(p, next.deps, log);
      expect(r).toMatchObject({ allowStop: false, turns: 0, reason: "tamper" });
      expect(r.error).toMatch(/re-seal/);
      expect(next.calls.claude).toHaveLength(0);
    } finally {
      chmodSync(p.ledgerFile, 0o644);
    }
    // only a fresh seal path lifts it
    await clearTamper(p);
    expect(existsSync(join(p.home, "TAMPERED"))).toBe(false);
  });

  it.skipIf(asRoot)("treats an append the ledger refuses as tamper (marker written first)", async () => {
    await setup();
    const { deps } = fakes({ edit: () => chmodSync(p.ledgerFile, 0o444), kane: (_t, files) => files.map(pass) });
    try {
      expect(await runBuildLoop(p, deps, log)).toMatchObject({ allowStop: false, reason: "tamper" });
      expect(readFileSync(join(p.home, "TAMPERED"), "utf8")).toMatch(/ledger append failed/);
    } finally {
      chmodSync(p.ledgerFile, 0o644);
    }
  });

  /** Run 1: the agent forges green runs and makes the ledger read-only, so the tamper reaches only the marker. */
  const forgeIntoReadOnlyLedger = async () => {
    const { deps } = fakes({
      edit: () => {
        forgeGreen();
        chmodSync(p.ledgerFile, 0o444);
      },
      kane: (_t, files) => files.map(pass),
    });
    try {
      expect(await runBuildLoop(p, deps, log)).toMatchObject({ allowStop: false, turns: 1, reason: "tamper" });
    } finally {
      chmodSync(p.ledgerFile, 0o644);
    }
    // the ledger alone (no tamper event made it in) would open the gate
    expect(gate(reduce(await readEvents(p.ledgerFile))).allowStop).toBe(true);
  };

  it.skipIf(asRoot)("a marker-only tamper does not survive a re-seal: the forged greens are dropped and verified again", async () => {
    await setup();
    await forgeIntoReadOnlyLedger();
    await reseal(p, log);
    expect(await tamperMarker(p)).toBeNull();
    const ev = await readEvents(p.ledgerFile);
    expect(ev.slice(-3).map((e) => e.t)).toEqual(["tamper", "seal", "recordings"]);
    expect(ev.at(-3)).toMatchObject({ t: "tamper", detail: expect.stringMatching(/ledger/) });
    expect(Object.values(reduce(ev).acs).map((a) => a.status)).toEqual(["owed", "owed"]);
    // the next run does not open the gate on the forged results: both tests run again
    const next = fakes({ kane: (_t, files) => files.map((f) => (idOf(f) === "t-3" ? fail(f) : pass(f))) });
    expect(await runBuildLoop(p, next.deps, log, { maxTurnsOverride: 2 })).toEqual({ allowStop: false, turns: 1, reason: "max-turns" });
    expect(next.calls.tests[0]!.files).toEqual([T1, T3]);
  });

  it.skipIf(asRoot)("copies a marker-only tamper into the ledger once at the next start, so even a bare seal drops the forged greens", async () => {
    await setup();
    await forgeIntoReadOnlyLedger();
    const before = (await readEvents(p.ledgerFile)).length;
    for (let i = 0; i < 2; i++) {
      const next = fakes({ kane: (_t, files) => files.map(pass) });
      const r = await runBuildLoop(p, next.deps, log);
      expect(r).toMatchObject({ allowStop: false, turns: 0, reason: "tamper" });
      expect(r.error).toMatch(/re-seal/);
      expect(next.calls.claude).toHaveLength(0);
    }
    const ev = await readEvents(p.ledgerFile);
    expect(ev.slice(before)).toEqual([{ at: expect.any(String), t: "tamper", detail: expect.stringMatching(/ledger/) }]);
    expect(gate(reduce(ev))).toMatchObject({ allowStop: false, tampered: true });
    await log({ at, t: "seal", manifest: await seal(p.verifierDir, { appDir, files: appSealFiles(p) }) });
    await clearTamper(p);
    expect(gate(reduce(await readEvents(p.ledgerFile)))).toMatchObject({ allowStop: false, tampered: false });
  });

  it("reseal logs a marker's tamper once, before its seal, then clears the marker and anchors the recordings", async () => {
    await setup();
    const since = async (n: number) => (await readEvents(p.ledgerFile)).slice(n);
    let n = (await readEvents(p.ledgerFile)).length;
    // no tamper anywhere: a plain re-seal, which keeps verified results (drift)
    await reseal(p, log);
    expect((await since(n)).map((e) => e.t)).toEqual(["seal", "recordings"]);
    n += 2;
    await markTampered(p, "ledger append failed: EPERM");
    await reseal(p, log);
    const ev = await since(n);
    expect(ev.map((e) => e.t)).toEqual(["tamper", "seal", "recordings"]);
    expect(ev[0]).toMatchObject({ detail: expect.stringContaining("ledger append failed: EPERM") });
    expect(ev[2]).toMatchObject({ digest: manifestDigest(await sealRecordings(p.verifierDir)) });
    expect(await tamperMarker(p)).toBeNull();
    n += 3;
    // a tamper already on record in the ledger is not logged twice
    await log({ at, t: "tamper", detail: "sealed files changed: x" });
    await markTampered(p, "sealed files changed: x");
    n += 1;
    await reseal(p, log);
    expect((await since(n)).map((e) => e.t)).toEqual(["seal", "recordings"]);
    // the anchor holds: the next run starts without seeding another one
    n += 2;
    const { deps } = fakes({ kane: (_t, files) => files.map(pass) });
    expect(await runBuildLoop(p, deps, log)).toEqual({ allowStop: true, turns: 1, reason: "gate-open" });
    expect((await since(n))[0]).toMatchObject({ t: "turn.start" });
  });

  it("still logs the tamper, and stops with tamper, when the marker cannot be written", async () => {
    await setup();
    const { deps, calls } = fakes({
      edit: () => {
        mkdirSync(join(p.home, "TAMPERED")); // writing the marker fails from here on
        appendFileSync(T3, "\nweakened\n");
      },
      kane: (_t, files) => files.map(pass),
    });
    expect(await runBuildLoop(p, deps, log)).toMatchObject({ allowStop: false, turns: 1, reason: "tamper" });
    expect(calls.tests).toHaveLength(0);
    expect((await readEvents(p.ledgerFile)).at(-1)).toMatchObject({ t: "tamper", detail: expect.stringContaining(".testmuai/tests/t3_test.md") });
  });

  it("treats anything at the marker path, even a directory, as a tamper on record", async () => {
    await setup();
    mkdirSync(join(p.home, "TAMPERED"));
    const { deps, calls } = fakes({ kane: (_t, files) => files.map(pass) });
    const r = await runBuildLoop(p, deps, log);
    expect(r).toMatchObject({ allowStop: false, turns: 0, reason: "tamper" });
    expect(r.error).toMatch(/re-seal/);
    expect(calls.claude).toHaveLength(0);
    expect((await readEvents(p.ledgerFile)).at(-1)).toMatchObject({ t: "tamper", detail: expect.stringMatching(/directory/) });
  });

  it.each(["Kane throws", "Kane returns too few results", "the app's stop() throws"] as const)(
    "anchors Kane's recordings after an interrupted batch (%s), so the next run sees no false tamper",
    async (how) => {
      await setup();
      const first = fakes({
        kane: (turn, files) => {
          // Kane writes its recording before anything goes wrong
          const out = join(dirname(T3), "output-t3_test");
          mkdirSync(out, { recursive: true });
          writeFileSync(join(out, `recording-${turn}.json`), `{"turn":${turn}}`);
          if (how === "Kane throws") throw new Error("kane crashed");
          return how === "Kane returns too few results" ? files.slice(1).map(pass) : files.map(pass);
        },
      });
      if (how === "the app's stop() throws") {
        const start = first.deps.app;
        first.deps.app = async (o) => {
          const a = await start(o);
          return {
            ...a,
            stop: async () => {
              await a.stop();
              throw new Error("stop failed");
            },
          };
        };
      }
      const r1 = await runBuildLoop(p, first.deps, log);
      expect(r1).toMatchObject({ allowStop: false, turns: 1, reason: "error" });
      expect((await readEvents(p.ledgerFile)).at(-1)).toMatchObject({ t: "recordings", digest: manifestDigest(await sealRecordings(p.verifierDir)) });
      const second = fakes({ kane: (_t, files) => files.map(pass) });
      expect((await runBuildLoop(p, second.deps, log)).reason).toBe("gate-open");
      expect(await tamperMarker(p)).toBeNull();
    },
  );

  it("lets a human add a remote and set an upstream between runs without a tamper", async () => {
    await setup();
    const kane = (turn: number, files: string[]) => files.map((f) => (turn === 1 && idOf(f) === "t-3" ? fail(f) : pass(f)));
    expect(await runBuildLoop(p, fakes({ kane }).deps, log, { maxTurnsOverride: 1 })).toMatchObject({ reason: "max-turns" });
    // what `git remote add` and `git push -u` write
    git(appDir, "remote", "add", "origin", "https://example.com/app.git");
    git(appDir, "config", "branch.master.remote", "origin");
    git(appDir, "config", "branch.master.merge", "refs/heads/master");
    git(appDir, "config", "push.default", "current");
    const next = fakes({ kane: (_t, files) => files.map(pass) });
    expect(await runBuildLoop(p, next.deps, log)).toEqual({ allowStop: true, turns: 1, reason: "gate-open" });
    expect(await tamperMarker(p)).toBeNull();
  });

  it("seeds the baseline at loop start, so a change before any Kane batch is still caught next run", async () => {
    await setup();
    const rec = join(dirname(T3), "output-t3_test", "recording.json");
    mkdirSync(dirname(rec), { recursive: true });
    writeFileSync(rec, '{"steps":"from the spec stage"}');
    // run 1 never gets to a Kane batch (the app never starts): only the seed anchors the recordings
    const down = fakes({ appUp: () => false, kane: (_t, files) => files.map(pass) });
    expect(await runBuildLoop(p, down.deps, log, { maxTurnsOverride: 1 })).toMatchObject({ reason: "max-turns" });
    writeFileSync(rec, '{"steps":"replay says pass"}');
    expect(await runBuildLoop(p, fakes({ kane: (_t, files) => files.map(pass) }).deps, log)).toMatchObject({ turns: 0, reason: "tamper" });
  });

  it("treats a ledger that becomes unreadable mid-run as tamper", async () => {
    await setup();
    const { deps } = fakes({
      edit: () => {
        rmSync(p.ledgerFile);
        mkdirSync(p.ledgerFile); // EISDIR from here on
      },
      kane: (_t, files) => files.map(pass),
    });
    expect(await runBuildLoop(p, deps, log)).toMatchObject({ allowStop: false, reason: "tamper" });
    expect(readFileSync(join(p.home, "TAMPERED"), "utf8")).toMatch(/ledger unreadable/);
  });

  it("caps the global turn number, and a human override extends it", async () => {
    await setup({ config: { loop: { maxTurns: 4 } } });
    await log({ at, t: "turn.start", n: 4, owed: ["ac-1", "ac-3"] });
    const capped = fakes({ kane: (_t, files) => files.map(pass) });
    expect(await runBuildLoop(p, capped.deps, log)).toEqual({ allowStop: false, turns: 0, reason: "max-turns" });
    expect(capped.calls.claude).toHaveLength(0);
    const extended = fakes({ kane: (_t, files) => files.map(pass) });
    expect(await runBuildLoop(p, extended.deps, log, { maxTurnsOverride: 5 })).toEqual({ allowStop: true, turns: 1, reason: "gate-open" });
    expect((await loopEvents()).filter((e) => e.t === "turn.start").map((e) => e.t === "turn.start" && e.n)).toEqual([4, 5]);
  });

  it("returns gate-open without a turn when nothing is owed", async () => {
    await setup();
    for (const f of [T1, T3]) await log({ at, t: "run", kind: "build", turn: 0, result: pass(f) });
    const { deps, calls } = fakes({ kane: (_t, files) => files.map(pass) });
    expect(await runBuildLoop(p, deps, log)).toEqual({ allowStop: true, turns: 0, reason: "gate-open" });
    expect(calls.claude).toHaveLength(0);
  });

  it("errors when the claude binary is missing or the agent dies without a result", async () => {
    await setup();
    const missing = fakes({ claude: () => Promise.reject(new Error("spawn claude ENOENT")), kane: (_t, files) => files.map(pass) });
    const r1 = await runBuildLoop(p, missing.deps, log);
    expect(r1).toMatchObject({ allowStop: false, reason: "error" });
    expect(r1.error).toMatch(/ENOENT/);
    expect(missing.calls.tests).toHaveLength(0);

    const dead = fakes({
      claude: () => Promise.resolve({ exitCode: 1, resultText: "", durationMs: 50, timedOut: false, stderrTail: "Invalid API key" }),
      kane: (_t, files) => files.map(pass),
    });
    const r2 = await runBuildLoop(p, dead.deps, log);
    expect(r2).toMatchObject({ allowStop: false, reason: "error" });
    expect(r2.error).toMatch(/Invalid API key/);
    expect(dead.calls.tests).toHaveLength(0);
  });

  it("reports tamper rather than error when an agent that died had changed a sealed file", async () => {
    await setup();
    const { deps } = fakes({
      claude: () => {
        appendFileSync(T3, "\nweakened\n");
        return Promise.resolve({ exitCode: 1, resultText: "", durationMs: 50, timedOut: false, stderrTail: "crashed" });
      },
      kane: (_t, files) => files.map(pass),
    });
    expect(await runBuildLoop(p, deps, log)).toMatchObject({ allowStop: false, turns: 1, reason: "tamper" });
  });

  it("errors when the app dir is not a git repository or nothing was sealed", async () => {
    await setup({ gitInit: false });
    const a = fakes({ kane: (_t, files) => files.map(pass) });
    const r1 = await runBuildLoop(p, a.deps, log);
    expect(r1).toMatchObject({ reason: "error", turns: 0 });
    expect(r1.error).toMatch(/git/i);

    rmSync(root, { recursive: true, force: true });
    mkdirSync(root);
    await setup();
    const events = (await readEvents(p.ledgerFile)).filter((e) => e.t !== "seal");
    writeFileSync(p.ledgerFile, events.map((e) => JSON.stringify(e)).join("\n") + "\n");
    const b = fakes({ kane: (_t, files) => files.map(pass) });
    const r2 = await runBuildLoop(p, b.deps, log);
    expect(r2).toMatchObject({ reason: "error", turns: 0 });
    expect(r2.error).toMatch(/seal/i);
    expect(b.calls.claude).toHaveLength(0);
    // nothing to anchor before a seal: no recordings seed either
    expect((await readEvents(p.ledgerFile)).map((e) => e.t)).toEqual(["design"]);

    // a seal but no acceptance criteria
    writeFileSync(p.ledgerFile, JSON.stringify({ at, t: "seal", manifest: await seal(p.verifierDir, { appDir, files: appSealFiles(p) }) }) + "\n");
    const r3 = await runBuildLoop(p, fakes({ kane: (_t, files) => files.map(pass) }).deps, log);
    expect(r3).toMatchObject({ reason: "error", turns: 0 });
    expect(r3.error).toMatch(/acceptance criteria/);
    expect((await readEvents(p.ledgerFile)).map((e) => e.t)).toEqual(["seal"]);
  });

  it("refuses to run the agent without a guard entry to hook", async () => {
    await setup();
    const { deps, calls } = fakes({ kane: (_t, files) => files.map(pass) });
    delete deps.guardCommand; // the default points at the compiled guard, absent when running from src
    const r = await runBuildLoop(p, deps, log);
    expect(r).toMatchObject({ allowStop: false, turns: 0, reason: "error" });
    expect(r.error).toMatch(/guard entry not found/);
    expect(calls.claude).toHaveLength(0);
  });

  it("denies web tools when loop.denyWeb is set", async () => {
    await setup({ config: { loop: { denyWeb: true } } });
    const { deps, calls } = fakes({ kane: (_t, files) => files.map(pass) });
    await runBuildLoop(p, deps, log);
    const settings = JSON.parse(readFileSync(calls.claude[0]!.settingsFile, "utf8"));
    expect(settings.permissions.deny).toEqual(expect.arrayContaining(["WebFetch", "WebSearch"]));
  });
});

describe("git helpers", { timeout: 60_000 }, () => {
  it("every git call runs with protocol.allow=never and GIT_NO_LAZY_FETCH=1 (Holdback never fetches)", async () => {
    const repo = join(root, "repo");
    mkdirSync(repo);
    git(repo, "init", "-q");
    delete process.env.GIT_NO_LAZY_FETCH;
    expect((await runGit(repo, ["config", "--get", "protocol.allow"])).stdout.trim()).toBe("never");
    // a shell alias sees the environment git was spawned with
    const probe = await runGit(repo, ["-c", 'alias.lazyprobe=!echo "lazy=$GIT_NO_LAZY_FETCH"', "lazyprobe"]);
    expect(probe.stdout.trim()).toBe("lazy=1");
  });

  it("commit, diff, checkout and worktrees over a scratch repo", async () => {
    const repo = join(root, "repo");
    mkdirSync(join(repo, "sub"), { recursive: true });
    git(repo, "init", "-q");
    git(repo, "config", "user.name", "Test");
    git(repo, "config", "user.email", "test@example.com");
    git(repo, "config", "commit.gpgsign", "false");
    expect(await isRepoRoot(repo)).toBe(true);
    expect(await isRepoRoot(join(repo, "sub"))).toBe(false);
    expect(await isRepoRoot(root)).toBe(false);

    expect(await headSha(repo)).toBeNull();
    writeFileSync(join(repo, ".gitignore"), "node_modules/\n");
    const first = await ensureHead(repo, "init");
    expect(await ensureHead(repo, "again")).toBe(first);
    expect(await commitAll(repo, "nothing")).toBeNull();

    mkdirSync(join(repo, "node_modules"));
    writeFileSync(join(repo, "node_modules", "dep.js"), "x");
    writeFileSync(join(repo, "sub", "ä b.txt"), "1");
    const second = await commitAll(repo, "turn");
    expect(second).toMatch(/^[0-9a-f]{7,}$/);
    expect(await headSha(repo)).toBe(second);
    expect(await changedFiles(repo, first, second!)).toEqual(["sub/ä b.txt"]);

    const wt = join(root, "wt");
    await worktreeAdd(repo, wt, first);
    expect(git(wt, "rev-parse", "--short", "HEAD")).toBe(first);
    await worktreeRemove(repo, wt);
    expect(git(repo, "worktree", "list").split("\n")).toHaveLength(1);

    await checkout(repo, first);
    expect(git(repo, "rev-parse", "--short", "HEAD")).toBe(first);
    await expect(checkout(repo, "no-such-ref")).rejects.toThrow(/git checkout/);
  });
});
