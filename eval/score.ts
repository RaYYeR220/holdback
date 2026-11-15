import { copyFile, mkdir, mkdtemp, readFile, readdir, rm, writeFile } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { balance, freePort, notAnAppFailure, runTests, startApp, type BalanceReader, type StartAppOptions, type TestRunResult } from "@holdback/core";
import { assertPrdRegistered, DEFAULT_RESULTS_DIR, EVAL_DIR } from "./prd.ts";
import { EXAM_NOW, nextExamToday } from "./reference.ts";
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
  today: string;
  now: string;
  examTotal: number;
  examPassed: number;
  inconclusive: number;
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
  turns: number;
  kaneCredits: number | null;
  agentUsd: number;
  breakerUsd: number;
  wallMin: number;
};
export type Summary = Partial<Record<ArmId, SummaryEntry>>;

export type ScoreOptions = {
  resultsDir?: string;
  examDir?: string;
  /** Home of the per-arm exam verifier dirs (`<evalHome>/exam-<arm>/`). Default: HOLDBACK_EVAL_HOME or `~/.holdback-eval`. */
  evalHome?: string;
  start?: { cmd?: string; readyPath?: string; port?: number; timeoutMs?: number };
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

/** HOLDBACK_TODAY for every arm: computed once from the first scoring date, then read back from `today.json`. */
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
    if (typeof t.today === "string" && /^\d{4}-\d{2}-\d{2}$/.test(t.today)) return t.today;
    throw new Error(`${file}: no valid "today"`);
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

/**
 * Score one arm's finished app on the pre-registered exam: once, on a fresh app and an empty DATA_DIR,
 * every file run one time with `kane-cli testmd run` from this arm's own verifier dir. A run that fails
 * for a reason other than the app is recorded `inconclusive` and counts as not passed, like any failure.
 */
export async function scoreApp(appDir: string, armId: ArmId, opts: ScoreOptions = {}): Promise<ExamScore> {
  const resultsDir = path.resolve(opts.resultsDir ?? DEFAULT_RESULTS_DIR);
  const now = opts.now ?? (() => new Date());
  await assertPrdRegistered(resultsDir);
  const outFile = path.join(resultsDir, `${armId.toLowerCase()}.json`);
  if ((await readJson<unknown>(outFile, null)) !== null) throw new Error(`${outFile} exists: every arm is scored once, with no reruns`);
  const today = await ensureToday(resultsDir, now);

  // this arm's exam verifier dir: the exam files and the start_url variable, nothing shared with another arm
  const examDir = opts.examDir ?? path.join(EVAL_DIR, "exam");
  const files = (await readdir(examDir)).filter((f) => f.endsWith("_test.md")).sort();
  if (files.length === 0) throw new Error(`no exam files in ${examDir}`);
  const verifier = path.join(opts.evalHome ?? defaultEvalHome(), `exam-${armId.toLowerCase()}`);
  await rm(verifier, { recursive: true, force: true });
  await mkdir(path.join(verifier, ".testmuai", "variables"), { recursive: true });
  const ids = new Map<string, string>();
  for (const f of files) {
    await copyFile(path.join(examDir, f), path.join(verifier, f));
    ids.set(f, examIdOf(await readFile(path.join(examDir, f), "utf8"), f));
  }

  const dataDir = await mkdtemp(path.join(os.tmpdir(), `holdback-exam-${armId.toLowerCase()}-`));
  const port = opts.start?.port ?? (await freePort());
  const app = await (opts.app ?? startApp)({
    cwd: path.resolve(appDir),
    cmd: opts.start?.cmd ?? "npm start",
    port,
    readyPath: opts.start?.readyPath ?? "/",
    timeoutMs: opts.start?.timeoutMs,
    env: { DATA_DIR: dataDir, HOLDBACK_TODAY: today, HOLDBACK_NOW: EXAM_NOW },
  });
  let results: TestRunResult[];
  let before: number | undefined;
  let after: number | undefined;
  try {
    await writeFile(
      path.join(verifier, ".testmuai", "variables", "exam.json"),
      JSON.stringify({ start_url: { secret: false, description: "URL of the app under test", value: app.url } }, null, 2) + "\n",
      "utf8",
    );
    const read = opts.balance ?? balance;
    before = await read().catch(() => undefined);
    results = await (opts.tests ?? runTests)(verifier, files, { startUrl: app.url, parallel: opts.parallel ?? 2, timeoutS: opts.timeoutS });
    after = await read().catch(() => undefined);
  } finally {
    await app.stop();
    await rm(dataDir, { recursive: true, force: true }).catch(() => {});
  }

  const cases: ExamCase[] = results.map((r, i) => {
    const file = files[i]!;
    const passed = r.status === "passed";
    const inconclusive = passed ? undefined : notAnAppFailure(r);
    return {
      id: ids.get(file)!,
      file,
      status: r.status,
      passed,
      ...(inconclusive !== undefined ? { inconclusive } : {}),
      ...(r.failedStep !== undefined ? { failedStep: r.failedStep } : {}),
      ...(r.verdict?.bugTitle ? { verdict: r.verdict.bugTitle } : {}),
      healTriggered: r.healTriggered,
      credits: r.credits,
      durationS: round4(r.durationS),
    };
  });
  const score: ExamScore = {
    arm: armId,
    appDir: path.resolve(appDir),
    today,
    now: EXAM_NOW,
    examTotal: cases.length,
    examPassed: cases.filter((c) => c.passed).length,
    inconclusive: cases.filter((c) => c.inconclusive !== undefined).length,
    kaneCredits: typeof before === "number" && typeof after === "number" && before >= after ? round4(before - after) : null,
    perRunCredits: round4(cases.reduce((s, c) => s + c.credits, 0)),
    scoredAt: now().toISOString(),
    cases,
  };
  await writeFile(outFile, JSON.stringify(score, null, 2) + "\n", "utf8");

  const run = await readJson<Partial<ArmRun>>(runFile(resultsDir, armId), {});
  const summaryFile = path.join(resultsDir, "summary.json");
  const summary = await readJson<Summary>(summaryFile, {});
  summary[armId] = {
    examPassed: score.examPassed,
    examTotal: score.examTotal,
    inconclusive: score.inconclusive,
    claimedDone: run.claimedDone ?? false,
    turns: run.turns ?? 0,
    kaneCredits: run.kaneCredits ?? null,
    agentUsd: run.agentUsd ?? 0,
    breakerUsd: run.breakerUsd ?? 0,
    wallMin: run.wallMin ?? 0,
  };
  await writeFile(summaryFile, JSON.stringify(summary, null, 2) + "\n", "utf8");
  return score;
}
