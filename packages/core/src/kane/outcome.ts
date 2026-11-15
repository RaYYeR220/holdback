import type { RunTestOptions, TestRunResult } from "./testmd.js";

/** The only verdict family that blames the app (Kane 0.10.4: also `environment_issue`, `automation_bug`). */
const APP_FAMILY = "application_issue";

/**
 * Why a run that did not pass says nothing about the app, or undefined when it did pass or failed
 * on the app. Only Kane's `application_issue`, or a plain assertion failure with no verdict family,
 * is a product failure. Everything else is not: another verdict family (Kane's browser or
 * platform, its own replay or authoring), a Holdback timeout, a crash (no complete run), or a run
 * already found inconclusive. Pure: the ledger reducer reads old and new results through it.
 */
export function notAnAppFailure(r: TestRunResult): string | undefined {
  if (r.inconclusive !== undefined) return r.inconclusive;
  if (r.status === "passed") return undefined;
  if (r.status === "error") return r.reason === "timeout" ? "timeout" : `crash: ${r.reason ?? "no result"}`;
  const family = r.verdict?.family;
  if (family !== undefined && family !== "") {
    return family === APP_FAMILY ? undefined : `${family}${r.verdict?.bugTitle ? `: ${r.verdict.bugTitle}` : ""}`;
  }
  // Kane finished without a pass or a fail and blamed nothing: not an assertion failure
  if (r.status === "broken") return `crash: ${r.reason ?? "Kane reported no outcome"}`;
  return undefined;
}

/** `<test>: <why>` for a human-facing line. */
export function inconclusiveNote(r: TestRunResult): string {
  return `${r.testId ?? r.testFile}: ${notAnAppFailure(r) ?? "inconclusive"}`;
}

type Batch = (cwd: string, files: string[], opts?: RunTestOptions & { parallel?: number }) => Promise<TestRunResult[]>;

const round = (n: number) => Math.round(n * 1e4) / 1e4;

/**
 * One Kane batch whose verdicts can be trusted: every run that failed for a reason other than the
 * app (`notAnAppFailure`) is run once more, with the same options, while the app is still up. The
 * re-run's result stands, with both attempts' credits and time; one that fails that way again is
 * marked `inconclusive`. Throws when a batch returns the wrong number of results.
 */
export async function runSettled(tests: Batch, cwd: string, files: string[], opts: RunTestOptions & { parallel?: number } = {}): Promise<TestRunResult[]> {
  const first = await tests(cwd, files, opts);
  if (first.length !== files.length) throw new Error(`Kane returned ${first.length} results for ${files.length} tests`);
  const again = first.flatMap((r, i) => (notAnAppFailure(r) === undefined ? [] : [i]));
  if (again.length === 0) return first;
  const second = await tests(
    cwd,
    again.map((i) => files[i]!),
    opts,
  );
  if (second.length !== again.length) throw new Error(`Kane returned ${second.length} results for ${again.length} tests`);
  const out = [...first];
  for (const [k, i] of again.entries()) {
    const was = first[i]!;
    const r = second[k]!;
    const merged: TestRunResult = { ...r, credits: round(was.credits + r.credits), durationS: round(was.durationS + r.durationS), retried: notAnAppFailure(was)! };
    const still = notAnAppFailure(r);
    if (still !== undefined) merged.inconclusive = still;
    out[i] = merged;
  }
  return out;
}
