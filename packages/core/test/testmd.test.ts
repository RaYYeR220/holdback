import { copyFileSync, mkdirSync, mkdtempSync, readFileSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join, dirname } from "node:path";
import { fileURLToPath } from "node:url";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { parseTestMd } from "../src/kane/testmd-parse.js";
import { runTest, runTests } from "../src/kane/testmd.js";

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
