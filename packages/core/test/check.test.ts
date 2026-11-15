import { execFileSync, spawn } from "node:child_process";
import { appendFileSync, copyFileSync, existsSync, mkdirSync, mkdtempSync, readdirSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { AppStartError } from "../src/app.js";
import type { AcNode, TestNode } from "../src/kane/assurance.js";
import type { TestRunResult } from "../src/kane/testmd.js";
import { appendEvent, readEvents } from "../src/ledger/store.js";
import type { LedgerEvent } from "../src/ledger/types.js";
import { acquireCheckLock, CHECK_LOCK, checkOnce, EDIT_MARK, forAgent, markEdit, readCheckState, readEditAt, type CheckDeps } from "../src/loop/check.js";
import { appSealFiles } from "../src/loop/spec.js";
import { loadProject, type Project } from "../src/project.js";
import { seal } from "../src/seal.js";
import { logSpecAttempt } from "../src/agent/attempts.js";

const here = dirname(fileURLToPath(import.meta.url));
const fxTests = join(here, "fixtures", "kane", "tests");
const at = "2026-11-15T00:00:00.000Z";
const git = (cwd: string, ...args: string[]) => execFileSync("git", args, { cwd, encoding: "utf8" }).trim();

const AC1: AcNode = { id: "ac-1", text: "A SNAP household is eligible.", useCase: "uc-1", cites: [{ source: "prd", anchor: "L3-L3", quote: "SNAP households are eligible." }], trust: "derived" };
const AC3: AcNode = { id: "ac-3", text: "Income above the limit is not eligible.", useCase: "uc-1", cites: [], trust: "derived" };

const saved = { ...process.env };
let root: string;
let appDir: string;
let p: Project;
let T1: string;
let T3: string;
const log = (e: LedgerEvent) => appendEvent(p.ledgerFile, e);

beforeEach(() => {
  root = mkdtempSync(join(tmpdir(), "hb-check-"));
  process.env.HOLDBACK_HOME = join(root, "home");
});
afterEach(() => {
  if (saved.HOLDBACK_HOME === undefined) delete process.env.HOLDBACK_HOME;
  else process.env.HOLDBACK_HOME = saved.HOLDBACK_HOME;
  rmSync(root, { recursive: true, force: true });
});

/** An app repo with one commit, a verifier with t-1/t-3, and a ledger with a design and a seal. */
async function setup(opts: { seal?: boolean; gitInit?: boolean; config?: Record<string, unknown> } = {}) {
  appDir = join(root, "app");
  mkdirSync(appDir);
  writeFileSync(join(appDir, "PRD.md"), "# Pantry\n\nSNAP households are eligible.\n");
  writeFileSync(join(appDir, "holdback.config.json"), JSON.stringify(opts.config ?? {}));
  writeFileSync(join(appDir, "app.js"), "// v0\n");
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
    { id: "t-1", title: "SNAP household qualifies", file: ".testmuai/tests/t1_test.md", verifies: ["ac-1"] },
    { id: "t-3", title: "Above the limit is not eligible", file: ".testmuai/tests/t3_test.md", verifies: ["ac-3"] },
  ];
  await log({ at, t: "design", useCase: "uc-1", acs: [AC1, AC3], tests, gaps: [], credits: 12 });
  if (opts.seal !== false) await log({ at, t: "seal", manifest: await seal(p.verifierDir, { appDir, files: appSealFiles(p) }) });
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
const fail = (file: string): TestRunResult => ({
  ...pass(file),
  status: "failed",
  failedStep: 2,
  failedStepText: "Set Household size to 1 and Monthly household income ($) to 2462.",
  verdict: { bugTitle: "Eligibility check approves income above displayed limit", observed: "Eligible. Monthly limit for a household of 1 is $2461." },
});

type Plan = { kane: (call: number, files: string[]) => TestRunResult[]; appUp?: () => boolean };

function fakes(plan: Plan) {
  const calls = { tests: [] as string[][], starts: [] as number[], stops: 0 };
  const deps: CheckDeps = {
    port: async () => 4555,
    app: async (o) => {
      calls.starts.push(o.port);
      if (plan.appUp && !plan.appUp()) throw new AppStartError("app exited before becoming ready", "> node app.js\nError: Cannot find module 'hono'");
      return { url: `http://127.0.0.1:${o.port}`, logs: () => "", stop: async () => void calls.stops++ };
    },
    tests: async (_cwd, files) => {
      calls.tests.push([...files]);
      return plan.kane(calls.tests.length, files);
    },
  };
  return { deps, calls };
}

const kinds = async () =>
  (await readEvents(p.ledgerFile))
    .filter((e) => ["turn.start", "turn.end", "run", "recordings", "tamper", "regression"].includes(e.t))
    .map((e) => (e.t === "run" ? `run:${e.turn}:${e.result.testId}:${e.result.status}` : e.t === "turn.start" || e.t === "turn.end" ? `${e.t}:${e.n}` : e.t));

describe("checkOnce", { timeout: 60_000 }, () => {
  it("runs the owed tests on an edit, briefs the failure, then keeps that verdict while nothing changes", async () => {
    await setup();
    const { deps, calls } = fakes({ kane: (_c, files) => files.map((f) => (idOf(f) === "t-3" ? fail(f) : pass(f))) });

    const r = await checkOnce(p, deps, log, { reason: "edit" });
    expect(r).toMatchObject({ status: "checked", allowStop: false, tampered: false, ran: ["t-1", "t-3"], owed: ["ac-3"] });
    expect(r.brief.startsWith("# Holdback — 1 criterion still owed\n")).toBe(true);
    expect(r.brief).toContain("## ac-3 — Income above the limit is not eligible.");
    expect(r.brief).toContain("Kane saw: Eligible. Monthly limit for a household of 1 is $2461.");
    expect(calls.tests).toEqual([[T1, T3]]);
    expect(calls.starts).toEqual([4555]); // a free port, never the configured one the agent may be using
    expect(calls.stops).toBe(1);
    // the first check after a stop opens a turn; an edit check never closes it; recordings are anchored after the batch
    expect(await kinds()).toEqual(["recordings", "turn.start:1", "run:1:t-1:passed", "run:1:t-3:failed", "recordings"]);
    expect((await readEvents(p.ledgerFile)).find((e) => e.t === "turn.start")).toMatchObject({ owed: ["ac-1", "ac-3"] });

    const st = await readCheckState(p.home);
    expect(st).toMatchObject({ status: "checked", reason: "edit", allowStop: false, owed: ["ac-3"], ran: ["t-1", "t-3"] });
    expect(st!.tree).toMatch(/^[0-9a-f]{40}$/);

    // nothing changed: no Kane, the same verdict, and the stop closes the turn (no commit in this mode)
    const again = await checkOnce(p, deps, log, { reason: "stop" });
    expect(again).toMatchObject({ status: "unchanged", allowStop: false, ran: [], owed: ["ac-3"] });
    expect(again.brief).toBe(r.brief);
    expect(calls.tests).toHaveLength(1);
    const end = (await readEvents(p.ledgerFile)).at(-1);
    expect(end).toMatchObject({ t: "turn.end", n: 1, commit: "", filesChanged: [], appUp: true, agentExit: 0 });
    // the repo's own index and history are untouched
    expect(git(appDir, "status", "--porcelain")).toContain("?? app.js");
    expect(() => git(appDir, "rev-parse", "--verify", "-q", "HEAD")).toThrow();
  });

  it("starts the app on a fresh DATA_DIR under the home: what Kane's runs write never moves the work tree, so the verdict stands", async () => {
    await setup();
    const { deps, calls } = fakes({ kane: (_c, files) => files.map((f) => (idOf(f) === "t-3" ? fail(f) : pass(f))) });
    const dirs: string[] = [];
    const app = deps.app;
    deps.app = async (o) => {
      // an app keeps its rows in DATA_DIR, or in ./data when none is given
      const dir = o.env?.DATA_DIR ?? join(appDir, "data");
      dirs.push(dir);
      mkdirSync(dir, { recursive: true });
      expect(readdirSync(dir)).toEqual([]);
      writeFileSync(join(dir, "pantry.db"), "a booking");
      return app(o);
    };
    await checkOnce(p, deps, log, { reason: "edit" });
    expect(dirs[0]!.startsWith(join(p.home, "data"))).toBe(true);
    const again = await checkOnce(p, deps, log, { reason: "stop" });
    expect(again.status).toBe("unchanged");
    expect(calls.tests).toHaveLength(1);
  });

  it("re-runs after any work-tree change (an untracked file too), replays the passing criteria once nothing is owed, and opens the gate", async () => {
    await setup();
    let fixed = false;
    const { deps, calls } = fakes({ kane: (_c, files) => files.map((f) => (idOf(f) === "t-3" && !fixed ? fail(f) : pass(f))) });
    await checkOnce(p, deps, log, { reason: "stop" }); // turn 1, closed

    // an edit Claude Code's Edit/Write hooks never see (a shell redirect): the fingerprint still moves
    fixed = true;
    writeFileSync(join(appDir, "limits.js"), "export const LIMIT = 2461;\n");
    const r = await checkOnce(p, deps, log, { reason: "stop" });
    expect(r).toMatchObject({ status: "checked", allowStop: true, ran: ["t-3", "t-1"], owed: [] });
    expect(calls.tests).toEqual([[T1, T3], [T3], [T1]]);
    const ev = await readEvents(p.ledgerFile);
    expect(ev.filter((e) => e.t === "turn.end")).toMatchObject([
      { n: 1, commit: "" },
      { n: 2, commit: "", filesChanged: ["limits.js"], appUp: true },
    ]);
    expect(await kinds()).toEqual([
      "recordings",
      "turn.start:1",
      "run:1:t-1:passed",
      "run:1:t-3:failed",
      "recordings",
      "turn.end:1",
      "turn.start:2",
      "run:2:t-3:passed",
      "run:2:t-1:passed",
      "recordings",
      "turn.end:2",
    ]);

    // Claude Code's own folder is not the app: touching it re-runs nothing
    mkdirSync(join(appDir, ".claude"));
    writeFileSync(join(appDir, ".claude", "settings.local.json"), "{}");
    expect(await checkOnce(p, deps, log, { reason: "edit" })).toMatchObject({ status: "unchanged", allowStop: true });
    expect(calls.tests).toHaveLength(3);
  });

  it("fingerprints the tree with Kane's evidence copies on disk and a git-ignored .claude folder (left out either way)", async () => {
    await setup();
    const { deps, calls } = fakes({ kane: (_c, files) => files.map(pass) });
    writeFileSync(join(appDir, ".gitignore"), ".claude/\n");
    mkdirSync(join(appDir, ".claude"));
    writeFileSync(join(appDir, ".claude", "settings.local.json"), "{}");
    expect(await checkOnce(p, deps, log, { reason: "edit" })).toMatchObject({ status: "checked" });
    // Kane's screenshot copies land under kane-evidence/, which Holdback keeps out of git
    mkdirSync(join(appDir, "kane-evidence", "turn-1"), { recursive: true });
    writeFileSync(join(appDir, "kane-evidence", "turn-1", "t-3-step-2.png"), "png");
    writeFileSync(join(appDir, ".claude", "settings.local.json"), '{"x":1}');
    expect(await checkOnce(p, deps, log, { reason: "stop" })).toMatchObject({ status: "unchanged", allowStop: true });
    expect(calls.tests).toHaveLength(1);
  });

  it("an app that no longer starts shuts the gate even when every criterion passed before", async () => {
    await setup();
    let up = true;
    const { deps, calls } = fakes({ kane: (_c, files) => files.map(pass), appUp: () => up });
    expect(await checkOnce(p, deps, log, { reason: "stop" })).toMatchObject({ status: "checked", allowStop: true });

    up = false;
    writeFileSync(join(appDir, "app.js"), "import 'hono';\n");
    const r = await checkOnce(p, deps, log, { reason: "edit" });
    expect(r).toMatchObject({ status: "checked", allowStop: false, ran: [], owed: [] });
    expect(r.gate.allowStop).toBe(true); // the ledger alone would have let it stop
    expect(r.appStartError).toContain("Cannot find module 'hono'");
    expect(r.brief).toContain("# Holdback — The app does not start");
    expect(calls.tests).toHaveLength(1); // nothing to test this time

    // the verdict stands until the tree changes, and the stop records the app as down
    const stop = await checkOnce(p, deps, log, { reason: "stop" });
    expect(stop).toMatchObject({ status: "unchanged", allowStop: false, appStartError: expect.stringContaining("hono") });
    expect((await readEvents(p.ledgerFile)).at(-1)).toMatchObject({ t: "turn.end", n: 2, appUp: false, filesChanged: ["app.js"] });
  });

  it("a changed sealed test is a tamper: logged, marked, nothing run, and the brief sends the agent to a human", async () => {
    await setup();
    const { deps, calls } = fakes({ kane: (_c, files) => files.map(pass) });
    appendFileSync(T3, "\n## extra step\n");
    const r = await checkOnce(p, deps, log, { reason: "stop" });
    expect(r).toMatchObject({ status: "tamper", tampered: true, allowStop: false, ran: [] });
    expect(r.detail).toContain(".testmuai/tests/t3_test.md");
    // the agent learns that something sealed changed, never which of Kane's files it was
    expect(r.brief).toContain("Holdback's sealed verification files changed — a human must re-seal; ask the human to run `holdback status`.");
    expect(r.brief).not.toMatch(/holdback reseal|t3_test|\.testmuai/);
    expect(r.brief.toLowerCase()).not.toContain(p.home.toLowerCase());
    expect(calls.tests).toHaveLength(0);
    expect(existsSync(join(p.home, "TAMPERED"))).toBe(true);
    expect((await readEvents(p.ledgerFile)).at(-1)).toMatchObject({ t: "tamper" });
    // and it stays shut on the next check
    expect(await checkOnce(p, deps, log, { reason: "stop" })).toMatchObject({ status: "tamper", allowStop: false });
    expect(await readCheckState(p.home)).toMatchObject({ status: "tamper", tampered: true });
  });

  it("a spec edit alone is drift for a human: the gate stays shut but nothing is marked tampered", async () => {
    await setup();
    const { deps, calls } = fakes({ kane: (_c, files) => files.map(pass) });
    appendFileSync(join(appDir, "PRD.md"), "\nHouseholds of 9 qualify at $9,467.\n");
    const r = await checkOnce(p, deps, log, { reason: "stop" });
    expect(r).toMatchObject({ status: "drift", tampered: false, allowStop: false, detail: "spec changed since the last seal: PRD.md" });
    expect(r.brief).toContain("`holdback drift`");
    expect(calls.tests).toHaveLength(0);
    expect(existsSync(join(p.home, "TAMPERED"))).toBe(false);
    expect((await readEvents(p.ledgerFile)).some((e) => e.t === "tamper")).toBe(false);
    // the interactive agent runs all along: its origin is unverified (R37); logged once, not on every check
    await checkOnce(p, deps, log, { reason: "stop" });
    expect((await readEvents(p.ledgerFile)).filter((e) => e.t === "spec.changed")).toEqual([expect.objectContaining({ files: ["PRD.md"], duringAgentTurn: true })]);
  });

  it("a spec change after the guard logged the agent aiming a write at the spec is a tamper (R37)", async () => {
    await setup();
    const { deps } = fakes({ kane: (_c, files) => files.map(pass) });
    logSpecAttempt(p.home, { tool: "Edit", how: "edit" });
    appendFileSync(join(appDir, "PRD.md"), "\nHouseholds of 9 qualify at $9,467.\n");
    const r = await checkOnce(p, deps, log, { reason: "stop" });
    expect(r).toMatchObject({ status: "tamper", tampered: true });
    expect(r.detail).toMatch(/tried to write/);
  });

  it("a spec edit made while Kane runs is drift too: no tamper, and the agent is sent to a human", async () => {
    await setup();
    const { deps, calls } = fakes({
      kane: (_c, files) => {
        appendFileSync(join(appDir, "PRD.md"), "\nHouseholds of 9 qualify at $9,467.\n");
        return files.map(pass);
      },
    });
    const r = await checkOnce(p, deps, log, { reason: "stop" });
    expect(r).toMatchObject({ status: "drift", tampered: false, allowStop: false });
    expect(r.brief).toContain("`holdback drift`");
    expect(calls.tests).toHaveLength(1);
    expect(existsSync(join(p.home, "TAMPERED"))).toBe(false);
    const ev = await readEvents(p.ledgerFile);
    expect(ev.some((e) => e.t === "tamper")).toBe(false);
    expect(ev.filter((e) => e.t === "run")).toHaveLength(2); // Kane's results stand
    expect(ev.filter((e) => e.t === "turn.end")).toHaveLength(1); // the stop still closes the turn
    expect(ev.filter((e) => e.t === "spec.changed")).toEqual([expect.objectContaining({ duringAgentTurn: true })]);
  });

  it.each([
    ["sealed by this version", false],
    ["sealed under the older `app:./PRD.md` key", true],
  ])("a spec listed as ./PRD.md is still drift, %s", async (_name, oldKey) => {
    await setup({ config: { spec: ["./PRD.md"] }, seal: false });
    const manifest = await seal(p.verifierDir, { appDir, files: appSealFiles(p) });
    expect(Object.keys(manifest)).toContain("app:PRD.md");
    if (oldKey) {
      manifest["app:./PRD.md"] = manifest["app:PRD.md"]!;
      delete manifest["app:PRD.md"];
    }
    await log({ at, t: "seal", manifest });
    appendFileSync(join(appDir, "PRD.md"), "\nHouseholds of 9 qualify at $9,467.\n");
    const r = await checkOnce(p, fakes({ kane: (_c, f) => f.map(pass) }).deps, log, { reason: "stop" });
    expect(r).toMatchObject({ status: "drift", tampered: false, detail: "spec changed since the last seal: PRD.md" });
  });

  it("a save through Claude Code invalidates the verdict even when the file is git-ignored", async () => {
    await setup();
    const { deps, calls } = fakes({ kane: (_c, files) => files.map(pass) });
    writeFileSync(join(appDir, ".gitignore"), ".env\n");
    expect(await checkOnce(p, deps, log, { reason: "stop" })).toMatchObject({ status: "checked" });
    expect(await checkOnce(p, deps, log, { reason: "stop" })).toMatchObject({ status: "unchanged" });
    writeFileSync(join(appDir, ".env"), "LIMIT=1\n"); // invisible to the work-tree fingerprint
    // a save strictly after the last check began, and the next check strictly after the save: no
    // reliance on the clock moving between two calls (it did not, on a fast or a loaded machine)
    const lastStart = (await readCheckState(p.home))!.startedAt;
    const savedAt = Math.max(Date.now(), lastStart + 1);
    await markEdit(p.home, savedAt);
    while (Date.now() <= savedAt) await new Promise((r) => setTimeout(r, 2));
    expect(await checkOnce(p, deps, log, { reason: "stop" })).toMatchObject({ status: "checked" });
    expect(calls.tests).toHaveLength(2);
    // the check that ran after the save covers it
    expect(await checkOnce(p, deps, log, { reason: "stop" })).toMatchObject({ status: "unchanged" });
    // an unreadable mark counts as a fresh save
    rmSync(join(p.home, EDIT_MARK));
    mkdirSync(join(p.home, EDIT_MARK));
    expect(await readEditAt(p.home)).toBe(Number.POSITIVE_INFINITY);
    expect(await checkOnce(p, deps, log, { reason: "stop" })).toMatchObject({ status: "checked" });
  });

  it("an error brief never names Holdback's folders or Kane's files; the detail keeps them", async () => {
    await setup();
    // a design names a test file that is not in the seal (and not on disk): the check refuses to run it
    await log({
      at,
      t: "design",
      useCase: "uc-2",
      acs: [{ id: "ac-5", text: "x", useCase: "uc-2", cites: [], trust: "derived" }],
      tests: [{ id: "t-5", title: "five", file: ".testmuai/tests/t5_test.md", verifies: ["ac-5"] }],
      gaps: [],
      credits: 0,
    });
    const r = await checkOnce(p, fakes({ kane: (_c, f) => f.map(pass) }).deps, log, { reason: "edit" });
    expect(r.status).toBe("error");
    expect(r.detail).toContain("t5_test.md");
    expect(r.brief).toContain("Holdback could not check the app: test file not sealed: <holdback>");
    expect(r.brief).not.toMatch(/t5_test|testmuai/i);
    expect(forAgent(p, `open '${p.verifierDir.toUpperCase().replace(/\\/g, "/")}/x' and ~/.holdback/abc/ledger.jsonl and C:\\w\\.testmuai\\tests\\t1_test.md`)).toBe(
      "open '<holdback>' and <verification file> and <verification file>",
    );
  });

  it("a changed config file is still a tamper, not drift", async () => {
    await setup();
    writeFileSync(join(appDir, "holdback.config.json"), '{"start":{"cmd":"node fake.js"}}');
    expect(await checkOnce(p, fakes({ kane: (_c, f) => f.map(pass) }).deps, log, { reason: "stop" })).toMatchObject({ status: "tamper" });
  });

  it("reports unsealed before the spec stage, and an error outside a git repository", async () => {
    await setup({ seal: false });
    expect(await checkOnce(p, fakes({ kane: (_c, f) => f.map(pass) }).deps, log, { reason: "stop" })).toMatchObject({ status: "unsealed", allowStop: false });
    rmSync(root, { recursive: true, force: true });
    mkdirSync(root);
    await setup({ gitInit: false });
    const r = await checkOnce(p, fakes({ kane: (_c, f) => f.map(pass) }).deps, log, { reason: "stop" });
    expect(r).toMatchObject({ status: "error", allowStop: false });
    expect(r.brief).toContain("the root of a git repository");
  });

  it("runs again when someone else wrote the ledger since the last check (a re-seal, a drift, a headless run)", async () => {
    await setup();
    const { deps, calls } = fakes({ kane: (_c, files) => files.map(pass) });
    await checkOnce(p, deps, log, { reason: "stop" });
    await log({ at, t: "seal", manifest: await seal(p.verifierDir, { appDir, files: appSealFiles(p) }) });
    expect(await checkOnce(p, deps, log, { reason: "stop" })).toMatchObject({ status: "checked" });
    expect(calls.tests.length).toBeGreaterThan(1);
  });

  it("a Kane batch that throws leaves an error, anchors the recordings and keeps the next check running", async () => {
    await setup();
    let boom = true;
    const { deps } = fakes({
      kane: (_c, files) => {
        if (boom) throw new Error("kane-cli crashed");
        return files.map(pass);
      },
    });
    const r = await checkOnce(p, deps, log, { reason: "edit" });
    expect(r).toMatchObject({ status: "error", allowStop: false, detail: "kane-cli crashed" });
    expect((await readEvents(p.ledgerFile)).at(-1)).toMatchObject({ t: "recordings" });
    boom = false;
    expect(await checkOnce(p, deps, log, { reason: "stop" })).toMatchObject({ status: "checked", allowStop: true });
  });

  it("replays a vacuous criterion's inconclusive test with the green ones, so the gate can open again", async () => {
    await setup();
    await log({ at, t: "turn.start", n: 1, owed: ["ac-1", "ac-3"] });
    await log({ at, t: "run", kind: "build", turn: 1, result: pass(T1) });
    await log({ at, t: "run", kind: "build", turn: 1, result: pass(T3) });
    await log({ at, t: "mutant", id: "m-ac-1-1", ac: "ac-1", patch: "p", model: "m", usd: 0, verdict: "survived" });
    await log({ at, t: "run", kind: "build", turn: 1, result: { ...pass(T1), status: "error", reason: "timeout", inconclusive: "timeout" } });
    const { deps, calls } = fakes({ kane: (_c, files) => files.map(pass) });
    const r = await checkOnce(p, deps, log, { reason: "edit" });
    expect(calls.tests).toEqual([[T3, T1]]);
    expect(r).toMatchObject({ status: "checked", allowStop: true, owed: [] });
    expect(r.gate.inconclusive).toEqual([]);
  });

  it("lets the last verdict stand while owed work keeps the lingering inconclusive test out of this check", async () => {
    await setup();
    // ac-1 passed, then t-1 timed out twice; ac-3 still fails on the app
    await log({ at, t: "run", kind: "build", turn: 1, result: pass(T1) });
    await log({ at, t: "run", kind: "build", turn: 1, result: { ...pass(T1), status: "error", reason: "timeout", inconclusive: "timeout" } });
    const { deps, calls } = fakes({ kane: (_c, files) => files.map((f) => (idOf(f) === "t-3" ? fail(f) : pass(f))) });
    const first = await checkOnce(p, deps, log, { reason: "edit" });
    expect(first).toMatchObject({ status: "checked", allowStop: false, owed: ["ac-3"], inconclusive: ["t-1: timeout"] });
    expect(calls.tests).toEqual([[T3]]); // ac-3 still owed: no replay, so t-1 is not run
    // the Stop after it, on the same tree: this check would not run t-1 either, so the verdict stands
    const again = await checkOnce(p, deps, log, { reason: "stop" });
    expect(again.status).toBe("unchanged");
    expect(calls.tests).toEqual([[T3]]);
  });

  it("refuses the stop while a passing criterion's latest replay proved nothing, though nothing is owed (R34)", async () => {
    await setup();
    const timeout = (file: string): TestRunResult => ({ ...pass(file), status: "error", reason: "timeout" });
    let stuck = false;
    const { deps, calls } = fakes({ kane: (_c, files) => files.map((f) => (stuck && idOf(f) === "t-1" ? timeout(f) : pass(f))) });
    expect(await checkOnce(p, deps, log, { reason: "edit" })).toMatchObject({ status: "checked", allowStop: true, owed: [] });

    // the agent saves again: nothing owed, so Kane replays every green criterion; t-1 times out twice
    stuck = true;
    await markEdit(p.home, Date.now() + 1);
    const r = await checkOnce(p, deps, log, { reason: "stop" });
    expect(calls.tests).toEqual([[T1, T3], [T1, T3], [T1]]);
    expect(r).toMatchObject({ status: "checked", allowStop: false, owed: [], inconclusive: ["t-1: timeout"] });
    expect(r.gate.inconclusive).toEqual([{ test: "t-1", turn: 1, reason: "timeout" }]);
    expect(r.brief).not.toMatch(/timeout|t-1/);
  });

  it("a run Kane could not finish is re-run once, surfaced to the human, never briefed, and the next check runs Kane again (R34)", async () => {
    await setup();
    const timeout = (file: string): TestRunResult => ({ ...pass(file), status: "error", reason: "timeout", credits: 160 });
    const { deps, calls } = fakes({ kane: (_c, files) => files.map((f) => (idOf(f) === "t-3" ? timeout(f) : pass(f))) });
    const r = await checkOnce(p, deps, log, { reason: "edit" });
    expect(r).toMatchObject({ status: "checked", allowStop: false, owed: ["ac-3"], ran: ["t-1", "t-3"], inconclusive: ["t-3: timeout"] });
    expect(calls.tests).toEqual([[T1, T3], [T3]]);
    expect(r.brief).toContain("## ac-3 — ");
    expect(r.brief).not.toMatch(/timeout|Kane reported/);
    expect(await readCheckState(p.home)).toMatchObject({ inconclusive: ["t-3: timeout"] });

    // nothing changed, but the last verdict proved nothing about t-3: Kane runs again
    const again = await checkOnce(p, deps, log, { reason: "stop" });
    expect(again.status).toBe("checked");
    expect(calls.tests).toHaveLength(4);
  });

  it("meters the check's Kane batch by the balance", async () => {
    await setup();
    let bal = 50;
    const { deps } = fakes({ kane: (_c, files) => files.map((f) => ({ ...pass(f), credits: 1 })) });
    const tests = deps.tests;
    deps.tests = async (...a) => ((bal -= 2), tests(...a));
    deps.balance = async () => bal;
    await checkOnce(p, deps, log, { reason: "edit" });
    const credits = (await readEvents(p.ledgerFile)).filter((e) => e.t === "credits");
    expect(credits).toEqual([{ at: expect.any(String), t: "credits", source: "check", delta: 2, perRunSum: 2 }]);
  });

  it("an abort before Kane runs checks nothing", async () => {
    await setup();
    const { deps, calls } = fakes({ kane: (_c, files) => files.map(pass) });
    const ctl = new AbortController();
    ctl.abort();
    expect(await checkOnce(p, deps, log, { reason: "edit", signal: ctl.signal })).toMatchObject({ status: "aborted", allowStop: false });
    expect(calls.tests).toHaveLength(0);
  });
});

describe("acquireCheckLock", { timeout: 30_000 }, () => {
  it("lets one holder in at a time, and the next one in after release", async () => {
    const home = join(root, "h");
    const a = await acquireCheckLock(home, { waitMs: 0 });
    expect(a).not.toBeNull();
    expect(await acquireCheckLock(home, { waitMs: 150, pollMs: 20 })).toBeNull();
    let asked = 0;
    expect(await acquireCheckLock(home, { waitMs: 10_000, pollMs: 20, giveUp: () => ++asked >= 2 })).toBeNull();
    const waiting = acquireCheckLock(home, { waitMs: 10_000, pollMs: 20 });
    await new Promise((r) => setTimeout(r, 60));
    await a!.release();
    const b = await waiting;
    expect(b).not.toBeNull();
    await b!.release();
    expect(existsSync(join(home, CHECK_LOCK))).toBe(false);
  });

  it("takes over a lock whose process is gone, or that nobody touched for too long", async () => {
    const home = join(root, "h");
    mkdirSync(home, { recursive: true });
    const child = spawn(process.execPath, ["-e", ""]);
    const deadPid = await new Promise<number>((res) => child.on("exit", () => res(child.pid!)));
    writeFileSync(join(home, CHECK_LOCK), JSON.stringify({ pid: deadPid, token: "x" }));
    const a = await acquireCheckLock(home, { waitMs: 0 });
    expect(a).not.toBeNull();
    // a live holder (this process) that went quiet past the stale limit
    expect(await acquireCheckLock(home, { waitMs: 0, staleMs: 60_000 })).toBeNull();
    const old = new Date(Date.now() - 120_000);
    const { utimesSync } = await import("node:fs");
    utimesSync(join(home, CHECK_LOCK), old, old);
    const b = await acquireCheckLock(home, { waitMs: 0, staleMs: 60_000 });
    expect(b).not.toBeNull();
    await a!.release(); // no longer its lock: must not remove b's
    expect(readFileSync(join(home, CHECK_LOCK), "utf8")).toContain(String(process.pid));
    await b!.release();
  });
});
