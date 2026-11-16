import { readFileSync } from "node:fs";
import path from "node:path";
import { runKane } from "./run.js";
import type { KaneEvent } from "./ndjson.js";
import { parseTestMd } from "./testmd-parse.js";

export { parseTestMd } from "./testmd-parse.js";
export { inconclusiveNote, killsAc, notAnAppFailure, runSettled, type Restart } from "./outcome.js";

export type BugVerdict = {
  bugTitle: string;
  rootCause?: string;
  suggestion?: string;
  severity?: string;
  confidence?: number;
  oneLiner?: string;
  observed?: string;
  culpritStep?: string;
  /**
   * Kane's verdict family: `application_issue` blames the app; `environment_issue` (browser,
   * platform) and `automation_bug` (Kane's own replay or authoring) do not.
   */
  family?: string;
  category?: string;
};

export type TestRunResult = {
  testFile: string;
  testId: string | null;
  status: "passed" | "failed" | "broken" | "error";
  failedStep?: number;
  failedStepText?: string;
  steps: { index: number; status: string; durationS: number }[];
  verdict?: BugVerdict;
  screenshot?: string;
  criteriaPassed: string[];
  criteriaFailed: string[];
  credits: number;
  replayDecisions: number;
  authorDecisions: number;
  healTriggered: boolean;
  evidencePack?: string;
  durationS: number;
  reason?: string;
  /** Why the first attempt was run again: it failed for a reason other than the app (`runSettled`). */
  retried?: string;
  /**
   * Set when the run (after one re-run) still failed for a reason other than the app: a Kane
   * environment or automation verdict, a timeout or a crash. Such a run proves nothing either way:
   * no criterion changes status on it and no mutant is killed by it.
   */
  inconclusive?: string;
};

export type RunTestOptions = {
  startUrl?: string;
  noHeal?: boolean;
  /**
   * Kane's `--timeout`: it bounds each step (every step is its own Kane agent run), not the whole
   * test. The process is killed only after `timeoutS` for every step of the test, plus `graceS`.
   */
  timeoutS?: number;
  /** Extra seconds on top of the steps' timeouts before the process is killed. Default 30. */
  graceS?: number;
};

const DEFAULT_TIMEOUT_S = 600;

const str = (v: unknown): string => (typeof v === "string" ? v : "");
const num = (v: unknown): number | undefined => (typeof v === "number" && Number.isFinite(v) ? v : undefined);
const isObj = (v: unknown): v is Record<string, unknown> => v !== null && typeof v === "object" && !Array.isArray(v);
const strs = (v: unknown): string[] => (Array.isArray(v) ? v.filter((x): x is string => typeof x === "string") : []);

/** The failure Kane reported last: after an adaptive heal, an earlier failure no longer stands. */
function verdictFrom(events: KaneEvent[]): { verdict?: BugVerdict; screenshot?: string } {
  const failedEnd = events.findLast((e) => e.type === "run_end" && e.status === "failed");
  const rich = isObj(failedEnd?.verdict) ? failedEnd.verdict : undefined;
  const screenshot = str(failedEnd?.screenshot_path) || undefined;
  const out: { verdict?: BugVerdict; screenshot?: string } = screenshot ? { screenshot } : {};
  if (rich && str(rich.bug_title)) {
    const v: BugVerdict = { bugTitle: str(rich.bug_title) };
    if (str(rich.root_cause)) v.rootCause = str(rich.root_cause);
    if (str(rich.suggestion)) v.suggestion = str(rich.suggestion);
    if (str(rich.severity)) v.severity = str(rich.severity);
    const conf = num(rich.confidence);
    if (conf !== undefined) v.confidence = conf;
    if (str(rich.one_liner)) v.oneLiner = str(rich.one_liner);
    const sig = Array.isArray(rich.signals) ? rich.signals.find(isObj) : undefined;
    if (str(sig?.excerpt)) v.observed = str(sig?.excerpt);
    if (str(rich.culprit_step)) v.culpritStep = str(rich.culprit_step);
    if (str(rich.family)) v.family = str(rich.family);
    if (str(rich.category)) v.category = str(rich.category);
    out.verdict = v;
    return out;
  }
  const bug = events.findLast((e) => e.type === "test_md_bug_verdict");
  if (bug && str(bug.bug_title)) {
    const v: BugVerdict = { bugTitle: str(bug.bug_title) };
    if (str(bug.severity)) v.severity = str(bug.severity);
    const conf = num(bug.confidence);
    if (conf !== undefined) v.confidence = conf;
    if (str(bug.one_liner)) v.oneLiner = str(bug.one_liner);
    if (str(bug.family)) v.family = str(bug.family);
    if (str(bug.category)) v.category = str(bug.category);
    out.verdict = v;
  }
  return out;
}

/** Parse the test file Kane is about to run; a relative path is relative to Kane's cwd. Null when unreadable. */
function readTestMd(cwd: string, testFile: string): ReturnType<typeof parseTestMd> | null {
  try {
    return parseTestMd(readFileSync(path.resolve(cwd, testFile), "utf8"));
  } catch {
    return null; // unreadable test file: Kane will report it
  }
}

