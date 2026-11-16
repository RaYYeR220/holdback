import { execFileSync } from "node:child_process";
import { appendFileSync, copyFileSync, existsSync, mkdirSync, mkdtempSync, readFileSync, readdirSync, rmSync, symlinkSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { AppStartError, type StartAppOptions } from "../src/app.js";
import { estimateUsd, usdOf, VeniceHttpError, VeniceOutputError, VeniceUnreachable, type VeniceChatOptions } from "../src/breaker/venice.js";
import { evolve as kaneEvolve, type AcNode, type EvolveResult, type Graph, type TestNode } from "../src/kane/assurance.js";
import type { Slip } from "../src/breaker/mutate.js";
import type { RunTestOptions, TestRunResult } from "../src/kane/testmd.js";
import { reduce } from "../src/ledger/reduce.js";
import { appendEvent, readEvents } from "../src/ledger/store.js";
import type { LedgerEvent } from "../src/ledger/types.js";
import { gate } from "../src/ledger/gate.js";
import { runBuildLoop } from "../src/loop/build.js";
import { falsifyVerdict, killsAc, pendingRecheck, runFalsify, type FalsifyDeps } from "../src/loop/falsify.js";
import type { HumanIO } from "../src/loop/human.js";
import { appSealFiles } from "../src/loop/spec.js";
import { loadProject, type Project } from "../src/project.js";
import { checkSeal, seal } from "../src/seal.js";
import { checkRecordingsAnchor, logRecordings, markTampered, tamperMarker } from "../src/tamper.js";
import { logSpecAttempt } from "../src/agent/attempts.js";

const here = dirname(fileURLToPath(import.meta.url));
const fxKane = join(here, "fixtures", "kane");
const fxTests = join(fxKane, "tests");
const at = "2026-11-15T00:00:00.000Z";
const MODEL = "deepseek-v4-flash";
const USD_PER_CALL = (1500 * 0.138 + 300 * 0.275) / 1e6;

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
/** An AC of another use case, left derived (unapproved) by the spec stage. */
const AC9: AcNode = { ...AC3, id: "ac-9", useCase: "uc-2", text: "A volunteer sees today's visits." };

const SRC = [
  "export const LIMITS = { 1: 2461, 2: 3301 };",
  "export function check(size, income, snap) {",
  '  if (snap) return "Eligible.";',
  '  return income <= LIMITS[size] ? "Eligible." : "Not eligible.";',
  "}",
  "",
].join("\n");
const PATCH: Record<string, string> = {
  "ac-1": [
    "--- a/src/eligibility.js",
    "+++ b/src/eligibility.js",
    "@@ -2,3 +2,3 @@",
    " export function check(size, income, snap) {",
    '-  if (snap) return "Eligible.";',
    '+  if (snap && income < 0) return "Eligible.";',
    '   return income <= LIMITS[size] ? "Eligible." : "Not eligible.";',
    "",
  ].join("\n"),
  "ac-3": [
    "--- a/src/eligibility.js",
    "+++ b/src/eligibility.js",
    "@@ -3,3 +3,3 @@",
    '   if (snap) return "Eligible.";',
    '-  return income <= LIMITS[size] ? "Eligible." : "Not eligible.";',
    '+  return income <= LIMITS[size] + 1 ? "Eligible." : "Not eligible.";',
    " }",
    "",
  ].join("\n"),
};
const BAD_PATCH = ["--- a/src/eligibility.js", "+++ b/src/eligibility.js", "@@ -1,1 +1,1 @@", "-const nothing = here;", "+const nothing = there;", ""].join("\n");

const saved = { ...process.env };
let root: string;
let appDir: string;
let p: Project;
let T1: string;
let T3: string;
let T3B: string;
const log = (e: LedgerEvent) => appendEvent(p.ledgerFile, e);

beforeEach(() => {
  root = mkdtempSync(join(tmpdir(), "hb-falsify-"));
  process.env.HOLDBACK_HOME = join(root, "home");
});
afterEach(() => {
  for (const k of ["HOLDBACK_HOME", "VENICE_API_KEY", "HOLDBACK_KANE_BIN", "FAKE_KANE_SEQUENCE", "FAKE_KANE_ARGV_LOG"]) {
    if (saved[k] === undefined) delete process.env[k];
    else process.env[k] = saved[k];
  }
  rmSync(root, { recursive: true, force: true });
});

/** `t1_test.md` is t-1, `t3b_test.md` t-3b, `t4_test.md` t-4. */
const idOf = (file: string) => `t-${/t(\w+?)_test\.md$/.exec(file)?.[1] ?? "3"}`;
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
const failOn =
  (...acs: string[]) =>
  (file: string): TestRunResult => ({
    ...pass(file),
    status: "failed",
    failedStep: 2,
    criteriaFailed: acs,
    verdict: { bugTitle: "Eligibility check approves income above displayed limit", family: "application_issue" },
    credits: 4.7,
  });

const testNodes = (): TestNode[] => [
  { id: "t-1", title: "SNAP household qualifies", file: ".testmuai/tests/t1_test.md", verifies: ["ac-1"] },
  { id: "t-3", title: "Non-SNAP household above $2,461 is not eligible", file: T3, verifies: ["ac-3"] },
];

/** App repo (one commit, a node_modules dir outside git) + verifier with t-1/t-3 + a ledger where ac-1 and ac-3 pass. */
async function setup(opts: { before?: () => Promise<void>; config?: object } = {}) {
  appDir = join(root, "app");
  mkdirSync(join(appDir, "src"), { recursive: true });
  mkdirSync(join(appDir, "node_modules", "dep"), { recursive: true });
  writeFileSync(join(appDir, "node_modules", "dep", "index.js"), "module.exports = 1;\n");
  writeFileSync(join(appDir, ".gitignore"), "node_modules/\n");
  writeFileSync(join(appDir, "PRD.md"), "# Food pantry\n\nNot eligible above 2461.\n");
  writeFileSync(join(appDir, "holdback.config.json"), JSON.stringify(opts.config ?? {}));
  writeFileSync(join(appDir, "src", "eligibility.js"), SRC);
  git(appDir, "init", "-q");
  git(appDir, "config", "user.name", "Test");
  git(appDir, "config", "user.email", "test@example.com");
  git(appDir, "config", "commit.gpgsign", "false");
  git(appDir, "add", "-A");
  git(appDir, "commit", "-q", "-m", "turn 1");
  p = await loadProject(appDir);
  const testsDir = join(p.verifierDir, ".testmuai", "tests");
  mkdirSync(testsDir, { recursive: true });
  T1 = join(testsDir, "t1_test.md");
  T3 = join(testsDir, "t3_test.md");
  T3B = join(testsDir, "t3b_test.md");
  copyFileSync(join(fxTests, "snap-household-qualifies-despite-above-limit-income_test.md"), T1);
  copyFileSync(join(fxTests, "non-snap-household-above-2-461-is-not-eligible_test.md"), T3);
  const vars = join(p.verifierDir, ".testmuai", "variables", "assurance.json");
  mkdirSync(dirname(vars), { recursive: true });
  writeFileSync(vars, JSON.stringify({ start_url: { value: "http://127.0.0.1:3100/" } }));
  await log({ at, t: "design", useCase: "uc-1", acs: [AC1, AC3], tests: testNodes(), gaps: [], credits: 12 });
  await log({ at, t: "seal", manifest: await seal(p.verifierDir, { appDir, files: appSealFiles(p) }) });
  await greenTurn(1);
  await opts.before?.();
}

async function greenTurn(n: number) {
  await log({ at, t: "turn.start", n, owed: ["ac-1", "ac-3"] });
  await log({ at, t: "turn.end", n, commit: "abc", filesChanged: ["src/eligibility.js"], durationMs: 1, appUp: true, agentExit: 0 });
  await log({ at, t: "run", kind: "build", turn: n, result: pass(T1) });
  await log({ at, t: "run", kind: "build", turn: n, result: pass(T3) });
}

/** An earlier pass: ac-3's planted bug survived, Kane evolved uc-1 (t-4 replaced t-1 and t-3), sealed it, and t-4 passed. */
async function evolvedEarlier() {
  await log({ at, t: "mutant", id: "m-ac-3-1", ac: "ac-3", patch: PATCH["ac-3"]!, model: MODEL, usd: 0.0003, verdict: "survived", slip: SLIP["ac-3"] });
  await log({ at, t: "falsify.evolved", uc: "uc-1", because: "b", minted: ["t-4"], retired: ["t-1", "t-3"], credits: 11.39, mutants: ["m-ac-3-1"] });
  writeFileSync(testFile("t-4"), "---\nassurance:\n  id: t-4\n---\n# t-4\n");
  await log({ at, t: "design", useCase: "uc-1", acs: [AC1, AC3], tests: [{ id: "t-4", title: "minted t-4", file: testFile("t-4"), verifies: ["ac-1", "ac-3"] }], gaps: [], credits: 0 });
  await log({ at, t: "seal", manifest: await seal(p.verifierDir, { appDir, files: appSealFiles(p) }), by: "kane" });
  await log({ at, t: "run", kind: "build", turn: 1, result: pass(testFile("t-4")) });
}

/** The breaker's account of the bug it planted for each AC. */
const SLIP: Record<string, Slip> = {
  "ac-1": { behaviour: "A SNAP household is told it is not eligible.", inputs: "household size 1, monthly income $3,000, SNAP checked", expected: "Eligible.", observed: "Not eligible." },
  "ac-3": {
    behaviour: "A one-person household one dollar over the limit is told it is eligible.",
    inputs: "household size 1, monthly income $2,462, SNAP unchecked",
    expected: "Not eligible. with the limit $2,461",
    observed: "Eligible. with the limit $2,461",
  },
};

/** What Kane's evolve does to the verifier in a fake: write a minted test, retire live ones. */
type EvolveKit = {
  mint: (id: string, verifies: string[], file?: string) => void;
  retire: (...ids: string[]) => void;
  /** A live test in Kane's graph that points at an existing file. */
  alias: (id: string, file: string, verifies: string[]) => void;
  /** A criterion in Kane's graph put under use case `uc`, or a new one. */
  placeAc: (ac: AcNode) => void;
};

type Plan = {
  /** Patch the breaker returns for an AC on its Nth call (0-based). */
  patch?: (ac: string, call: number) => string;
  /** Kane results for a falsify batch (`ac` is the AC under attack). */
  mutantRun: (ac: string, files: string[]) => TestRunResult[];
  /** Kane results for the closing replay against the real build. Default: all pass. */
  replay?: (files: string[]) => TestRunResult[];
  mutantStarts?: boolean;
  onBatch?: (ac: string) => void;
  /**
   * Kane's Nth `maintain evolve` (0-based). Default: like the live capture, it mints t-4 (verifying
   * ac-1 and ac-3) and retires t-1 and t-3.
   */
  evolve?: (n: number, kit: EvolveKit) => EvolveResult | Promise<EvolveResult>;
  /** Extra effect of Kane's evolve, after it wrote its tests. */
  onEvolve?: (n: number) => void;
  /** The breaker call fails instead of answering (`call`: the AC's Nth breaker call, 0-based). */
  chatError?: (ac: string, call: number) => Error | undefined;
  /** The breaker leaves its account of the bug out. */
  noSlip?: boolean;
};

const EVOLVED: EvolveResult = {
  status: "complete",
  minted: [{ scenario: "sc-4", test: "t-4" }],
  superseded: [
    { scenario: "sc-1", test: "t-1" },
    { scenario: "sc-3", test: "t-3" },
  ],
  retained: [],
  moves: [],
  testsCommitted: 1,
  credits: 11.39,
};

/** A test file Kane minted: `t-4` lives in `t4_test.md`. */
const testFile = (id: string) => join(p.verifierDir, ".testmuai", "tests", `${id.replace("-", "")}_test.md`);

function fakes(plan: Plan) {
  const calls = {
    chat: [] as { ac: string; o: VeniceChatOptions }[],
    tests: [] as { ac: string; cwd: string; files: string[]; opts: RunTestOptions & { parallel?: number } }[],
    apps: [] as StartAppOptions[],
    stops: 0,
    evolve: [] as { cwd: string; uc: string; because: string }[],
    /** Per mutant start: the patched source and whether the app's node_modules showed through. */
    mutantSrc: [] as { src: string; deps: boolean }[],
  };
  let current = "";
  const perAc = new Map<string, number>();
  // Kane's live tests: what its graph shows (an evolve's new set replaces the use case's old one)
  let live: TestNode[] = testNodes();
  const kit: EvolveKit = {
    mint: (id, verifies, file = testFile(id)) => {
      writeFileSync(file, `---\nassurance:\n  id: ${id}\n---\n# ${id}\n\n## Step 1 @verifies ${verifies.join(", ")}\n\nCheck it.\n`);
      live = [...live.filter((t) => t.id !== id), { id, title: `minted ${id}`, file, verifies }];
    },
    retire: (...ids) => void (live = live.filter((t) => !ids.includes(t.id))),
    alias: (id, file, verifies) => void (live = [...live, { id, title: `live ${id}`, file, verifies }]),
    placeAc: (ac) => void (graphAcs = [...graphAcs.filter((a) => a.id !== ac.id), ac]),
  };
  let graphAcs: AcNode[] = [AC1, AC3, AC9];
  const graph = (): Graph => ({ useCases: [], acs: graphAcs, tests: live, gaps: [] });
  const deps: FalsifyDeps = {
    apiKey: "test-key",
    port: async () => 5178,
    chat: async (o) => {
      const ac = /^AC (\S+):/m.exec(o.messages[1]!.content)![1]!;
      current = ac;
      const n = perAc.get(ac) ?? 0;
      perAc.set(ac, n + 1);
      calls.chat.push({ ac, o });
      const err = plan.chatError?.(ac, n);
      if (err) throw err;
      const patch = plan.patch ? plan.patch(ac, n) : PATCH[ac]!;
      return { json: { patch, rationale: `breaks ${ac}`, ...(plan.noSlip ? {} : SLIP[ac]) }, usage: { prompt_tokens: 1500, completion_tokens: 300 } };
    },
    app: async (o) => {
      calls.apps.push(o);
      if (o.cwd !== appDir) {
        // a re-checked survivor plants its patch without asking the breaker: name the AC from its worktree
        current = /m-(ac-\d+)-\d+$/.exec(o.cwd)?.[1] ?? current;
        calls.mutantSrc.push({ src: readFileSync(join(o.cwd, "src", "eligibility.js"), "utf8"), deps: existsSync(join(o.cwd, "node_modules", "dep", "index.js")) });
        if (plan.mutantStarts === false) throw new AppStartError("app exited before becoming ready", "SyntaxError: Unexpected token");
      }
      return { url: `http://127.0.0.1:${o.port}`, logs: () => "", stop: async () => void calls.stops++ };
    },
    tests: async (cwd, files, opts = {}) => {
      calls.tests.push({ ac: opts.noHeal ? current : "", cwd, files: [...files], opts });
      // Kane writes its own recordings next to the tests
      const out = join(p.verifierDir, ".testmuai", "tests", `output-${calls.tests.length}`);
      mkdirSync(out, { recursive: true });
      writeFileSync(join(out, "run.json"), "{}");
      if (opts.noHeal) {
        plan.onBatch?.(current);
        return plan.mutantRun(current, files);
      }
      return (plan.replay ?? ((f) => f.map(pass)))(files);
    },
    kane: {
      evolve: async (cwd, uc, because) => {
        const n = calls.evolve.length;
        calls.evolve.push({ cwd, uc, because });
        let r: EvolveResult;
        if (plan.evolve) r = await plan.evolve(n, kit);
        else {
          kit.mint("t-4", ["ac-1", "ac-3"]);
          kit.retire("t-1", "t-3");
          r = EVOLVED;
        }
        plan.onEvolve?.(n);
        return r;
      },
      readGraph: async () => graph(),
    },
  };
  const io: HumanIO = {
    answer: async () => {
      throw new Error("falsify asks the human nothing");
    },
    approve: async () => {
      throw new Error("falsify asks the human nothing");
    },
  };
  return { deps, io, calls, kit };
}

const after = async (since: number) => (await readEvents(p.ledgerFile)).slice(since);
const tags = (ev: LedgerEvent[]) =>
  ev.map((e) => (e.t === "run" ? `run:${e.kind}:${e.result.testId}:${e.result.status}` : e.t === "mutant" ? `mutant:${e.ac}:${e.verdict}` : e.t));
const mutDir = (id: string) => join(p.home, "mut", id);

describe("runFalsify", { timeout: 60_000 }, () => {
  it("kills a mutant that fails its AC: proved, runs logged as falsify, recordings anchored, worktree gone, real build replayed", async () => {
    await setup();
    const since = (await readEvents(p.ledgerFile)).length;
    const { deps, io, calls } = fakes({ mutantRun: (ac, files) => files.map(failOn(ac)) });
    const r = await runFalsify(p, deps, io, log);
    expect(r).toEqual({
      killed: ["ac-1", "ac-3"],
      survived: [],
      invalid: [],
      redesigned: [],
      vacuous: [],
      skipped: [],
      usd: expect.closeTo(2 * USD_PER_CALL, 12),
      reason: "done",
    });

    // one breaker call per AC, each shown the AC and the source that implements it
    expect(calls.chat.map((c) => c.ac)).toEqual(["ac-1", "ac-3"]);
    expect(calls.chat[1]!.o.model).toBe(MODEL);
    expect(calls.chat[1]!.o.apiKey).toBe("test-key");
    expect(calls.chat[1]!.o.messages[1]!.content).toContain(`AC ac-3: ${AC3.text}`);
    expect(calls.chat[1]!.o.messages[1]!.content).toContain('<file path="src/eligibility.js">');
    expect(calls.chat[1]!.o.messages[1]!.content).not.toContain("Food pantry"); // never the spec file

    // each mutant ran from a worktree of HEAD with the patch applied, its own data dir and the app's deps
    const mutantApps = calls.apps.filter((a) => a.cwd !== appDir);
    // each mutant started twice: its replay, then the second replay that confirms the kill (R44)
    expect(mutantApps.map((a) => a.cwd)).toEqual([mutDir("m-ac-1-1"), mutDir("m-ac-1-1"), mutDir("m-ac-3-1"), mutDir("m-ac-3-1")]);
    expect(mutantApps[1]).toMatchObject({ cmd: "npm start", port: 5178, readyPath: "/", env: { DATA_DIR: expect.any(String), VENICE_API_KEY: "" } });
    // a data dir of its own under the home, never one inside the worktree (a committed database would seed it)
    const dataDirs = calls.apps.map((a) => a.env!.DATA_DIR!);
    expect(new Set(dataDirs).size).toBe(calls.apps.length);
    for (const d of dataDirs) expect(d.startsWith(join(p.home, "data"))).toBe(true);
    expect(calls.mutantSrc[0]!.src).toContain("if (snap && income < 0)");
    expect(calls.mutantSrc[2]!.src).toContain("LIMITS[size] + 1");
    expect(calls.mutantSrc.every((m) => m.deps)).toBe(true);

    // Kane replays only the AC's tests, from the sealed verifier, against the mutant, healing off
    const falsify = calls.tests.filter((t) => t.opts.noHeal);
    expect(falsify.map((t) => [t.ac, t.files])).toEqual([
      ["ac-1", [T1]],
      ["ac-1", [T1]],
      ["ac-3", [T3]],
      ["ac-3", [T3]],
    ]);
    expect(falsify[0]!.cwd).toBe(p.verifierDir);
    // one replay at a time (breaker.parallel 1): parallel replays raced Kane's own start navigation live (R44)
    expect(falsify[0]!.opts).toEqual({ startUrl: "http://127.0.0.1:5178/", noHeal: true, timeoutS: 120, parallel: 1 });

    // then every test once against the real build (heal on), to restore Kane's own coverage
    const replay = calls.tests.filter((t) => !t.opts.noHeal);
    expect(replay.map((t) => t.files)).toEqual([[T1, T3]]);
    expect(replay[0]!.opts).toEqual({ startUrl: "http://127.0.0.1:3100/", timeoutS: 120, parallel: 1 });
    expect(calls.apps.filter((a) => a.cwd === appDir)).toEqual([expect.objectContaining({ port: 3100, cmd: "npm start" })]);
    expect(calls.stops).toBe(calls.apps.length);

    const ev = await after(since);
    expect(tags(ev)).toEqual([
      "recordings", // seeded: nothing anchored the recordings since the seal
      "mutant:ac-1:killed",
      "run:falsify:t-1:failed",
      "run:falsify:t-1:failed", // the second replay that confirmed the kill
      "recordings",
      "mutant:ac-3:killed",
      "run:falsify:t-3:failed",
      "run:falsify:t-3:failed",
      "recordings",
      "run:replay:t-1:passed", // the closing replay of the real build, apart from the build checks
      "run:replay:t-3:passed",
      "recordings",
    ]);
    expect(ev[5]).toEqual({ at: expect.any(String), t: "mutant", id: "m-ac-3-1", ac: "ac-3", patch: PATCH["ac-3"], model: MODEL, usd: expect.closeTo(USD_PER_CALL, 12), verdict: "killed", slip: SLIP["ac-3"] });
    expect(ev[6]).toMatchObject({ t: "run", kind: "falsify", mutantId: "m-ac-3-1" });
    expect(ev[7]).toMatchObject({ t: "run", kind: "falsify", mutantId: "m-ac-3-1", confirm: true });
    // a replay of turn 1's build: the turn whose code it ran
    expect(ev[9]).toMatchObject({ t: "run", kind: "replay", turn: 1 });

    const state = reduce(await readEvents(p.ledgerFile));
    expect(state.acs["ac-1"]!.status).toBe("proved");
    expect(state.acs["ac-3"]!.status).toBe("proved");
    expect(state.breakerUsd).toBeCloseTo(2 * USD_PER_CALL, 12);
    expect(state.mutants).toEqual({ killed: 2, survived: 0, invalid: 0 });

    // the next build loop holds the disk to what falsify logged: no false tamper
    expect((await checkRecordingsAnchor(p, await readEvents(p.ledgerFile))).moved).toEqual([]);
    // the throwaway worktrees and patch files are gone, the app's own deps and source are untouched
    expect(existsSync(join(p.home, "mut")) ? readdirSync(join(p.home, "mut")) : []).toEqual([]);
    expect(git(appDir, "worktree", "list").split("\n")).toHaveLength(1);
    expect(readFileSync(join(appDir, "node_modules", "dep", "index.js"), "utf8")).toBe("module.exports = 1;\n");
    expect(readFileSync(join(appDir, "src", "eligibility.js"), "utf8")).toBe(SRC);
    expect(git(appDir, "status", "--porcelain")).toBe("");
  });

  it("a kill counts only when a second replay of the same test on the same mutant, on a fresh start, fails the criterion again: both runs on the ledger (R44)", async () => {
    await setup();
    const { deps, io, calls } = fakes({ mutantRun: (ac, files) => files.map(failOn(ac)) });
    const r = await runFalsify(p, deps, io, log);
    expect(r).toMatchObject({ killed: ["ac-1", "ac-3"], invalid: [] });
    expect(calls.tests.filter((t) => t.opts.noHeal).map((t) => [t.ac, t.files])).toEqual([
      ["ac-1", [T1]],
      ["ac-1", [T1]],
      ["ac-3", [T3]],
      ["ac-3", [T3]],
    ]);
    // the mutant started again, on a new data dir, for the second replay
    const m1 = calls.apps.filter((a) => a.cwd === mutDir("m-ac-1-1"));
    expect(m1).toHaveLength(2);
    expect(m1[0]!.env!.DATA_DIR).not.toBe(m1[1]!.env!.DATA_DIR);
    const runs = (await readEvents(p.ledgerFile)).filter((e): e is Extract<LedgerEvent, { t: "run" }> => e.t === "run" && e.mutantId === "m-ac-1-1");
    expect(runs.map((e) => [e.result.testId, e.result.status, e.confirm ?? false])).toEqual([
      ["t-1", "failed", false],
      ["t-1", "failed", true],
    ]);
  });

  it("a kill the second replay does not reproduce is inconclusive: never a kill, never a survival (R44)", async () => {
    await setup();
    const n = new Map<string, number>();
    const { deps, io, calls } = fakes({
      mutantRun: (ac, files) => {
        n.set(ac, (n.get(ac) ?? 0) + 1);
        return files.map(n.get(ac) === 1 ? failOn(ac) : pass);
      },
    });
    const r = await runFalsify(p, deps, io, log);
    expect(r).toMatchObject({ killed: [], survived: [], invalid: ["ac-1", "ac-3"], vacuous: [], redesigned: [] });
    expect(r.survivors).toBeUndefined();
    expect(calls.evolve).toEqual([]);
    const all = await readEvents(p.ledgerFile);
    expect(all.find((e) => e.t === "mutant" && e.ac === "ac-1")).toMatchObject({
      verdict: "invalid",
      note: "inconclusive: the kill did not reproduce: t-1 passed on a second replay of the same mutant",
    });
    expect(all.filter((e) => e.t === "run" && e.mutantId === "m-ac-1-1")).toHaveLength(2);
    expect(reduce(all).acs["ac-1"]!.status).toBe("passing");
  });

  it("a second replay that fails for another reason, or on another criterion, does not confirm the kill (R44)", async () => {
    await setup();
    const n = new Map<string, number>();
    const { deps, io } = fakes({
      mutantRun: (ac, files) => {
        n.set(ac, (n.get(ac) ?? 0) + 1);
        if (n.get(ac) === 1) return files.map(failOn(ac));
        // the second replay of ac-1's test fails ac-6; ac-3's fails ac-3 but blames the automation, twice
        return files.map(ac === "ac-1" ? failOn("ac-6") : (f) => ({ ...failOn(ac)(f), verdict: { bugTitle: "label assertion no longer matches", family: "automation_bug" } }));
      },
    });
    const r = await runFalsify(p, deps, io, log);
    expect(r).toMatchObject({ killed: [], invalid: ["ac-1", "ac-3"] });
    const ms = (await readEvents(p.ledgerFile)).filter((e) => e.t === "mutant");
    expect(ms.map((m) => (m.t === "mutant" ? m.note : ""))).toEqual([
      "inconclusive: the kill did not reproduce: t-1 failed ac-6, not ac-1, on a second replay of the same mutant",
      "inconclusive: the kill did not reproduce: t-3 proved nothing on a second replay of the same mutant (automation_bug: label assertion no longer matches)",
    ]);
  });

  it("breaker.parallel sets how many of falsify's replays run at once, whatever kane.parallel (the build checks) says (R44)", async () => {
    await setup({ config: { kane: { parallel: 4 }, breaker: { parallel: 2 } } });
    const { deps, io, calls } = fakes({ mutantRun: (ac, files) => files.map(failOn(ac)) });
    await runFalsify(p, deps, io, log);
    expect(calls.tests.length).toBeGreaterThan(1);
    for (const t of calls.tests) expect(t.opts.parallel).toBe(2);
  });

  it("refuses a breaker.parallel that is not a whole number of at least 1, before any breaker call", async () => {
    await setup({ config: { breaker: { parallel: 0 } } });
    const { deps, io, calls } = fakes({ mutantRun: (ac, files) => files.map(failOn(ac)) });
    const r = await runFalsify(p, deps, io, log);
    expect(r).toMatchObject({ reason: "error", error: "breaker.parallel must be a whole number of 1 or more, got 0" });
    expect(calls.chat).toEqual([]);
  });

  it("stops with reason aborted after the current AC, still replays the real build, and skips the rest", async () => {
    await setup();
    const ctl = new AbortController();
    const { deps, io, calls } = fakes({ mutantRun: (ac, files) => files.map(failOn(ac)), onBatch: () => ctl.abort() });
    const r = await runFalsify(p, deps, io, log, { signal: ctl.signal });
    expect(r).toMatchObject({ killed: ["ac-1"], reason: "aborted" });
    expect(calls.chat.map((c) => c.ac)).toEqual(["ac-1"]);
    expect(calls.tests.filter((t) => !t.opts.noHeal)).toHaveLength(1); // Kane's coverage restored
    expect(calls.stops).toBe(calls.apps.length);
    expect(existsSync(join(p.home, "mut")) ? readdirSync(join(p.home, "mut")) : []).toEqual([]);
    expect((await checkRecordingsAnchor(p, await readEvents(p.ledgerFile))).moved).toEqual([]);
  });

  const survives3 = (ac: string, files: string[]) => files.map(ac === "ac-1" ? failOn("ac-1") : pass);

  it("a surviving AC sends its use case to Kane's maintain evolve: told what slipped through, its new set replaces the old tests, sealed by Kane, every criterion owed again and the new tests replayed (R40)", async () => {
    await setup();
    const sealedBefore = (await readEvents(p.ledgerFile)).findLast((e) => e.t === "seal") as Extract<LedgerEvent, { t: "seal" }>;
    const since = (await readEvents(p.ledgerFile)).length;
    const { deps, io, calls } = fakes({ mutantRun: survives3 });
    const r = await runFalsify(p, deps, io, log);
    expect(r).toMatchObject({ killed: ["ac-1"], survived: ["ac-3"], invalid: [], redesigned: ["uc-1"], vacuous: [], reason: "done" });

    // Kane, the verifier, is told what slipped through in a user's terms: the inputs, expected and observed
    expect(calls.evolve).toHaveLength(1);
    const { cwd, uc, because } = calls.evolve[0]!;
    expect([cwd, uc]).toEqual([p.verifierDir, "uc-1"]);
    for (const part of [`ac-3 ("${AC3.text}")`, SLIP["ac-3"]!.behaviour, SLIP["ac-3"]!.inputs, SLIP["ac-3"]!.expected, SLIP["ac-3"]!.observed]) expect(because).toContain(part);
    expect(because).not.toContain("LIMITS[size]"); // the bug in a user's terms, not its code
    // the human's own output (`holdback run`) shows what Kane was told (I-4)
    expect(r.evolved).toEqual([{ uc: "uc-1", because }]);

    const ev = await after(since);
    expect(tags(ev)).toEqual([
      "recordings",
      "mutant:ac-1:killed",
      "run:falsify:t-1:failed",
      "run:falsify:t-1:failed",
      "recordings",
      "mutant:ac-3:survived",
      "run:falsify:t-3:passed",
      "recordings",
      "falsify.evolved",
      "design",
      "seal",
      "recordings",
      "run:replay:t-4:passed",
      "recordings",
    ]);
    expect(ev[5]).toMatchObject({ t: "mutant", id: "m-ac-3-1", slip: SLIP["ac-3"] });
    expect(ev[8]).toEqual({ at: expect.any(String), t: "falsify.evolved", uc: "uc-1", because, minted: ["t-4"], retired: ["t-1", "t-3"], credits: 11.39, mutants: ["m-ac-3-1"] });
    // Kane's new set replaces the old one: no retired test is run or kept on any criterion
    const design = ev[9] as Extract<LedgerEvent, { t: "design" }>;
    expect(design).toMatchObject({ useCase: "uc-1", acs: [AC1, AC3], credits: 0 });
    expect(design.tests.map((t) => t.id)).toEqual(["t-4"]);
    const sealEv = ev[10] as Extract<LedgerEvent, { t: "seal" }>;
    expect(sealEv.by).toBe("kane");
    expect(Object.keys(sealEv.manifest)).toContain(".testmuai/tests/t4_test.md");
    expect(sealEv.manifest["app:PRD.md"]).toBe(sealedBefore.manifest["app:PRD.md"]);
    expect(await checkSeal(p.verifierDir, sealEv.manifest, appDir)).toEqual([]);

    // every criterion of the use case was owed again; the closing replay ran the new tests against the real build
    const all = await readEvents(p.ledgerFile);
    const beforeReplay = reduce(all.slice(0, since + 12));
    expect(beforeReplay.acs["ac-1"]).toMatchObject({ status: "owed", tests: ["t-4"] });
    expect(beforeReplay.acs["ac-3"]).toMatchObject({ status: "owed", tests: ["t-4"] });
    expect(calls.tests.filter((t) => !t.opts.noHeal).map((t) => t.files)).toEqual([[testFile("t-4")]]);
    expect(reduce(all).acs["ac-3"]!.status).toBe("passing");
    // the kill's two failed replays (Kane bills its verdict on a failure) and the evolve
    expect(reduce(all).credits - reduce(all.slice(0, since)).credits).toBeCloseTo(2 * 4.7 + 11.39, 9);
  });

  it("logs Kane's balance drop for each mutant's batch, the evolve (before its seal) and the closing replay, counting the evolve once (R34, R40)", async () => {
    await setup();
    const since = (await readEvents(p.ledgerFile)).length;
    let bal = 1000;
    const { deps, io } = fakes({ mutantRun: survives3 });
    const tests = deps.tests;
    deps.tests = async (...a) => ((bal -= 6), tests(...a));
    const evolveOnce = deps.kane.evolve;
    deps.kane = { ...deps.kane, evolve: async (...a) => ((bal -= 12), evolveOnce(...a)) };
    deps.balance = async () => bal;
    await runFalsify(p, deps, io, log);
    const all = await readEvents(p.ledgerFile);
    const ev = all.slice(since);
    expect(tags(ev).filter((t) => ["credits", "falsify.evolved", "design", "seal"].includes(t) || t.startsWith("mutant"))).toEqual([
      "mutant:ac-1:killed",
      "credits",
      "mutant:ac-3:survived",
      "credits",
      "credits",
      "falsify.evolved",
      "design",
      "seal",
      "credits",
    ]);
    expect(ev.filter((e) => e.t === "credits").map((e) => e.t === "credits" && [e.source, e.delta, e.perRunSum])).toEqual([
      ["falsify", 12, 9.4], // the kill's replay and its second replay, one batch
      ["falsify", 6, 0],
      ["evolve", 12, 11.39],
      ["falsify", 6, 0],
    ]);
    // by the balance: 12 + 6 + 12 + 6, the evolve's own figure never added on top
    expect(reduce(all).kaneCredits - reduce(all.slice(0, since)).kaneCredits).toBeCloseTo(36, 9);
  });

  it("a survivor's test that proved nothing twice in the closing replay is re-checked by the next build loop, and the gate can open", async () => {
    await setup();
    const timeout = (file: string): TestRunResult => ({ ...pass(file), status: "error", reason: "timeout" });
    const { deps, io } = fakes({
      mutantRun: survives3,
      evolve: () => ({ status: "nothing", note: "nothing to change", credits: 5 }), // ac-3 stays vacuous
      replay: (files) => files.map((f) => (idOf(f) === "t-3" ? timeout(f) : pass(f))),
    });
    await runFalsify(p, deps, io, log);
    let state = reduce(await readEvents(p.ledgerFile));
    expect(state.acs["ac-3"]!.status).toBe("vacuous");
    expect(gate(state)).toMatchObject({ allowStop: false, owed: [], regressed: [], inconclusive: [{ test: "t-3", reason: "timeout" }] });

    // the next `holdback run`: Kane re-checks t-3 first; the agent is never called
    const ran: string[][] = [];
    const r = await runBuildLoop(
      p,
      {
        guardCommand: "node guard.js",
        claude: async () => {
          throw new Error("no agent turn expected");
        },
        app: async (o) => ({ url: `http://127.0.0.1:${o.port}`, logs: () => "", stop: async () => {} }),
        tests: async (_cwd, files) => (ran.push([...files]), files.map(pass)),
      },
      log,
    );
    expect(r).toEqual({ allowStop: true, turns: 0, reason: "gate-open" });
    expect(ran).toEqual([[T3]]);
    state = reduce(await readEvents(p.ledgerFile));
    expect(state.acs["ac-3"]!.status).toBe("vacuous");
    expect(gate(state).inconclusive).toEqual([]);
  });

  it("runs the live capture through Holdback's own evolve runner: Kane 0.10.4 retired every old test of the use case (R40)", async () => {
    await setup();
    const seq = join(root, "seq.txt");
    writeFileSync(seq, [join(fxKane, "14-evolve-paused.ndjson"), join(fxKane, "15-evolve-complete.ndjson")].join("\n"));
    const argvLog = join(root, "argv.log");
    for (const [k, v] of Object.entries({ HOLDBACK_KANE_BIN: join(here, "fake-kane.mjs"), FAKE_KANE_SEQUENCE: seq, FAKE_KANE_ARGV_LOG: argvLog })) process.env[k] = v;
    const { deps, io, kit } = fakes({ mutantRun: survives3 });
    deps.kane.evolve = async (cwd, uc, because) => {
      kit.mint("t-4", ["ac-1", "ac-3"]);
      kit.retire("t-1", "t-3");
      return kaneEvolve(cwd, uc, because);
    };
    const r = await runFalsify(p, deps, io, log);
    expect(r.redesigned).toEqual(["uc-1"]);
    const argv = readFileSync(argvLog, "utf8").trim().split("\n").map((l) => JSON.parse(l) as string[]);
    expect(argv.map((a) => a.slice(0, 3).join(" "))).toEqual(["maintain evolve uc-1", "maintain evolve uc-1"]);
    expect(argv[1]!.slice(-2)).toEqual(["--answer", "evolve:uc-1=1"]);
    expect((await readEvents(p.ledgerFile)).find((e) => e.t === "falsify.evolved")).toMatchObject({ minted: ["t-4"], retired: ["t-1", "t-2", "t-3"], credits: 11.39 });
  });

  it("the next pass re-checks the survivor's own planted bug against the new tests first, with no breaker call: killed proves it (R40)", async () => {
    await setup({ before: evolvedEarlier });
    const since = (await readEvents(p.ledgerFile)).length;
    const { deps, io, calls } = fakes({ mutantRun: (ac, files) => files.map(failOn(ac)) });
    const r = await runFalsify(p, deps, io, log);
    expect(r).toMatchObject({ killed: ["ac-1", "ac-3"], survived: [], vacuous: [], redesigned: [], reason: "done" });
    expect(calls.chat.map((c) => c.ac)).toEqual(["ac-1"]); // ac-3's bug is the one that slipped through before
    expect(calls.mutantSrc[2]!.src).toContain("LIMITS[size] + 1");
    expect(calls.tests.filter((t) => t.opts.noHeal).map((t) => [t.ac, t.files])).toEqual([
      ["ac-1", [testFile("t-4")]],
      ["ac-1", [testFile("t-4")]],
      ["ac-3", [testFile("t-4")]],
      ["ac-3", [testFile("t-4")]],
    ]);
    const m = (await after(since)).find((e) => e.t === "mutant" && e.ac === "ac-3");
    expect(m).toMatchObject({ recheck: "m-ac-3-1", patch: PATCH["ac-3"], usd: 0, verdict: "killed", slip: SLIP["ac-3"] });
    expect(calls.evolve).toEqual([]);
    expect(reduce(await readEvents(p.ledgerFile)).acs["ac-3"]!.status).toBe("proved");
  });

  it("a re-checked survivor that gets past the new tests too stays vacuous, with the reason, and never goes back to Kane (R40)", async () => {
    await setup({ before: evolvedEarlier });
    const { deps, io, calls } = fakes({ mutantRun: survives3 });
    const r = await runFalsify(p, deps, io, log);
    expect(r).toMatchObject({ killed: ["ac-1"], survived: ["ac-3"], vacuous: ["ac-3"], redesigned: [], reason: "done" });
    expect(calls.evolve).toEqual([]);
    expect(reduce(await readEvents(p.ledgerFile)).acs["ac-3"]).toMatchObject({ status: "vacuous", reason: expect.stringMatching(/got past the new tests too/) });
  });

  it("when the code moved under the survivor's patch, the breaker plants the same bug in the code as it is now, once (R40)", async () => {
    await setup({ before: evolvedEarlier });
    writeFileSync(join(appDir, "src", "eligibility.js"), SRC.replace(': "Not eligible."', ': "Not eligible!"'));
    git(appDir, "commit", "-q", "-am", "turn 2");
    const moved = PATCH["ac-3"]!.replaceAll('"Not eligible."', '"Not eligible!"');
    const { deps, io, calls } = fakes({ mutantRun: (ac, files) => files.map(failOn(ac)), patch: (ac) => PATCH[ac]!.replaceAll('"Not eligible."', '"Not eligible!"') });
    const r = await runFalsify(p, deps, io, log);
    expect(r).toMatchObject({ killed: ["ac-1", "ac-3"], reason: "done" });
    expect(calls.chat.map((c) => c.ac)).toEqual(["ac-1", "ac-3"]);
    const asked = calls.chat[1]!.o.messages.map((x) => x.content).join("\n");
    expect(asked).toContain("plant the same bug in the code as it is now");
    expect(asked).toContain("LIMITS[size] + 1"); // the survivor's own patch
    const m = (await readEvents(p.ledgerFile)).findLast((e) => e.t === "mutant" && e.ac === "ac-3");
    expect(m).toMatchObject({ recheck: "m-ac-3-1", patch: moved, verdict: "killed", usd: expect.closeTo(USD_PER_CALL, 12) });
  });

  it("an evolve that adds no test leaves the survivor vacuous with a plain-words reason; the verifier is rolled back and Kane's credits count (R40)", async () => {
    await setup();
    const since = (await readEvents(p.ledgerFile)).length;
    const { deps, io, calls } = fakes({ mutantRun: survives3, evolve: () => ({ status: "nothing", note: "I found no requested change to apply.", credits: 5.69 }) });
    const r = await runFalsify(p, deps, io, log);
    expect(r).toMatchObject({ killed: ["ac-1"], survived: ["ac-3"], redesigned: [], vacuous: ["ac-3"], reason: "done" });
    expect(r.redesignError).toMatch(/Kane added no test to uc-1: I found no requested change/);
    expect(calls.evolve).toHaveLength(1); // never retried blindly
    const all = await readEvents(p.ledgerFile);
    expect(tags(all.slice(since))).toEqual([
      "recordings",
      "mutant:ac-1:killed",
      "run:falsify:t-1:failed",
      "run:falsify:t-1:failed",
      "recordings",
      "mutant:ac-3:survived",
      "run:falsify:t-3:passed",
      "recordings",
      "recordings", // anchored right after the rollback
      "redesign.dropped",
      "run:replay:t-1:passed",
      "run:replay:t-3:passed",
      "recordings",
    ]);
    expect(all.find((e) => e.t === "redesign.dropped")).toMatchObject({ useCases: ["uc-1"], credits: 5.69, acs: ["ac-3"], reason: "Kane could not add a test that catches this planted bug" });
    expect(reduce(all).acs["ac-3"]).toMatchObject({ status: "vacuous", reason: "Kane could not add a test that catches this planted bug" });
    expect(reduce(all).credits - reduce(all.slice(0, since)).credits).toBeCloseTo(2 * 4.7 + 5.69, 9);
    const sealEv = all.filter((e) => e.t === "seal").pop() as Extract<LedgerEvent, { t: "seal" }>;
    expect(await checkSeal(p.verifierDir, sealEv.manifest, appDir)).toEqual([]);
    expect((await checkRecordingsAnchor(p, all)).moved).toEqual([]);
  });

  /** Kane's own graph store in the verifier, file by file (hex), and its folders. */
  const kaneStore = (): Record<string, string> => {
    const out: Record<string, string> = {};
    const walk = (dir: string, rel: string) => {
      for (const ent of readdirSync(dir, { withFileTypes: true })) {
        const r = `${rel}/${ent.name}`;
        if (ent.isDirectory()) {
          out[`${r}/`] = "dir";
          walk(join(dir, ent.name), r);
        } else out[r] = readFileSync(join(dir, ent.name)).toString("hex");
      }
    };
    walk(join(p.verifierDir, ".context"), ".context");
    return out;
  };
  /** A store like Kane's (generation 7), and an evolve that moves it on (generation 8) before Holdback rolls it back. */
  const seedStore = async () => {
    mkdirSync(join(p.verifierDir, ".context", "commits"), { recursive: true });
    writeFileSync(join(p.verifierDir, ".context", "commits", "000007-81ca27a3f5b2.json"), '{"generation":7}');
    writeFileSync(join(p.verifierDir, ".context", "store.json"), '{"generation":7,"live":["t-1","t-3"]}');
  };
  const moveStore = () => {
    writeFileSync(join(p.verifierDir, ".context", "store.json"), '{"generation":8,"live":["t-4"]}');
    mkdirSync(join(p.verifierDir, ".context", "derived", "nodes"), { recursive: true });
    writeFileSync(join(p.verifierDir, ".context", "commits", "000008-4a3f438914a8.json"), '{"generation":8}');
    writeFileSync(join(p.verifierDir, ".context", "derived", "nodes", "t-4.json"), "{}");
    rmSync(join(p.verifierDir, ".context", "commits", "000007-81ca27a3f5b2.json"));
  };

  it.each([
    ["adds no test", { evolve: (_n: number, kit: EvolveKit) => (moveStore(), kit.mint("t-4", ["ac-3"]), { status: "nothing" as const, note: "nothing", credits: 5 }) }, "done"],
    ["strays", { onEvolve: () => (moveStore(), writeFileSync(join(p.verifierDir, ".testmuai", "tests", "extra_test.md"), "x")) }, "tamper"],
    ["races a spec edit", { onEvolve: () => (moveStore(), writeFileSync(join(appDir, "PRD.md"), "# Food pantry\n\nEdited meanwhile.\n")) }, "drift"],
  ])("an evolve that %s is rolled back with Kane's own graph store: its bytes are the snapshot's again (I-3)", async (_name, plan, reason) => {
    await setup({ before: seedStore });
    const store = kaneStore();
    const { deps, io } = fakes({ mutantRun: survives3, ...(plan as Partial<Plan>) });
    const r = await runFalsify(p, deps, io, log);
    expect(r.reason).toBe(reason);
    expect(existsSync(testFile("t-4"))).toBe(false);
    expect(kaneStore()).toEqual(store);
  });

  /** Runs a pass where ac-1 is killed and ac-3 survives, and expects Kane's evolve to be rolled back. */
  async function rolledBack(plan: Partial<Plan>, why: RegExp) {
    await setup();
    const t1 = readFileSync(T1);
    const { deps, io, calls } = fakes({ mutantRun: survives3, ...plan });
    const r = await runFalsify(p, deps, io, log);
    expect(r).toMatchObject({ killed: ["ac-1"], survived: ["ac-3"], redesigned: [], vacuous: ["ac-3"], reason: "done" });
    expect(r.redesignError).toMatch(why);
    const all = await readEvents(p.ledgerFile);
    expect(all.some((e) => e.t === "falsify.evolved" || (e.t === "design" && e.at !== at))).toBe(false);
    expect(all.find((e) => e.t === "redesign.dropped")).toMatchObject({ useCases: ["uc-1"], detail: expect.stringMatching(why), acs: ["ac-3"] });
    expect(existsSync(testFile("t-4"))).toBe(false);
    expect(readFileSync(T1).equals(t1)).toBe(true);
    const sealEv = all.filter((e) => e.t === "seal").pop() as Extract<LedgerEvent, { t: "seal" }>;
    expect(await checkSeal(p.verifierDir, sealEv.manifest, appDir)).toEqual([]);
    expect(reduce(all).acs["ac-3"]!.status).toBe("vacuous");
    // the pass still ends with the replay of the sealed tests against the real build
    expect(calls.tests.filter((t) => !t.opts.noHeal).map((t) => t.files)).toEqual([[T1, T3]]);
    return { r, calls };
  }

  it("lets Kane's evolve change or remove the tests of the use case it retired: only its minted tests are sealed as live", async () => {
    await setup();
    const { deps, io } = fakes({
      mutantRun: survives3,
      onEvolve: () => {
        appendFileSync(T1, "\nsuperseded\n");
        rmSync(T3);
      },
    });
    const r = await runFalsify(p, deps, io, log);
    expect(r).toMatchObject({ redesigned: ["uc-1"], reason: "done" });
    const sealEv = (await readEvents(p.ledgerFile)).findLast((e) => e.t === "seal") as Extract<LedgerEvent, { t: "seal" }>;
    expect(sealEv.by).toBe("kane");
    expect(await checkSeal(p.verifierDir, sealEv.manifest, appDir)).toEqual([]);
  });

  /** Kane's evolve touches a sealed verifier entry outside what it may: a tamper, never sealed. */
  async function strayed(plan: Partial<Plan>, paths: string[], before?: () => Promise<void>) {
    await setup(before ? { before } : {});
    const sealsBefore = (await readEvents(p.ledgerFile)).filter((e) => e.t === "seal").length;
    const { deps, io } = fakes({ mutantRun: survives3, ...plan });
    const r = await runFalsify(p, deps, io, log);
    expect(r.reason).toBe("tamper");
    const all = await readEvents(p.ledgerFile);
    expect(all.find((e) => e.t === "falsify.evolve.stray")).toMatchObject({ uc: "uc-1", paths, credits: 11.39 });
    expect(all.filter((e) => e.t === "seal")).toHaveLength(sealsBefore);
    expect(all.some((e) => e.t === "falsify.evolved")).toBe(false);
    const state = reduce(all);
    expect(state.tampered).toBe(true);
    expect(state.acs["ac-3"]!.status).toBe("vacuous");
    expect(await tamperMarker(p)).toContain(paths[0]!);
    // rolled back: nothing of Kane's evolve is left unsealed on disk
    expect(existsSync(testFile("t-4"))).toBe(false);
    const sealEv = all.findLast((e) => e.t === "seal") as Extract<LedgerEvent, { t: "seal" }>;
    expect(await checkSeal(p.verifierDir, sealEv.manifest, appDir)).toEqual([]);
  }
  const T9 = () => join(p.verifierDir, ".testmuai", "tests", "t9_test.md");
  /** Another use case, uc-2, with a sealed test t-9 in `file` (default t9_test.md). */
  const otherUseCase = (file?: () => string) => async () => {
    const f = file ?? T9;
    if (!existsSync(f())) writeFileSync(f(), "---\nassurance:\n  id: t-9\n---\n# t-9\n");
    await log({ at, t: "design", useCase: "uc-2", acs: [AC9], tests: [{ id: "t-9", title: "nine", file: f(), verifies: ["ac-9"] }], gaps: [], credits: 0 });
    await log({ at, t: "seal", manifest: await seal(p.verifierDir, { appDir, files: appSealFiles(p) }) });
  };

  it("a variables file Kane's evolve changed is a tamper: nothing sealed", async () => {
    await strayed({ onEvolve: () => writeFileSync(join(p.verifierDir, ".testmuai", "variables", "assurance.json"), JSON.stringify({ start_url: { value: "http://evil.example/" } })) }, [".testmuai/variables/assurance.json"]);
  });

  it("another use case's test Kane's evolve removed is a tamper: nothing sealed", async () => {
    await strayed({ onEvolve: () => rmSync(T9()) }, [".testmuai/tests/t9_test.md"], otherUseCase());
  });

  it("an extra test file Kane's evolve wrote but did not mint is a tamper: nothing sealed", async () => {
    await strayed({ onEvolve: () => writeFileSync(join(p.verifierDir, ".testmuai", "tests", "extra_test.md"), "---\nassurance:\n  id: t-77\n---\n# extra\n") }, [".testmuai/tests/extra_test.md"]);
  });

  describe("what Kane's evolve may touch: its minted tests and the tests of the use case it retired, nothing else", () => {
    /** The default evolve: t-4 minted for uc-1, t-1 and t-3 reported superseded. */
    const evolveWith = (shape: (kit: EvolveKit) => void) => ({ evolve: (_n: number, kit: EvolveKit) => (shape(kit), EVOLVED) });

    it("a retired test Kane still keeps live (it still verifies criteria) may not change", async () => {
      await strayed(
        {
          ...evolveWith((kit) => {
            kit.mint("t-4", ["ac-1", "ac-3"]);
            kit.retire("t-3"); // t-1 stays live, though reported superseded
            appendFileSync(T1, "\nchanged\n");
          }),
        },
        [".testmuai/tests/t1_test.md"],
      );
    });

    it("a retired test's file that a live test still points at may not change", async () => {
      await strayed(
        {
          ...evolveWith((kit) => {
            kit.mint("t-4", ["ac-1", "ac-3"]);
            kit.retire("t-1", "t-3");
            kit.alias("t-8", T1, ["ac-1"]);
            appendFileSync(T1, "\nchanged\n");
          }),
        },
        [".testmuai/tests/t1_test.md"],
      );
    });

    it("a retired test's file that another sealed test shares may not change", async () => {
      await strayed(
        {
          ...evolveWith((kit) => {
            kit.mint("t-4", ["ac-1", "ac-3"]);
            kit.retire("t-1", "t-3");
            rmSync(T3);
          }),
        },
        [".testmuai/tests/t3_test.md"],
        otherUseCase(() => T3),
      );
    });

    it("a retired test that also verified another use case's criterion may not change", async () => {
      await strayed(
        {
          ...evolveWith((kit) => {
            kit.mint("t-4", ["ac-1", "ac-3"]);
            kit.retire("t-1", "t-3");
            rmSync(T3);
          }),
        },
        [".testmuai/tests/t3_test.md"],
        async () => {
          // uc-1 as designed: t-3 also verified uc-2's ac-9
          const tests = [testNodes()[0]!, { ...testNodes()[1]!, verifies: ["ac-3", "ac-9"] }];
          await log({ at, t: "design", useCase: "uc-1", acs: [AC1, AC3], tests, gaps: [], credits: 0 });
          await log({ at, t: "seal", manifest: await seal(p.verifierDir, { appDir, files: appSealFiles(p) }) });
          await greenTurn(2);
        },
      );
    });

    it("a minted test may not overwrite a sealed file: another use case's test", async () => {
      await strayed(
        {
          ...evolveWith((kit) => {
            kit.mint("t-4", ["ac-1", "ac-3"], T9());
            kit.retire("t-1", "t-3");
          }),
        },
        [".testmuai/tests/t9_test.md"],
        otherUseCase(),
      );
    });

    it("a minted test may verify criteria of this use case only", async () => {
      await strayed(
        {
          ...evolveWith((kit) => {
            kit.mint("t-4", ["ac-1", "ac-3", "ac-9"]);
            kit.retire("t-1", "t-3");
          }),
        },
        [".testmuai/tests/t4_test.md"],
      );
    });

    it("a graph that lists one test id twice is a tamper", async () => {
      await strayed(
        {
          ...evolveWith((kit) => {
            kit.mint("t-4", ["ac-1", "ac-3"]);
            kit.retire("t-1", "t-3");
            kit.alias("t-4", testFile("t-4"), ["ac-1"]);
          }),
        },
        [".testmuai/tests/t4_test.md"],
      );
    });

    it("a graph in which two tests share one file is a tamper", async () => {
      await strayed(
        {
          ...evolveWith((kit) => {
            kit.mint("t-4", ["ac-1", "ac-3"]);
            kit.retire("t-1", "t-3");
            kit.alias("t-6", testFile("t-4"), ["ac-3"]);
          }),
        },
        [".testmuai/tests/t4_test.md"],
      );
    });

    it.runIf(process.platform === "win32" || process.platform === "darwin")("a minted test whose path collides with a sealed one but for its case is a tamper (case folds only to catch a collision)", async () => {
      await strayed(
        {
          ...evolveWith((kit) => {
            kit.mint("t-4", ["ac-1", "ac-3"], T9().replace("t9_test.md", "T9_TEST.md"));
            kit.retire("t-1", "t-3");
          }),
        },
        [".testmuai/tests/T9_TEST.md", ".testmuai/tests/t9_test.md"],
        otherUseCase(),
      );
    });

    it("a changed path that differs from an allowed file only by its case is a tamper: the allowlist takes exact paths", async () => {
      const upper = () => testFile("t-4").replace("t4_test.md", "T4_TEST.md");
      const insensitive = process.platform === "win32" || process.platform === "darwin";
      await strayed(
        {
          ...evolveWith((kit) => {
            // Kane wrote t4_test.md; its graph names the minted test T4_TEST.md
            kit.mint("t-4", ["ac-1", "ac-3"]);
            kit.retire("t-1", "t-3", "t-4");
            kit.alias("t-4", upper(), ["ac-1", "ac-3"]);
          }),
        },
        // where the file system tells the two names apart, the graph's file does not exist at all
        insensitive ? [".testmuai/tests/t4_test.md"] : [".testmuai/tests/T4_TEST.md", ".testmuai/tests/t4_test.md"],
      );
    });

    it("a minted test outside the tests folder is a tamper", async () => {
      await strayed(
        {
          ...evolveWith((kit) => {
            kit.mint("t-4", ["ac-1", "ac-3"], join(p.verifierDir, ".testmuai", "variables", "t4_test.md"));
            kit.retire("t-1", "t-3");
          }),
        },
        [".testmuai/variables/t4_test.md"],
      );
    });

    it("a minted test outside the verifier is a tamper", async () => {
      await strayed(
        {
          ...evolveWith((kit) => {
            kit.mint("t-4", ["ac-1", "ac-3"], join(p.verifierDir, "..", "t4_test.md"));
            kit.retire("t-1", "t-3");
          }),
        },
        ["../t4_test.md"],
      );
    });

    it("a minted test that is a link, not a file, is a tamper", async () => {
      await strayed(
        {
          ...evolveWith((kit) => {
            kit.mint("t-4", ["ac-1", "ac-3"]);
            kit.retire("t-1", "t-3");
            rmSync(testFile("t-4"));
            const target = mkdtempSync(join(root, "linked-"));
            symlinkSync(target, testFile("t-4"), "junction");
          }),
        },
        [".testmuai/tests/t4_test.md"],
      );
    });

    it("a minted test may verify only criteria the ledger has under this use case: Kane's graph cannot move another use case's criterion in", async () => {
      await strayed(
        {
          ...evolveWith((kit) => {
            kit.placeAc({ ...AC9, useCase: "uc-1" });
            kit.mint("t-4", ["ac-1", "ac-3", "ac-9"]);
            kit.retire("t-1", "t-3");
          }),
        },
        [".testmuai/tests/t4_test.md"],
        otherUseCase(),
      );
    });

    it("a minted test may verify a criterion Kane newly adds under this use case", async () => {
      await setup();
      const AC12: AcNode = { ...AC1, id: "ac-12", text: "A household of 9 uses the $9,467 limit." };
      const { deps, io } = fakes({
        mutantRun: survives3,
        ...evolveWith((kit) => {
          kit.placeAc(AC12);
          kit.mint("t-4", ["ac-1", "ac-3", "ac-12"]);
          kit.retire("t-1", "t-3");
        }),
      });
      const r = await runFalsify(p, deps, io, log);
      expect(r).toMatchObject({ redesigned: ["uc-1"], reason: "done" });
      expect(reduce(await readEvents(p.ledgerFile)).acs["ac-12"]).toMatchObject({ useCase: "uc-1", tests: ["t-4"] });
    });

    describe("a minted test at a retired test's path (I-5)", () => {
      it("is allowed when the old test is retired and gone from the graph, the path is the new test's alone, it verifies this use case only, and no other sealed test maps to it", async () => {
        await setup();
        const { deps, io } = fakes({
          mutantRun: survives3,
          ...evolveWith((kit) => {
            kit.retire("t-1", "t-3");
            kit.mint("t-4", ["ac-1", "ac-3"], T3); // Kane named the new test as the old one
          }),
        });
        const r = await runFalsify(p, deps, io, log);
        expect(r).toMatchObject({ redesigned: ["uc-1"], reason: "done" });
        const all = await readEvents(p.ledgerFile);
        const design = all.findLast((e) => e.t === "design") as Extract<LedgerEvent, { t: "design" }>;
        expect(design.tests.map((t) => [t.id, t.file])).toEqual([["t-4", T3]]);
        const sealEv = all.findLast((e) => e.t === "seal") as Extract<LedgerEvent, { t: "seal" }>;
        expect(sealEv.by).toBe("kane");
        expect(await checkSeal(p.verifierDir, sealEv.manifest, appDir)).toEqual([]);
        expect(readFileSync(T3, "utf8")).toContain("id: t-4");
      });

      it("is a tamper when Kane did not report the old test retired", async () => {
        await strayed(
          {
            evolve: (_n: number, kit: EvolveKit) => {
              kit.retire("t-1", "t-3");
              kit.mint("t-4", ["ac-1", "ac-3"], T3);
              return { ...EVOLVED, superseded: [{ scenario: "sc-1", test: "t-1" }] };
            },
          },
          [".testmuai/tests/t3_test.md"],
        );
      });

      it("is a tamper when the old test is still in the graph", async () => {
        await strayed(
          {
            ...evolveWith((kit) => {
              kit.retire("t-1", "t-3");
              kit.mint("t-4", ["ac-1", "ac-3"], T3);
              kit.alias("t-3", T1, []); // still listed, now under another file
            }),
          },
          [".testmuai/tests/t3_test.md"],
        );
      });

      it("is a tamper when two minted tests claim the path", async () => {
        await strayed(
          {
            evolve: (_n: number, kit: EvolveKit) => {
              kit.retire("t-1", "t-3");
              kit.mint("t-4", ["ac-1"], T3);
              kit.alias("t-5", T3, ["ac-3"]);
              return { ...EVOLVED, minted: [...EVOLVED.minted, { scenario: "sc-5", test: "t-5" }] };
            },
          },
          [".testmuai/tests/t3_test.md"],
        );
      });

      it("is a tamper when the new test verifies another use case's criterion", async () => {
        await strayed(
          {
            ...evolveWith((kit) => {
              kit.retire("t-1", "t-3");
              kit.mint("t-4", ["ac-1", "ac-3", "ac-9"], T3);
            }),
          },
          [".testmuai/tests/t3_test.md"],
          otherUseCase(),
        );
      });

      it("is a tamper when another sealed test maps to the path", async () => {
        await strayed(
          {
            ...evolveWith((kit) => {
              kit.retire("t-1", "t-3");
              kit.mint("t-4", ["ac-1", "ac-3"], T3);
            }),
          },
          [".testmuai/tests/t3_test.md"],
          otherUseCase(() => T3),
        );
      });
    });
  });

  it("rolls Kane's evolve back when it reports a minted test the verifier has no file of", async () => {
    await rolledBack({ evolve: () => EVOLVED }, /minted t-4 but no test file of it/);
  });

  it("rolls Kane's evolve back when Kane fails during it", async () => {
    await rolledBack(
      {
        evolve: (_n, kit) => {
          kit.mint("t-4", ["ac-3"]);
          throw new Error("kane-cli exited with code 3");
        },
      },
      /Kane failed during the evolve of uc-1: kane-cli exited with code 3/,
    );
  });

  it("a criterion the evolve left without a test gets one bounded follow-up evolve; still uncovered, it needs the spec, with the reason (R40)", async () => {
    await setup();
    const { deps, io, calls } = fakes({
      mutantRun: survives3,
      evolve: (n, kit) => {
        if (n > 0) return { status: "nothing", note: "nothing to change", credits: 4 };
        kit.mint("t-4", ["ac-3"]);
        kit.retire("t-1", "t-3");
        return EVOLVED;
      },
    });
    const r = await runFalsify(p, deps, io, log);
    expect(r.redesigned).toEqual(["uc-1"]);
    expect(calls.evolve).toHaveLength(2);
    expect(calls.evolve[1]!.because.startsWith(`cover ac-1 ("${AC1.text}") again`)).toBe(true);
    const all = await readEvents(p.ledgerFile);
    expect(all.find((e) => e.t === "redesign.dropped")).toMatchObject({ useCases: ["uc-1"], credits: 4, detail: expect.stringMatching(/^follow-up evolve of uc-1/) });
    const design = all.findLast((e) => e.t === "design") as Extract<LedgerEvent, { t: "design" }>;
    expect(design.notes).toEqual({ "ac-1": "Kane's evolved tests no longer cover it; a follow-up evolve did not cover it either" });
    const s = reduce(all);
    expect(s.acs["ac-1"]).toMatchObject({ status: "needs-spec", tests: [], reason: expect.stringMatching(/no longer cover it/) });
    expect(s.acs["ac-3"]).toMatchObject({ status: "passing", tests: ["t-4"] });
    // m-7: the timeline reads evolved, then the follow-up rolled back
    const tl = all.map((e) => e.t);
    expect(tl.indexOf("falsify.evolved")).toBeLessThan(tl.indexOf("redesign.dropped"));
  });

  it("a follow-up cover evolve does not count toward the run's bound: after one evolve and its follow-up, a later survivor is still evolved (R44)", async () => {
    await setup();
    const { deps, io, calls } = fakes({
      mutantRun: survives3,
      evolve: (n, kit) => {
        // the first evolve loses ac-1; the follow-up covers it again
        if (n === 0) kit.mint("t-4", ["ac-3"]);
        else kit.mint("t-5", ["ac-1"]);
        kit.retire("t-1", "t-3");
        return n === 0 ? EVOLVED : { ...EVOLVED, minted: [{ scenario: "sc-5", test: "t-5" }], superseded: [], credits: 5 };
      },
    });
    // one survivor-triggered evolve of uc-1 already happened in this run, followed by its cover evolve
    const evolves = new Map([["uc-1", 1]]);
    const r = await runFalsify(p, deps, io, log, { evolves });
    expect(r.redesigned).toEqual(["uc-1"]);
    expect(calls.evolve).toHaveLength(2); // the evolve and its follow-up both ran
    expect(evolves.get("uc-1")).toBe(2); // only the survivor's evolve counted
    expect(r.evolved?.map((e) => e.followUp === true)).toEqual([false, true]);
  });

  it("names every survivor of the pass, with the slip in plain words, and why one was not sent to Kane (R44)", async () => {
    await setup();
    const { deps, io } = fakes({ mutantRun: survives3 });
    const r = await runFalsify(p, deps, io, log, { evolves: new Map([["uc-1", 2]]) });
    expect(r.survivors).toEqual([{ ac: "ac-3", mutant: "m-ac-3-1", slip: SLIP["ac-3"]!.behaviour }]);
    expect(r.notEvolved).toEqual([{ uc: "uc-1", acs: ["ac-3"], why: "Kane already evolved this use case twice in this run: the next `holdback run` tries again" }]);
  });

  it("names a survivor the breaker did not describe by its rationale", async () => {
    await setup();
    const { deps, io } = fakes({ mutantRun: survives3, noSlip: true });
    const r = await runFalsify(p, deps, io, log, { evolves: new Map([["uc-1", 2]]) });
    expect(r.survivors).toEqual([{ ac: "ac-3", mutant: "m-ac-3-1", slip: "breaks ac-3" }]);
  });

  it("a credit cap reached at a later use case's evolve keeps the earlier use case's evolve; the later survivors stay vacuous with that reason (m-1)", async () => {
    await setup({
      before: async () => {
        await otherUseCase()();
        await log({ at, t: "run", kind: "build", turn: 1, result: pass(T9()) });
      },
    });
    const { deps, io, calls } = fakes({ mutantRun: (ac, files) => files.map(ac === "ac-1" ? failOn("ac-1") : pass), patch: (ac) => PATCH[ac] ?? PATCH["ac-3"]! });
    // three attacks, then uc-1's evolve shows a drop of 100 credits on the balance: uc-2's evolve meets the cap
    let reads = 0;
    deps.balance = async () => (++reads <= 7 ? 1000 : 900);
    const r = await runFalsify(p, deps, io, log, { kaneCap: 60 });
    expect(r).toMatchObject({ reason: "kane-budget", redesigned: ["uc-1"] });
    expect(r.vacuous).toContain("ac-9");
    expect(calls.evolve.map((c) => c.uc)).toEqual(["uc-1"]);
    const all = await readEvents(p.ledgerFile);
    expect(all.filter((e) => e.t === "falsify.evolved").map((e) => e.t === "falsify.evolved" && e.uc)).toEqual(["uc-1"]);
    expect(all.findLast((e) => e.t === "seal")).toMatchObject({ by: "kane" });
    expect(existsSync(testFile("t-4"))).toBe(true);
    expect(reduce(all).acs["ac-9"]).toMatchObject({ status: "vacuous", reason: expect.stringMatching(/credit cap/) });
  });

  describe("a survivor not evolved in its own pass (m-2)", () => {
    const survivedEarlier = async () => {
      await log({ at, t: "mutant", id: "m-ac-3-1", ac: "ac-3", patch: PATCH["ac-3"]!, model: MODEL, usd: 0.0003, verdict: "survived", slip: SLIP["ac-3"] });
    };

    it("goes to Kane in the next pass, without being attacked again", async () => {
      await setup({ before: survivedEarlier }); // that pass stopped (aborted) before the evolve
      const { deps, io, calls } = fakes({ mutantRun: (ac, files) => files.map(failOn(ac)) });
      const r = await runFalsify(p, deps, io, log);
      expect(r).toMatchObject({ killed: ["ac-1"], redesigned: ["uc-1"], reason: "done" });
      expect(calls.chat.map((c) => c.ac)).toEqual(["ac-1"]);
      expect(calls.evolve).toHaveLength(1);
      expect(calls.evolve[0]!.because).toContain(SLIP["ac-3"]!.observed);
      const ev = (await readEvents(p.ledgerFile)).find((e) => e.t === "falsify.evolved");
      expect(ev).toMatchObject({ uc: "uc-1", mutants: ["m-ac-3-1"] });
    });

    it("waits out the run's bound, and the cap, but never goes back once Kane could not add a test for it", async () => {
      for (const [reason, again] of [
        ["Kane already evolved this use case twice in this run: the next `holdback run` tries again", 1],
        ["the Kane credit cap was reached before Kane could evolve its tests", 1],
        ["Kane could not add a test that catches this planted bug", 0],
      ] as const) {
        await setup({
          before: async () => {
            await survivedEarlier();
            await log({ at, t: "redesign.dropped", useCases: ["uc-1"], detail: "d", credits: 0, acs: ["ac-3"], reason });
          },
        });
        const { deps, io, calls } = fakes({ mutantRun: (ac, files) => files.map(failOn(ac)) });
        await runFalsify(p, deps, io, log);
        expect(calls.evolve, reason).toHaveLength(again);
        rmSync(root, { recursive: true, force: true });
        root = mkdtempSync(join(tmpdir(), "hb-falsify-"));
        process.env.HOLDBACK_HOME = join(root, "home");
      }
    });
  });

  describe("which survivor a criterion is re-checked with (m-3)", () => {
    const m = (id: string, ac: string, extra: Partial<Extract<LedgerEvent, { t: "mutant" }>> = {}): LedgerEvent => ({ at, t: "mutant", id, ac, patch: "p", model: MODEL, usd: 0, verdict: "survived", ...extra });
    const evolved = (mutants: string[]): LedgerEvent => ({ at, t: "falsify.evolved", uc: "uc-1", because: "b", minted: ["t-9"], retired: [], credits: 1, mutants });
    const ac3 = { id: "ac-3", useCase: "uc-1" };

    it("is its own survivor after the evolve that answered it", () => {
      expect(pendingRecheck([m("m-ac-3-1", "ac-3"), evolved(["m-ac-3-1"])], ac3)?.id).toBe("m-ac-3-1");
      // attacked since: nothing pending
      expect(pendingRecheck([m("m-ac-3-1", "ac-3"), evolved(["m-ac-3-1"]), m("m-ac-3-2", "ac-3", { verdict: "killed", recheck: "m-ac-3-1" })], ac3)).toBeUndefined();
    });

    it("stops at a drift the human applied: the old bug may not break the new spec", () => {
      const drift: LedgerEvent = { at, t: "drift", rows: [{ kind: "MODIFY", ref: "uc-1", why: "w" }], applied: true, credits: 1 };
      expect(pendingRecheck([m("m-ac-3-1", "ac-3"), evolved(["m-ac-3-1"]), drift], ac3)).toBeUndefined();
    });

    it("is re-checked again after a later evolve of its use case replaced the tests that caught it", () => {
      const events = [
        m("m-ac-3-1", "ac-3"),
        evolved(["m-ac-3-1"]),
        m("m-ac-3-2", "ac-3", { verdict: "killed", recheck: "m-ac-3-1" }),
        m("m-ac-1-1", "ac-1"),
        evolved(["m-ac-1-1"]),
      ];
      expect(pendingRecheck(events, ac3)?.id).toBe("m-ac-3-1");
      expect(pendingRecheck(events, { id: "ac-1", useCase: "uc-1" })?.id).toBe("m-ac-1-1");
      // another use case's evolve does not touch it
      expect(pendingRecheck([...events.slice(0, 3), { ...(evolved(["m-x"]) as object), uc: "uc-2" } as LedgerEvent], ac3)).toBeUndefined();
    });
  });

  it("a follow-up evolve that covers the criterion again is on record as one, and its set is what gets sealed (R40)", async () => {
    await setup();
    const { deps, io, calls } = fakes({
      mutantRun: survives3,
      evolve: (n, kit) => {
        if (n === 0) {
          kit.mint("t-4", ["ac-3"]);
          kit.retire("t-1", "t-3");
          return EVOLVED;
        }
        kit.mint("t-5", ["ac-1"]);
        return { ...EVOLVED, minted: [{ scenario: "sc-5", test: "t-5" }], superseded: [], credits: 7.33 };
      },
    });
    await runFalsify(p, deps, io, log);
    expect(calls.evolve).toHaveLength(2);
    const all = await readEvents(p.ledgerFile);
    expect(all.filter((e) => e.t === "falsify.evolved")).toMatchObject([
      { minted: ["t-4"], retired: ["t-1", "t-3"], credits: 11.39 },
      { minted: ["t-5"], retired: [], credits: 7.33, followUp: true, mutants: ["m-ac-3-1"] },
    ]);
    const s = reduce(all);
    expect(s.acs["ac-1"]).toMatchObject({ status: "passing", tests: ["t-5"] });
    expect(s.acs["ac-3"]).toMatchObject({ status: "passing", tests: ["t-4"] });
    const sealEv = all.findLast((e) => e.t === "seal") as Extract<LedgerEvent, { t: "seal" }>;
    expect(Object.keys(sealEv.manifest)).toEqual(expect.arrayContaining([".testmuai/tests/t4_test.md", ".testmuai/tests/t5_test.md"]));
  });

  it("a follow-up evolve may retire, and remove, the test the first evolve minted in the same pass (R40)", async () => {
    await setup();
    const { deps, io } = fakes({
      mutantRun: survives3,
      evolve: (n, kit) => {
        if (n === 0) {
          kit.mint("t-4", ["ac-3"]);
          kit.retire("t-1", "t-3");
          return EVOLVED;
        }
        kit.mint("t-5", ["ac-1", "ac-3"]);
        kit.retire("t-4");
        rmSync(testFile("t-4"));
        return { ...EVOLVED, minted: [{ scenario: "sc-5", test: "t-5" }], superseded: [{ scenario: "sc-4", test: "t-4" }], credits: 7.33 };
      },
    });
    const r = await runFalsify(p, deps, io, log);
    expect(r).toMatchObject({ redesigned: ["uc-1"], reason: "done" });
    const s = reduce(await readEvents(p.ledgerFile));
    expect(s.acs["ac-1"]).toMatchObject({ tests: ["t-5"] });
    expect(s.acs["ac-3"]).toMatchObject({ tests: ["t-5"] });
  });

  it("checks the Kane credit cap before an evolve: at the cap, Kane is not called and the pass stops", async () => {
    await setup();
    const { deps, io, calls } = fakes({ mutantRun: (ac, files) => files.map(ac === "ac-3" ? failOn("ac-3") : pass) });
    // the spec stage spent 12 credits; ac-3's caught bug costs 4.7 more
    const r = await runFalsify(p, deps, io, log, { kaneCap: 16 });
    expect(r).toMatchObject({ killed: ["ac-3"], survived: ["ac-1"], reason: "kane-budget" });
    expect(calls.evolve).toEqual([]);
    expect(existsSync(testFile("t-4"))).toBe(false);
  });

  it("a config edited while Kane evolves the tests is never sealed: the evolve is rolled back and the change is a tamper (I-1)", async () => {
    await setup();
    const sealsBefore = (await readEvents(p.ledgerFile)).filter((e) => e.t === "seal").length;
    const { deps, io } = fakes({ mutantRun: survives3, onEvolve: () => writeFileSync(join(appDir, "holdback.config.json"), '{"start":{"cmd":"evil"}}') });
    const r = await runFalsify(p, deps, io, log);
    expect(r.reason).toBe("tamper");
    const all = await readEvents(p.ledgerFile);
    expect(all.filter((e) => e.t === "seal")).toHaveLength(sealsBefore);
    expect(all.some((e) => e.t === "falsify.evolved")).toBe(false);
    expect(all.find((e) => e.t === "redesign.dropped")).toMatchObject({ credits: 11.39, acs: ["ac-3"] });
    expect(reduce(all).tampered).toBe(true);
    expect(await tamperMarker(p)).toContain("holdback.config.json");
    expect(existsSync(testFile("t-4"))).toBe(false);
  });

  it("a sealed verifier file changed after Kane's evolve was checked is caught before the seal: every change since the pass's copy must be one an evolve was allowed (I-1)", async () => {
    await setup();
    const sealsBefore = (await readEvents(p.ledgerFile)).filter((e) => e.t === "seal").length;
    const { deps, io } = fakes({ mutantRun: survives3 });
    // balance is read before and after each Kane batch: the 6th read follows the evolve's own check
    let reads = 0;
    deps.balance = async () => {
      if (++reads === 6) writeFileSync(join(p.verifierDir, ".testmuai", "variables", "assurance.json"), JSON.stringify({ start_url: { value: "http://evil.example/" } }));
      return 100;
    };
    const r = await runFalsify(p, deps, io, log);
    expect(r.reason).toBe("tamper");
    const all = await readEvents(p.ledgerFile);
    expect(all.filter((e) => e.t === "seal")).toHaveLength(sealsBefore);
    expect(all.some((e) => e.t === "falsify.evolved")).toBe(false);
    expect(await tamperMarker(p)).toContain(".testmuai/variables/assurance.json");
    expect(existsSync(testFile("t-4"))).toBe(false);
  });

  it("a spec edited while Kane evolves the tests is never sealed: the evolve is rolled back, the edit kept, the change on record as unverified (N-I2)", async () => {
    await setup();
    const sealsBefore = (await readEvents(p.ledgerFile)).filter((e) => e.t === "seal").length;
    const edited = "# Food pantry\n\nNot eligible above 2461.\nA rule written while Kane evolved the tests.\n";
    const { deps, io } = fakes({ mutantRun: survives3, onEvolve: () => writeFileSync(join(appDir, "PRD.md"), edited) });
    const r = await runFalsify(p, deps, io, log);
    expect(r).toMatchObject({ reason: "drift", redesigned: [], vacuous: ["ac-3"], specChange: { files: ["PRD.md"], duringAgentTurn: true } });
    const all = await readEvents(p.ledgerFile);
    expect(all.filter((e) => e.t === "seal")).toHaveLength(sealsBefore);
    expect(all.some((e) => e.t === "falsify.evolved")).toBe(false);
    expect(all.find((e) => e.t === "redesign.dropped")).toMatchObject({ credits: 11.39, detail: expect.stringMatching(/spec changed while Kane evolved the tests/) });
    expect(all.findLast((e) => e.t === "spec.changed")).toMatchObject({ files: ["PRD.md"], duringAgentTurn: true });
    expect(existsSync(testFile("t-4"))).toBe(false);
    expect(readFileSync(join(appDir, "PRD.md"), "utf8")).toBe(edited);
  });

  it("restores the verifier before stopping with tamper when the ledger is forged during the evolve", async () => {
    await setup();
    const { deps, io } = fakes({
      mutantRun: survives3,
      onEvolve: () => appendFileSync(p.ledgerFile, JSON.stringify({ at, t: "seal", manifest: {} }) + "\n"),
    });
    deps.balance = async () => 100; // the batch's credits line is the first append after the forgery
    const r = await runFalsify(p, deps, io, log);
    expect(r.reason).toBe("tamper");
    expect(existsSync(testFile("t-4"))).toBe(false);
    expect(await tamperMarker(p)).not.toBeNull();
  });

  it("counts an AC whose breaker call failed in transit as invalid, books the worst case, and goes on with the pass", async () => {
    await setup();
    const { deps, io, calls } = fakes({
      mutantRun: (ac, files) => files.map(failOn(ac)),
      chatError: (ac) => (ac === "ac-1" ? new VeniceUnreachable("Venice unreachable: The operation was aborted due to timeout") : undefined),
    });
    const r = await runFalsify(p, deps, io, log);
    expect(r).toMatchObject({ killed: ["ac-3"], invalid: ["ac-1"], reason: "done" });
    const m = (await readEvents(p.ledgerFile)).find((e) => e.t === "mutant" && e.ac === "ac-1");
    expect(m).toMatchObject({
      verdict: "invalid",
      note: expect.stringMatching(/^breaker unavailable: Venice unreachable/),
      usd: expect.closeTo(estimateUsd(MODEL, calls.chat[0]!.o.messages), 12),
    });
    expect(calls.tests.filter((t) => !t.opts.noHeal)).toHaveLength(1); // the closing replay still ran
  });

  it("counts an AC whose breaker call Venice refused with an error status as invalid, at no cost", async () => {
    await setup();
    const { deps, io } = fakes({
      mutantRun: (ac, files) => files.map(failOn(ac)),
      chatError: (ac) => (ac === "ac-1" ? new VeniceHttpError("Venice 503 Service Unavailable: busy", 503) : undefined),
    });
    const r = await runFalsify(p, deps, io, log);
    expect(r).toMatchObject({ killed: ["ac-3"], invalid: ["ac-1"], reason: "done" });
    const m = (await readEvents(p.ledgerFile)).find((e) => e.t === "mutant" && e.ac === "ac-1");
    expect(m).toMatchObject({ usd: 0, note: expect.stringContaining("Venice 503") });
  });

  it("counts a failure on another AC as invalid (collateral), leaving the AC passing", async () => {
    await setup();
    const { deps, io } = fakes({ mutantRun: (ac, files) => files.map(ac === "ac-1" ? failOn("ac-1") : failOn("ac-6")) });
    const r = await runFalsify(p, deps, io, log);
    expect(r).toMatchObject({ killed: ["ac-1"], survived: [], invalid: ["ac-3"], redesigned: [], reason: "done" });
    const all = await readEvents(p.ledgerFile);
    const m = all.find((e) => e.t === "mutant" && e.ac === "ac-3");
    expect(m).toMatchObject({ verdict: "invalid", note: expect.stringMatching(/^collateral: t-3 failed \(ac-6\)/) });
    expect(reduce(all).acs["ac-3"]!.status).toBe("passing");
  });

  it("re-runs a mutant replay Kane blames on its own environment once, then counts it invalid (inconclusive), never a kill", async () => {
    await setup();
    // the live t-3: Kane's browser closed mid-run; its criteria list still names the AC under attack
    const envFail = (ac: string) => (file: string): TestRunResult => ({
      ...failOn(ac)(file),
      verdict: { bugTitle: "Browser target closed before screenshot capture", family: "environment_issue" },
    });
    const { deps, io, calls } = fakes({ mutantRun: (ac, files) => files.map(ac === "ac-1" ? failOn("ac-1") : envFail("ac-3")) });
    const r = await runFalsify(p, deps, io, log);
    expect(r).toMatchObject({ killed: ["ac-1"], survived: [], invalid: ["ac-3"], redesigned: [], reason: "done" });
    // the same test, the same mutant, run once more before the verdict
    expect(calls.tests.filter((t) => t.opts.noHeal).map((t) => [t.ac, t.files])).toEqual([
      ["ac-1", [T1]],
      ["ac-1", [T1]], // the kill confirmed by a second replay (R44)
      ["ac-3", [T3]],
      ["ac-3", [T3]],
    ]);
    const all = await readEvents(p.ledgerFile);
    expect(all.find((e) => e.t === "mutant" && e.ac === "ac-3")).toMatchObject({
      verdict: "invalid",
      note: "inconclusive: t-3: environment_issue: Browser target closed before screenshot capture",
    });
    const logged = all.filter((e) => e.t === "run" && e.kind === "falsify" && e.mutantId === "m-ac-3-1");
    expect(logged).toHaveLength(1); // both attempts in one result: their credits added up
    expect(logged[0]).toMatchObject({ result: { retried: expect.stringContaining("environment_issue"), inconclusive: expect.stringContaining("environment_issue"), credits: 9.4 } });
    expect(reduce(all).acs["ac-3"]!.status).toBe("passing");
    expect(reduce(all).acs["ac-1"]!.status).toBe("proved");
  });

  it("kills the mutant when the re-run fails on the app; a Holdback timeout is re-run too", async () => {
    await setup();
    const seen = new Map<string, number>();
    const { deps, io, calls } = fakes({
      mutantRun: (ac, files) => {
        const n = (seen.get(ac) ?? 0) + 1;
        seen.set(ac, n);
        return files.map((f) => (n === 1 ? { ...pass(f), status: "error", reason: "timeout" } : failOn(ac)(f)));
      },
    });
    const r = await runFalsify(p, deps, io, log);
    expect(r).toMatchObject({ killed: ["ac-1", "ac-3"], invalid: [], reason: "done" });
    // per AC: the timeout, its re-run, then the second replay that confirms the kill
    expect(calls.tests.filter((t) => t.opts.noHeal)).toHaveLength(6);
  });

  it("counts a pass after a heal as survived-by-heal; at most two evolves per use case per run, so a later survivor stays vacuous with the reason (R40)", async () => {
    await setup();
    const { deps, io, calls } = fakes({
      mutantRun: (ac, files) => files.map(ac === "ac-1" ? failOn("ac-1") : (f) => ({ ...pass(f), healTriggered: true })),
    });
    // this run already evolved uc-1 twice after a survivor (each perhaps with a follow-up)
    const evolves = new Map([["uc-1", 2]]);
    const r = await runFalsify(p, deps, io, log, { evolves });
    expect(r).toMatchObject({ killed: ["ac-1"], survived: ["ac-3"], invalid: [], redesigned: [], vacuous: ["ac-3"], reason: "done" });
    expect(r.redesignError).toMatch(/already evolved uc-1 2 times in this run/);
    expect(calls.evolve).toEqual([]);
    expect(evolves.get("uc-1")).toBe(2);
    const all = await readEvents(p.ledgerFile);
    expect(all.at(-1)!.t).toBe("recordings");
    const m = all.filter((e) => e.t === "mutant").pop();
    expect(m).toMatchObject({ id: "m-ac-3-1", ac: "ac-3", verdict: "survived-by-heal", note: expect.stringContaining("heal") });
    // the next `holdback run` sends it to Kane again (m-2)
    expect(reduce(all).acs["ac-3"]).toMatchObject({ status: "vacuous", reason: "Kane already evolved this use case twice in this run: the next `holdback run` tries again" });
  });

  it("retries a patch that does not apply once with git's error, then counts it invalid without any Kane run", async () => {
    await setup();
    const { deps, io, calls } = fakes({ patch: () => BAD_PATCH, mutantRun: () => [] });
    const r = await runFalsify(p, deps, io, log);
    expect(r).toMatchObject({ killed: [], survived: [], invalid: ["ac-1", "ac-3"], reason: "done" });
    expect(r.usd).toBeCloseTo(4 * USD_PER_CALL, 12);
    expect(calls.chat.map((c) => c.ac)).toEqual(["ac-1", "ac-1", "ac-3", "ac-3"]);
    const retry = calls.chat[1]!.o.messages.map((m) => m.content).join("\n");
    expect(retry).toContain("Your previous patch failed:");
    expect(retry).toMatch(/patch does not apply|patch failed/);
    expect(retry).toContain("-const nothing = here;");
    expect(calls.tests).toEqual([]);
    expect(calls.apps).toEqual([]);
    const all = await readEvents(p.ledgerFile);
    const ms = all.filter((e) => e.t === "mutant");
    expect(ms).toEqual([
      expect.objectContaining({ ac: "ac-1", verdict: "invalid", usd: expect.closeTo(2 * USD_PER_CALL, 12), note: expect.stringMatching(/^patch did not apply/) }),
      expect.objectContaining({ ac: "ac-3", verdict: "invalid" }),
    ]);
    expect(Object.values(reduce(all).acs).map((a) => a.status)).toEqual(["passing", "passing"]);
    expect(existsSync(join(p.home, "mut")) ? readdirSync(join(p.home, "mut")) : []).toEqual([]);
  });

  /** The rehearsal's empty reply: the reasoning used the whole token cap. */
  const cutOff = () => new VeniceOutputError("Venice reply has no message content (cut off at the 2048-token limit)", { prompt_tokens: 1198, completion_tokens: 2048 }, true);
  const CUT_USD = usdOf(MODEL, { prompt_tokens: 1198, completion_tokens: 2048 });

  it("asks a breaker cut off by the token limit again once, with a larger cap, never the same call; cut off again, the mutant is invalid", async () => {
    await setup();
    const { deps, io, calls } = fakes({ mutantRun: (ac, files) => files.map(failOn(ac)), chatError: (ac) => (ac === "ac-1" ? cutOff() : undefined) });
    const r = await runFalsify(p, deps, io, log);
    expect(r).toMatchObject({ killed: ["ac-3"], invalid: ["ac-1"], reason: "done" });
    const mine = calls.chat.filter((c) => c.ac === "ac-1");
    expect(mine.map((c) => c.o.maxTokens ?? 2048)).toEqual([2048, 4096]);
    // the larger cap is the only change: the prompt is the same, and no third call follows
    expect(mine[1]!.o.messages).toEqual(mine[0]!.o.messages);
    const m = (await readEvents(p.ledgerFile)).find((e) => e.t === "mutant" && e.ac === "ac-1");
    expect(m).toMatchObject({ verdict: "invalid", usd: expect.closeTo(2 * CUT_USD, 12), note: expect.stringMatching(/^no usable patch: .*cut off at the 2048-token limit/) });
    expect(calls.tests.filter((t) => t.opts.noHeal && t.ac === "ac-1")).toEqual([]);
  });

  it("a cut-off reply and then a patch that does not apply get one retry each: the larger cap, then the error fed back", async () => {
    await setup();
    const { deps, io, calls } = fakes({
      mutantRun: (ac, files) => files.map(failOn(ac)),
      chatError: (ac, n) => (ac === "ac-1" && n === 0 ? cutOff() : undefined),
      patch: (ac, n) => (ac === "ac-1" && n === 1 ? BAD_PATCH : PATCH[ac]!),
    });
    const r = await runFalsify(p, deps, io, log);
    expect(r).toMatchObject({ killed: ["ac-1", "ac-3"], invalid: [], reason: "done" });
    const mine = calls.chat.filter((c) => c.ac === "ac-1");
    expect(mine.map((c) => c.o.maxTokens ?? 2048)).toEqual([2048, 4096, 4096]);
    expect(mine[2]!.o.messages[1]!.content).toContain("Your previous patch failed:");
    expect(mine[2]!.o.messages[1]!.content).toContain("-const nothing = here;");
    const m = (await readEvents(p.ledgerFile)).find((e) => e.t === "mutant" && e.ac === "ac-1");
    expect(m).toMatchObject({ verdict: "killed", usd: expect.closeTo(CUT_USD + 2 * USD_PER_CALL, 12) });
  });

  it("counts a mutant that does not start as invalid, with no Kane run", async () => {
    await setup();
    const { deps, io, calls } = fakes({ mutantStarts: false, mutantRun: () => [] });
    const r = await runFalsify(p, deps, io, log);
    expect(r).toMatchObject({ invalid: ["ac-1", "ac-3"], reason: "done" });
    expect(calls.tests).toEqual([]);
    const m = (await readEvents(p.ledgerFile)).find((e) => e.t === "mutant");
    expect(m).toMatchObject({ verdict: "invalid", note: expect.stringContaining("SyntaxError: Unexpected token") });
  });

  it("refuses the breaker call once the budget is spent, and logs no mutant", async () => {
    await setup({
      before: async () => {
        await log({ at, t: "mutant", id: "m-old", ac: "ac-0", patch: "", model: MODEL, usd: 1.9999, verdict: "invalid" });
      },
    });
    const since = (await readEvents(p.ledgerFile)).length;
    const { deps, io, calls } = fakes({ mutantRun: (ac, files) => files.map(failOn(ac)) });
    const r = await runFalsify(p, deps, io, log);
    expect(r).toMatchObject({ killed: [], invalid: [], skipped: ["ac-1", "ac-3"], usd: 0, reason: "budget" });
    expect(calls.chat).toEqual([]);
    expect(calls.tests).toEqual([]);
    expect(tags(await after(since))).toEqual(["recordings"]);
    expect(existsSync(join(p.home, "mut")) ? readdirSync(join(p.home, "mut")) : []).toEqual([]);
  });

  it("checks the Kane credit cap before the breaker's paid call: at the cap, no breaker spend and no mutant (N-m2)", async () => {
    await setup();
    const since = (await readEvents(p.ledgerFile)).length;
    const { deps, io, calls } = fakes({ mutantRun: (ac, files) => files.map(failOn(ac)) });
    const r = await runFalsify(p, deps, io, log, { kaneCap: 0 });
    expect(r).toMatchObject({ killed: [], invalid: [], survived: [], usd: 0, reason: "kane-budget" });
    expect(r.error).toMatch(/Kane credit cap reached/);
    expect(calls.chat).toEqual([]);
    expect(calls.tests).toEqual([]);
    expect(tags(await after(since)).filter((t) => t.startsWith("mutant"))).toEqual([]);
    expect(reduce(await readEvents(p.ledgerFile)).breakerUsd).toBe(0);
  });

  it("removes a mutant worktree a crashed pass left behind, first thing, without touching the app's node_modules behind its link", async () => {
    await setup({ before: async () => markTampered(p, "an earlier tamper") });
    const stale = mutDir("m-ac-1-1");
    mkdirSync(dirname(stale), { recursive: true });
    git(appDir, "worktree", "add", "-q", "--detach", stale, "HEAD");
    symlinkSync(join(appDir, "node_modules"), join(stale, "node_modules"), "junction");
    writeFileSync(join(p.home, "mut", "m-ac-1-1.patch"), "x");
    const { deps, io } = fakes({ mutantRun: (ac, files) => files.map(failOn(ac)) });
    const r = await runFalsify(p, deps, io, log);
    expect(r.reason).toBe("tamper"); // even a pass that stops at once cleans up
    expect(readdirSync(join(p.home, "mut"))).toEqual([]);
    expect(git(appDir, "worktree", "list").split("\n")).toHaveLength(1);
    expect(readFileSync(join(appDir, "node_modules", "dep", "index.js"), "utf8")).toBe("module.exports = 1;\n");
  });

  it("stops with tamper, before any breaker call, when Kane's recordings changed since they were last logged", async () => {
    await setup({ before: async () => void (await logRecordings(p, log)) });
    const out = join(p.verifierDir, ".testmuai", "tests", "output-planted");
    mkdirSync(out, { recursive: true });
    writeFileSync(join(out, "run.json"), "{}");
    const { deps, io, calls } = fakes({ mutantRun: (ac, files) => files.map(failOn(ac)) });
    const r = await runFalsify(p, deps, io, log);
    expect(r.reason).toBe("tamper");
    expect(calls.chat).toEqual([]);
    const last = (await readEvents(p.ledgerFile)).at(-1);
    expect(last).toMatchObject({ t: "tamper", detail: expect.stringContaining("Kane's recordings") });
    expect(await tamperMarker(p)).not.toBeNull();
  });

  it("refuses, before any breaker call, while the app has uncommitted changes: mutants are planted in the last commit (I2)", async () => {
    await setup();
    writeFileSync(join(appDir, "src", "eligibility.js"), SRC.replace("2461", "2462")); // the human's work, not committed
    writeFileSync(join(appDir, "src", "new.js"), "export const x = 1;\n");
    const { deps, io, calls } = fakes({ mutantRun: (ac, files) => files.map(failOn(ac)) });
    const before = (await readEvents(p.ledgerFile)).length;
    const r = await runFalsify(p, deps, io, log);
    expect(r.reason).toBe("error");
    expect(r.error).toContain("commit");
    expect(r.error).toContain("src/eligibility.js");
    expect(r.error).toContain("src/new.js");
    // the app's own data folder is not code to commit: the message says where it goes (N-m6)
    expect(r.error).toContain("data/");
    expect(r.error).toContain(".gitignore");
    expect(calls.chat).toEqual([]);
    expect(calls.tests).toEqual([]);
    expect((await readEvents(p.ledgerFile)).slice(before).filter((e) => e.t === "mutant")).toEqual([]);
  });

  it("is not held up by Kane's evidence copies or Claude Code's own folder", async () => {
    await setup();
    mkdirSync(join(appDir, "kane-evidence", "turn-1"), { recursive: true });
    writeFileSync(join(appDir, "kane-evidence", "turn-1", "t-3-step-2.png"), "png");
    mkdirSync(join(appDir, ".claude"), { recursive: true });
    writeFileSync(join(appDir, ".claude", "settings.local.json"), "{}");
    const { deps, io } = fakes({ mutantRun: (ac, files) => files.map(failOn(ac)) });
    const r = await runFalsify(p, deps, io, log);
    expect(r.reason).toBe("done");
    expect(r.killed).toEqual(["ac-1", "ac-3"]);
  });

  it("stops with drift, not tamper, before any breaker call when only the spec changed since the seal", async () => {
    await setup();
    appendFileSync(join(appDir, "PRD.md"), "\nHouseholds of 9 qualify.\n");
    const { deps, io, calls } = fakes({ mutantRun: (ac, files) => files.map(failOn(ac)) });
    const r = await runFalsify(p, deps, io, log);
    expect(r.reason).toBe("drift");
    expect(r.error).toContain("holdback drift");
    expect(calls.chat).toEqual([]);
    expect((await readEvents(p.ledgerFile)).some((e) => e.t === "tamper")).toBe(false);
    expect(await tamperMarker(p)).toBeNull();
  });

  it("a spec edit made while Kane attacks a mutant stops the pass with drift: that verdict stands, nothing else is attacked or evolved, the real build is still replayed", async () => {
    await setup();
    const { deps, io, calls } = fakes({
      mutantRun: (_ac, files) => files.map(pass), // a survivor, which would otherwise go to Kane
      onBatch: () => appendFileSync(join(appDir, "PRD.md"), "\nHouseholds of 9 qualify.\n"),
    });
    const r = await runFalsify(p, deps, io, log);
    expect(r).toMatchObject({ reason: "drift", survived: ["ac-1"], redesigned: [], vacuous: ["ac-1"] });
    expect(calls.chat.map((c) => c.ac)).toEqual(["ac-1"]);
    expect(calls.evolve).toEqual([]);
    expect(calls.tests.filter((t) => !t.opts.noHeal)).toHaveLength(1); // the closing replay
    const ev = await readEvents(p.ledgerFile);
    expect(ev.some((e) => e.t === "tamper")).toBe(false);
    expect(await tamperMarker(p)).toBeNull();
    // an agent turn ran since the seal: its origin is unverified (R38)
    expect(ev.filter((e) => e.t === "spec.changed")).toEqual([expect.objectContaining({ duringAgentTurn: true })]);
  });

  it("a spec change during the pass after the guard logged a write at the spec since the seal is a tamper (R38)", async () => {
    await setup();
    logSpecAttempt(p.home, { tool: "Bash", how: "shell" });
    const { deps, io } = fakes({
      mutantRun: (ac, files) => files.map(failOn(ac)),
      onBatch: () => appendFileSync(join(appDir, "PRD.md"), "\nHouseholds of 9 qualify.\n"),
    });
    const r = await runFalsify(p, deps, io, log);
    expect(r.reason).toBe("tamper");
    expect(await tamperMarker(p)).toMatch(/tried to write/);
  });

  it("stops with tamper when a sealed test changed since the seal", async () => {
    await setup();
    appendFileSync(T3, "\nAlso accept anything.\n");
    const { deps, io, calls } = fakes({ mutantRun: (ac, files) => files.map(failOn(ac)) });
    const r = await runFalsify(p, deps, io, log);
    expect(r.reason).toBe("tamper");
    expect(calls.chat).toEqual([]);
    expect((await readEvents(p.ledgerFile)).at(-1)).toMatchObject({ t: "tamper", detail: expect.stringContaining(".testmuai/tests/t3_test.md") });
  });

  it("discards a batch whose sealed test changed while Kane ran, stops with tamper, and still books the breaker's spend", async () => {
    await setup();
    const since = (await readEvents(p.ledgerFile)).length;
    const { deps, io, calls } = fakes({
      mutantRun: (ac, files) => files.map(failOn(ac)),
      onBatch: () => appendFileSync(T3, "\nAlso accept anything.\n"),
    });
    const r = await runFalsify(p, deps, io, log);
    expect(r).toMatchObject({ killed: [], invalid: ["ac-1"], reason: "tamper" });
    expect(calls.chat.map((c) => c.ac)).toEqual(["ac-1"]);
    const ev = await after(since);
    expect(tags(ev)).toEqual(["recordings", "tamper", "mutant:ac-1:invalid"]);
    expect(ev[1]).toMatchObject({ t: "tamper", detail: expect.stringContaining(".testmuai/tests/t3_test.md") });
    expect(ev[2]).toMatchObject({ usd: expect.closeTo(USD_PER_CALL, 12), note: "results discarded: the pass stopped" });
    expect(reduce(await readEvents(p.ledgerFile)).breakerUsd).toBeCloseTo(USD_PER_CALL, 12);
    expect(existsSync(join(p.home, "mut")) ? readdirSync(join(p.home, "mut")) : []).toEqual([]);
  });

  it("stops with tamper when the ledger is changed behind Holdback's back mid-pass, and still cleans up", async () => {
    await setup();
    const { deps, io } = fakes({
      mutantRun: (ac, files) => files.map(failOn(ac)),
      onBatch: () => appendFileSync(p.ledgerFile, JSON.stringify({ at, t: "mutant", id: "x", ac: "ac-3", patch: "", model: MODEL, usd: 0, verdict: "killed" }) + "\n"),
    });
    const r = await runFalsify(p, deps, io, log);
    expect(r.reason).toBe("tamper");
    expect(await tamperMarker(p)).not.toBeNull();
    expect(reduce(await readEvents(p.ledgerFile)).tampered).toBe(true);
    expect(existsSync(join(p.home, "mut")) ? readdirSync(join(p.home, "mut")) : []).toEqual([]);
    expect(readFileSync(join(appDir, "node_modules", "dep", "index.js"), "utf8")).toBe("module.exports = 1;\n");
  });

  it("refuses with a clear error, before touching anything, when VENICE_API_KEY is not set", async () => {
    await setup();
    delete process.env.VENICE_API_KEY;
    const before = readFileSync(p.ledgerFile, "utf8");
    const { deps, io, calls } = fakes({ mutantRun: (ac, files) => files.map(failOn(ac)) });
    delete deps.apiKey;
    await expect(runFalsify(p, deps, io, log)).rejects.toThrow(/VENICE_API_KEY/);
    expect(calls.chat).toEqual([]);
    expect(readFileSync(p.ledgerFile, "utf8")).toBe(before);
  });
});

describe("falsifyVerdict", () => {
  const r = (over: Partial<TestRunResult>): TestRunResult => ({ ...pass(T3 ?? "t3_test.md"), testId: "t-3", ...over });
  it("only a failure Kane blames on the app (application_issue) on the attacked criterion kills; any other failure of the AC is inconclusive (R44)", () => {
    const app = r({ status: "failed", criteriaFailed: ["ac-3"], verdict: { bugTitle: "b", family: "application_issue" } });
    expect(falsifyVerdict("ac-3", [app])).toEqual({ verdict: "killed" });
    // a failure Kane did not put down to the app, or to anything: never a kill
    expect(falsifyVerdict("ac-3", [r({ status: "failed", criteriaFailed: ["ac-3"] })])).toEqual({
      verdict: "invalid",
      note: "inconclusive: t-3 failed ac-3 but Kane did not blame the app (no verdict)",
    });
    expect(falsifyVerdict("ac-3", [r({ status: "failed", criteriaFailed: ["ac-3"], verdict: { bugTitle: "b", family: "product_gap" } })])).toEqual({
      verdict: "invalid",
      note: "inconclusive: t-3 failed ac-3 but Kane did not blame the app (verdict family product_gap)",
    });
    // the rehearsal's m-ac-8-2: an application_issue on another criterion (a replay-ordering error) never kills
    const other = r({ status: "failed", criteriaFailed: ["ac-1"], verdict: { bugTitle: "SNAP household marked Not eligible", family: "application_issue" } });
    expect(falsifyVerdict("ac-8", [other]).verdict).toBe("invalid");
    expect(killsAc(other, "ac-8")).toBe(false);
    expect(killsAc(app, "ac-3")).toBe(true);
    const automation = r({ status: "failed", criteriaFailed: ["ac-3"], verdict: { bugTitle: "empty form", family: "automation_bug" } });
    expect(falsifyVerdict("ac-3", [automation])).toEqual({ verdict: "invalid", note: "inconclusive: t-3: automation_bug: empty form" });
    // an inconclusive test next to tests that passed may have been the one that caught it
    expect(falsifyVerdict("ac-3", [r({}), r({ testId: "t-4", status: "error", reason: "timeout" })])).toEqual({ verdict: "invalid", note: "inconclusive: t-4: timeout" });
    // a kill by one test stands next to an inconclusive one
    expect(falsifyVerdict("ac-3", [app, r({ testId: "t-4", status: "error", reason: "timeout" })])).toEqual({ verdict: "killed" });
  });
});
