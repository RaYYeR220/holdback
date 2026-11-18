import { execFileSync } from "node:child_process";
import { appendFileSync, copyFileSync, existsSync, mkdirSync, mkdtempSync, readFileSync, readdirSync, rmSync, symlinkSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { AppStartError, type StartAppOptions } from "../src/app.js";
import { Budget, estimateUsd, usdOf, VeniceHttpError, VeniceOutputError, VeniceUnreachable, type VeniceChatOptions } from "../src/breaker/venice.js";
import { REFEREE_MAX_TOKENS, refereeMutant } from "../src/breaker/referee.js";
import { parseEvents } from "../src/ledger/parse.js";
import { setAside } from "../src/ledger/setaside.js";
import { verdict } from "../src/ledger/verdict.js";
import { evolve as kaneEvolve, type AcNode, type EvolveResult, type Graph, type TestNode } from "../src/kane/assurance.js";
import { BudgetRefused, type Slip } from "../src/breaker/mutate.js";
import type { RunTestOptions, TestRunResult } from "../src/kane/testmd.js";
import { reduce } from "../src/ledger/reduce.js";
import { appendEvent, readEvents } from "../src/ledger/store.js";
import type { LedgerEvent } from "../src/ledger/types.js";
import { gate } from "../src/ledger/gate.js";
import { runBuildLoop } from "../src/loop/build.js";
import {
  becauseText,
  coverText,
  falsifyVerdict,
  KANE_ARG_MAX,
  TOO_LONG,
  UNJUDGED,
  killsAc,
  pendingRecheck,
  rejudgedEvent,
  runFalsify,
  unevolvedSurvivors,
  unjudgedSurvivors,
  type FalsifyDeps,
} from "../src/loop/falsify.js";
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
async function setup(opts: { before?: () => Promise<void>; config?: object; vars?: object } = {}) {
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
  writeFileSync(vars, JSON.stringify({ start_url: { value: "http://127.0.0.1:3100/" }, ...opts.vars }));
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
async function evolvedEarlier(extra: Partial<Extract<LedgerEvent, { t: "mutant" }>> = {}) {
  await log({ at, t: "mutant", id: "m-ac-3-1", ac: "ac-3", patch: PATCH["ac-3"]!, model: MODEL, usd: 0.0003, verdict: "survived", slip: SLIP["ac-3"], ...extra });
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
  /**
   * The referee's reply on a survivor of `ac` (its Nth referee call, 0-based), or an error its call
   * throws. Default: it confirms the bug with the breaker's own inputs and results.
   */
  referee?: (ac: string, call: number) => unknown;
  /** The referee call's usage. Default: none, so a pass's spend is the breaker's. */
  refereeUsage?: { prompt_tokens: number; completion_tokens: number };
};

/** The referee confirming a survivor of `ac`: the breaker's inputs, expected and observed results. */
const confirms = (ac: string) => ({
  verdict: "violates",
  input: SLIP[ac]?.inputs ?? "household size 1, monthly income $2,462",
  expected: SLIP[ac]?.expected ?? "Not eligible.",
  observed: SLIP[ac]?.observed ?? "Eligible.",
  reason: `the change breaks ${ac}`,
});

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
    /** The referee's calls, apart from the breaker's. */
    referee: [] as { ac: string; o: VeniceChatOptions }[],
    tests: [] as { ac: string; cwd: string; files: string[]; opts: RunTestOptions & { parallel?: number } }[],
    apps: [] as StartAppOptions[],
    stops: 0,
    evolve: [] as { cwd: string; uc: string; because: string }[],
    /** Per mutant start: the patched source and whether the app's node_modules showed through. */
    mutantSrc: [] as { src: string; deps: boolean }[],
  };
  let current = "";
  const perAc = new Map<string, number>();
  const refereed = new Map<string, number>();
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
      if (o.messages[0]!.content.startsWith("You are the referee")) {
        const n = refereed.get(ac) ?? 0;
        refereed.set(ac, n + 1);
        calls.referee.push({ ac, o });
        const said = plan.referee ? plan.referee(ac, n) : confirms(ac);
        if (said instanceof Error) throw said;
        return { json: said, usage: plan.refereeUsage ?? { prompt_tokens: 0, completion_tokens: 0 } };
      }
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
    values: async () => {
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

  it("with the gate shut (`holdback run` stopped on Kane's own runs or a dispute), falsifies the passing criteria and replays only their tests: code the agent did not change is not checked again (live demo)", async () => {
    // ac-3's test failed on the app in turn 2: it regressed, and stays so
    await setup({ before: async () => void (await log({ at, t: "run", kind: "build", turn: 2, result: failOn("ac-3")(T3) })) });
    expect(reduce(await readEvents(p.ledgerFile)).acs["ac-3"]!.status).toBe("regressed");
    const { deps, io, calls } = fakes({ mutantRun: (_ac, files) => files.map(failOn("ac-1")) });
    const r = await runFalsify(p, deps, io, log, { gateShut: true });
    expect(r).toMatchObject({ killed: ["ac-1"], survived: [], reason: "done" });
    // the closing replay ran ac-1's test only, never ac-3's
    expect(calls.tests.filter((t) => !t.opts.noHeal).map((t) => t.files)).toEqual([[T1]]);
    const s = reduce(await readEvents(p.ledgerFile));
    expect(s.acs["ac-1"]!.status).toBe("proved");
    expect(s.acs["ac-3"]!.status).toBe("regressed");
  });

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

  describe("the referee: a survivor counts only once it confirms the planted bug visibly breaks its criterion", () => {
    const off = (reason: string) => ({ verdict: "off-target", input: "", expected: "", observed: "", reason });
    const REF_USD = (1000 * 0.138 + 100 * 0.275) / 1e6;

    it("asks once per survivor, never for a kill: its confirmation is on the ledger, its spend in the mutant's and under the cap, and Kane is told its account", async () => {
      await setup();
      const spentBefore = reduce(await readEvents(p.ledgerFile)).breakerUsd;
      const said = { verdict: "violates", input: "household size 1, monthly income $2,461.50, SNAP unchecked", expected: "Not eligible.", observed: "Eligible.", reason: "LIMITS[size] + 1 lets $2,461.50 through." };
      const { deps, io, calls } = fakes({ mutantRun: survives3, referee: () => said, refereeUsage: { prompt_tokens: 1000, completion_tokens: 100 } });
      const r = await runFalsify(p, deps, io, log);
      expect(r).toMatchObject({ killed: ["ac-1"], survived: ["ac-3"], redesigned: ["uc-1"], reason: "done" });
      expect(calls.referee.map((c) => c.ac)).toEqual(["ac-3"]);
      expect(calls.referee[0]!.o).toMatchObject({ model: MODEL, temperature: 0, schemaName: "referee" });
      expect(calls.referee[0]!.o.messages[1]!.content).toContain(PATCH["ac-3"]!);
      const all = await readEvents(p.ledgerFile);
      expect(all.find((e) => e.t === "mutant" && e.ac === "ac-3")).toMatchObject({
        verdict: "survived",
        usd: expect.closeTo(USD_PER_CALL + REF_USD, 12),
        referee: { confirmed: true, input: said.input, expected: "Not eligible.", observed: "Eligible.", reason: said.reason, usd: expect.closeTo(REF_USD, 12) },
      });
      expect(r.usd).toBeCloseTo(2 * USD_PER_CALL + REF_USD, 12);
      expect(reduce(all).breakerUsd - spentBefore).toBeCloseTo(2 * USD_PER_CALL + REF_USD, 12);
      // Kane is told the account the referee checked against the spec, not the breaker's
      expect(calls.evolve[0]!.because).toContain(said.input);
      expect(calls.evolve[0]!.because).not.toContain(SLIP["ac-3"]!.inputs);
      expect(calls.evolve[0]!.because).toContain(SLIP["ac-3"]!.behaviour);
    });

    it("a survivor it does not confirm is invalid with its words: never sent to Kane, the criterion keeps its status (live demo m-ac-27-1, m-ac-20-1)", async () => {
      await setup();
      const { deps, io, calls } = fakes({
        mutantRun: (_ac, files) => files.map(pass),
        referee: (ac) => (ac === "ac-1" ? off("A zero income is never above the limit.") : { verdict: "no-change", input: "", expected: "", observed: "", reason: "digits already holds that value." }),
      });
      const r = await runFalsify(p, deps, io, log);
      expect(r).toMatchObject({ killed: [], survived: [], invalid: ["ac-1", "ac-3"], vacuous: [], redesigned: [], reason: "done" });
      expect(r.survivors).toBeUndefined();
      expect(r.refuted).toEqual([
        { ac: "ac-1", mutant: "m-ac-1-1", by: "referee", why: "off target: A zero income is never above the limit." },
        { ac: "ac-3", mutant: "m-ac-3-1", by: "referee", why: "no observable change: digits already holds that value." },
      ]);
      expect(calls.evolve).toEqual([]);
      const all = await readEvents(p.ledgerFile);
      expect(all.find((e) => e.t === "mutant" && e.ac === "ac-1")).toMatchObject({
        verdict: "invalid",
        refuted: "referee",
        note: "off target: A zero income is never above the limit.",
        referee: { confirmed: false, input: "", expected: "", observed: "", reason: "A zero income is never above the limit.", usd: 0 },
      });
      // the replay that let it through is on record all the same
      expect(all.filter((e) => e.t === "run" && e.mutantId === "m-ac-1-1")).toHaveLength(1);
      const s = reduce(all);
      expect([s.acs["ac-1"]!.status, s.acs["ac-3"]!.status]).toEqual(["passing", "passing"]);
      expect(s.mutants).toEqual({ killed: 0, survived: 0, invalid: 2 });
    });

    it("a referee with no usable answer, or one the budget refuses, leaves the survivor invalid, not refuted: only a confirmed survivor counts", async () => {
      await setup();
      const { deps, io, calls } = fakes({
        mutantRun: (_ac, files) => files.map(pass),
        referee: (ac) => (ac === "ac-1" ? new VeniceUnreachable("Venice unreachable: timeout") : new BudgetRefused(0.0003, 0.0099, 0.01)),
      });
      const r = await runFalsify(p, deps, io, log);
      expect(r).toMatchObject({ survived: [], invalid: ["ac-1", "ac-3"], vacuous: [], redesigned: [], reason: "budget" });
      expect(r.refuted).toBeUndefined();
      expect(calls.evolve).toEqual([]);
      const ms = (await readEvents(p.ledgerFile)).filter((e): e is Extract<LedgerEvent, { t: "mutant" }> => e.t === "mutant");
      expect(ms[0]).toMatchObject({ verdict: "invalid", note: "got past the tests, but the referee gave no usable answer: Venice unreachable: timeout" });
      // an outage is charged at the worst case, as the breaker's is
      expect(ms[0]!.usd).toBeGreaterThan(USD_PER_CALL);
      expect(ms[1]).toMatchObject({ verdict: "invalid", note: expect.stringMatching(/^got past the tests, but the referee was not asked: breaker budget: /) });
      expect(ms.every((m) => m.refuted === undefined)).toBe(true);
    });

    it("a re-checked survivor is refereed again unless the referee confirmed that same patch before; rejected, the criterion keeps its status", async () => {
      await setup({ before: () => evolvedEarlier() });
      // the earlier survivor is from before the referee: judged first, it gets no usable answer, so its re-check is judged on its own
      const a = fakes({ mutantRun: survives3, referee: (_ac, n) => (n === 0 ? new VeniceHttpError("Venice HTTP 503: busy", 503) : off("it breaks another rule")) });
      const r = await runFalsify(p, a.deps, a.io, log);
      expect(r).toMatchObject({ killed: ["ac-1"], invalid: ["ac-3"], vacuous: [], redesigned: [] });
      expect(a.calls.referee.map((c) => c.ac)).toEqual(["ac-3", "ac-3"]);
      expect((await readEvents(p.ledgerFile)).findLast((e) => e.t === "mutant" && e.ac === "ac-3")).toMatchObject({ recheck: "m-ac-3-1", refuted: "referee" });
      expect(a.calls.evolve).toEqual([]);
      expect(reduce(await readEvents(p.ledgerFile)).acs["ac-3"]!.status).toBe("passing");
    });

    it("a re-checked survivor the referee confirmed before, planted as it was, is not asked about again: it stays vacuous", async () => {
      const confirmed = { confirmed: true, input: SLIP["ac-3"]!.inputs, expected: SLIP["ac-3"]!.expected, observed: SLIP["ac-3"]!.observed, reason: "r", usd: 0.0001 };
      await setup({ before: () => evolvedEarlier({ referee: confirmed }) });
      const b = fakes({ mutantRun: survives3 });
      const r = await runFalsify(p, b.deps, b.io, log);
      expect(r).toMatchObject({ killed: ["ac-1"], survived: ["ac-3"], vacuous: ["ac-3"], redesigned: [] });
      expect(b.calls.referee).toEqual([]);
      expect(reduce(await readEvents(p.ledgerFile)).acs["ac-3"]).toMatchObject({ status: "vacuous", reason: expect.stringMatching(/got past the new tests too/) });
    });
  });

  describe("a survivor logged before the referee existed is judged by it first, at the start of the next pass", () => {
    const off = (reason: string) => ({ verdict: "off-target", input: "", expected: "", observed: "", reason });
    const REF_USD = (1000 * 0.138 + 100 * 0.275) / 1e6;
    const refereeUsage = { prompt_tokens: 1000, completion_tokens: 100 };
    /** An earlier pass's survivor of ac-3 with no judgment of the referee's (that pass came before it), never sent to Kane. */
    const unjudged = () => log({ at, t: "mutant", id: "m-ac-3-1", ac: "ac-3", patch: PATCH["ac-3"]!, model: MODEL, usd: 0.0003, verdict: "survived", slip: SLIP["ac-3"] });

    it("rejected: on record (`mutant.referee`) before anything is attacked, set aside, never sent to Kane; its criterion is passing again and attacked like any other", async () => {
      await setup({ before: unjudged });
      expect(reduce(await readEvents(p.ledgerFile)).acs["ac-3"]!.status).toBe("vacuous");
      const since = (await readEvents(p.ledgerFile)).length;
      const { deps, io, calls } = fakes({ mutantRun: (ac, files) => files.map(failOn(ac)), referee: () => off("it breaks another rule"), refereeUsage });
      const r = await runFalsify(p, deps, io, log);
      expect(r).toMatchObject({ killed: ["ac-1", "ac-3"], survived: [], vacuous: [], redesigned: [], reason: "done" });
      expect(r.rejudged).toEqual([{ ac: "ac-3", mutant: "m-ac-3-1", outcome: "rejected", why: "off target: it breaks another rule" }]);
      expect(r.survivors).toBeUndefined();
      expect(calls.evolve).toEqual([]);
      // the prompt, caps and model of a pass's referee: the criterion and its spec quote from the design, the patch from the `mutant` event
      expect(calls.referee).toHaveLength(1);
      const asked = calls.referee[0]!.o;
      expect(asked).toMatchObject({ model: MODEL, temperature: 0, schemaName: "referee", maxTokens: REFEREE_MAX_TOKENS });
      expect(asked.messages[0]!.content).toMatch(/^You are the referee/);
      for (const part of [`AC ac-3: ${AC3.text}`, `"${AC3.cites[0]!.quote}"`, PATCH["ac-3"]!]) expect(asked.messages[1]!.content).toContain(part);
      expect(asked.messages[1]!.content).not.toContain(SLIP["ac-3"]!.behaviour);
      const ev = await after(since);
      expect(tags(ev).slice(0, 3)).toEqual(["recordings", "mutant.referee", "mutant:ac-1:killed"]);
      expect(ev[1]).toEqual({
        at: expect.any(String),
        t: "mutant.referee",
        mutant: "m-ac-3-1",
        ac: "ac-3",
        usd: expect.closeTo(REF_USD, 12),
        referee: { confirmed: false, input: "", expected: "", observed: "", reason: "it breaks another rule", usd: expect.closeTo(REF_USD, 12) },
        note: "off target: it breaks another rule",
      });
      const all = await readEvents(p.ledgerFile);
      expect(reduce(all.slice(0, since + 2)).acs["ac-3"]!.status).toBe("passing");
      // ac-3 was attacked afresh by the breaker (not a re-check), and the new bug was caught
      expect(calls.chat.map((c) => c.ac)).toEqual(["ac-1", "ac-3"]);
      expect(all.findLast((e) => e.t === "mutant" && e.ac === "ac-3")).toMatchObject({ id: "m-ac-3-2", verdict: "killed" });
      expect(reduce(all).acs["ac-3"]!.status).toBe("proved");
      // its cost is under the cap with the breaker's
      expect(r.usd).toBeCloseTo(2 * USD_PER_CALL + REF_USD, 12);
      expect(reduce(all).breakerUsd - reduce(all.slice(0, since)).breakerUsd).toBeCloseTo(2 * USD_PER_CALL + REF_USD, 12);
      // judged once: no later pass asks about it again
      expect(unjudgedSurvivors(all)).toEqual([]);
    });

    it("confirmed: on record, and it goes on as before: to Kane, told the referee's account", async () => {
      await setup({ before: unjudged });
      const said = { verdict: "violates", input: "household size 1, monthly income $2,461.50, SNAP unchecked", expected: "Not eligible.", observed: "Eligible.", reason: "LIMITS[size] + 1 lets $2,461.50 through." };
      const { deps, io, calls } = fakes({ mutantRun: (ac, files) => files.map(failOn(ac)), referee: () => said });
      const r = await runFalsify(p, deps, io, log);
      expect(r).toMatchObject({ killed: ["ac-1"], redesigned: ["uc-1"], reason: "done" });
      expect(r.rejudged).toEqual([{ ac: "ac-3", mutant: "m-ac-3-1", outcome: "confirmed", why: said.reason }]);
      expect(r.survivors).toEqual([{ ac: "ac-3", mutant: "m-ac-3-1", slip: SLIP["ac-3"]!.behaviour, earlier: true }]);
      expect(calls.referee).toHaveLength(1);
      expect(calls.evolve).toHaveLength(1);
      expect(calls.evolve[0]!.because).toContain(said.input);
      expect(calls.evolve[0]!.because).not.toContain(SLIP["ac-3"]!.inputs);
      const rec = (await readEvents(p.ledgerFile)).find((e) => e.t === "mutant.referee");
      expect(rec).toMatchObject({ mutant: "m-ac-3-1", referee: { confirmed: true, input: said.input, expected: "Not eligible.", observed: "Eligible." } });
      expect(rec).not.toHaveProperty("note");
    });

    it("a re-check pending from before the referee: rejected, nothing is re-checked and the criterion is attacked afresh; confirmed, it is re-checked as planted and not asked about again", async () => {
      await setup({ before: () => evolvedEarlier() });
      const a = fakes({ mutantRun: (ac, files) => files.map(failOn(ac)), referee: () => off("it breaks another rule") });
      const r = await runFalsify(p, a.deps, a.io, log);
      expect(r).toMatchObject({ killed: ["ac-1", "ac-3"], vacuous: [], redesigned: [] });
      expect(r.rejudged).toEqual([{ ac: "ac-3", mutant: "m-ac-3-1", outcome: "rejected", why: "off target: it breaks another rule" }]);
      expect(a.calls.chat.map((c) => c.ac)).toEqual(["ac-1", "ac-3"]);
      const m = (await readEvents(p.ledgerFile)).findLast((e) => e.t === "mutant" && e.ac === "ac-3");
      expect(m).toMatchObject({ verdict: "killed" });
      expect(m).not.toHaveProperty("recheck");

      rmSync(root, { recursive: true, force: true });
      root = mkdtempSync(join(tmpdir(), "hb-falsify-"));
      process.env.HOLDBACK_HOME = join(root, "home");
      await setup({ before: () => evolvedEarlier() });
      const b = fakes({ mutantRun: survives3 });
      const r2 = await runFalsify(p, b.deps, b.io, log);
      expect(r2).toMatchObject({ killed: ["ac-1"], survived: ["ac-3"], vacuous: ["ac-3"], redesigned: [] });
      expect(r2.rejudged).toEqual([{ ac: "ac-3", mutant: "m-ac-3-1", outcome: "confirmed", why: "the change breaks ac-3" }]);
      expect(b.calls.chat.map((c) => c.ac)).toEqual(["ac-1"]);
      expect(b.calls.referee).toHaveLength(1);
      expect((await readEvents(p.ledgerFile)).findLast((e) => e.t === "mutant" && e.ac === "ac-3")).toMatchObject({ recheck: "m-ac-3-1", verdict: "survived" });
    });

    it("no usable answer: on record with its cost; the survivor stands as logged, is not sent to Kane in this pass, and the next pass asks again", async () => {
      await setup({ before: unjudged });
      const { deps, io, calls } = fakes({ mutantRun: (ac, files) => files.map(failOn(ac)), referee: () => new VeniceUnreachable("Venice unreachable: timeout") });
      const r = await runFalsify(p, deps, io, log);
      const why = "the referee gave no usable answer: Venice unreachable: timeout";
      expect(r).toMatchObject({ killed: ["ac-1"], redesigned: [], reason: "done" });
      expect(r.rejudged).toEqual([{ ac: "ac-3", mutant: "m-ac-3-1", outcome: "unanswered", why }]);
      expect(r.notEvolved).toEqual([{ uc: "uc-1", acs: ["ac-3"], why: UNJUDGED }]);
      expect(calls.evolve).toEqual([]);
      const all = await readEvents(p.ledgerFile);
      const rec = all.find((e) => e.t === "mutant.referee");
      expect(rec).toMatchObject({ mutant: "m-ac-3-1", ac: "ac-3", note: why });
      expect(rec).not.toHaveProperty("referee");
      // an outage is charged at the worst case, as the breaker's is
      expect((rec as { usd: number }).usd).toBeGreaterThan(0);
      expect(reduce(all).acs["ac-3"]!.status).toBe("vacuous");
      expect(unjudgedSurvivors(all).map((m) => m.id)).toEqual(["m-ac-3-1"]);
    });

    it("the USD cap refuses the referee's call: nothing is spent, attacked or sent to Kane, and the survivor waits", async () => {
      await setup({ before: unjudged });
      const { deps, io, calls } = fakes({ mutantRun: (ac, files) => files.map(failOn(ac)), referee: () => new BudgetRefused(0.0003, 0.0099, 0.01) });
      const r = await runFalsify(p, deps, io, log);
      expect(r).toMatchObject({ killed: [], skipped: ["ac-1"], redesigned: [], reason: "budget" });
      expect(r.rejudged).toBeUndefined();
      expect(r.notEvolved).toEqual([{ uc: "uc-1", acs: ["ac-3"], why: UNJUDGED }]);
      expect(calls.chat).toEqual([]);
      expect(calls.evolve).toEqual([]);
      const all = await readEvents(p.ledgerFile);
      expect(all.some((e) => e.t === "mutant.referee")).toBe(false);
      expect(reduce(all).acs["ac-3"]!.status).toBe("vacuous");
    });
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

  it("an earlier survivor whose patch changes no code is refuted on its re-check: the criterion keeps its status, never vacuous (live demo m-ac-53-1)", async () => {
    const same = ["--- a/src/eligibility.js", "+++ b/src/eligibility.js", "@@ -3,3 +3,3 @@", '   if (snap) return "Eligible.";', '-  return income <= LIMITS[size] ? "Eligible." : "Not eligible.";', '+  return income <= LIMITS[size] ? "Eligible." : "Not eligible.";', " }", ""].join("\n");
    await setup({
      before: async () => {
        await evolvedEarlier();
        // the ledger's survivor of ac-3 was a line replaced with itself (a ledger from before the no-op filter)
        const all = await readEvents(p.ledgerFile);
        const m = all.find((e) => e.t === "mutant" && e.id === "m-ac-3-1") as Extract<LedgerEvent, { t: "mutant" }>;
        m.patch = same;
        writeFileSync(p.ledgerFile, all.map((e) => JSON.stringify(e)).join("\n") + "\n");
      },
    });
    const { deps, io, calls } = fakes({ mutantRun: (ac, files) => files.map(failOn(ac)) });
    const r = await runFalsify(p, deps, io, log);
    expect(r).toMatchObject({ killed: ["ac-1"], invalid: ["ac-3"], vacuous: [], reason: "done" });
    expect(calls.chat.map((c) => c.ac)).toEqual(["ac-1"]);
    const m = (await readEvents(p.ledgerFile)).findLast((e) => e.t === "mutant" && e.ac === "ac-3");
    expect(m).toMatchObject({ recheck: "m-ac-3-1", verdict: "invalid", refuted: "no-op" });
    expect(reduce(await readEvents(p.ledgerFile)).acs["ac-3"]!.status).toBe("passing");
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

  /** Kane's evolve: t-4 minted for uc-1 (its body typing `body`), t-1 and t-3 retired. */
  const mintsTyping = (body: string) => (_n: number, kit: EvolveKit) => (kit.mint("t-4", ["ac-1", "ac-3"]), appendFileSync(testFile("t-4"), `${body}\n`), kit.retire("t-1", "t-3"), EVOLVED);
  const varsFile = () => join(p.verifierDir, ".testmuai", "variables", "assurance.json");

  it("Kane's new test types an empty variable: Holdback fills its suggestion with no human, logs it as suggested, and Kane's seal holds it (R46)", async () => {
    await setup({ vars: { guest_phone: { value: "", secret: false, description: "Unused ten-digit phone." } } });
    const since = (await readEvents(p.ledgerFile)).length;
    const { deps, io } = fakes({ mutantRun: survives3, evolve: mintsTyping("Type {{guest_phone}}.") });
    const r = await runFalsify(p, deps, io, log);
    expect(r).toMatchObject({ killed: ["ac-1"], survived: ["ac-3"], redesigned: ["uc-1"], vacuous: [], reason: "done" });
    const ev = await after(since);
    const t = ev.map((e) => e.t);
    expect(t.slice(t.indexOf("falsify.evolved"), t.indexOf("seal") + 1)).toEqual(["falsify.evolved", "spec.variables", "design", "seal"]);
    expect(ev.find((e) => e.t === "spec.variables")).toEqual({ at: expect.any(String), t: "spec.variables", names: ["guest_phone"], filledBy: "suggested" });
    expect(JSON.parse(readFileSync(varsFile(), "utf8")).guest_phone).toEqual({ value: "2155550101", secret: false, description: "Unused ten-digit phone." });
    const sealEv = ev.find((e) => e.t === "seal") as Extract<LedgerEvent, { t: "seal" }>;
    expect(sealEv.by).toBe("kane");
    expect(await checkSeal(p.verifierDir, (ev.filter((e) => e.t === "seal").pop() as Extract<LedgerEvent, { t: "seal" }>).manifest, appDir)).toEqual([]);
    expect(ev.some((e) => e.t === "tamper" || e.t === "falsify.evolve.stray")).toBe(false);
  });

  it.each([
    ["an empty secret", "login_password", { value: "", secret: true, description: "Password of the test account." }],
    ["a variable Holdback has no value for", "coupon", { value: "", secret: false, description: "A coupon code the shop accepts." }],
  ] as const)("Kane's new test types %s: nothing is sealed, and the criterion stays vacuous with why (R46)", async (_what, name, decl) => {
    {
      await setup({ vars: { [name]: decl } });
      const varsBefore = readFileSync(varsFile(), "utf8");
      const since = (await readEvents(p.ledgerFile)).length;
      const { deps, io, calls } = fakes({ mutantRun: survives3, evolve: mintsTyping(`Use {{${name}}}.`) });
      const r = await runFalsify(p, deps, io, log);
      expect(r).toMatchObject({ killed: ["ac-1"], survived: ["ac-3"], redesigned: [], vacuous: ["ac-3"], reason: "done" });
      expect(calls.evolve).toHaveLength(1);
      const why = `Kane's new test needs a value only you can give: ${name}`;
      const ev = await after(since);
      expect(ev.find((e) => e.t === "redesign.dropped")).toMatchObject({ useCases: ["uc-1"], credits: 11.39, acs: ["ac-3"], reason: why });
      expect(ev.some((e) => e.t === "falsify.evolved" || e.t === "spec.variables" || (e.t === "seal" && e.by === "kane"))).toBe(false);
      expect(reduce(await readEvents(p.ledgerFile)).acs["ac-3"]).toMatchObject({ status: "vacuous", reason: why });
      // rolled back: Kane's new test is gone, the variables file is as sealed
      expect(existsSync(testFile("t-4"))).toBe(false);
      expect(readFileSync(varsFile(), "utf8")).toBe(varsBefore);
      const sealEv = (await readEvents(p.ledgerFile)).filter((e) => e.t === "seal").pop() as Extract<LedgerEvent, { t: "seal" }>;
      expect(await checkSeal(p.verifierDir, sealEv.manifest, appDir)).toEqual([]);
    }
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

  it("a survivor whose account is too long to hand Kane whole is never cut: its evolve is skipped with the reason, and it stays vacuous", async () => {
    const giant: Slip = { ...SLIP["ac-3"]!, inputs: "household size 1 ".repeat(3000) };
    const referee = { confirmed: true, input: giant.inputs, expected: giant.expected, observed: giant.observed, reason: "r", usd: 0.0001 };
    // a survivor an earlier pass logged but never got to Kane
    await setup({ before: async () => void (await log({ at, t: "mutant", id: "m-ac-3-1", ac: "ac-3", patch: PATCH["ac-3"]!, model: MODEL, usd: 0.0003, verdict: "survived", slip: giant, referee })) });
    const { deps, io, calls } = fakes({ mutantRun: (ac, files) => files.map(failOn(ac)) });
    const r = await runFalsify(p, deps, io, log);
    expect(r).toMatchObject({ killed: ["ac-1"], vacuous: ["ac-3"], redesigned: [], reason: "done" });
    expect(r.notEvolved).toEqual([{ uc: "uc-1", acs: ["ac-3"], why: TOO_LONG }]);
    expect(calls.evolve).toEqual([]);
    const all = await readEvents(p.ledgerFile);
    expect(all.find((e) => e.t === "redesign.dropped")).toMatchObject({ useCases: ["uc-1"], credits: 0, acs: ["ac-3"], reason: TOO_LONG });
    expect(reduce(all).acs["ac-3"]).toMatchObject({ status: "vacuous", reason: TOO_LONG });
    expect(TOO_LONG).toBe("the account of what slipped is too long to hand Kane whole");
  });

  describe("Kane disputes a planted bug: its evolve pauses on a question, which Holdback never answers", () => {
    const Q = "For a household of one with $2,461 monthly income, should the result be Eligible. as the published at-or-below rule says, or Not eligible. as the bug report says?";
    const paused = (credits: number, ...texts: string[]): EvolveResult => ({
      status: "paused",
      questions: texts.map((text, i) => ({ id: `q${i + 1}`, text, risk: "high", rationale: "r", options: [{ label: "Follow published rule" }], recommendedIndex: 0, allowFreeText: true })),
      credits,
    });

    it("the survivor it answers is invalid with Kane's question on the ledger, nothing is retired or sealed, the criterion keeps its status, and it is not sent again (live demo uc-1)", async () => {
      await setup();
      const since = (await readEvents(p.ledgerFile)).length;
      const { deps, io, calls } = fakes({
        mutantRun: survives3,
        // Kane wrote a test before it stopped to ask: rolled back with the rest
        evolve: (_n, kit) => (kit.mint("t-4", ["ac-1", "ac-3"]), paused(11.25, Q)),
      });
      const r = await runFalsify(p, deps, io, log);
      expect(r).toMatchObject({ killed: ["ac-1"], survived: [], invalid: ["ac-3"], vacuous: [], redesigned: [], reason: "done" });
      expect(r.disputed).toEqual([{ uc: "uc-1", acs: ["ac-3"], mutants: ["m-ac-3-1"], question: Q }]);
      expect(r.survivors).toBeUndefined();
      expect(r.notEvolved).toBeUndefined();
      expect(calls.evolve).toHaveLength(1); // never answered, never a follow-up
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
        "recordings", // the verifier rolled back, Kane's recordings anchored again
        "falsify.disputed",
        "run:replay:t-1:passed",
        "run:replay:t-3:passed",
        "recordings",
      ]);
      expect(ev.find((e) => e.t === "falsify.disputed")).toEqual({ at: expect.any(String), t: "falsify.disputed", uc: "uc-1", ac: "ac-3", mutant: "m-ac-3-1", question: Q, credits: 11.25 });
      expect(existsSync(testFile("t-4"))).toBe(false);
      const all = await readEvents(p.ledgerFile);
      const s = reduce(all);
      expect(s.acs["ac-3"]).toMatchObject({ status: "passing", tests: ["t-3"] });
      expect(s.mutants).toEqual({ killed: 1, survived: 0, invalid: 1 });
      expect(s.credits - reduce(all.slice(0, since)).credits).toBeCloseTo(2 * 4.7 + 11.25, 9);
      expect(unevolvedSurvivors(all)).toEqual([]);
    });

    it("every survivor of the paused evolve is disputed with Kane's questions; the paused evolve's credits are booked once", async () => {
      await setup();
      const { deps, io } = fakes({ mutantRun: (_ac, files) => files.map(pass), evolve: () => paused(5, Q, "The fourth planted bug was truncated; proceed with the visible cases?") });
      const r = await runFalsify(p, deps, io, log);
      const both = `${Q} / The fourth planted bug was truncated; proceed with the visible cases?`;
      expect(r).toMatchObject({ survived: [], invalid: ["ac-1", "ac-3"], vacuous: [], redesigned: [] });
      expect(r.disputed).toEqual([{ uc: "uc-1", acs: ["ac-1", "ac-3"], mutants: ["m-ac-1-1", "m-ac-3-1"], question: both }]);
      const ds = (await readEvents(p.ledgerFile)).filter((e) => e.t === "falsify.disputed");
      expect(ds.map((e) => e.t === "falsify.disputed" && [e.ac, e.mutant, e.question, e.credits])).toEqual([
        ["ac-1", "m-ac-1-1", both, 5],
        ["ac-3", "m-ac-3-1", both, 0],
      ]);
      const s = reduce(await readEvents(p.ledgerFile));
      expect([s.acs["ac-1"]!.status, s.acs["ac-3"]!.status]).toEqual(["passing", "passing"]);
    });

    it("a follow-up cover evolve that pauses is no dispute of the planted bug: the first evolve stands, its question on record", async () => {
      await setup();
      const { deps, io, calls } = fakes({
        mutantRun: survives3,
        evolve: (n, kit) => {
          if (n > 0) return paused(5, "The request ends with an unfinished “ac”; cover the named criteria only?");
          kit.mint("t-4", ["ac-3"]);
          kit.retire("t-1", "t-3");
          return EVOLVED;
        },
      });
      const r = await runFalsify(p, deps, io, log);
      expect(r).toMatchObject({ redesigned: ["uc-1"], survived: ["ac-3"] });
      expect(r.disputed).toBeUndefined();
      expect(calls.evolve).toHaveLength(2);
      const all = await readEvents(p.ledgerFile);
      expect(all.some((e) => e.t === "falsify.disputed")).toBe(false);
      expect(all.find((e) => e.t === "redesign.dropped")).toMatchObject({ credits: 5, detail: "follow-up evolve of uc-1: Kane asked a question Holdback does not answer on its own: The request ends with an unfinished “ac”; cover the named criteria only?" });
      expect(reduce(all).acs["ac-1"]).toMatchObject({ status: "needs-spec" });
    });
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

  it("a patch that changes no code is invalid before any replay: no app started, no Kane run, the criterion keeps its status (live demo m-ac-53-1)", async () => {
    await setup();
    // ac-1: a line replaced with itself, as m-ac-53-1 did; ac-3: a comment, which leaves the tokens as they were
    const same = ["--- a/src/eligibility.js", "+++ b/src/eligibility.js", "@@ -2,3 +2,3 @@", " export function check(size, income, snap) {", '-  if (snap) return "Eligible.";', '+  if (snap) return "Eligible.";', '   return income <= LIMITS[size] ? "Eligible." : "Not eligible.";', ""].join("\n");
    const comment = ["--- a/src/eligibility.js", "+++ b/src/eligibility.js", "@@ -3,2 +3,3 @@", '   if (snap) return "Eligible.";', "+  // at or below the limit", '   return income <= LIMITS[size] ? "Eligible." : "Not eligible.";', ""].join("\n");
    const { deps, io, calls } = fakes({ patch: (ac) => (ac === "ac-1" ? same : comment), mutantRun: (ac, files) => files.map(pass) });
    const r = await runFalsify(p, deps, io, log);
    expect(r).toMatchObject({ killed: [], survived: [], invalid: ["ac-1", "ac-3"], vacuous: [], redesigned: [], reason: "done" });
    expect(r.refuted).toEqual([
      { ac: "ac-1", mutant: "m-ac-1-1", by: "no-op", why: "changes no code: every line it changes is the same line once whitespace is normalised" },
      { ac: "ac-3", mutant: "m-ac-3-1", by: "no-op", why: "changes no code: it leaves the code's tokens as they were: only whitespace or comments change" },
    ]);
    expect(calls.apps).toEqual([]);
    expect(calls.tests).toEqual([]);
    expect(calls.evolve).toEqual([]);
    const all = await readEvents(p.ledgerFile);
    expect(all.find((e) => e.t === "mutant" && e.ac === "ac-1")).toMatchObject({ verdict: "invalid", refuted: "no-op", note: expect.stringMatching(/^changes no code: /) });
    const s = reduce(all);
    expect([s.acs["ac-1"]!.status, s.acs["ac-3"]!.status]).toEqual(["passing", "passing"]);
    expect(s.mutants).toEqual({ killed: 0, survived: 0, invalid: 2 });
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

  it("a pass stopped by the Kane credit cap after a survivor still says why Kane did not evolve its use case (wave-4 m-2)", async () => {
    await setup();
    let bal = 1000;
    const capped = fakes({ mutantRun: (ac, files) => files.map(ac === "ac-1" ? pass : failOn(ac)) });
    const tests = capped.deps.tests;
    capped.deps.tests = async (...a) => ((bal -= 10), tests(...a));
    capped.deps.balance = async () => bal;
    // the fixture has 12 credits on record; ac-1's replay spends 10 more, past a cap of 20
    const r = await runFalsify(p, capped.deps, capped.io, log, { kaneCap: 20 });
    expect(r).toMatchObject({ reason: "kane-budget", survived: ["ac-1"] });
    expect(r.survivors).toEqual([{ ac: "ac-1", mutant: "m-ac-1-1", slip: SLIP["ac-1"]!.behaviour }]);
    expect(r.notEvolved).toEqual([{ uc: "uc-1", acs: ["ac-1"], why: "the Kane credit cap was reached before Kane could evolve its tests" }]);
  });

  it("a pass stopped by an error after a survivor says why Kane did not evolve its use case (wave-4 m-2)", async () => {
    await setup();
    const { deps, io } = fakes({
      mutantRun: (ac, files) => files.map(ac === "ac-1" ? pass : failOn(ac)),
      chatError: (ac) => (ac === "ac-3" ? new Error("disk full") : undefined),
    });
    const r = await runFalsify(p, deps, io, log);
    expect(r).toMatchObject({ reason: "error", error: "disk full" });
    expect(r.notEvolved).toEqual([{ uc: "uc-1", acs: ["ac-1"], why: "the pass stopped on an error before Kane could evolve its tests" }]);
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

describe("what Kane is told (--because): never cut mid-text", () => {
  type Live = { mutant: string; ac: { id: string; text: string; useCase: string; cites: AcNode["cites"] }; patch: string; slip: Slip | null };
  const LIVE: Live[] = JSON.parse(readFileSync(join(here, "fixtures", "breaker", "survivors.json"), "utf8"));
  const acState = (a: Live["ac"]) => ({ ...a, tests: ["t-1"], status: "vacuous" as const });
  const survivor = (l: Live) => ({ ac: acState(l.ac), patch: l.patch, rationale: "", ...(l.slip ? { slip: l.slip } : {}) });
  const long = (id: string, n: number) => ({
    ac: { id, text: `Criterion ${id} holds for every household.`, useCase: "uc-1", cites: [], tests: ["t-1"], status: "vacuous" as const },
    patch: "",
    rationale: "",
    slip: { behaviour: `${id}: ${"the page goes wrong in a way a user sees ".repeat(n)}.`, inputs: `household size 1 for ${id}`, expected: "Eligible.", observed: "Not eligible." },
  });

  it("the demo's four uc-1 survivors, cut at 1,500 characters mid-sentence live, now go as whole accounts with the count of those left out", () => {
    const uc1 = ["m-ac-26-1", "m-ac-27-1", "m-ac-36-1", "m-ac-37-1"].map((id) => survivor(LIVE.find((l) => l.mutant === id)!));
    const t = becauseText(uc1)!;
    expect(t.length).toBeLessThanOrEqual(1500);
    expect(t).not.toMatch(/…/);
    expect(t.startsWith("4 planted bugs got past every test of this use case.")).toBe(true);
    const kept = uc1.filter((s) => t.includes(`${s.ac.id} ("`));
    expect(kept.length).toBeGreaterThan(0);
    expect(kept.length).toBeLessThan(4);
    expect(t).toContain(`; the other ${4 - kept.length} ${4 - kept.length === 1 ? "is" : "are"} left out of this message on purpose.`);
    // each one sent is whole: its inputs, expected and observed results, in order, then the next
    for (const s of kept) expect(t).toContain(`With ${s.slip!.inputs}, the page should show ${s.slip!.expected}, but it showed ${s.slip!.observed}.`);
    for (const s of uc1.filter((x) => !kept.includes(x))) expect(t).not.toContain(s.ac.id);
    expect(t.endsWith("Add a test that catches each.")).toBe(true);
  });

  it("all of them when they fit, with no note", () => {
    const t = becauseText([long("ac-1", 1), long("ac-2", 1)])!;
    expect(t).toContain('ac-1 ("');
    expect(t).toContain('ac-2 ("');
    expect(t).not.toContain("left out");
  });

  it("an account too long on its own goes in its short form, the criterion by id; still too long, that one account goes whole, never cut, while Kane's command line can take it", () => {
    const one = long("ac-7", 60);
    const t = becauseText([one])!;
    expect(t.length).toBeLessThanOrEqual(1500);
    expect(t).toBe(`A planted bug got past every test of this use case. ac-7: With ${one.slip.inputs}, the page should show Eligible., but it showed Not eligible.. Add a test that catches it.`);
    // over the 1,500-character limit in every form: the whole accounts that fit go, the rest are counted
    const huge = { ...one, slip: { ...one.slip, inputs: `household size 1 ${"and ".repeat(1000)}income $2,462` } };
    const both = becauseText([huge, long("ac-8", 1)])!;
    expect(both.length).toBeLessThanOrEqual(1500);
    expect(both).toContain('ac-8 ("');
    expect(both).not.toContain("ac-7");
    expect(both).toContain("the other 1 is left out of this message on purpose");
    // none fits: the first account alone, whole
    const h = becauseText([huge])!;
    expect(h.length).toBeGreaterThan(1500);
    expect(h.length).toBeLessThanOrEqual(KANE_ARG_MAX);
    expect(h).not.toMatch(/…/);
    expect(h).toContain(`With ${huge.slip.inputs}, the page should show Eligible., but it showed Not eligible..`);
    expect(h.endsWith("Add a test that catches it.")).toBe(true);
    // over what Kane's command line takes: nothing to send
    const giant = { ...one, slip: { ...one.slip, inputs: "x ".repeat(KANE_ARG_MAX) } };
    expect(becauseText([giant])).toBeUndefined();
    expect(coverText([{ id: "ac-1", text: "t" }], [giant])).toBeUndefined();
  });

  it("the follow-up names every criterion it must cover again, and the account of what slipped through stays whole (live demo uc-3: it ended on an unfinished “ac”)", () => {
    const left = Array.from({ length: 21 }, (_, i) => ({ id: `ac-${i + 1}`, text: `A visit time with six visits remains listed with the suffix ' — Full' (${i + 1}).` }));
    const s20 = survivor(LIVE.find((l) => l.mutant === "m-ac-20-1")!);
    const t = coverText(left, [s20])!;
    expect(t.length).toBeLessThanOrEqual(1500);
    for (const a of left) expect(t).toMatch(new RegExp(`${a.id}(?!\\d)`));
    expect(t).toContain(`With ${s20.slip!.inputs}, the page should show ${s20.slip!.expected}, but it showed ${s20.slip!.observed}.`);
    expect(t.endsWith("Add a test that catches it.")).toBe(true);
    // short enough, the criteria keep their text
    const few = coverText(left.slice(0, 2), [s20])!;
    expect(few.startsWith(`cover ac-1 ("${left[0]!.text}"), ac-2 ("${left[1]!.text}") again`)).toBe(true);
  });
});

describe("the pantry run's six survivors, from before the referee, judged by it in a later pass", () => {
  /** The pantry demo run's ledger, sanitized (the dashboard's replay fixture): its 6 survivors carry no judgment of the referee's. */
  const PANTRY = join(here, "..", "..", "..", "apps", "dashboard", "fixtures", "ledger.jsonl");
  type Reply = { mutant: string; reply: unknown; usage: { prompt_tokens: number; completion_tokens: number } };
  const REPLIES: Reply[] = JSON.parse(readFileSync(join(here, "fixtures", "venice", "referee-rejudge.json"), "utf8"));
  const LIVE: { mutant: string; patch: string }[] = JSON.parse(readFileSync(join(here, "fixtures", "breaker", "survivors.json"), "utf8"));
  const UC1 = ["ac-26", "ac-27", "ac-36", "ac-37"];

  it("each is judged from the ledger alone; with the referee's replies rejecting them, ac-26, ac-27, ac-36 and ac-37 are no longer vacuous, and none is re-checked or sent to Kane", async () => {
    const events = parseEvents(readFileSync(PANTRY, "utf8"));
    const before = reduce(events);
    expect(Object.values(before.acs).filter((a) => a.status === "vacuous").map((a) => a.id)).toEqual(UC1);
    expect(before.mutants).toEqual({ killed: 4, survived: 6, invalid: 16 });
    // uc-1's four stay vacuous (its evolve added no test); ac-20's and ac-53's use cases were evolved, so they wait for a re-check
    const todo = unjudgedSurvivors(events);
    expect(todo.map((m) => m.id)).toEqual(["m-ac-20-1", "m-ac-26-1", "m-ac-27-1", "m-ac-36-1", "m-ac-37-1", "m-ac-53-1"]);
    expect(pendingRecheck(events, before.acs["ac-20"]!)?.id).toBe("m-ac-20-1");
    expect(pendingRecheck(events, before.acs["ac-53"]!)?.id).toBe("m-ac-53-1");

    const added: LedgerEvent[] = [];
    for (const m of todo) {
      // the patch is the ledger's `mutant` event's: the real one, as the sanitized fixture of the six has it
      expect(m.patch).toBe(LIVE.find((l) => l.mutant === m.id)!.patch);
      const ac = before.acs[m.ac]!;
      const r = REPLIES.find((x) => x.mutant === m.id)!;
      let asked: VeniceChatOptions | undefined;
      const f = await refereeMutant(ac, m.patch, {
        model: MODEL,
        apiKey: "k",
        budget: new Budget(2, before.breakerUsd),
        chat: async (o) => ((asked = o), { json: r.reply, usage: r.usage }),
      });
      // the criterion's text and spec quote from the ledger's design events
      expect(asked!.messages[1]!.content).toContain(`AC ${ac.id}: ${ac.text}`);
      for (const c of ac.cites.slice(0, 3)) expect(asked!.messages[1]!.content).toContain(c.anchor);
      expect(f.confirmed).toBe(false);
      added.push({ at: "2026-11-19T10:00:00.000Z", ...rejudgedEvent(m, f) } as LedgerEvent);
    }

    // the records come after everything the old ledger holds
    const all = [...events, ...added];
    const s = reduce(all);
    for (const id of UC1) expect(s.acs[id], id).toMatchObject({ status: "passing" });
    for (const id of UC1) expect(s.acs[id]!.reason, id).toBeUndefined();
    expect(verdict(s).counts.vacuous).toBe(0);
    expect(s.mutants).toEqual({ killed: 4, survived: 0, invalid: 22 });
    expect(s.breakerUsd - before.breakerUsd).toBeCloseTo(added.reduce((n, e) => n + (e.t === "mutant.referee" ? e.usd : 0), 0), 12);
    // every other criterion reduces as it did
    for (const [id, a] of Object.entries(before.acs)) if (!UC1.includes(id)) expect(s.acs[id], id).toEqual(a);
    // judged once: nothing to judge, re-check or send to Kane again
    expect(unjudgedSurvivors(all)).toEqual([]);
    expect(unevolvedSurvivors(all)).toEqual([]);
    expect(pendingRecheck(all, s.acs["ac-20"]!)).toBeUndefined();
    expect(pendingRecheck(all, s.acs["ac-53"]!)).toBeUndefined();
    // each is set aside on its criterion, by the referee, with its reason (for the human: `status` prints the ids only)
    expect(setAside(all).filter((a) => a.rejudged).map((a) => [a.ac, a.mutant, a.by])).toEqual(todo.map((m) => [m.ac, m.id, "referee"]));
    expect(setAside(all).find((a) => a.mutant === "m-ac-27-1")!.why).toBe("off target: A zero income is never above the limit, so no input this criterion covers gets a different result.");
  });
});
