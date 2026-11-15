import { mkdtempSync, readFileSync } from "node:fs";
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
  it("no done event is an error", async () => {
    delete process.env.FAKE_KANE_FIXTURE;
    process.env.FAKE_KANE_EXIT = "1";
    const r = await runTest(cwd, T3, {});
    expect(r.status).toBe("error");
  });
});

describe("runTests", () => {
  it("returns results in input order", async () => {
    use("05-replay-t3.ndjson");
    const rs = await runTests(cwd, [T3, T1, T3], { parallel: 2 });
    expect(rs.map((r) => r.testFile)).toEqual([T3, T1, T3]);
    expect(rs.map((r) => r.testId)).toEqual(["t-3", "t-1", "t-3"]);
  });
});
