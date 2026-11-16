import type { RunTestOptions, TestRunResult } from "./testmd.js";

/**
 * The verdict families (Kane 0.10.4) that put a failure down to Kane's own side: its browser or
 * platform, its own replay or authoring. Matched trimmed and case-insensitively. Any other family,
 * `application_issue` or one Holdback does not know, is the app's failure: unknown fails closed.
 */
const NOT_THE_APP = new Set(["environment_issue", "automation_bug"]);

/**
 * Why a run that did not pass says nothing about the app, or undefined when it did pass or failed
 * on the app. The verdict family is read first, whatever the run's status: one in `NOT_THE_APP` is
 * not the app's, any other is. With no family: a Holdback timeout or a crash (no complete run, or
 * Kane ending neither passed nor failed) is not the app's; a plain failure is. A run already found
 * inconclusive stays so. Pure: the ledger reducer reads old and new results through it.
 */
export function notAnAppFailure(r: TestRunResult): string | undefined {
  if (r.inconclusive !== undefined) return r.inconclusive;
  if (r.status === "passed") return undefined;
  const family = r.verdict?.family?.trim().toLowerCase() ?? "";
  if (NOT_THE_APP.has(family)) return `${family}${r.verdict?.bugTitle ? `: ${r.verdict.bugTitle}` : ""}`;
  if (family !== "") return undefined;
  if (r.status === "error") return r.reason === "timeout" ? "timeout" : `crash: ${r.reason ?? "no result"}`;
  // Kane finished without a pass or a fail and blamed nothing: not an assertion failure
  if (r.status === "broken") return `crash: ${r.reason ?? "Kane reported no outcome"}`;
  return undefined;
}

/**
 * True when `r` kills a planted bug in `acId` (R44): it failed the criterion and Kane blamed the app,
 * its verdict family `application_issue`. A failure with no family, or one Holdback does not know,
 * fails closed here: it is never a kill. Pure: the dashboard words a replay with it.
 */
export function killsAc(r: TestRunResult, acId: string): boolean {
  return r.status !== "passed" && r.inconclusive === undefined && r.criteriaFailed.includes(acId) && r.verdict?.family?.trim().toLowerCase() === "application_issue";
}

/** `<test>: <why>` for a human-facing line. */
export function inconclusiveNote(r: TestRunResult): string {
  return `${r.testId ?? r.testFile}: ${notAnAppFailure(r) ?? "inconclusive"}`;
}

type Batch = (cwd: string, files: string[], opts?: RunTestOptions & { parallel?: number }) => Promise<TestRunResult[]>;

/**
 * Starts the app under test again before a re-run (stopped, then up on a new, empty data dir, so the
 * re-run never meets the rows the first attempt left half-written). Resolves to its start URL;
 * throws when it does not come back.
 */
export type Restart = () => Promise<string>;

const round = (n: number) => Math.round(n * 1e4) / 1e4;
const errText = (e: unknown) => (e instanceof Error ? e.message : String(e));

/**
 * One Kane batch whose verdicts can be trusted: every run that failed for a reason other than the
 * app (`notAnAppFailure`) is run once more, with the same options, against the app as `restart`
 * brings it back (without one, while the app is still up). The re-run's result stands, with both
 * attempts' credits and time; one that fails that way again is marked `inconclusive`, and so is
 * every run due a re-run when the app does not come back for it. Throws when a batch returns the
 * wrong number of results.
 */
export async function runSettled(
  tests: Batch,
  cwd: string,
  files: string[],
  opts: RunTestOptions & { parallel?: number } = {},
  restart?: Restart,
): Promise<TestRunResult[]> {
  const first = await tests(cwd, files, opts);
  if (first.length !== files.length) throw new Error(`Kane returned ${first.length} results for ${files.length} tests`);
  const again = first.flatMap((r, i) => (notAnAppFailure(r) === undefined ? [] : [i]));
  if (again.length === 0) return first;
  let retryOpts = opts;
  if (restart) {
    try {
      retryOpts = { ...opts, startUrl: await restart() };
    } catch (e) {
      const out = [...first];
      for (const i of again) out[i] = { ...first[i]!, inconclusive: `${notAnAppFailure(first[i]!)}; not re-run: the app did not start again (${errText(e)})` };
      return out;
    }
  }
  const second = await tests(
    cwd,
    again.map((i) => files[i]!),
    retryOpts,
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
