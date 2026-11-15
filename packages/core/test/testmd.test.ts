import { copyFileSync, mkdirSync, mkdtempSync, readFileSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join, dirname } from "node:path";
import { fileURLToPath } from "node:url";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { parseTestMd } from "../src/kane/testmd-parse.js";
import { notAnAppFailure, runSettled, runTest, runTests, type TestRunResult } from "../src/kane/testmd.js";

const here = dirname(fileURLToPath(import.meta.url));
const fakeBin = join(here, "fake-kane.mjs");
const fx = (n: string) => join(here, "fixtures", "kane", n);
const T1 = fx("tests/snap-household-qualifies-despite-above-limit-income_test.md");
const T3 = fx("tests/non-snap-household-above-2-461-is-not-eligible_test.md");

const saved = { ...process.env };
let cwd: string;
let argvLog: string;
beforeEach(() => {
  cwd = mkdtempSync(join(tmpdir(), "holdback-testmd-"));
  argvLog = join(cwd, "argv.log");
  process.env.HOLDBACK_KANE_BIN = fakeBin;
  process.env.FAKE_KANE_ARGV_LOG = argvLog;
  delete process.env.FAKE_KANE_EXIT;
  delete process.env.FAKE_KANE_HANG;
});
afterEach(() => {
  for (const k of ["HOLDBACK_KANE_BIN", "FAKE_KANE_FIXTURE", "FAKE_KANE_ARGV_LOG", "FAKE_KANE_EXIT", "FAKE_KANE_HANG"]) {
    if (saved[k] === undefined) delete process.env[k];
    else process.env[k] = saved[k];
  }
});
const use = (n: string) => {
  process.env.FAKE_KANE_FIXTURE = fx(n);
};

describe("parseTestMd", () => {
  it("reads id, title and steps with verifies", () => {
    const p = parseTestMd(readFileSync(T3, "utf8"));
    expect(p.id).toBe("t-3");
    expect(p.title).toMatch(/non-SNAP/i);
    expect(p.steps).toHaveLength(2);
    expect(p.steps[1]?.n).toBe(2);
    expect(p.steps[1]?.verifies).toEqual(["ac-3", "ac-4", "ac-5"]);
    expect(p.steps[1]?.text).toMatch(/^On the/);
  });
  it("handles dash-assert headers and missing frontmatter", () => {
    const p = parseTestMd("# T\n\n## Step 1 — assert @verifies ac-1, ac-2\n\nDo it.\n");
    expect(p.id).toBeNull();
    expect(p.steps[0]).toEqual({ n: 1, verifies: ["ac-1", "ac-2"], text: "Do it." });
  });
});

