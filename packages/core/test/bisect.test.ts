import { execFileSync } from "node:child_process";
import { copyFileSync, existsSync, mkdirSync, mkdtempSync, readdirSync, readFileSync, rmSync, symlinkSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import type { AcNode, TestNode } from "../src/kane/assurance.js";
import type { TestRunResult } from "../src/kane/testmd.js";
import { appendEvent, readEvents } from "../src/ledger/store.js";
import type { LedgerEvent } from "../src/ledger/types.js";
import { bisectRegression, BisectTampered, blameOf, lastGoodTurn, type BisectDeps } from "../src/loop/bisect.js";
import { sweepStaleWorktrees } from "../src/loop/falsify.js";
import { appSealFiles } from "../src/loop/spec.js";
import { loadProject, type Project } from "../src/project.js";
import { seal } from "../src/seal.js";

const here = dirname(fileURLToPath(import.meta.url));
const fxTests = join(here, "fixtures", "kane", "tests");
const at = "2026-11-15T00:00:00.000Z";
const git = (cwd: string, ...args: string[]) => execFileSync("git", args, { cwd, encoding: "utf8" }).trim();

const AC1: AcNode = {
  id: "ac-1",
  text: "SNAP households are eligible regardless of income.",
  useCase: "uc-1",
  cites: [],
  trust: "derived",
};

const saved = { ...process.env };
let root: string;
let appDir: string;
let p: Project;
let T1: string;
const commits = new Map<number, string>();
const log = (e: LedgerEvent) => appendEvent(p.ledgerFile, e);

beforeEach(() => {
  root = mkdtempSync(join(tmpdir(), "hb-bisect-"));
  process.env.HOLDBACK_HOME = join(root, "home");
});
afterEach(() => {
  if (saved.HOLDBACK_HOME === undefined) delete process.env.HOLDBACK_HOME;
  else process.env.HOLDBACK_HOME = saved.HOLDBACK_HOME;
  rmSync(root, { recursive: true, force: true });
});

/** An app repo with one commit per turn 1..N (each writes turn.txt) and a ledger describing them. */
async function setup(turns = 8) {
  appDir = join(root, "app");
  mkdirSync(appDir);
  writeFileSync(join(appDir, "holdback.config.json"), "{}");
  git(appDir, "init", "-q");
  git(appDir, "config", "user.name", "Test");
  git(appDir, "config", "user.email", "test@example.com");
  git(appDir, "config", "commit.gpgsign", "false");
  p = await loadProject(appDir);
  const testsDir = join(p.verifierDir, ".testmuai", "tests");
  mkdirSync(testsDir, { recursive: true });
  T1 = join(testsDir, "t1_test.md");
  copyFileSync(join(fxTests, "snap-household-qualifies-despite-above-limit-income_test.md"), T1);
  const tests: TestNode[] = [{ id: "t-1", title: "SNAP", file: ".testmuai/tests/t1_test.md", verifies: ["ac-1"] }];
  await log({ at, t: "design", useCase: "uc-1", acs: [AC1], tests, gaps: [], credits: 0 });
  await log({ at, t: "seal", manifest: await seal(p.verifierDir, { appDir, files: appSealFiles(p) }) });
  for (let n = 1; n <= turns; n++) {
    writeFileSync(join(appDir, "turn.txt"), String(n));
    writeFileSync(join(appDir, `file${n}.js`), `// ${n}\n`);
    git(appDir, "add", "-A");
    git(appDir, "commit", "-q", "-m", `turn ${n}`);
    const commit = git(appDir, "rev-parse", "--short", "HEAD");
    commits.set(n, commit);
    await log({ at, t: "turn.start", n, owed: ["ac-1"] });
    await log({ at, t: "turn.end", n, commit, filesChanged: [`file${n}.js`], durationMs: 1, appUp: true, agentExit: 0 });
  }
}

const result = (status: TestRunResult["status"], failed: boolean): TestRunResult => ({
  testFile: T1,
  testId: "t-1",
  status,
  steps: [],
  criteriaPassed: failed ? [] : ["ac-1"],
  criteriaFailed: failed ? ["ac-1"] : [],
  credits: 0,
  replayDecisions: 0,
  authorDecisions: 0,
  healTriggered: false,
  durationS: 1,
});

/** Fake app + Kane: the "app" reads turn.txt of the worktree it was started in. */
function fakes(failsFrom: number, over: Partial<BisectDeps> = {}) {
  const seen = { turns: [] as number[], cwds: [] as string[], envs: [] as Record<string, string>[], noHeal: [] as unknown[] };
  let current = 0;
  const deps: BisectDeps = {
    port: async () => 40000 + seen.turns.length,
    app: async (o) => {
      current = Number(readFileSync(join(o.cwd, "turn.txt"), "utf8"));
      seen.cwds.push(o.cwd);
      seen.envs.push(o.env ?? {});
      return { url: `http://127.0.0.1:${o.port}`, logs: () => "", stop: async () => {} };
    },
    tests: async (_cwd, files, opts) => {
      seen.turns.push(current);
      seen.noHeal.push(opts?.noHeal);
      return files.map(() => (current >= failsFrom ? result("failed", true) : result("passed", false)));
    },
    ...over,
  };
  return { deps, seen };
}

describe("bisectRegression", { timeout: 60_000 }, () => {
  it("blames turn 6 in at most 3 probes over turns 1..8", async () => {
    await setup();
    const { deps, seen } = fakes(6);
    const r = await bisectRegression(p, "ac-1", 1, 8, deps, log);
    expect(r).toEqual({ turn: 6, commit: commits.get(6) });
    expect(seen.turns.length).toBeLessThanOrEqual(3);
    expect(seen.noHeal.every((v) => v === true)).toBe(true);
    expect(new Set(seen.cwds).size).toBe(seen.cwds.length); // a worktree per probe
    expect(seen.envs.every((e) => typeof e.DATA_DIR === "string" && e.VENICE_API_KEY === "")).toBe(true);
    // a fresh data dir under the home per probe, never one inside the checked-out commit (it may hold a committed database)
    expect(new Set(seen.envs.map((e) => e.DATA_DIR)).size).toBe(seen.envs.length);
    expect(seen.envs.every((e) => e.DATA_DIR!.startsWith(join(p.home, "data")))).toBe(true);

    const events = await readEvents(p.ledgerFile);
    expect(events.filter((e) => e.t === "regression")).toEqual([
      { at: expect.any(String), t: "regression", ac: "ac-1", turn: 8, blamedTurn: 6, blamedCommit: commits.get(6) },
    ]);
    const runs = events.filter((e) => e.t === "run");
    expect(runs).toHaveLength(seen.turns.length);
    expect(runs.every((e) => e.t === "run" && e.kind === "bisect")).toBe(true);
    expect(events.some((e) => e.t === "recordings")).toBe(true);
    expect(git(appDir, "worktree", "list").split("\n")).toHaveLength(1); // probe worktrees are gone
  });

  it("blames the first turn after the good one when it already fails", async () => {
    await setup();
    const { deps, seen } = fakes(2);
    expect(await bisectRegression(p, "ac-1", 1, 8, deps, log)).toEqual({ turn: 2, commit: commits.get(2) });
    expect(seen.turns.length).toBeLessThanOrEqual(3);
  });

  it("re-probes a flaky probe once, then gives up with null and logs no blame", async () => {
    await setup();
    let calls = 0;
    const { deps } = fakes(6, {
      tests: async () => {
        calls++;
        throw new Error("kane crashed");
      },
    });
    expect(await bisectRegression(p, "ac-1", 1, 8, deps, log)).toBeNull();
    expect(calls).toBe(2);
    expect((await readEvents(p.ledgerFile)).filter((e) => e.t === "regression")).toEqual([]);
    expect(git(appDir, "worktree", "list").split("\n")).toHaveLength(1);
  });

  it("uses the re-probe's answer when the first try was flaky", async () => {
    await setup();
    const base = fakes(6);
    let first = true;
    const deps: BisectDeps = {
      ...base.deps,
      tests: async (c, f, o) => {
        if (first) {
          first = false;
          return [result("error", false)];
        }
        return base.deps.tests(c, f, o);
      },
    };
    expect(await bisectRegression(p, "ac-1", 1, 8, deps, log)).toEqual({ turn: 6, commit: commits.get(6) });
  });

  it("treats a commit whose app does not start as inconclusive", async () => {
    await setup();
    const { deps } = fakes(6, {
      app: async () => {
        throw new Error("exited");
      },
    });
    expect(await bisectRegression(p, "ac-1", 1, 8, deps, log)).toBeNull();
  });

  it("falls back to the previous commit when the bad turn recorded none", async () => {
    await setup();
    await log({ at, t: "turn.start", n: 9, owed: ["ac-1"] });
    await log({ at, t: "turn.end", n: 9, commit: "", filesChanged: [], durationMs: 1, appUp: true, agentExit: 0 });
    const { deps } = fakes(6);
    expect(await bisectRegression(p, "ac-1", 1, 9, deps, log)).toEqual({ turn: 6, commit: commits.get(6) });
  });

  it("returns null, blaming nothing, when no probe reproduces the failure", async () => {
    await setup();
    const { deps } = fakes(99);
    expect(await bisectRegression(p, "ac-1", 1, 8, deps, log)).toBeNull();
    expect((await readEvents(p.ledgerFile)).filter((e) => e.t === "regression")).toEqual([]);
  });

  it("checks the guard even when Kane returned the wrong number of results", async () => {
    await setup();
    const { deps } = fakes(6, { guard: async () => true, tests: async () => [] });
    await expect(bisectRegression(p, "ac-1", 1, 8, deps, log)).rejects.toBeInstanceOf(BisectTampered);
  });

  it("sweeps stale bisect and mut worktrees first, without touching the app's node_modules behind their links", async () => {
    await setup();
    mkdirSync(join(appDir, "node_modules", "dep"), { recursive: true });
    writeFileSync(join(appDir, "node_modules", "dep", "index.js"), "module.exports = 1;\n");
    for (const [sub, name] of [["bisect", "ac-1-4-1"], ["mut", "m-ac-1-1"]] as const) {
      const stale = join(p.home, sub, name);
      mkdirSync(dirname(stale), { recursive: true });
      git(appDir, "worktree", "add", "-q", "--detach", stale, "HEAD");
      symlinkSync(join(appDir, "node_modules"), join(stale, "node_modules"), "junction");
    }
    const { deps } = fakes(6);
    expect(await bisectRegression(p, "ac-1", 1, 8, deps, log)).toEqual({ turn: 6, commit: commits.get(6) });
    expect(readdirSync(join(p.home, "bisect"))).toEqual([]);
    expect(readdirSync(join(p.home, "mut"))).toEqual([]);
    expect(git(appDir, "worktree", "list").split("\n")).toHaveLength(1);
    expect(readFileSync(join(appDir, "node_modules", "dep", "index.js"), "utf8")).toBe("module.exports = 1;\n");
    await sweepStaleWorktrees(p); // shared entry point: a no-op on a clean home
    expect(existsSync(join(appDir, "node_modules", "dep"))).toBe(true);
  });

  it("never blames a turn on a failure Kane puts down to its own browser or replay (R34)", async () => {
    await setup();
    const { deps, seen } = fakes(6);
    const flaky = deps.tests;
    deps.tests = async (c, f, o) =>
      (await flaky(c, f, o)).map((r) => (r.status === "failed" ? { ...r, verdict: { bugTitle: "page closed", family: "environment_issue" } } : r));
    expect(await bisectRegression(p, "ac-1", 1, 8, deps, log)).toBeNull();
    expect((await readEvents(p.ledgerFile)).filter((e) => e.t === "regression")).toEqual([]);
    expect(seen.turns.length).toBeGreaterThan(1); // the probe that proved nothing was tried again
  });

  it("meters the search by Kane's balance: one credits event after it, with the probes' per-run credits", async () => {
    await setup();
    let bal = 500;
    const { deps, seen } = fakes(6, { balance: async () => bal });
    const inner = deps.tests;
    deps.tests = async (c, f, o) => {
      bal -= 3;
      return (await inner(c, f, o)).map((r) => ({ ...r, credits: 2 }));
    };
    expect(await bisectRegression(p, "ac-1", 1, 8, deps, log)).toEqual({ turn: 6, commit: commits.get(6) });
    const ev = await readEvents(p.ledgerFile);
    const probes = seen.turns.length;
    expect(ev.filter((e) => e.t === "credits")).toEqual([{ at: expect.any(String), t: "credits", source: "bisect", delta: 3 * probes, perRunSum: 2 * probes }]);
    expect(ev.at(-1)!.t).toBe("credits");
  });

  it("throws BisectTampered, logging no probe result, when the guard trips", async () => {
    await setup();
    const { deps } = fakes(6, { guard: async () => true });
    await expect(bisectRegression(p, "ac-1", 1, 8, deps, log)).rejects.toBeInstanceOf(BisectTampered);
    const events = await readEvents(p.ledgerFile);
    expect(events.filter((e) => e.t === "run" || e.t === "regression" || e.t === "recordings")).toEqual([]);
  });
});

describe("blame helpers", { timeout: 60_000 }, () => {
  it("lastGoodTurn is the last turn the AC was green before the regressing run", async () => {
    await setup(3);
    const runEv = (turn: number, passed: boolean): LedgerEvent => ({ at, t: "run", kind: "build", turn, result: result(passed ? "passed" : "failed", !passed) });
    const events = [...(await readEvents(p.ledgerFile)), runEv(1, true), runEv(2, true), runEv(5, false)];
    expect(lastGoodTurn(events, "ac-1", 5)).toBe(2);
    expect(lastGoodTurn(events, "ac-1", 1)).toBe(0);
  });

  it("blameOf keeps the newest blame and drops it after an unblamed regression", async () => {
    await setup(3);
    const base = await readEvents(p.ledgerFile);
    const blamed: LedgerEvent = { at, t: "regression", ac: "ac-1", turn: 3, blamedTurn: 2, blamedCommit: commits.get(2)! };
    expect([...blameOf([...base, blamed])]).toEqual([["ac-1", { turn: 2, commit: commits.get(2), files: ["file2.js"] }]]);
    expect(blameOf([...base, blamed, { at, t: "regression", ac: "ac-1", turn: 9 }]).size).toBe(0);
  });
});
