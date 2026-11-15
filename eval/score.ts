import { spawn } from "node:child_process";
import { copyFile, mkdir, mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import {
  AppStartError,
  PortInUse,
  balance,
  freePort,
  notAnAppFailure,
  runTests,
  startApp,
  worktreeAdd,
  worktreeRemove,
  git,
  type BalanceReader,
  type StartAppOptions,
  type TestRunResult,
} from "@holdback/core";
import { assertPrdRegistered, DEFAULT_RESULTS_DIR, EVAL_DIR, PrdChanged, verifiedExamFiles, verifyInputs } from "./prd.ts";
import { EXAM_NOW, examTodayAllowed, nextExamToday } from "./reference.ts";
import { runFile, type ArmId, type ArmRun } from "./run-arm.ts";

export type ExamCase = {
  /** `e-NN`, from the test's `tags`. */
  id: string;
  file: string;
  status: TestRunResult["status"];
  passed: boolean;
  /** Set when the run failed for a reason other than the app: counts as not passed. */
  inconclusive?: string;
  failedStep?: number;
  verdict?: string;
  healTriggered: boolean;
  credits: number;
  durationS: number;
};

export type ExamScore = {
  arm: ArmId;
  appDir: string;
  /** The commit that was scored: a clean checkout of it, not the working tree. */
  head: string;
  today: string;
  now: string;
  examTotal: number;
  examPassed: number;
  inconclusive: number;
  /** Set when the app could not be installed or would not boot: 0 of 22, recorded as the app's failure. */
  appFailure?: string;
  /** Kane credits the exam run used, by the balance (null when unreadable) and by Kane's per-run figures. */
  kaneCredits: number | null;
  perRunCredits: number;
  scoredAt: string;
  cases: ExamCase[];
};

export type SummaryEntry = {
  examPassed: number;
  examTotal: number;
  inconclusive: number;
  claimedDone: boolean;
  turns: number | null;
  kaneCredits: number | null;
  agentUsd: number | null;
  breakerUsd: number | null;
  wallMin: number | null;
};
export type Summary = Partial<Record<ArmId, SummaryEntry>>;

/** Rough Kane credits one exam case costs: scoring is refused when the balance cannot cover all 22. */
export const CREDITS_PER_CASE_ESTIMATE = 30;

export type ScoreOptions = {
  resultsDir?: string;
  examDir?: string;
  /** Home of the per-arm exam verifier dirs (`<evalHome>/exam-<arm>/`). Default: HOLDBACK_EVAL_HOME or `~/.holdback-eval`. */
  evalHome?: string;
  start?: { cmd?: string; readyPath?: string; port?: number; timeoutMs?: number };
  /** The same scripted install for every arm, run in the clean checkout. Default: `npm install`. */
  install?: (cwd: string) => Promise<void>;
  /** Refuse to start when the Kane balance is below this. Default: 22 cases x CREDITS_PER_CASE_ESTIMATE. */
  minCredits?: number;
  parallel?: number;
  timeoutS?: number;
  balance?: BalanceReader;
  now?: () => Date;
  tests?: typeof runTests;
  app?: (o: StartAppOptions) => ReturnType<typeof startApp>;
};

export const defaultEvalHome = () => process.env.HOLDBACK_EVAL_HOME || path.join(os.homedir(), ".holdback-eval");
const round4 = (n: number) => Math.round(n * 1e4) / 1e4;

const localDate = (d: Date) => `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, "0")}-${String(d.getDate()).padStart(2, "0")}`;

/** HOLDBACK_TODAY for every arm: computed once from the first scoring date, then read back (and re-validated) from `today.json`. */
export async function ensureToday(resultsDir: string, now: () => Date = () => new Date()): Promise<string> {
  const file = path.join(resultsDir, "today.json");
  let text: string | undefined;
  try {
    text = await readFile(file, "utf8");
  } catch (e) {
    if ((e as NodeJS.ErrnoException).code !== "ENOENT") throw e;
  }
  if (text !== undefined) {
    const t = JSON.parse(text) as { today?: unknown };
    if (typeof t.today === "string" && /^\d{4}-\d{2}-\d{2}$/.test(t.today) && examTodayAllowed(t.today)) return t.today;
    throw new Error(`${file}: "today" is not an allowed exam day (a Tuesday, Thursday or Saturday on or after the 7th)`);
  }
  const d = now();
  const from = localDate(d);
  const today = nextExamToday(from);
  await mkdir(resultsDir, { recursive: true });
  await writeFile(file, JSON.stringify({ today, computedFrom: from, computedAt: d.toISOString() }, null, 2) + "\n", "utf8");
  return today;
}

/** The exam id: the `e-NN` entry of the test's `tags` (frontmatter takes no custom keys). */
export function examIdOf(text: string, fileName: string): string {
  const fm = /^---\r?\n([\s\S]*?)\r?\n---/.exec(text)?.[1] ?? "";
  const tags = /^tags:\s*\[([^\]]*)\]/m.exec(fm)?.[1] ?? "";
  const id = tags
    .split(",")
    .map((t) => t.trim().replace(/^["']|["']$/g, ""))
    .find((t) => /^e-\d\d$/.test(t));
  return id ?? /^(e-\d\d)/.exec(fileName)?.[1] ?? fileName;
}

async function readJson<T>(file: string, fallback: T): Promise<T> {
  try {
    return JSON.parse(await readFile(file, "utf8")) as T;
  } catch (e) {
    if ((e as NodeJS.ErrnoException).code === "ENOENT") return fallback;
    throw e;
  }
}

/** `npm install` in `cwd`; rejects with the tail of its output when it fails. */
export function npmInstall(cwd: string): Promise<void> {
  return new Promise((resolve, reject) => {
    const child = spawn("npm install --no-audit --no-fund", [], { cwd, shell: true, stdio: ["ignore", "pipe", "pipe"], windowsHide: true });
    let tail = "";
    const keep = (c: Buffer) => (tail = (tail + c.toString("utf8")).slice(-2000));
    child.stdout?.on("data", keep);
    child.stderr?.on("data", keep);
    const timer = setTimeout(() => child.kill("SIGKILL"), 10 * 60_000);
    child.on("error", (e) => {
      clearTimeout(timer);
      reject(e);
    });
    child.on("close", (code) => {
      clearTimeout(timer);
      code === 0 ? resolve() : reject(new Error(`npm install failed (exit ${code}): ${tail.trim()}`));
    });
  });
}

/**
 * Score one arm's finished app on the pre-registered exam: once. The recorded HEAD is checked out clean, installed with
 * the same scripted install for every arm and started fresh on an empty DATA_DIR; every exam file runs one time with
 * `kane-cli testmd run` from this arm's own verifier dir. A run that fails for a reason other than the app is recorded
 * `inconclusive` and counts as not passed, like any failure. An app that will not install or boot scores 0 of 22.
 */
export async function scoreApp(appDir: string, armId: ArmId, opts: ScoreOptions = {}): Promise<ExamScore> {
  const resultsDir = path.resolve(opts.resultsDir ?? DEFAULT_RESULTS_DIR);
  const now = opts.now ?? (() => new Date());
  await assertPrdRegistered(resultsDir);
  const run = await readJson<ArmRun | null>(runFile(resultsDir, armId), null);
  if (!run) throw new Error(`no ${path.basename(runFile(resultsDir, armId))} in ${resultsDir}: record the arm's build first (arm ${armId})`);
  await verifyInputs(resultsDir, run, `arm ${armId}`);
  if (path.resolve(run.appDir) !== path.resolve(appDir)) throw new Error(`arm ${armId} was recorded for ${run.appDir}, not ${path.resolve(appDir)}`);
  if (!run.head) throw new Error(`arm ${armId} has no recorded commit to score`);
  const files = await verifiedExamFiles(opts.examDir ?? path.join(EVAL_DIR, "exam"));

  const outFile = path.join(resultsDir, `${armId.toLowerCase()}.json`);
  const attemptFile = path.join(resultsDir, `${armId.toLowerCase()}.attempt.json`);
  if ((await readJson<unknown>(attemptFile, null)) !== null || (await readJson<unknown>(outFile, null)) !== null) {
    throw new Error(`arm ${armId} was already scored (or an attempt began): every arm is scored once, with no reruns`);
  }
  const today = await ensureToday(resultsDir, now);
  const read = opts.balance ?? balance;
  const need = opts.minCredits ?? files.length * CREDITS_PER_CASE_ESTIMATE;
  const have = await read().catch(() => undefined);
  if (typeof have === "number" && have < need) throw new Error(`Kane balance ${have} is below the exam estimate of ${need} credits: top up before scoring`);

  // the attempt is on record before anything starts: a crash or a failed boot cannot be followed by a second try
  await mkdir(resultsDir, { recursive: true });
  await writeFile(attemptFile, JSON.stringify({ arm: armId, appDir: path.resolve(appDir), head: run.head, today, startedAt: now().toISOString() }, null, 2) + "\n", "utf8");

  const verifier = path.join(opts.evalHome ?? defaultEvalHome(), `exam-${armId.toLowerCase()}`);
  await rm(verifier, { recursive: true, force: true });
  await mkdir(path.join(verifier, ".testmuai", "variables"), { recursive: true });
  const examDir = opts.examDir ?? path.join(EVAL_DIR, "exam");
  const ids = new Map<string, string>();
  for (const f of files) {
    await copyFile(path.join(examDir, f), path.join(verifier, f));
    ids.set(f, examIdOf(await readFile(path.join(examDir, f), "utf8"), f));
  }

  const tmp = await mkdtemp(path.join(os.tmpdir(), `holdback-exam-${armId.toLowerCase()}-`));
  const dataDir = path.join(tmp, "data");
  await mkdir(dataDir);
  const hooksDir = path.join(tmp, "no-hooks");
  await mkdir(hooksDir);
  const gitOpts = { hooksDir };
  const checkout = path.join(tmp, "app");
  let before: number | undefined;
  let after: number | undefined;
  let results: TestRunResult[] | undefined;
  let appFailure: string | undefined;
  let worktree = false;
  try {
    await worktreeAdd(appDir, checkout, run.head, gitOpts);
    worktree = true;
    try {
      await (opts.install ?? npmInstall)(checkout);
    } catch (e) {
      appFailure = `install failed: ${e instanceof Error ? e.message : String(e)}`;
    }
    let app: Awaited<ReturnType<typeof startApp>> | undefined;
    if (appFailure === undefined) {
      try {
        app = await (opts.app ?? startApp)({
          cwd: checkout,
          cmd: opts.start?.cmd ?? "npm start",
          port: opts.start?.port ?? (await freePort()),
          readyPath: opts.start?.readyPath ?? "/",
          timeoutMs: opts.start?.timeoutMs,
          env: { DATA_DIR: dataDir, HOLDBACK_TODAY: today, HOLDBACK_NOW: EXAM_NOW },
        });
      } catch (e) {
        // another program on the port says nothing about the app: nothing was scored, so the attempt is not used up
        if (e instanceof PortInUse) {
          await rm(attemptFile, { force: true });
          throw e;
        }
        if (!(e instanceof AppStartError)) throw e;
        appFailure = `app did not boot: ${e.message}`;
      }
    }
    if (app) {
      try {
        await writeFile(
          path.join(verifier, ".testmuai", "variables", "exam.json"),
          JSON.stringify({ start_url: { secret: false, description: "URL of the app under test", value: app.url } }, null, 2) + "\n",
          "utf8",
        );
        before = await read().catch(() => undefined);
        results = await (opts.tests ?? runTests)(verifier, files, { startUrl: app.url, parallel: opts.parallel ?? 2, timeoutS: opts.timeoutS });
        after = await read().catch(() => undefined);
      } finally {
        await app.stop();
      }
    }
  } finally {
    if (worktree) await worktreeRemove(appDir, checkout, gitOpts).catch(() => {});
    await git(appDir, ["worktree", "prune"], gitOpts).catch(() => {});
    await rm(tmp, { recursive: true, force: true, maxRetries: 5, retryDelay: 200 }).catch(() => {});
  }

  const cases: ExamCase[] = files.map((file, i) => {
    const r = results?.[i];
    const passed = r?.status === "passed";
    const inconclusive = r && !passed ? notAnAppFailure(r) : undefined;
    return {
      id: ids.get(file)!,
      file,
      status: r?.status ?? "error",
      passed,
      ...(inconclusive !== undefined ? { inconclusive } : {}),
      ...(r?.failedStep !== undefined ? { failedStep: r.failedStep } : {}),
      ...(r?.verdict?.bugTitle ? { verdict: r.verdict.bugTitle } : {}),
      healTriggered: r?.healTriggered ?? false,
      credits: r?.credits ?? 0,
      durationS: round4(r?.durationS ?? 0),
    };
  });
  const score: ExamScore = {
    arm: armId,
    appDir: path.resolve(appDir),
    head: run.head,
    today,
    now: EXAM_NOW,
    examTotal: cases.length,
    examPassed: cases.filter((c) => c.passed).length,
    inconclusive: cases.filter((c) => c.inconclusive !== undefined).length,
    ...(appFailure !== undefined ? { appFailure } : {}),
    kaneCredits: typeof before === "number" && typeof after === "number" && before >= after ? round4(before - after) : null,
    perRunCredits: round4(cases.reduce((s, c) => s + c.credits, 0)),
    scoredAt: now().toISOString(),
    cases,
  };
  await writeFile(outFile, JSON.stringify(score, null, 2) + "\n", "utf8");

  const summaryFile = path.join(resultsDir, "summary.json");
  const summary = await readJson<Summary>(summaryFile, {});
  summary[armId] = {
    examPassed: score.examPassed,
    examTotal: score.examTotal,
    inconclusive: score.inconclusive,
    claimedDone: run.claimedDone,
    turns: run.turns,
    kaneCredits: run.kaneCredits,
    agentUsd: run.agentUsd,
    breakerUsd: run.breakerUsd,
    wallMin: run.wallMin,
  };
  await writeFile(summaryFile, JSON.stringify(summary, null, 2) + "\n", "utf8");
  return score;
}

export { PrdChanged };