describe("runTest", () => {
  it("authoring run passes", async () => {
    use("04-run-t3.ndjson");
    const r = await runTest(cwd, T3, { startUrl: "http://127.0.0.1:1/" });
    expect(r.status).toBe("passed");
    expect(r.authorDecisions).toBe(2);
    expect(r.credits).toBeCloseTo(36.2, 0);
    expect(r.criteriaPassed).toContain("ac-3");
    expect(r.testId).toBe("t-3");
    const argv = JSON.parse(readFileSync(argvLog, "utf8").trim().split("\n")[0]!) as string[];
    expect(argv).toEqual(["testmd", "run", T3, "--agent", "--headless", "--timeout", "600", "--override-start-url", "http://127.0.0.1:1/"]);
  });
  it("replay run passes for free", async () => {
    use("05-replay-t3.ndjson");
    const r = await runTest(cwd, T3, {});
    expect(r.status).toBe("passed");
    expect(r.credits).toBe(0);
    expect(r.replayDecisions).toBe(2);
    expect(r.failedStep).toBeUndefined();
  });
  it("mutant run fails with verdict", async () => {
    use("06-mutant-t3.ndjson");
    const r = await runTest(cwd, T3, { noHeal: true, startUrl: "http://x/" });
    expect(r.status).toBe("failed");
    expect(r.failedStep).toBe(2);
    expect(r.failedStepText).toMatch(/^On the/);
    expect(r.verdict?.bugTitle).toBe("Eligibility check approves income above displayed limit");
    expect(r.verdict?.observed?.startsWith("Eligible. Monthly limit")).toBe(true);
    expect(r.screenshot?.endsWith("step_008.png")).toBe(true);
    expect(r.criteriaFailed).toEqual(["ac-3", "ac-4", "ac-5"]);
    expect(r.credits).toBeCloseTo(2.63, 1);
    expect(r.evidencePack).toMatch(/\.evidence$/);
    expect(r.healTriggered).toBe(false);
    const argv = JSON.parse(readFileSync(argvLog, "utf8").trim().split("\n")[0]!) as string[];
    expect(argv).toContain("--no-adaptive-heal");
  });
  it("hang becomes error/timeout", async () => {
    process.env.FAKE_KANE_HANG = "1";
    delete process.env.FAKE_KANE_FIXTURE;
    const r = await runTest(cwd, T3, { timeoutS: 1, graceS: 0 });
    expect(r.status).toBe("error");
    expect(r.reason).toBe("timeout");
  });
  it("gives every step the Kane timeout before the whole run is killed", async () => {
    // live smoke: Kane's --timeout bounds each step (each step is its own agent run). An 11-step
    // authoring run (~40 s a step) was killed at timeoutS + 30 s with 9 steps done: 165 credits lost
    process.env.FAKE_KANE_HANG = "1";
    delete process.env.FAKE_KANE_FIXTURE;
    const file = join(cwd, "three_test.md");
    writeFileSync(file, "---\nassurance:\n  id: t-9\n---\n# Three\n\n## Step 1 @verifies ac-1\n\nOne.\n\n## Step 2 @verifies ac-1\n\nTwo.\n\n## Step 3 @verifies ac-1\n\nThree.\n");
    const r = await runTest(cwd, file, { timeoutS: 1, graceS: 0 });
    expect(r.reason).toBe("timeout");
    expect(r.durationS).toBeGreaterThanOrEqual(2.9);
    const argv = JSON.parse(readFileSync(argvLog, "utf8").trim().split("\n")[0]!) as string[];
    expect(argv.slice(argv.indexOf("--timeout"), argv.indexOf("--timeout") + 2)).toEqual(["--timeout", "1"]);
  });
  it("no done event is an error", async () => {
    delete process.env.FAKE_KANE_FIXTURE;
    process.env.FAKE_KANE_EXIT = "1";
    const r = await runTest(cwd, T3, {});
    expect(r.status).toBe("error");
    expect(r.reason).toMatch(/exited with code 1/);
  });
  it("reads a relative test file against the run cwd, not the process cwd", async () => {
    use("06-mutant-t3.ndjson");
    mkdirSync(join(cwd, "tests"));
    copyFileSync(T3, join(cwd, "tests", "t3_test.md"));
    const r = await runTest(cwd, "tests/t3_test.md", {});
    expect(r.testFile).toBe("tests/t3_test.md");
    expect(r.testId).toBe("t-3");
    expect(r.failedStepText).toMatch(/^On the/);
  });
  it("gives a broken run the first step that did not pass", async () => {
    const fixture = join(cwd, "broken.ndjson");
    const ev = (o: Record<string, unknown>) => JSON.stringify({ v: 1, ...o });
    writeFileSync(
      fixture,
      [
        ev({ type: "test_md_step_end", step_index: 1, status: "passed", duration_s: 3 }),
        ev({ type: "run_end", status: "error", reason: "element not found" }),
        ev({ type: "test_md_step_end", step_index: 2, status: "error", duration_s: 9 }),
        ev({ type: "test_md_done", overall_status: "error" }),
      ].join("\n") + "\n",
    );
    process.env.FAKE_KANE_FIXTURE = fixture;
    const r = await runTest(cwd, T3, {});
    expect(r.status).toBe("broken");
    expect(r.failedStep).toBe(2);
    expect(r.failedStepText).toMatch(/^On the/);
    expect(r.reason).toBe("element not found");
  });
});

