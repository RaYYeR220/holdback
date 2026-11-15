import { execFileSync } from "node:child_process";
import { appendFileSync, copyFileSync, existsSync, mkdirSync, mkdtempSync, readFileSync, readdirSync, rmSync, symlinkSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { AppStartError, type StartAppOptions } from "../src/app.js";
import { estimateUsd, VeniceHttpError, VeniceUnreachable, type VeniceChatOptions } from "../src/breaker/venice.js";
import type { AcNode, Graph, TestNode } from "../src/kane/assurance.js";
import type { RunTestOptions, TestRunResult } from "../src/kane/testmd.js";
import { reduce } from "../src/ledger/reduce.js";
import { appendEvent, readEvents } from "../src/ledger/store.js";
import type { LedgerEvent } from "../src/ledger/types.js";
import { falsifyVerdict, runFalsify, type FalsifyDeps } from "../src/loop/falsify.js";
import type { ApprovalItem, HumanIO } from "../src/loop/human.js";
import { appSealFiles } from "../src/loop/spec.js";
import { loadProject, type Project } from "../src/project.js";
import { checkSeal, seal } from "../src/seal.js";
import { checkRecordingsAnchor, logRecordings, markTampered, tamperMarker } from "../src/tamper.js";

const here = dirname(fileURLToPath(import.meta.url));
const fxTests = join(here, "fixtures", "kane", "tests");
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
  for (const k of ["HOLDBACK_HOME", "VENICE_API_KEY"]) {
    if (saved[k] === undefined) delete process.env[k];
    else process.env[k] = saved[k];
  }
  rmSync(root, { recursive: true, force: true });
});

const idOf = (file: string) => (file.endsWith("t1_test.md") ? "t-1" : file.endsWith("t3b_test.md") ? "t-3b" : "t-3");
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
    verdict: { bugTitle: "Eligibility check approves income above displayed limit" },
    credits: 4.7,
  });

const testNodes = (): TestNode[] => [
  { id: "t-1", title: "SNAP household qualifies", file: ".testmuai/tests/t1_test.md", verifies: ["ac-1"] },
  { id: "t-3", title: "Non-SNAP household above $2,461 is not eligible", file: T3, verifies: ["ac-3"] },
];

