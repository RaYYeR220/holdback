import { mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import type { AcNode, TestNode } from "../src/kane/assurance.js";
import { runTest, type TestRunResult } from "../src/kane/testmd.js";
import { reduce } from "../src/ledger/reduce.js";
import type { LedgerEvent } from "../src/ledger/types.js";
import { buildBrief } from "../src/loop/brief.js";

const here = dirname(fileURLToPath(import.meta.url));
const T3 = join(here, "fixtures", "kane", "tests", "non-snap-household-above-2-461-is-not-eligible_test.md");
const at = "2026-11-15T00:00:00.000Z";

const ac = (id: string, text: string, cite?: { anchor: string; quote: string }): AcNode => ({
  id,
  text,
  useCase: "uc-1",
  cites: cite ? [{ source: "prd", ...cite }] : [],
  trust: "derived",
});

// ACs, cites and test wiring as Kane designed them for the pantry PRD (fixtures/kane/context-*).
const AC1 = ac("ac-1", "When someone in the household receives SNAP, the household's eligibility result is “Eligible.” regardless of monthly income.", {
  anchor: "L12-L12",
  quote: "A household where someone receives SNAP is eligible regardless of income.",
});
const AC3 = ac("ac-3", "For a household without SNAP, monthly income above the applicable limit produces “Not eligible.”", {
  anchor: "L10-L10",
  quote: "A household is eligible when its monthly income is at or below the monthly limit for its size.",
});
const AC6 = ac("ac-6", "The page displays an input labelled “Household size”.", {
  anchor: "L7-L7",
  quote: 'The page "Food pantry eligibility check" has a field labelled "Household size".',
});
const TESTS: TestNode[] = [
  { id: "t-1", title: "SNAP household qualifies despite above-limit income", file: "t1_test.md", verifies: ["ac-1"] },
  { id: "t-3", title: "Non-SNAP household above $2,461 is not eligible", file: "t3_test.md", verifies: ["ac-3", "ac-6"] },
];
const design = (acs: AcNode[] = [AC1, AC3, AC6]): LedgerEvent => ({ at, t: "design", useCase: "uc-1", acs, tests: TESTS, gaps: [], credits: 0 });
const run = (result: TestRunResult, turn = 1): LedgerEvent => ({ at, t: "run", kind: "build", turn, result });

// The real failing replay of t-3 against the `<= lim + 1` mutant, parsed by runTest from the recorded NDJSON.
let mutantRun: TestRunResult;
const saved = { ...process.env };
beforeAll(async () => {
  process.env.HOLDBACK_KANE_BIN = join(here, "fake-kane.mjs");
  process.env.FAKE_KANE_FIXTURE = join(here, "fixtures", "kane", "06-mutant-t3.ndjson");
  delete process.env.FAKE_KANE_SEQUENCE;
  mutantRun = await runTest(mkdtempSync(join(tmpdir(), "hb-brief-")), T3, {});
});
afterAll(() => {
  for (const k of ["HOLDBACK_KANE_BIN", "FAKE_KANE_FIXTURE"]) {
    if (saved[k] === undefined) delete process.env[k];
    else process.env[k] = saved[k];
  }
});

const SCREENSHOT = "~\\.testmuai\\kaneai\\sessions\\750d58db-e6a4-46b9-9667-d5d4dd0c9745\\scratch\\1\\replay-test\\screenshots/step_008.png";
const AC3_FAILED = [
  "## ac-3 — For a household without SNAP, monthly income above the applicable limit produces “Not eligible.”",
  'Spec: "A household is eligible when its monthly income is at or below the monthly limit for its size." (prd L10-L10)',
  "Kane ran: On the “Food pantry eligibility check” page, set Household size to 1 and Monthly household income ($) to 2462, leave “Someone in the household receives SNAP” unselected, and request “Check eligibility”; then assert the result below the button says “Not eligible.” and states the applied monthly limit of $2,461.",
  "Kane saw: Eligible. Monthly limit for a household of 1 is $2461.",
  "Kane's diagnosis: Eligibility check approves income above displayed limit — The eligibility decision is using the wrong boundary for income at the stated monthly limit.",
  "Suggested: Correct the income comparison so an income of $2,462 is not eligible when the displayed limit is $2,461, then add a boundary test for one dollar above the limit.",
  `Screenshot: ${SCREENSHOT}`,
];

describe("buildBrief", () => {
  it("lists never-run ACs with their spec line only", () => {
    expect(buildBrief(reduce([design()]), {})).toBe(
      [
        "# Holdback — 3 criteria still owed",
        "",
        "## ac-1 — When someone in the household receives SNAP, the household's eligibility result is “Eligible.” regardless of monthly income.",
        'Spec: "A household where someone receives SNAP is eligible regardless of income." (prd L12-L12)',
        "",
        "## ac-3 — For a household without SNAP, monthly income above the applicable limit produces “Not eligible.”",
        'Spec: "A household is eligible when its monthly income is at or below the monthly limit for its size." (prd L10-L10)',
        "",
        "## ac-6 — The page displays an input labelled “Household size”.",
        'Spec: "The page "Food pantry eligibility check" has a field labelled "Household size"." (prd L7-L7)',
        "",
      ].join("\n"),
    );
  });

  it("writes a failed AC as a bug report with Kane's full verdict, and drops ACs that pass", () => {
    expect(mutantRun.status).toBe("failed");
    const state = reduce([design(), run(mutantRun)]);
    expect(state.acs["ac-6"]!.status).toBe("passing");
    expect(buildBrief(state, {})).toBe(
      [
        "# Holdback — 2 criteria still owed",
        "",
        "## ac-1 — When someone in the household receives SNAP, the household's eligibility result is “Eligible.” regardless of monthly income.",
        'Spec: "A household where someone receives SNAP is eligible regardless of income." (prd L12-L12)',
        "",
        ...AC3_FAILED,
        "",
      ].join("\n"),
    );
  });

  it("lists regressed ACs before owed ones and marks them", () => {
    const broke: TestRunResult = {
      ...mutantRun,
      criteriaPassed: [],
      criteriaFailed: ["ac-6"],
      failedStep: 1,
      failedStepText: "At {{start_url}}, open the page and assert it has an input labelled “Household size”.",
      verdict: { bugTitle: "Household size input missing", observed: "No input labelled “Household size” on the page." },
      screenshot: "shot-2.png",
    };
    const state = reduce([design(), run(mutantRun, 1), run(broke, 2)]);
    expect(state.acs["ac-6"]!.status).toBe("regressed");
    const brief = buildBrief(state, {});
    expect(brief.startsWith("# Holdback — 3 criteria still owed\n\n## ac-6 — The page displays an input labelled “Household size”.\n")).toBe(true);
    expect(brief).toContain(
      [
        "## ac-6 — The page displays an input labelled “Household size”.",
        "Regressed: this passed on an earlier turn and fails now.",
        'Spec: "The page "Food pantry eligibility check" has a field labelled "Household size"." (prd L7-L7)',
        "Kane ran: At {{start_url}}, open the page and assert it has an input labelled “Household size”.",
        "Kane saw: No input labelled “Household size” on the page.",
        "Kane's diagnosis: Household size input missing",
        "Screenshot: shot-2.png",
      ].join("\n"),
    );
    expect(brief.indexOf("## ac-6")).toBeLessThan(brief.indexOf("## ac-1"));
    expect(brief.indexOf("## ac-1")).toBeLessThan(brief.indexOf("## ac-3"));
    expect(brief).toContain(AC3_FAILED.join("\n"));
  });

  it("is only the start failure and the last 40 log lines when the app does not start", () => {
    const log = Array.from({ length: 60 }, (_, i) => `log line ${i + 1}`).join("\n");
    const brief = buildBrief(reduce([design(), run(mutantRun)]), { appStartError: log + "\napp exited before becoming ready" });
    const tail = [...Array.from({ length: 39 }, (_, i) => `log line ${i + 22}`), "app exited before becoming ready"];
    expect(brief).toBe(
      [
        "# Holdback — The app does not start",
        "",
        "The app does not start, so Kane could not check any criterion this turn. Make it boot and answer HTTP on the port in the PORT environment variable before anything else.",
        "",
        "Last lines of the app log:",
        "",
        "```",
        ...tail,
        "```",
        "",
      ].join("\n"),
    );
    expect(brief).not.toContain("## ac-");
  });

  it("fences a log that itself contains a code fence", () => {
    const brief = buildBrief(reduce([design()]), { appStartError: "```\noops" });
    expect(brief).toContain("````\n```\noops\n````\n");
  });

  it("omits the Spec line when an AC has no cite, and reports a failure without a verdict", () => {
    const timeout: TestRunResult = {
      ...mutantRun,
      status: "error",
      reason: "timeout",
      criteriaPassed: [],
      criteriaFailed: [],
      verdict: undefined,
      screenshot: undefined,
      failedStep: undefined,
      failedStepText: undefined,
    };
    const state = reduce([design([AC1, ac("ac-3", "No cite here."), AC6]), run(timeout)]);
    const brief = buildBrief(state, {});
    expect(brief).toContain("## ac-3 — No cite here.\nKane reported: timeout\n");
    expect(brief).not.toContain("Kane saw:");
  });

  it("falls back to Kane's one-liner when the verdict has no observed excerpt", () => {
    const thin: TestRunResult = {
      ...mutantRun,
      verdict: { bugTitle: "Eligibility check approves income above displayed limit", oneLiner: "Marks $2,462 eligible under a $2,461 limit." },
    };
    const brief = buildBrief(reduce([design(), run(thin)]), {});
    expect(brief).toContain("Kane saw: Marks $2,462 eligible under a $2,461 limit.\nKane's diagnosis: Eligibility check approves income above displayed limit\n");
  });

  it("caps the listed ACs at maxItems, keeps the full count, and names the notes file", () => {
    const brief = buildBrief(reduce([design()]), { maxItems: 1, notes: "STACK.md" });
    expect(brief).toBe(
      [
        "# Holdback — 3 criteria still owed",
        "",
        "Stack and style notes: STACK.md",
        "",
        "## ac-1 — When someone in the household receives SNAP, the household's eligibility result is “Eligible.” regardless of monthly income.",
        'Spec: "A household where someone receives SNAP is eligible regardless of income." (prd L12-L12)',
        "",
        "…and 2 more not shown.",
        "",
      ].join("\n"),
    );
  });

  it("uses the singular for one owed AC and sorts ids numerically", () => {
    expect(buildBrief(reduce([design([AC1])]), {}).split("\n")[0]).toBe("# Holdback — 1 criterion still owed");
    const many = ["ac-10", "ac-2", "ac-1"].map((id) => ac(id, id));
    const tests: TestNode[] = [{ id: "t-9", title: "t", file: "t9_test.md", verifies: ["ac-10", "ac-2", "ac-1"] }];
    const brief = buildBrief(reduce([{ at, t: "design", useCase: "uc-1", acs: many, tests, gaps: [], credits: 0 }]), {});
    expect(brief.match(/^## ac-\d+/gm)).toEqual(["## ac-1", "## ac-2", "## ac-10"]);
  });
});