// Captured in the first live run (Task 15b), sanitized: shapes the spike did not record.
describe("runTest on live Kane 0.10.4 output", () => {
  it("a replay that healed: passed, heal triggered, both billed calls counted", async () => {
    // step 4 replayed on an empty form, Kane healed it (adaptive heal from step 3) and re-ran it
    use("11-heal-replay-t1.ndjson");
    const r = await runTest(cwd, fx("tests/income-above-limit-returns-not-eligible-without-snap_test.md"), {});
    expect(r.testId).toBe("t-1");
    expect(r.status).toBe("passed");
    expect(r.healTriggered).toBe(true);
    expect(r.replayDecisions).toBe(4);
    expect(r.credits).toBeCloseTo(2.55945 + 15.0233125, 4); // the failed replay's verdict, then the re-authored step
    expect(r.criteriaPassed).toEqual(["ac-2", "ac-5", "ac-6", "ac-7", "ac-8", "ac-9", "ac-10", "ac-11"]);
    expect(r.criteriaFailed).toEqual([]);
    // the pre-heal failure (step 4, automation_bug) is gone: the run passed
    expect(r.failedStep).toBeUndefined();
    expect(r.failedStepText).toBeUndefined();
    expect(r.verdict).toBeUndefined();
    expect(r.screenshot).toBeUndefined();
    expect(r.reason).toBeUndefined();
    // steps 1-4 were re-emitted after the heal: one entry each, the last one
    expect(r.steps.map((s) => [s.index, s.status])).toEqual([
      [1, "passed"],
      [2, "passed"],
      [3, "passed"],
      [4, "passed"],
    ]);
    expect(r.steps[3]!.durationS).toBe(45.8);
  });

  it("keeps Kane's verdict family: application_issue on a mutant replay, environment_issue on a broken-off run", async () => {
    use("06-mutant-t3.ndjson");
    const app = await runTest(cwd, T3, { noHeal: true });
    expect(app.verdict).toMatchObject({ family: "application_issue", category: "functional_defect" });
    use("12-env-failure-t3.ndjson");
    const env = await runTest(cwd, fx("tests/inclusive-limits-and-published-household-size-schedule_test.md"), {});
    expect(env.verdict).toMatchObject({ family: "environment_issue", category: "platform_failure" });
  });

  it("a healed run that still failed reports the failure after the heal, not the one before it", async () => {
    const fixture = join(cwd, "healed-fail.ndjson");
    const ev = (o: Record<string, unknown>) => JSON.stringify({ v: 1, ...o });
    const failedEnd = (title: string, family: string) => ev({ type: "run_end", status: "failed", reason: title, verdict: { bug_title: title, family } });
    writeFileSync(
      fixture,
      [
        ev({ type: "test_md_step_end", step_index: 1, status: "passed", duration_s: 1 }),
        failedEnd("empty form", "automation_bug"),
        ev({ type: "test_md_step_end", step_index: 2, status: "failed", duration_s: 2 }),
        ev({ type: "test_md_adaptive_heal", shrink_count: 1 }),
        ev({ type: "test_md_step_end", step_index: 1, status: "passed", duration_s: 1 }),
        ev({ type: "run_end", status: "passed", reason: "Objective completed", credits_consumed: 3 }),
        ev({ type: "test_md_step_end", step_index: 2, status: "passed", duration_s: 5 }),
        failedEnd("limit off by one", "application_issue"),
        ev({ type: "test_md_step_end", step_index: 3, status: "failed", duration_s: 4 }),
        ev({ type: "test_md_done", overall_status: "failed" }),
      ].join("\n") + "\n",
    );
    process.env.FAKE_KANE_FIXTURE = fixture;
    const r = await runTest(cwd, T3, {});
    expect(r.status).toBe("failed");
    expect(r.steps.map((s) => [s.index, s.status])).toEqual([
      [1, "passed"],
      [2, "passed"],
      [3, "failed"],
    ]);
    expect(r.failedStep).toBe(3);
    expect(r.verdict).toMatchObject({ bugTitle: "limit off by one", family: "application_issue" });
    expect(r.reason).toBe("limit off by one");
  });

  it("an authoring run that Kane's browser broke off: failed, nothing failed in coverage, the verdict kept", async () => {
    // Kane classes it environment_issue / platform_failure; its coverage fails no criterion
    use("12-env-failure-t3.ndjson");
    const r = await runTest(cwd, fx("tests/inclusive-limits-and-published-household-size-schedule_test.md"), {});
    expect(r.testId).toBe("t-3");
    expect(r.status).toBe("failed");
    expect(r.failedStep).toBe(2);
    expect(r.criteriaPassed).toEqual(["ac-8", "ac-9", "ac-10", "ac-11"]);
    expect(r.criteriaFailed).toEqual([]);
    expect(r.verdict?.bugTitle).toBe("Browser target closed before screenshot capture");
    expect(r.authorDecisions).toBe(11);
    expect(r.credits).toBeGreaterThan(0);
  });
});

