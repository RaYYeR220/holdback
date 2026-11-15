import { mkdirSync, mkdtempSync, readFileSync, readdirSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { registerPrd } from "./prd.ts";
import { examTodayAllowed } from "./reference.ts";
import { ensureToday, examIdOf, scoreApp } from "./score.ts";

const here = path.dirname(fileURLToPath(import.meta.url));
const PRD = path.join(here, "..", "examples", "pantry-spec", "PRD.md");
const STACK = path.join(here, "..", "examples", "pantry-spec", "STACK.md");
const fakeKane = path.join(here, "test", "fake-kane-exam.mjs");

vi.setConfig({ testTimeout: 120_000 });
const saved = { ...process.env };
let tmp: string;
let results: string;
let evalHome: string;
let appDir: string;
let log: string;

beforeEach(async () => {
  tmp = mkdtempSync(path.join(tmpdir(), "holdback-score-"));
  results = path.join(tmp, "results");
  evalHome = path.join(tmp, "home");
  appDir = path.join(tmp, "app");
  log = path.join(tmp, "kane.log");
  mkdirSync(appDir);
  writeFileSync(path.join(appDir, "package.json"), JSON.stringify({ scripts: { start: `node ${path.join(here, "test", "app.mjs").replace(/\\/g, "/")}` } }));
  process.env.HOLDBACK_KANE_BIN = fakeKane;
  process.env.FAKE_EXAM_LOG = log;
  delete process.env.FAKE_EXAM_OUTCOMES;
  await registerPrd(PRD, results, { stackPath: STACK });
});
afterEach(() => {
  process.env = { ...saved };
  rmSync(tmp, { recursive: true, force: true, maxRetries: 10, retryDelay: 200 });
});

const opts = (extra = {}) => ({ resultsDir: results, evalHome, balance: async () => 100, ...extra });
const readJson = (f: string) => JSON.parse(readFileSync(path.join(results, f), "utf8"));
const kaneCalls = () =>
  readFileSync(log, "utf8")
    .split("\n")
    .filter(Boolean)
    .map((l) => JSON.parse(l) as { cwd: string; argv: string[] });

describe("examIdOf", () => {
  it("takes e-NN from the tags", () => {
    expect(examIdOf("---\ntags: [exam, e-07]\n---\n# T\n", "x_test.md")).toBe("e-07");
  });
  it("falls back to the file name prefix", () => {
    expect(examIdOf("# T\n", "e-12-foo_test.md")).toBe("e-12");
  });
});

describe("ensureToday", () => {
  it("computes an allowed exam day once and reuses it", async () => {
    const dir = path.join(tmp, "t");
    const first = await ensureToday(dir, () => new Date(2026, 10, 15, 12));
    expect(first).toBe("2026-11-17");
    expect(examTodayAllowed(first)).toBe(true);
    expect(await ensureToday(dir, () => new Date(2027, 0, 1))).toBe(first);
    expect(JSON.parse(readFileSync(path.join(dir, "today.json"), "utf8")).computedFrom).toBe("2026-11-15");
  });
});

describe("scoreApp", () => {
  it("counts passes, records inconclusive as not passed, and writes results and summary", async () => {
    const files = readdirSync(path.join(here, "exam")).filter((f) => f.endsWith("_test.md")).sort();
    process.env.FAKE_EXAM_OUTCOMES = JSON.stringify({ [files[0]!]: "fail", [files[1]!]: "env" });
    const s = await scoreApp(appDir, "A", opts());
    expect(s.examTotal).toBe(22);
    expect(s.examPassed).toBe(20);
    expect(s.inconclusive).toBe(1);
    const a = readJson("a.json");
    expect(a.cases).toHaveLength(22);
    const byId = Object.fromEntries(a.cases.map((c: { id: string }) => [c.id, c]));
    expect(byId["e-01"]).toMatchObject({ passed: false, status: "failed", verdict: "Wrong result shown", failedStep: 2 });
    expect(byId["e-01"].inconclusive).toBeUndefined();
    expect(byId["e-02"]).toMatchObject({ passed: false });
    expect(byId["e-02"].inconclusive).toMatch(/environment_issue/);
    expect(byId["e-04"]).toMatchObject({ passed: true, credits: 0.5 });
    expect(readJson("summary.json").A).toMatchObject({ examPassed: 20, examTotal: 22, inconclusive: 1, claimedDone: false, kaneCredits: null });
  });

  it("runs every file once, with no rerun, from the arm's own verifier dir", async () => {
    process.env.FAKE_EXAM_OUTCOMES = JSON.stringify({ "e-01-one-person-at-monthly-limit_test.md": "env" });
    await scoreApp(appDir, "B", opts());
    const calls = kaneCalls();
    expect(calls).toHaveLength(22);
    expect(new Set(calls.map((c) => c.argv[2])).size).toBe(22);
    const verifier = path.join(evalHome, "exam-b");
    expect(new Set(calls.map((c) => path.resolve(c.cwd)))).toEqual(new Set([path.resolve(verifier)]));
    const vars = JSON.parse(readFileSync(path.join(verifier, ".testmuai", "variables", "exam.json"), "utf8"));
    expect(vars.start_url.value).toMatch(/^http:\/\/127\.0\.0\.1:\d+$/);
    expect(calls[0]!.argv).toContain("--override-start-url");
  });

  it("starts the app on an empty DATA_DIR with HOLDBACK_TODAY and HOLDBACK_NOW", async () => {
    await scoreApp(appDir, "A", opts({ now: () => new Date(2026, 10, 15, 12) }));
    const env = JSON.parse(readFileSync(path.join(appDir, "env.json"), "utf8"));
    expect(env).toMatchObject({ today: "2026-11-17", now: "08:00" });
    expect(env.dataDir).not.toBe("");
  });

  it("reuses today.json for a later arm, whatever the date", async () => {
    await scoreApp(appDir, "A", opts({ now: () => new Date(2026, 10, 15, 12) }));
    await scoreApp(appDir, "C", opts({ now: () => new Date(2027, 2, 1) }));
    expect(JSON.parse(readFileSync(path.join(appDir, "env.json"), "utf8")).today).toBe("2026-11-17");
    expect(readJson("today.json").today).toBe("2026-11-17");
    expect(readJson("c.json").today).toBe("2026-11-17");
    expect(Object.keys(readJson("summary.json")).sort()).toEqual(["A", "C"]);
  });

  it("takes the arm's run record into the summary and the balance delta into its score", async () => {
    writeFileSync(
      path.join(results, "b-run.json"),
      JSON.stringify({ arm: "B", claimedDone: true, turns: 41, agentUsd: 3.2, breakerUsd: 0, wallMin: 12.5, kaneCredits: 150 }),
    );
    let n = 0;
    await scoreApp(appDir, "B", opts({ balance: async () => (n++ === 0 ? 100 : 89.5) }));
    expect(readJson("summary.json").B).toEqual({
      examPassed: 22,
      examTotal: 22,
      inconclusive: 0,
      claimedDone: true,
      turns: 41,
      kaneCredits: 150,
      agentUsd: 3.2,
      breakerUsd: 0,
      wallMin: 12.5,
    });
    expect(readJson("b.json").kaneCredits).toBe(10.5);
  });

  it("refuses when the PRD lines the exam depends on changed", async () => {
    const md = readFileSync(path.join(results, "prd-final.md"), "utf8").replace("Eligible.", "Eligible!");
    writeFileSync(path.join(results, "prd-final.md"), md);
    await expect(scoreApp(appDir, "A", opts())).rejects.toThrow(/changed|no longer matches/);
    expect(() => readFileSync(log)).toThrow();
  });

  it("refuses without a registered final PRD", async () => {
    await expect(scoreApp(appDir, "A", opts({ resultsDir: path.join(tmp, "empty") }))).rejects.toThrow(/no final PRD/);
  });

  it("scores an arm once", async () => {
    await scoreApp(appDir, "A", opts());
    await expect(scoreApp(appDir, "A", opts())).rejects.toThrow(/scored once/);
  });
});
