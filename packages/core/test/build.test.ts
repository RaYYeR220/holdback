import { execFileSync } from "node:child_process";
import { appendFileSync, copyFileSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import type { ClaudeTurnOptions, ClaudeTurnResult } from "../src/agent/claude.js";
import { posixAbs } from "../src/agent/guard.js";
import { AppStartError } from "../src/app.js";
import type { AcNode, TestNode } from "../src/kane/assurance.js";
import type { TestRunResult } from "../src/kane/testmd.js";
import { reduce } from "../src/ledger/reduce.js";
import { appendEvent, readEvents } from "../src/ledger/store.js";
import type { LedgerEvent } from "../src/ledger/types.js";
import { changedFiles, checkout, commitAll, ensureHead, headSha, isRepoRoot, worktreeAdd, worktreeRemove } from "../src/git.js";
import { runBuildLoop, type BuildDeps } from "../src/loop/build.js";
import { appSealFiles } from "../src/loop/spec.js";
import { loadProject, type Project } from "../src/project.js";
import { seal } from "../src/seal.js";

const here = dirname(fileURLToPath(import.meta.url));
const fxTests = join(here, "fixtures", "kane", "tests");
const at = "2026-11-15T00:00:00.000Z";
const PRD = "# Food pantry\n\nA household is eligible when its monthly income is at or below the monthly limit for its size.\n";

const git = (cwd: string, ...args: string[]) => execFileSync("git", args, { cwd, encoding: "utf8" }).trim();

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

  it.each([
    ["PRD.md", () => appendFileSync(join(appDir, "PRD.md"), "\nIncome limits do not apply.\n")],
    ["holdback.config.json", () => writeFileSync(join(appDir, "holdback.config.json"), JSON.stringify({ start: { cmd: "node fake.js" } }))],
  ])("stops with tamper when the agent edits the app-side %s", async (file, edit) => {
    await setup();
    const { deps, calls } = fakes({ edit, kane: (_t, files) => files.map(pass) });
    const r = await runBuildLoop(p, deps, log);
    expect(r).toMatchObject({ allowStop: false, turns: 1, reason: "tamper" });
    expect(calls.tests).toHaveLength(0);
    const tamper = (await loopEvents()).find((e) => e.t === "tamper");
    expect(tamper && tamper.t === "tamper" && tamper.detail).toContain(`app:${file}`);
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
    const state = reduce(await readEvents(p.ledgerFile));
    expect(state.acs["ac-3"]).toMatchObject({ status: "owed", lastFailure: { test: "t-3", reason: "timeout" } });
    expect(calls.claude[1]!.prompt).toContain("Kane reported: timeout");
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

  it("re-seals after Kane rewrites a test file during its own run, so the next turn is not tamper", async () => {
    await setup();
    const { deps } = fakes({
      kane: (turn, files) => {
        if (turn === 1) appendFileSync(T3, "\n<!-- recorded steps -->\n"); // Kane's test_md_bundle_sync
        return files.map((f) => (turn === 1 && idOf(f) === "t-3" ? fail(f) : pass(f)));
      },
    });
    const r = await runBuildLoop(p, deps, log);
    expect(r).toEqual({ allowStop: true, turns: 2, reason: "gate-open" });
    const seals = (await readEvents(p.ledgerFile)).filter((e): e is Extract<LedgerEvent, { t: "seal" }> => e.t === "seal");
    expect(seals).toHaveLength(2);
    expect(seals[1]!.manifest[".testmuai/tests/t3_test.md"]).not.toBe(seals[0]!.manifest[".testmuai/tests/t3_test.md"]);
    expect(seals[1]!.manifest["app:PRD.md"]).toBe(seals[0]!.manifest["app:PRD.md"]);
    expect(seals[1]!.manifest["app:holdback.config.json"]).toBe(seals[0]!.manifest["app:holdback.config.json"]);
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