describe("runTests", () => {
  it("returns results in input order", async () => {
    use("05-replay-t3.ndjson");
    const rs = await runTests(cwd, [T3, T1, T3], { parallel: 2 });
    expect(rs.map((r) => r.testFile)).toEqual([T3, T1, T3]);
    expect(rs.map((r) => r.testId)).toEqual(["t-3", "t-1", "t-3"]);
  });
  it("turns a thrown run into an error result instead of rejecting the batch", async () => {
    process.env.HOLDBACK_KANE_BIN = join(cwd, "no-such-kane-binary");
    const rs = await runTests(cwd, [T3, T1], { parallel: 2 });
    expect(rs.map((r) => r.status)).toEqual(["error", "error"]);
    expect(rs.map((r) => r.testFile)).toEqual([T3, T1]);
    expect(rs.map((r) => r.testId)).toEqual(["t-3", "t-1"]);
    expect(rs[0]!.reason).toMatch(/ENOENT|not found|no-such-kane-binary/i);
    expect(rs[0]!.credits).toBe(0);
  });
});

describe("notAnAppFailure / runSettled (R34: Kane's verdict family gates everything)", () => {
  const base = (over: Partial<TestRunResult> = {}): TestRunResult => ({
    testFile: "t3_test.md",
    testId: "t-3",
    status: "failed",
    steps: [],
    criteriaPassed: [],
    criteriaFailed: ["ac-3"],
    credits: 1,
    replayDecisions: 0,
    authorDecisions: 0,
    healTriggered: false,
    durationS: 10,
    ...over,
  });
  const verdict = (family?: string) => ({ bugTitle: "something broke", ...(family ? { family } : {}) });

  it("only Kane's known non-app families, a timeout or a crash are not app failures; anything else fails closed on the app", () => {
    expect(notAnAppFailure(base({ status: "passed", criteriaFailed: [] }))).toBeUndefined();
    expect(notAnAppFailure(base({ verdict: verdict("application_issue") }))).toBeUndefined();
    expect(notAnAppFailure(base())).toBeUndefined(); // a plain assertion failure
    expect(notAnAppFailure(base({ verdict: verdict() }))).toBeUndefined(); // a verdict without a family (older Kane)
    expect(notAnAppFailure(base({ status: "broken", verdict: verdict("application_issue") }))).toBeUndefined();
    expect(notAnAppFailure(base({ verdict: verdict("environment_issue") }))).toBe("environment_issue: something broke");
    expect(notAnAppFailure(base({ verdict: verdict("automation_bug") }))).toBe("automation_bug: something broke");
    // compared trimmed and case-insensitively
    expect(notAnAppFailure(base({ verdict: verdict("  Environment_Issue ") }))).toBe("environment_issue: something broke");
    expect(notAnAppFailure(base({ verdict: verdict("AUTOMATION_BUG") }))).toBe("automation_bug: something broke");
    // a family Holdback does not know (a new Kane, a typo) is the app's failure: fail closed
    expect(notAnAppFailure(base({ verdict: verdict("tooling_glitch") }))).toBeUndefined();
    expect(notAnAppFailure(base({ status: "broken", verdict: verdict("platform_hiccup") }))).toBeUndefined();
    expect(notAnAppFailure(base({ verdict: verdict("environment issue") }))).toBeUndefined();
    expect(notAnAppFailure(base({ status: "error", reason: "timeout" }))).toBe("timeout");
    expect(notAnAppFailure(base({ status: "error", reason: "spawn kane-cli ENOENT" }))).toBe("crash: spawn kane-cli ENOENT");
    expect(notAnAppFailure(base({ status: "broken", reason: "Kane exited mid-run" }))).toBe("crash: Kane exited mid-run");
    expect(notAnAppFailure(base({ inconclusive: "timeout" }))).toBe("timeout");
  });

  it("the live captures: a broken-off authoring run is not the app's failure, a mutant's failed replay is", async () => {
    use("12-env-failure-t3.ndjson");
    const env = await runTest(cwd, fx("tests/inclusive-limits-and-published-household-size-schedule_test.md"), {});
    expect(notAnAppFailure(env)).toBe("environment_issue: Browser target closed before screenshot capture");
    use("06-mutant-t3.ndjson");
    expect(notAnAppFailure(await runTest(cwd, T3, { noHeal: true }))).toBeUndefined();
  });

  type Call = { files: string[]; opts: unknown };
  const scripted = (answers: TestRunResult[][]) => {
    const calls: Call[] = [];
    const tests: typeof runTests = async (_cwd, files, opts) => {
      calls.push({ files: [...files], opts });
      return answers[calls.length - 1]!;
    };
    return { tests, calls };
  };

  it("re-runs only the runs that failed for a reason other than the app, once, with the same options", async () => {
    const env = base({ testFile: "a", testId: "t-1", verdict: verdict("environment_issue"), credits: 2, durationS: 5 });
    const app = base({ testFile: "b", testId: "t-2", verdict: verdict("application_issue") });
    const ok = base({ testFile: "c", testId: "t-3", status: "passed", criteriaFailed: [], criteriaPassed: ["ac-3"] });
    const retried = base({ testFile: "a", testId: "t-1", status: "passed", criteriaFailed: [], criteriaPassed: ["ac-1"], credits: 3, durationS: 7 });
    const { tests, calls } = scripted([[env, app, ok], [retried]]);
    const rs = await runSettled(tests, "/v", ["a", "b", "c"], { startUrl: "http://x/", parallel: 2 });
    expect(calls).toEqual([
      { files: ["a", "b", "c"], opts: { startUrl: "http://x/", parallel: 2 } },
      { files: ["a"], opts: { startUrl: "http://x/", parallel: 2 } },
    ]);
    expect(rs[0]).toMatchObject({ testId: "t-1", status: "passed", credits: 5, durationS: 12, retried: "environment_issue: something broke" });
    expect(rs[0]!.inconclusive).toBeUndefined();
    expect(rs[1]).toBe(app);
    expect(rs[2]).toBe(ok);
  });

  it("marks a run that fails for a reason other than the app twice as inconclusive", async () => {
    const timeout = base({ status: "error", reason: "timeout", criteriaFailed: [], credits: 160 });
    const env = base({ verdict: verdict("environment_issue"), credits: 9.6 });
    const { tests, calls } = scripted([[timeout], [env]]);
    const [r] = await runSettled(tests, "/v", ["t3"], {});
    expect(calls).toHaveLength(2);
    expect(r).toMatchObject({ retried: "timeout", inconclusive: "environment_issue: something broke", credits: 169.6 });
  });

  it("runs nothing more when every run passed or failed on the app", async () => {
    const { tests, calls } = scripted([[base({ verdict: verdict("application_issue") }), base({ status: "passed", criteriaFailed: [] })]]);
    await runSettled(tests, "/v", ["x", "y"], {});
    expect(calls).toHaveLength(1);
  });

  it("a re-run that returns the wrong number of results is an error, like a short batch", async () => {
    const { tests } = scripted([[base({ status: "error", reason: "timeout" })], []]);
    await expect(runSettled(tests, "/v", ["x"], {})).rejects.toThrow("Kane returned 0 results for 1 tests");
  });
});