/** App repo (one commit, a node_modules dir outside git) + verifier with t-1/t-3 + a ledger where ac-1 and ac-3 pass. */
async function setup(opts: { before?: () => Promise<void> } = {}) {
  appDir = join(root, "app");
  mkdirSync(join(appDir, "src"), { recursive: true });
  mkdirSync(join(appDir, "node_modules", "dep"), { recursive: true });
  writeFileSync(join(appDir, "node_modules", "dep", "index.js"), "module.exports = 1;\n");
  writeFileSync(join(appDir, ".gitignore"), "node_modules/\n");
  writeFileSync(join(appDir, "PRD.md"), "# Food pantry\n\nNot eligible above 2461.\n");
  writeFileSync(join(appDir, "holdback.config.json"), "{}");
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

type Plan = {
  /** Patch the breaker returns for an AC on its Nth call (0-based). */
  patch?: (ac: string, call: number) => string;
  /** Kane results for a falsify batch (`ac` is the AC under attack). */
  mutantRun: (ac: string, files: string[]) => TestRunResult[];
  /** Kane results for the closing replay against the real build. Default: all pass. */
  replay?: (files: string[]) => TestRunResult[];
  mutantStarts?: boolean;
  approve?: (items: ApprovalItem[]) => string[];
  onBatch?: (ac: string) => void;
  /** Extra effect of Kane's re-design (after it wrote the new test t-3b). */
  onDesign?: () => void;
  /** The breaker call fails instead of answering. */
  chatError?: (ac: string) => Error | undefined;
};

function fakes(plan: Plan) {
  const calls = {
    chat: [] as { ac: string; o: VeniceChatOptions }[],
    tests: [] as { ac: string; cwd: string; files: string[]; opts: RunTestOptions & { parallel?: number } }[],
    apps: [] as StartAppOptions[],
    stops: 0,
    design: [] as { cwd: string; uc: string; opts: unknown }[],
    review: [] as string[][],
    approvals: [] as ApprovalItem[][],
    /** Per mutant start: the patched source and whether the app's node_modules showed through. */
    mutantSrc: [] as { src: string; deps: boolean }[],
  };
  let current = "";
  let designed = false;
  const perAc = new Map<string, number>();
  // after the re-design Kane keeps ac-3 (re-derived, awaiting approval) and verifies it with a new test t-3b
  const graph = (): Graph => ({
    useCases: [],
    acs: [AC1, AC3, AC9],
    tests: [testNodes()[0]!, { id: "t-3b", title: "redesigned", file: T3B, verifies: ["ac-3"] }],
    gaps: [],
  });
  const deps: FalsifyDeps = {
    apiKey: "test-key",
    port: async () => 5178,
    chat: async (o) => {
      const ac = /^AC (\S+):/m.exec(o.messages[1]!.content)![1]!;
      current = ac;
      const n = perAc.get(ac) ?? 0;
      perAc.set(ac, n + 1);
      calls.chat.push({ ac, o });
      const err = plan.chatError?.(ac);
      if (err) throw err;
      const patch = plan.patch ? plan.patch(ac, n) : PATCH[ac]!;
      return { json: { patch, rationale: `breaks ${ac}` }, usage: { prompt_tokens: 1500, completion_tokens: 300 } };
    },
    app: async (o) => {
      calls.apps.push(o);
      if (o.cwd !== appDir) {
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
      designTests: async (cwd, uc, opts) => {
        calls.design.push({ cwd, uc, opts });
        writeFileSync(T3B, "---\nassurance:\n  id: t-3b\n---\n# A one-person household earning $2,462 is not eligible\n");
        const rec = join(p.verifierDir, ".testmuai", "tests", "output-design");
        mkdirSync(rec, { recursive: true });
        writeFileSync(join(rec, "authoring.json"), "{}");
        designed = true;
        plan.onDesign?.();
        return { status: "complete", tests: ["t-3b"], acs: ["ac-3"], gaps: [], variables: [], credits: 9, next: [] };
      },
      listNodes: async () => [
        { id: "uc-1", label: "usecase", title: "Check eligibility", trust: "approved" },
        { id: "ac-9", label: "ac", title: AC9.text, trust: "derived" },
        ...(designed
          ? [
              { id: "ac-3", label: "ac", title: AC3.text, trust: "derived" },
              { id: "t-3b", label: "test", title: "redesigned", trust: "derived" },
              { id: "sc-7", label: "scenario", title: "income just above the limit", trust: "derived" },
            ]
          : []),
      ],
      review: async (_cwd, refs) => void calls.review.push(refs),
      readGraph: async () => graph(),
      resumeSession: async () => {
        throw new Error("no pause expected");
      },
      extractResume: async () => {
        throw new Error("no pause expected");
      },
    },
  };
  const io: HumanIO = {
    answer: async () => {
      throw new Error("no question expected");
    },
    approve: async (items) => {
      calls.approvals.push(items);
      return plan.approve ? plan.approve(items) : items.map((i) => i.ref);
    },
  };
  return { deps, io, calls };
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
    expect(mutantApps.map((a) => a.cwd)).toEqual([mutDir("m-ac-1-1"), mutDir("m-ac-3-1")]);
    expect(mutantApps[1]).toMatchObject({ cmd: "npm start", port: 5178, readyPath: "/", env: { DATA_DIR: join(mutDir("m-ac-3-1"), "data"), VENICE_API_KEY: "" } });
    expect(calls.mutantSrc[0]!.src).toContain("if (snap && income < 0)");
    expect(calls.mutantSrc[1]!.src).toContain("LIMITS[size] + 1");
    expect(calls.mutantSrc.every((m) => m.deps)).toBe(true);

    // Kane replays only the AC's tests, from the sealed verifier, against the mutant, healing off
    const falsify = calls.tests.filter((t) => t.opts.noHeal);
    expect(falsify.map((t) => [t.ac, t.files])).toEqual([
      ["ac-1", [T1]],
      ["ac-3", [T3]],
    ]);
    expect(falsify[0]!.cwd).toBe(p.verifierDir);
    expect(falsify[0]!.opts).toEqual({ startUrl: "http://127.0.0.1:5178/", noHeal: true, timeoutS: 420, parallel: 3 });

    // then every test once against the real build (heal on), to restore Kane's own coverage
    const replay = calls.tests.filter((t) => !t.opts.noHeal);
    expect(replay.map((t) => t.files)).toEqual([[T1, T3]]);
    expect(replay[0]!.opts).toEqual({ startUrl: "http://127.0.0.1:3100/", timeoutS: 420, parallel: 3 });
    expect(calls.apps.filter((a) => a.cwd === appDir)).toEqual([expect.objectContaining({ port: 3100, cmd: "npm start" })]);
    expect(calls.stops).toBe(calls.apps.length);

    const ev = await after(since);
    expect(tags(ev)).toEqual([
      "recordings", // seeded: nothing anchored the recordings since the seal
      "mutant:ac-1:killed",
      "run:falsify:t-1:failed",
      "recordings",
      "mutant:ac-3:killed",
      "run:falsify:t-3:failed",
      "recordings",
      "run:build:t-1:passed",
      "run:build:t-3:passed",
      "recordings",
    ]);
    expect(ev[4]).toEqual({ at: expect.any(String), t: "mutant", id: "m-ac-3-1", ac: "ac-3", patch: PATCH["ac-3"], model: MODEL, usd: expect.closeTo(USD_PER_CALL, 12), verdict: "killed" });
    expect(ev[5]).toMatchObject({ t: "run", kind: "falsify", mutantId: "m-ac-3-1" });
    expect(ev[7]).toMatchObject({ t: "run", kind: "build", turn: 1 });

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

  it("marks a surviving AC vacuous and re-designs its use case once, with the human's approval and a fresh seal", async () => {
    await setup();
    const since = (await readEvents(p.ledgerFile)).length;
    const { deps, io, calls } = fakes({ mutantRun: (ac, files) => files.map(ac === "ac-1" ? failOn("ac-1") : pass) });
    const r = await runFalsify(p, deps, io, log);
    expect(r).toMatchObject({ killed: ["ac-1"], survived: ["ac-3"], invalid: [], redesigned: ["uc-1"], vacuous: [], reason: "done" });

    expect(calls.design).toEqual([{ cwd: p.verifierDir, uc: "uc-1", opts: { force: true, max: 5 } }]);
    // only nodes of the re-designed use case: the derived ac-9 of uc-2 is not the human's question here
    expect(calls.approvals).toEqual([
      [
        { ref: "ac-3", title: AC3.text, kind: "ac" },
        { ref: "t-3b", title: "redesigned", kind: "test" },
        { ref: "sc-7", title: "income just above the limit", kind: "scenario" },
      ],
    ]);
    expect(calls.review).toEqual([["ac-3", "t-3b", "sc-7"]]);

    const ev = await after(since);
    expect(tags(ev)).toEqual([
      "recordings",
      "mutant:ac-1:killed",
      "run:falsify:t-1:failed",
      "recordings",
      "mutant:ac-3:survived",
      "run:falsify:t-3:passed",
      "recordings",
      "spec.approved",
      "design",
      "seal",
      "recordings",
      "run:build:t-1:passed",
      "run:build:t-3b:passed",
      "recordings",
    ]);
    expect(ev[7]).toMatchObject({ t: "spec.approved", refs: ["ac-3", "t-3b", "sc-7"], rejected: [] });
    expect(ev[8]).toMatchObject({ t: "design", useCase: "uc-1", acs: [AC1, AC3], credits: 9 });
    expect((ev[8] as Extract<LedgerEvent, { t: "design" }>).tests.map((t) => t.id)).toEqual(["t-1", "t-3b"]);
    const sealEv = ev[9] as Extract<LedgerEvent, { t: "seal" }>;
    expect(Object.keys(sealEv.manifest)).toContain(".testmuai/tests/t3b_test.md");
    expect(await checkSeal(p.verifierDir, sealEv.manifest, appDir)).toEqual([]);

    // the survivor stays on record; the redesigned use case went back to owed, and the replay ran its new tests
    const all = await readEvents(p.ledgerFile);
    expect(all.some((e) => e.t === "mutant" && e.ac === "ac-3" && e.verdict === "survived")).toBe(true);
    const beforeReplay = reduce(all.slice(0, since + 11));
    expect(beforeReplay.acs["ac-1"]!.status).toBe("owed");
    expect(beforeReplay.acs["ac-3"]).toMatchObject({ status: "owed", tests: ["t-3b"] });
    expect(reduce(all).acs["ac-3"]!.status).toBe("passing");
  });

  it("logs Kane's balance drop for each mutant's batch, the re-design (before its seal) and the closing replay (R34)", async () => {
    await setup();
    const since = (await readEvents(p.ledgerFile)).length;
    let bal = 1000;
    const { deps, io } = fakes({ mutantRun: (ac, files) => files.map(ac === "ac-1" ? failOn("ac-1") : pass) });
    const tests = deps.tests;
    deps.tests = async (...a) => ((bal -= 6), tests(...a));
    const design = deps.kane.designTests;
    deps.kane = { ...deps.kane, designTests: async (...a) => ((bal -= 11), design(...a)) };
    deps.balance = async () => bal;
    await runFalsify(p, deps, io, log);
    const ev = await after(since);
    expect(tags(ev).filter((t) => ["credits", "design", "seal"].includes(t) || t.startsWith("mutant"))).toEqual([
      "mutant:ac-1:killed",
      "credits",
      "mutant:ac-3:survived",
      "credits",
      "design",
      "credits",
      "seal",
      "credits",
    ]);
    expect(ev.filter((e) => e.t === "credits").map((e) => e.t === "credits" && [e.source, e.delta, e.perRunSum])).toEqual([
      ["falsify", 6, 4.7],
      ["falsify", 6, 0],
      ["design", 11, 9],
      ["falsify", 6, 0],
    ]);
  });

  it("rolls the verifier back and keeps the survivor vacuous when the human approves none of the re-design", async () => {
    await setup();
    const since = (await readEvents(p.ledgerFile)).length;
    const { deps, io, calls } = fakes({ mutantRun: (ac, files) => files.map(ac === "ac-1" ? failOn("ac-1") : pass), approve: () => [] });
    const r = await runFalsify(p, deps, io, log);
    expect(r).toMatchObject({ killed: ["ac-1"], survived: ["ac-3"], redesigned: [], vacuous: ["ac-3"], reason: "done" });
    expect(r.redesignError).toMatch(/approved/);
    expect(calls.review).toEqual([]);
    expect(existsSync(T3B)).toBe(false);
    const all = await readEvents(p.ledgerFile);
    expect(tags(all.slice(since))).toEqual([
      "recordings",
      "mutant:ac-1:killed",
      "run:falsify:t-1:failed",
      "recordings",
      "mutant:ac-3:survived",
      "run:falsify:t-3:passed",
      "recordings",
      "spec.approved",
      "recordings", // what Kane wrote while designing, anchored right after the rollback
      "redesign.dropped",
      "run:build:t-1:passed",
      "run:build:t-3:passed",
      "recordings",
    ]);
    const sealEv = all.filter((e) => e.t === "seal").pop() as Extract<LedgerEvent, { t: "seal" }>;
    expect(await checkSeal(p.verifierDir, sealEv.manifest, appDir)).toEqual([]);
    expect(reduce(all).acs["ac-3"]!.status).toBe("vacuous");
    // what Kane recorded while designing is anchored, so the next build loop sees no tamper
    expect((await checkRecordingsAnchor(p, all)).moved).toEqual([]);
    // the closing replay still runs the sealed tests
    expect(calls.tests.filter((t) => !t.opts.noHeal).map((t) => t.files)).toEqual([[T1, T3]]);
    // the re-design's Kane credits are still accounted
    expect(all.find((e) => e.t === "redesign.dropped")).toMatchObject({ useCases: ["uc-1"], credits: 9, detail: expect.stringMatching(/approved/) });
    expect(reduce(all).credits - reduce(all.slice(0, since)).credits).toBeCloseTo(4.7 + 9, 9);
  });

  /** Runs a pass where ac-1 is killed and ac-3 survives, and expects the re-design to be rolled back. */
  async function rolledBack(plan: Partial<Plan>, why: RegExp) {
    await setup();
    const t1 = readFileSync(T1);
    const { deps, io, calls } = fakes({ mutantRun: (ac, files) => files.map(ac === "ac-1" ? failOn("ac-1") : pass), ...plan });
    const r = await runFalsify(p, deps, io, log);
    expect(r).toMatchObject({ killed: ["ac-1"], survived: ["ac-3"], redesigned: [], vacuous: ["ac-3"], reason: "done" });
    expect(r.redesignError).toMatch(why);
    const all = await readEvents(p.ledgerFile);
    expect(all.some((e) => e.t === "design" && e.at !== at)).toBe(false);
    expect(all.find((e) => e.t === "redesign.dropped")).toMatchObject({ useCases: ["uc-1"], detail: expect.stringMatching(why) });
    expect(existsSync(T3B)).toBe(false);
    expect(readFileSync(T1).equals(t1)).toBe(true);
    const sealEv = all.filter((e) => e.t === "seal").pop() as Extract<LedgerEvent, { t: "seal" }>;
    expect(await checkSeal(p.verifierDir, sealEv.manifest, appDir)).toEqual([]);
    expect(reduce(all).acs["ac-3"]!.status).toBe("vacuous");
    // the pass still ends with the replay of the sealed tests against the real build
    expect(calls.tests.filter((t) => !t.opts.noHeal).map((t) => t.files)).toEqual([[T1, T3]]);
    return { r, calls };
  }

  it("rolls the re-design back when Kane rewrote a test file the human did not approve in it", async () => {
    await rolledBack({ onDesign: () => appendFileSync(T1, "\nAlso accept a blank result.\n") }, /nobody approved: \.testmuai\/tests\/t1_test\.md/);
  });

  it("rolls the re-design back when the human rejects the survivor's re-derived AC, so it never leaves the gate silently", async () => {
    const { calls } = await rolledBack({ approve: (items) => items.map((i) => i.ref).filter((r) => r !== "ac-3") }, /no longer holds ac-3/);
    expect(calls.review).toEqual([]); // Kane is never told to approve a design that is rolled back
  });

  it("rolls the re-design back when Kane fails during it", async () => {
    await rolledBack(
      {
        onDesign: () => {
          throw new Error("kane-cli exited with code 3");
        },
      },
      /Kane failed during the re-design: kane-cli exited with code 3/,
    );
  });

  it("restores the sealed files before stopping with tamper when the ledger is forged during the re-design", async () => {
    await setup();
    const { deps, io } = fakes({
      mutantRun: (ac, files) => files.map(ac === "ac-1" ? failOn("ac-1") : pass),
      onDesign: () => appendFileSync(p.ledgerFile, JSON.stringify({ at, t: "seal", manifest: {} }) + "\n"),
    });
    const r = await runFalsify(p, deps, io, log);
    expect(r.reason).toBe("tamper");
    expect(existsSync(T3B)).toBe(false);
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
    expect(calls.tests.filter((t) => t.opts.noHeal)).toHaveLength(4);
  });

  it("counts a pass after a heal as survived-by-heal; a second survival of a use case stays vacuous without another re-design", async () => {
    await setup({
      before: async () => {
        // an earlier pass: ac-3 survived, its use case was re-designed, and the build loop made it green again
        await log({ at, t: "mutant", id: "m-ac-3-1", ac: "ac-3", patch: PATCH["ac-3"]!, model: MODEL, usd: 0.0003, verdict: "survived" });
        await log({ at, t: "design", useCase: "uc-1", acs: [AC1, AC3], tests: testNodes(), gaps: [], credits: 9 });
        await log({ at, t: "seal", manifest: await seal(p.verifierDir, { appDir, files: appSealFiles(p) }) });
        await greenTurn(2);
      },
    });
    const { deps, io, calls } = fakes({
      mutantRun: (ac, files) => files.map(ac === "ac-1" ? failOn("ac-1") : (f) => ({ ...pass(f), healTriggered: true })),
    });
    const r = await runFalsify(p, deps, io, log);
    expect(r).toMatchObject({ killed: ["ac-1"], survived: ["ac-3"], invalid: [], redesigned: [], vacuous: ["ac-3"], reason: "done" });
    expect(calls.design).toEqual([]);
    expect(calls.approvals).toEqual([]);
    const all = await readEvents(p.ledgerFile);
    expect(all.at(-1)!.t).toBe("recordings");
    const m = all.filter((e) => e.t === "mutant").pop();
    expect(m).toMatchObject({ id: "m-ac-3-2", ac: "ac-3", verdict: "survived-by-heal", note: expect.stringContaining("heal") });
    expect(reduce(all).acs["ac-3"]!.status).toBe("vacuous");
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
  it("only a failure Kane blames on the app kills; any other failure of the AC is inconclusive", () => {
    const app = r({ status: "failed", criteriaFailed: ["ac-3"], verdict: { bugTitle: "b", family: "application_issue" } });
    expect(falsifyVerdict("ac-3", [app])).toEqual({ verdict: "killed" });
    expect(falsifyVerdict("ac-3", [r({ status: "failed", criteriaFailed: ["ac-3"] })])).toEqual({ verdict: "killed" }); // no verdict at all
    const automation = r({ status: "failed", criteriaFailed: ["ac-3"], verdict: { bugTitle: "empty form", family: "automation_bug" } });
    expect(falsifyVerdict("ac-3", [automation])).toEqual({ verdict: "invalid", note: "inconclusive: t-3: automation_bug: empty form" });
    // an inconclusive test next to tests that passed may have been the one that caught it
    expect(falsifyVerdict("ac-3", [r({}), r({ testId: "t-4", status: "error", reason: "timeout" })])).toEqual({ verdict: "invalid", note: "inconclusive: t-4: timeout" });
    // a kill by one test stands next to an inconclusive one
    expect(falsifyVerdict("ac-3", [app, r({ testId: "t-4", status: "error", reason: "timeout" })])).toEqual({ verdict: "killed" });
  });
});
