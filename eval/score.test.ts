import { existsSync, mkdtempSync, readFileSync, readdirSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { registerPrd } from "./prd.ts";
import { examTodayAllowed } from "./reference.ts";
import { ensureToday, examIdOf, parseMinCredits, scoreApp } from "./score.ts";
import { FAKE_KANE, GIT, MODEL, PRD, STACK, makeAppRepo, writeRun } from "./test/helpers.ts";
import { commitAll } from "@holdback/core";

vi.setConfig({ testTimeout: 120_000 });
const here = path.dirname(fileURLToPath(import.meta.url));

const saved = { ...process.env };
let tmp: string;
let results: string;
let evalHome: string;
let appDir: string;
let head: string;
let log: string;
let envFile: string;
const installs: string[] = [];

beforeEach(async () => {
  tmp = mkdtempSync(path.join(tmpdir(), "holdback-score-"));
  results = path.join(tmp, "results");
  evalHome = path.join(tmp, "home");
  appDir = path.join(tmp, "app");
  log = path.join(tmp, "kane.log");
  envFile = path.join(tmp, "env.json");
  installs.length = 0;
  process.env.HOLDBACK_KANE_BIN = FAKE_KANE;
  process.env.FAKE_EXAM_LOG = log;
  process.env.FAKE_APP_ENV_FILE = envFile;
  delete process.env.FAKE_EXAM_OUTCOMES;
  delete process.env.FAKE_APP_BOOT;
  await registerPrd(PRD, STACK, MODEL, results);
  head = await makeAppRepo(appDir);
  for (const a of ["A", "B", "C"] as const) writeRun(results, a, appDir, head);
});
afterEach(() => {
  process.env = { ...saved };
  rmSync(tmp, { recursive: true, force: true, maxRetries: 10, retryDelay: 200 });
});

const opts = (extra = {}) => ({
  resultsDir: results,
  evalHome,
  balance: async () => 5000,
  install: async (cwd: string) => void installs.push(cwd),
  ...extra,
});
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
  it("refuses a stored day the exam does not allow", async () => {
    const dir = path.join(tmp, "t2");
    await ensureToday(dir, () => new Date(2026, 10, 15, 12));
    writeFileSync(path.join(dir, "today.json"), JSON.stringify({ today: "2026-11-16" })); // a Monday
    await expect(ensureToday(dir)).rejects.toThrow(/not an allowed exam day/);
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
    expect(a.head).toBe(head);
    const byId = Object.fromEntries(a.cases.map((c: { id: string }) => [c.id, c]));
    expect(byId["e-01"]).toMatchObject({ passed: false, status: "failed", verdict: "Wrong result shown", failedStep: 2 });
    expect(byId["e-01"].inconclusive).toBeUndefined();
    expect(byId["e-02"].inconclusive).toMatch(/environment_issue/);
    expect(byId["e-04"]).toMatchObject({ passed: true, credits: 0.5 });
    expect(readJson("summary.json").A).toMatchObject({ examPassed: 20, examTotal: 22, inconclusive: 1, claimedDone: true, turns: 10, agentUsd: 1.5 });
  });

  it("scores a clean checkout of the recorded HEAD, installed the same way, not the working tree", async () => {
    writeFileSync(path.join(appDir, "stray.txt"), "uncommitted");
    await scoreApp(appDir, "A", opts());
    expect(installs).toHaveLength(1);
    expect(path.resolve(installs[0]!)).not.toBe(path.resolve(appDir));
    const env = JSON.parse(readFileSync(envFile, "utf8"));
    expect(path.resolve(env.cwd)).toBe(path.resolve(installs[0]!));
    expect(existsSync(installs[0]!)).toBe(false); // removed afterwards
    // a later commit does not change what the recorded HEAD scores
    writeFileSync(path.join(appDir, "later.txt"), "x");
    await commitAll(appDir, "later", GIT);
    await scoreApp(appDir, "B", opts());
    expect(readJson("b.json").head).toBe(head);
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
    // like every other caller: the app's root URL with its trailing slash (M13)
    expect(calls[0]!.argv[calls[0]!.argv.indexOf("--override-start-url") + 1]).toMatch(/^http:\/\/127\.0\.0\.1:\d+\/$/);
  });

  it("starts the app on an empty DATA_DIR with HOLDBACK_TODAY and HOLDBACK_NOW", async () => {
    await scoreApp(appDir, "A", opts({ now: () => new Date(2026, 10, 15, 12) }));
    const env = JSON.parse(readFileSync(envFile, "utf8"));
    expect(env).toMatchObject({ today: "2026-11-17", now: "08:00" });
    expect(env.dataDir).not.toBe("");
  });

  it("reuses today.json for a later arm, whatever the date", async () => {
    await scoreApp(appDir, "A", opts({ now: () => new Date(2026, 10, 15, 12) }));
    await scoreApp(appDir, "C", opts({ now: () => new Date(2027, 2, 1) }));
    expect(JSON.parse(readFileSync(envFile, "utf8")).today).toBe("2026-11-17");
    expect(readJson("c.json").today).toBe("2026-11-17");
    expect(Object.keys(readJson("summary.json")).sort()).toEqual(["A", "C"]);
  });

  it("takes the arm's run record into the summary and the balance delta into its score", async () => {
    writeRun(results, "B", appDir, head, { claimedDone: false, turns: 41, agentUsd: 3.2, breakerUsd: 0, wallMin: 12.5, kaneCredits: 150 });
    let n = 0;
    await scoreApp(appDir, "B", opts({ balance: async () => (n++ < 2 ? 5000 : 4989.5) }));
    expect(readJson("summary.json").B).toEqual({
      examPassed: 22,
      examTotal: 22,
      inconclusive: 0,
      claimedDone: false,
      turns: 41,
      kaneCredits: 150,
      agentUsd: 3.2,
      breakerUsd: 0,
      wallMin: 12.5,
      stopReason: "done",
    });
    expect(readJson("b.json").kaneCredits).toBe(10.5);
  });

  it("keeps a figure the run record does not hold as null, never zero", async () => {
    writeRun(results, "C", appDir, head, { turns: null, agentUsd: null, wallMin: null, kaneCredits: null });
    await scoreApp(appDir, "C", opts());
    expect(readJson("summary.json").C).toMatchObject({ turns: null, agentUsd: null, wallMin: null, kaneCredits: null });
  });

  it("refuses without a run record", async () => {
    rmSync(path.join(results, "a-run.json"));
    await expect(scoreApp(appDir, "A", opts())).rejects.toThrow(/record the arm's build first/);
  });

  it("refuses when the arm's PRD, STACK or model differs from the registration", async () => {
    writeRun(results, "A", appDir, head, { model: "another-model" });
    await expect(scoreApp(appDir, "A", opts())).rejects.toThrow(/model/);
    writeRun(results, "B", appDir, head, { stackSha256: "0".repeat(64) });
    await expect(scoreApp(appDir, "B", opts())).rejects.toThrow(/STACK\.md/);
    writeRun(results, "C", appDir, head, { prdSha256: "1".repeat(64) });
    await expect(scoreApp(appDir, "C", opts())).rejects.toThrow(/PRD\.md/);
    expect(existsSync(log)).toBe(false);
  });

  it("refuses when the PRD lines the exam depends on changed", async () => {
    const md = readFileSync(path.join(results, "prd-final.md"), "utf8").replace("Not eligible.", "Not eligible!");
    writeFileSync(path.join(results, "prd-final.md"), md);
    await expect(scoreApp(appDir, "A", opts())).rejects.toThrow(/changed|no longer matches/);
    expect(existsSync(log)).toBe(false);
  });

  it("refuses without a registered final PRD", async () => {
    await expect(scoreApp(appDir, "A", opts({ resultsDir: path.join(tmp, "empty") }))).rejects.toThrow(/no final PRD/);
  });

  it("refuses when the exam files differ from the registered ones", async () => {
    const dir = path.join(tmp, "exam");
    const { cpSync } = await import("node:fs");
    cpSync(path.join(here, "exam"), dir, { recursive: true });
    await scoreApp(appDir, "A", opts({ examDir: dir }));
    const f = path.join(dir, "e-03-one-person-at-weekly-limit_test.md");
    writeFileSync(f, readFileSync(f, "utf8") + "x");
    await expect(scoreApp(appDir, "B", opts({ examDir: dir }))).rejects.toThrow(/no longer matches its registered hash/);
    rmSync(path.join(dir, "e-04-one-person-over-weekly-limit_test.md"));
    await expect(scoreApp(appDir, "C", opts({ examDir: dir }))).rejects.toThrow(/expected the 22 registered exam files/);
  });

  it("refuses when the Kane balance cannot cover the exam", async () => {
    await expect(scoreApp(appDir, "A", opts({ balance: async () => 100 }))).rejects.toThrow(/below the exam estimate/);
    expect(existsSync(path.join(results, "a.attempt.json"))).toBe(false);
  });

  it("scores an arm once: the attempt is on record, a second one is refused", async () => {
    await scoreApp(appDir, "A", opts());
    expect(readJson("a.attempt.json")).toMatchObject({ arm: "A", head });
    await expect(scoreApp(appDir, "A", opts())).rejects.toThrow(/scored once/);
  });

  it("an app that will not boot scores 0 of 22, recorded as the app's failure, and cannot be retried", async () => {
    process.env.FAKE_APP_BOOT = "fail";
    const s = await scoreApp(appDir, "A", opts({ start: { timeoutMs: 5000 } }));
    expect(s).toMatchObject({ examPassed: 0, examTotal: 22, inconclusive: 0 });
    expect(s.appFailure).toMatch(/did not boot/);
    expect(existsSync(log)).toBe(false);
    expect(readJson("summary.json").A).toMatchObject({ examPassed: 0, examTotal: 22 });
    delete process.env.FAKE_APP_BOOT;
    await expect(scoreApp(appDir, "A", opts())).rejects.toThrow(/scored once/);
  });

  it("an install that fails scores 0 of 22 too", async () => {
    const s = await scoreApp(
      appDir,
      "A",
      opts({
        install: async () => {
          throw new Error("npm install failed (exit 1)");
        },
      }),
    );
    expect(s.examPassed).toBe(0);
    expect(s.appFailure).toMatch(/install failed/);
  });
});