function emptyResult(testFile: string, testId: string | null): TestRunResult {
  return {
    testFile,
    testId,
    status: "error",
    steps: [],
    criteriaPassed: [],
    criteriaFailed: [],
    credits: 0,
    replayDecisions: 0,
    authorDecisions: 0,
    healTriggered: false,
    durationS: 0,
  };
}

export async function runTest(cwd: string, testFile: string, opts: RunTestOptions = {}): Promise<TestRunResult> {
  const timeoutS = opts.timeoutS ?? DEFAULT_TIMEOUT_S;
  const args = ["testmd", "run", testFile, "--agent", "--headless", "--timeout", String(timeoutS)];
  if (opts.startUrl) args.push("--override-start-url", opts.startUrl);
  if (opts.noHeal) args.push("--no-adaptive-heal");

  const parsed = readTestMd(cwd, testFile);
  // a whole-run kill at one step's timeout lost a long authoring run (and its credits) mid-way
  const steps = Math.max(1, parsed?.steps.length ?? 1);

  const r = await runKane(args, { cwd, timeoutMs: (timeoutS * steps + (opts.graceS ?? 30)) * 1000 });
  const ev = r.events;

  const result = emptyResult(testFile, parsed?.id ?? null);
  result.durationS = r.durationMs / 1000;

  let credits = 0;
  for (const e of ev) {
    if (e.type !== "run_end") continue;
    credits += num(e.credits_consumed) ?? 0;
    if (isObj(e.verdict)) credits += num(e.verdict.credits_consumed) ?? 0;
  }
  result.credits = Math.round(credits * 1e4) / 1e4;

  // an adaptive heal re-runs steps and Kane emits them again: the last entry of each step stands
  const byStep = new Map<number, TestRunResult["steps"][number]>();
  for (const e of ev) {
    if (e.type !== "test_md_step_end") continue;
    const index = num(e.step_index) ?? 0;
    byStep.set(index, { index, status: str(e.status), durationS: num(e.duration_s) ?? 0 });
  }
  result.steps = [...byStep.values()];
  const failed = result.steps.find((s) => s.status === "failed");
  if (failed) result.failedStep = failed.index;
  const summary = ev.find((e) => e.type === "test_md_summary");
  if (summary) {
    const s = isObj(summary.steps) ? summary.steps : {};
    result.replayDecisions = num(s.replay_decisions) ?? 0;
    result.authorDecisions = num(s.author_decisions) ?? 0;
    result.healTriggered = isObj(summary.adaptive_heal) && summary.adaptive_heal.triggered === true;
  }
  const cov = ev.find((e) => e.type === "coverage");
  if (cov) {
    if (str(cov.pack)) result.evidencePack = str(cov.pack);
    if (isObj(cov.this_run)) {
      result.criteriaPassed = strs(cov.this_run.criteria_passed);
      result.criteriaFailed = strs(cov.this_run.criteria_failed);
    }
  }
  const done = ev.find((e) => e.type === "test_md_done");
  const overall = str(done?.overall_status);
  if (r.timedOut) {
    result.status = "error";
    result.reason = "timeout";
  } else if (!done) {
    result.status = "error";
    const err = ev.find((e) => e.type === "error");
    result.reason = str(err?.message) || r.stderr.trim() || `kane-cli exited with code ${r.exitCode} without test_md_done`;
  } else {
    result.status = overall === "passed" ? "passed" : overall === "failed" ? "failed" : "broken";
    if (result.status !== "passed") {
      const failing = ev.findLast((e) => e.type === "run_end" && e.status !== "passed");
      const reason = str(failing?.reason);
      if (reason) result.reason = reason;
    }
  }
  // a run that passed (after a heal, maybe) keeps nothing of the failures it got past
  if (result.status === "passed") delete result.failedStep;
  else Object.assign(result, verdictFrom(ev));

  // broken/error runs may end on a step whose status is not "failed": point at the first step that did not pass
  if (result.failedStep === undefined && result.status !== "passed") {
    result.failedStep = result.steps.find((s) => s.status !== "passed")?.index;
  }
  if (result.failedStep !== undefined) {
    const text = parsed?.steps.find((s) => s.n === result.failedStep)?.text;
    if (text) result.failedStepText = text;
  }
  return result;
}

export async function runTests(
  cwd: string,
  files: string[],
  opts: RunTestOptions & { parallel?: number } = {},
): Promise<TestRunResult[]> {
  const { parallel, ...rest } = opts;
  const limit = Math.max(1, Math.floor(parallel ?? 1));
  const results = new Array<TestRunResult>(files.length);
  let next = 0;
  const worker = async () => {
    for (;;) {
      const i = next++;
      if (i >= files.length) return;
      const file = files[i]!;
      try {
        results[i] = await runTest(cwd, file, rest);
      } catch (e) {
        // one run that cannot start (spawn error) must not discard the rest of the batch
        results[i] = { ...emptyResult(file, readTestMd(cwd, file)?.id ?? null), reason: e instanceof Error ? e.message : String(e) };
      }
    }
  };
  await Promise.all(Array.from({ length: Math.min(limit, files.length) }, worker));
  return results;
}
