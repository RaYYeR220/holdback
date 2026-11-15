import { copyFile, mkdir, mkdtemp, readFile, readdir, writeFile } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { balance, commitAll, ensureHead, git, runClaudeTurn, type BalanceReader, type ClaudeTurnResult, type GitOptions } from "@holdback/core";
import { DEFAULT_RESULTS_DIR, EVAL_DIR, registerPrd } from "./prd.ts";

export type ArmId = "A" | "B" | "C";

/** What one arm cost and did; written to `<results>/<arm>-run.json` and merged into summary.json by the scorer. */
export type ArmRun = {
  arm: ArmId;
  appDir: string;
  model?: string;
  calls: number;
  turns: number;
  agentUsd: number;
  breakerUsd: number;
  wallMin: number;
  /** The agent stopped on its own with a successful result (it said it was done). */
  claimedDone: boolean;
  stopReason: string;
  /** Kane credits the arm spent building (balance drop around the run); null when the balance could not be read. */
  kaneCredits: number | null;
  head: string | null;
  prdSha256: string;
};

export type RunArmOptions = {
  /** Fresh directory for the arm's app, outside the holdback repository. */
  outDir: string;
  /** The final PRD.md (with Kane's Clarifications appended) and STACK.md every arm builds from. */
  prdPath: string;
  stackPath: string;
  /** Same `agent.model` for every arm: explicit, never inherited. */
  model: string;
  resultsDir?: string;
  /** Cap on `claude -p` calls (a call that ran out of turns is continued). Default 3. */
  maxCalls?: number;
  maxTurnsPerCall?: number;
  timeoutMs?: number;
  claude?: typeof runClaudeTurn;
  /** Kane's balance; B only. Default: `kane-cli balance`. */
  balance?: BalanceReader;
  env?: NodeJS.ProcessEnv;
  now?: () => Date;
};

const ARM_FILES: Record<"A" | "B", string> = { A: "a-self.md", B: "b-self-kane.md" };
const CONTINUE = "You stopped before the app was finished. Carry on from where the working tree stands, and stop when the app is done.";
const round2 = (n: number) => Math.round(n * 100) / 100;

const inside = (parent: string, child: string) => {
  const rel = path.relative(parent, child);
  return rel === "" || (!rel.startsWith("..") && !path.isAbsolute(rel));
};

async function isEmptyOrMissing(dir: string): Promise<boolean> {
  try {
    return (await readdir(dir)).length === 0;
  } catch (e) {
    if ((e as NodeJS.ErrnoException).code === "ENOENT") return true;
    throw e;
  }
}

export const runFile = (resultsDir: string, arm: ArmId) => path.join(resultsDir, `${arm.toLowerCase()}-run.json`);

async function writeRun(resultsDir: string, run: ArmRun): Promise<void> {
  await mkdir(resultsDir, { recursive: true });
  await writeFile(runFile(resultsDir, run.arm), JSON.stringify(run, null, 2) + "\n", "utf8");
}