describe("parseMinCredits", () => {
  it("takes a finite number of 0 or more and nothing else", () => {
    expect(parseMinCredits(undefined)).toBeUndefined();
    expect(parseMinCredits("500")).toBe(500);
    expect(parseMinCredits("0")).toBe(0);
    for (const bad of ["abc", "", " ", "Infinity", "NaN", "-5"]) expect(() => parseMinCredits(bad)).toThrow(/--min-credits/);
  });
});

describe("summary notes", () => {
  it("carries the run's stop reason and an app failure into summary.json", async () => {
    writeRun(results, "A", appDir, head, { stopReason: "transient-exhausted", claimedDone: false });
    process.env.FAKE_APP_BOOT = "fail";
    await scoreApp(appDir, "A", opts({ start: { timeoutMs: 5000 } }));
    expect(readJson("summary.json").A).toMatchObject({ stopReason: "transient-exhausted", claimedDone: false, appFailure: expect.stringMatching(/did not boot/) });
  });

  it("carries C's spec-stage split, B's assurance count and C's unmeasured batches", async () => {
    writeRun(results, "B", appDir, head, { assuranceCallsUsed: 2 });
    writeRun(results, "C", appDir, head, { specCredits: 40, specMinutes: 5, kaneUnmeasured: 1, turnsWithoutCost: 2 });
    await scoreApp(appDir, "B", opts());
    await scoreApp(appDir, "C", opts());
    const s = readJson("summary.json");
    expect(s.B.assuranceCallsUsed).toBe(2);
    expect(s.C).toMatchObject({ specCredits: 40, specMinutes: 5, kaneUnmeasured: 1, turnsWithoutCost: 2 });
  });
});