/** Arm A or B: a fresh repo with the final PRD and STACK, one headless Claude Code agent without web access, commit what it built. */
export async function runArm(arm: "A" | "B", opts: RunArmOptions): Promise<ArmRun> {
  const outDir = path.resolve(opts.outDir);
  const repoRoot = path.dirname(EVAL_DIR);
  if (inside(repoRoot, outDir)) throw new Error(`arm dir ${outDir} is inside the holdback repository: use a fresh directory outside it`);
  if (!(await isEmptyOrMissing(outDir))) throw new Error(`arm dir ${outDir} is not empty: every arm starts from a fresh directory`);
  const resultsDir = path.resolve(opts.resultsDir ?? DEFAULT_RESULTS_DIR);
  const prd = await registerPrd(opts.prdPath, resultsDir, { stackPath: opts.stackPath, now: opts.now });

  const prompt = await readFile(path.join(EVAL_DIR, "arms", ARM_FILES[arm]), "utf8");
  await mkdir(outDir, { recursive: true });
  await copyFile(opts.prdPath, path.join(outDir, "PRD.md"));
  await copyFile(opts.stackPath, path.join(outDir, "STACK.md"));
  await writeFile(path.join(outDir, "PROMPT.md"), prompt, "utf8");

  // settings and the agent's system-prompt file live outside the app repo
  const meta = await mkdtemp(path.join(os.tmpdir(), `holdback-arm-${arm.toLowerCase()}-`));
  const hooksDir = path.join(meta, "no-hooks");
  await mkdir(hooksDir, { recursive: true });
  const gitOpts: GitOptions = {
    hooksDir,
    env: {
      GIT_AUTHOR_NAME: "arm",
      GIT_AUTHOR_EMAIL: "arm@example.invalid",
      GIT_COMMITTER_NAME: "arm",
      GIT_COMMITTER_EMAIL: "arm@example.invalid",
    },
  };
  const init = await git(outDir, ["init", "-q"], gitOpts);
  if (init.code !== 0) throw new Error(`git init failed: ${init.stderr.trim()}`);
  await ensureHead(outDir, `arm ${arm}: PRD, STACK and prompt`, gitOpts);

  const deny = ["WebFetch", "WebSearch", ...(arm === "A" ? ["Bash(kane-cli:*)"] : [])];
  const settingsFile = path.join(meta, "settings.json");
  await writeFile(settingsFile, JSON.stringify({ permissions: { deny } }, null, 2) + "\n", "utf8");
  const contractFile = path.join(meta, "agent.md");
  await writeFile(contractFile, "Work in the current directory. Stop when the app is finished.\n", "utf8");

  const claude = opts.claude ?? runClaudeTurn;
  const read = arm === "B" ? (opts.balance ?? balance) : undefined;
  const before = read ? await read().catch(() => undefined) : undefined;
  const maxCalls = Math.max(1, opts.maxCalls ?? 3);
  let calls = 0;
  let turns = 0;
  let usd = 0;
  let ms = 0;
  let last: ClaudeTurnResult | undefined;
  while (calls < maxCalls) {
    last = await claude({
      cwd: outDir,
      prompt: calls === 0 ? prompt : CONTINUE,
      settingsFile,
      contractFile,
      maxTurns: opts.maxTurnsPerCall ?? 60,
      model: opts.model,
      timeoutMs: opts.timeoutMs ?? 90 * 60_000,
      env: opts.env,
    });
    calls++;
    turns += last.numTurns ?? 0;
    usd += last.costUsd ?? 0;
    ms += last.durationMs;
    if (last.exitCode === 0 && last.isError !== true) break;
    if (last.timedOut || last.subtype !== "error_max_turns") break;
  }
  const claimedDone = last !== undefined && last.exitCode === 0 && last.isError !== true && !last.timedOut;
  const stopReason = claimedDone ? "done" : last?.timedOut ? "timeout" : (last?.subtype ?? "error");
  const after = read ? await read().catch(() => undefined) : undefined;
  const kaneCredits = arm === "A" ? 0 : typeof before === "number" && typeof after === "number" && before >= after ? round2(before - after) : null;

  await commitAll(outDir, `arm ${arm}: final state (${stopReason})`, gitOpts);
  const head = (await git(outDir, ["rev-parse", "--short", "HEAD"], gitOpts)).stdout.trim() || null;

  const run: ArmRun = {
    arm,
    appDir: outDir,
    model: opts.model,
    calls,
    turns,
    agentUsd: round2(usd),
    breakerUsd: 0,
    wallMin: round2(ms / 60_000),
    claimedDone,
    stopReason,
    kaneCredits,
    head,
    prdSha256: prd.prdSha256,
  };
  await writeRun(resultsDir, run);
  return run;
}

/** Arm C is the Holdback demo run: record where its app is and what the run cost. */
export async function recordArmC(
  appDir: string,
  metrics: Partial<Pick<ArmRun, "turns" | "agentUsd" | "breakerUsd" | "wallMin" | "claimedDone" | "kaneCredits" | "model">>,
  opts: { resultsDir?: string } = {},
): Promise<ArmRun> {
  const resultsDir = path.resolve(opts.resultsDir ?? DEFAULT_RESULTS_DIR);
  const run: ArmRun = {
    arm: "C",
    appDir: path.resolve(appDir),
    calls: 0,
    turns: metrics.turns ?? 0,
    agentUsd: metrics.agentUsd ?? 0,
    breakerUsd: metrics.breakerUsd ?? 0,
    wallMin: metrics.wallMin ?? 0,
    claimedDone: metrics.claimedDone ?? false,
    stopReason: "holdback",
    kaneCredits: metrics.kaneCredits ?? null,
    head: null,
    prdSha256: "",
    ...(metrics.model ? { model: metrics.model } : {}),
  };
  await writeRun(resultsDir, run);
  return run;
}
