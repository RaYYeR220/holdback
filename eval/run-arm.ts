import { copyFile, mkdir, mkdtemp, readFile, readdir, writeFile } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import {
  balance,
  commitAll,
  ensureHead,
  gate,
  git,
  loadProject,
  readEvents,
  reduce,
  runClaudeTurn,
  type BalanceReader,
  type ClaudeTurnResult,
  type GitOptions,
} from "@holdback/core";
import { DEFAULT_RESULTS_DIR, EVAL_DIR, PrdChanged, sha256, verifyInputs } from "./prd.ts";

export type ArmId = "A" | "B" | "C";

/** The budget caps an arm ran under. */
export type ArmCaps = { maxCalls: number; maxTurnsPerCall: number; timeoutMs: number; maxRetries: number };

/** What one arm cost and did; written to `<results>/<arm>-run.json` and merged into summary.json by the scorer. */
export type ArmRun = {
  arm: ArmId;
  appDir: string;
  model: string;
  calls: number;
  retries: number;
  /** null: not recorded (never a made-up zero). */
  turns: number | null;
  agentUsd: number | null;
  breakerUsd: number | null;
  wallMin: number | null;
  /** The agent stopped on its own with a successful result (A, B); the gate was open (C). */
  claimedDone: boolean;
  stopReason: string;
  /** Kane credits the arm spent building (balance drops); null when the balance could not be read. */
  kaneCredits: number | null;
  head: string | null;
  /** Uncommitted changes in the app dir when the run was recorded (scoring uses HEAD only). */
  dirty: boolean;
  prdSha256: string;
  stackSha256: string;
  caps?: ArmCaps;
  recordedAt: string;
  /** B: Kane assurance commands (context, design, maintain, cover) the agent ran despite the deny rules. */
  assuranceCallsUsed?: number;
  /** C: Kane credits and minutes of the spec stage, kept out of the build figures (those start at C's first build turn). */
  specCredits?: number;
  specMinutes?: number;
  /** C: metered Kane batches with no balance reading, and loop turns that carry no agent cost (agentUsd and turns are then null). */
  kaneUnmeasured?: number;
  turnsWithoutCost?: number;
};

export type RunArmOptions = {
  /** Fresh directory for the arm's app, outside the holdback repository. */
  outDir: string;
  /** The final PRD.md (with Kane's Clarifications appended) and STACK.md, as registered by `register-prd`. */
  prdPath: string;
  stackPath: string;
  /** Same `agent.model` for every arm: explicit, never inherited, and equal to the registered one. */
  model: string;
  resultsDir?: string;
  /** Cap on `claude -p` calls (a call that ran out of turns is continued). Default 3. */
  maxCalls?: number;
  maxTurnsPerCall?: number;
  timeoutMs?: number;
  /** Retries of one call after a transient API error (overload, rate limit, network). Default 3. */
  maxRetries?: number;
  retryDelayMs?: number;
  sleep?: (ms: number) => Promise<void>;
  claude?: typeof runClaudeTurn;
  /** Kane's balance; B only. Default: `kane-cli balance`. */
  balance?: BalanceReader;
  env?: NodeJS.ProcessEnv;
  now?: () => Date;
};

const ARM_FILES: Record<"A" | "B", string> = { A: "a-self.md", B: "b-self-kane.md" };
const CONTINUE = "You stopped before the app was finished. Carry on from where the working tree stands, and stop when the app is done.";
const TRANSIENT = /overloaded|rate.?limit|\b(?:429|500|502|503|504|529)\b|ECONNRESET|ETIMEDOUT|EAI_AGAIN|socket hang up|api error|temporarily unavailable/i;
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

async function exists(file: string): Promise<boolean> {
  try {
    await readFile(file);
    return true;
  } catch (e) {
    if ((e as NodeJS.ErrnoException).code === "ENOENT") return false;
    throw e;
  }
}

async function writeRun(resultsDir: string, run: ArmRun): Promise<void> {
  await mkdir(resultsDir, { recursive: true });
  await writeFile(runFile(resultsDir, run.arm), JSON.stringify(run, null, 2) + "\n", "utf8");
}

/** A Kane assurance command anywhere in a shell command, behind any prefix (env vars, npx, a path). */
const ASSURANCE = /\bkane-cli\s+(?:context|design|maintain|cover)\b/g;

/** How many Bash tool calls in a stream-json transcript run a Kane assurance command. */
export function countAssuranceCalls(transcript: string[]): number {
  let n = 0;
  for (const line of transcript) {
    let o: { type?: string; message?: { content?: unknown } };
    try {
      o = JSON.parse(line);
    } catch {
      continue;
    }
    if (o.type !== "assistant" || !Array.isArray(o.message?.content)) continue;
    for (const part of o.message.content as { type?: string; input?: unknown }[]) {
      if (part?.type === "tool_use") n += JSON.stringify(part.input ?? "").match(ASSURANCE)?.length ?? 0;
    }
  }
  return n;
}

const isDone = (r: ClaudeTurnResult) => r.exitCode === 0 && r.isError !== true && !r.timedOut;
const isTransient = (r: ClaudeTurnResult) => !isDone(r) && !r.timedOut && r.subtype !== "error_max_turns" && TRANSIENT.test(`${r.resultText}\n${r.stderrTail}`);

/**
 * Arm A or B: a fresh repo with the final PRD and STACK, one headless Claude Code agent without web access, commit
 * what it built. Arms run one after another, never at the same time (same machine, same Kane balance). An arm is
 * built once: a second build of the same arm is refused, so a bad run cannot be quietly replaced by a better one.
 */
export async function runArm(arm: "A" | "B", opts: RunArmOptions): Promise<ArmRun> {
  const outDir = path.resolve(opts.outDir);
  const repoRoot = path.dirname(EVAL_DIR);
  if (inside(repoRoot, outDir)) throw new Error(`arm dir ${outDir} is inside the holdback repository: use a fresh directory outside it`);
  if (!(await isEmptyOrMissing(outDir))) throw new Error(`arm dir ${outDir} is not empty: every arm starts from a fresh directory`);
  const resultsDir = path.resolve(opts.resultsDir ?? DEFAULT_RESULTS_DIR);
  if (await exists(runFile(resultsDir, arm))) throw new Error(`${runFile(resultsDir, arm)} exists: arm ${arm} was already built, and an arm is built once`);
  // bound to the registration made by `register-prd`: the same PRD, STACK and model as every other arm
  const prdSha256 = sha256(await readFile(opts.prdPath));
  const stackSha256 = sha256(await readFile(opts.stackPath));
  await verifyInputs(resultsDir, { prdSha256, stackSha256, model: opts.model }, `arm ${arm}`);

  // the attempt is on record before the first agent call: a crash mid-build leaves the marker, and the arm is not built again
  // unless a human clears it by hand, writing the reason into the file as `redoReason`
  const marker = path.join(resultsDir, `${arm.toLowerCase()}-run.attempt.json`);
  let previous: unknown;
  try {
    previous = JSON.parse(await readFile(marker, "utf8"));
  } catch (e) {
    if ((e as NodeJS.ErrnoException).code !== "ENOENT") throw e;
  }
  const redo = (previous as { redoReason?: unknown } | undefined)?.redoReason;
  if (previous !== undefined && !(typeof redo === "string" && redo.trim() !== "")) {
    throw new Error(`${marker} exists: a build of arm ${arm} already began. Re-building needs a reason written into that file as "redoReason"`);
  }
  const prompt = await readFile(path.join(EVAL_DIR, "arms", ARM_FILES[arm]), "utf8");
  await mkdir(outDir, { recursive: true });
  await writeFile(
    marker,
    JSON.stringify({ arm, appDir: outDir, startedAt: (opts.now?.() ?? new Date()).toISOString(), ...(previous !== undefined ? { previousAttempt: previous } : {}) }, null, 2) + "\n",
    "utf8",
  );
  await copyFile(opts.prdPath, path.join(outDir, "PRD.md"));
  await copyFile(opts.stackPath, path.join(outDir, "STACK.md"));
  await writeFile(path.join(outDir, "PROMPT.md"), prompt, "utf8");
  await writeFile(path.join(outDir, ".gitignore"), "node_modules/\n", "utf8");

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

  // A has no Kane at all; B has Kane for its own checks but not the assurance commands (the exam is self-written checks)
  const deny = [
    "WebFetch",
    "WebSearch",
    ...(arm === "A" ? ["Bash(kane-cli:*)"] : ["Bash(kane-cli context:*)", "Bash(kane-cli design:*)", "Bash(kane-cli maintain:*)"]),
  ];
  const settingsFile = path.join(meta, "settings.json");
  await writeFile(settingsFile, JSON.stringify({ permissions: { deny } }, null, 2) + "\n", "utf8");
  const contractFile = path.join(meta, "agent.md");
  await writeFile(contractFile, "Work in the current directory. Stop when the app is finished.\n", "utf8");

  const caps: ArmCaps = {
    maxCalls: Math.max(1, opts.maxCalls ?? 3),
    maxTurnsPerCall: opts.maxTurnsPerCall ?? 60,
    timeoutMs: opts.timeoutMs ?? 90 * 60_000,
    maxRetries: Math.max(0, opts.maxRetries ?? 6),
  };
  const transcriptFile = `${outDir}.transcript.ndjson`;
  const transcript: string[] = [];
  const sleep = opts.sleep ?? ((ms: number) => new Promise<void>((r) => setTimeout(r, ms)));
  const claude = opts.claude ?? runClaudeTurn;
  const read = arm === "B" ? (opts.balance ?? balance) : undefined;
  const before = read ? await read().catch(() => undefined) : undefined;
  let calls = 0;
  let retries = 0;
  let turns = 0;
  let usd = 0;
  let ms = 0;
  let last: ClaudeTurnResult | undefined;
  while (calls < caps.maxCalls) {
    const callPrompt = calls === 0 ? prompt : CONTINUE;
    let tries = 0;
    for (;;) {
      last = await claude({
        cwd: outDir,
        prompt: callPrompt,
        settingsFile,
        contractFile,
        maxTurns: caps.maxTurnsPerCall,
        model: opts.model,
        timeoutMs: caps.timeoutMs,
        env: opts.env,
        onLine: (l) => transcript.push(l),
      });
      turns += last.numTurns ?? 0;
      usd += last.costUsd ?? 0;
      ms += last.durationMs;
      // a transient API error is retried inside the attempt, like the Holdback loop does
      if (isTransient(last) && tries < caps.maxRetries) {
        tries++;
        retries++;
        await sleep((opts.retryDelayMs ?? 30_000) * tries);
        continue;
      }
      break;
    }
    calls++;
    if (isDone(last)) break;
    if (last.timedOut || last.subtype !== "error_max_turns") break;
  }
  const claimedDone = last !== undefined && isDone(last);
  const exhausted = last !== undefined && isTransient(last);
  const stopReason = claimedDone ? "done" : last?.timedOut ? "timeout" : exhausted ? "transient-exhausted" : (last?.subtype ?? "error");
  await writeFile(transcriptFile, transcript.join("\n") + "\n", "utf8");
  const after = read ? await read().catch(() => undefined) : undefined;
  const kaneCredits = arm === "A" ? 0 : typeof before === "number" && typeof after === "number" && before >= after ? round2(before - after) : null;

  await commitAll(outDir, `arm ${arm}: final state (${stopReason})`, gitOpts);
  const head = (await git(outDir, ["rev-parse", "--short", "HEAD"], gitOpts)).stdout.trim() || null;

  const run: ArmRun = {
    arm,
    appDir: outDir,
    model: opts.model,
    calls,
    retries,
    turns,
    agentUsd: round2(usd),
    breakerUsd: 0,
    wallMin: round2(ms / 60_000),
    claimedDone,
    stopReason,
    kaneCredits,
    head,
    dirty: false,
    prdSha256,
    stackSha256,
    caps,
    recordedAt: (opts.now?.() ?? new Date()).toISOString(),
    ...(arm === "B" ? { assuranceCallsUsed: countAssuranceCalls(transcript) } : {}),
  };
  await writeRun(resultsDir, run);
  return run;
}

/**
 * Arm C is the Holdback demo run. Its numbers come from the Holdback ledger of the app dir, never from the keyboard:
 * the gate (claimed done), the agent turns and cost the build loop recorded per turn, Kane credits by balance, the
 * breaker's spend, the wall time from the first to the last event. Its PRD.md and STACK.md must equal the registered
 * ones and its `agent.model` the registered model. A figure the ledger does not hold is recorded as null.
 */
export async function recordArmC(appDir: string, opts: { resultsDir?: string; now?: () => Date } = {}): Promise<ArmRun> {
  const abs = path.resolve(appDir);
  const resultsDir = path.resolve(opts.resultsDir ?? DEFAULT_RESULTS_DIR);
  if (await exists(runFile(resultsDir, "C"))) throw new Error(`${runFile(resultsDir, "C")} exists: arm C was already recorded`);
  const project = await loadProject(abs);
  const model = project.config.agent.model;
  if (!model) throw new PrdChanged(`${abs}: agent.model is not set in holdback.config.json; arm C must name the same model as the registration`);
  // R35: no mid-build PRD appends in the eval run, so C's PRD stays the registered one
  if (project.config.loop.appendClarifications !== "spec-only") {
    throw new PrdChanged(`${abs}: loop.appendClarifications must be "spec-only" in holdback.config.json for the eval run`);
  }
  const prdSha256 = sha256(await readFile(path.join(abs, "PRD.md")));
  const stackSha256 = sha256(await readFile(path.join(abs, "STACK.md")));
  const registration = await verifyInputs(resultsDir, { prdSha256, stackSha256, model }, "arm C");

  const events = await readEvents(project.ledgerFile);
  if (events.length === 0) throw new Error(`no Holdback ledger for ${abs} (${project.ledgerFile}): run Holdback on it first (HOLDBACK_HOME must be the one it ran with)`);
  // the build starts at C's first turn: the spec stage before it is reported apart, and registration must precede the build
  const firstTurn = events.findIndex((e) => e.t === "turn.start");
  if (firstTurn < 0) throw new Error(`${abs}: the ledger has no build turn (turn.start) yet`);
  const buildStart = Date.parse(events[firstTurn]!.at);
  if (Date.parse(registration.registeredAt) > buildStart) {
    throw new PrdChanged(
      `the PRD was registered (${registration.registeredAt}) after arm C's first build turn (${events[firstTurn]!.at}): register-prd runs right after the spec stage, before the build`,
    );
  }
  const state = reduce(events);
  const spec = reduce(events.slice(0, firstTurn));
  const ends = events.flatMap((e) => (e.t === "turn.end" ? [e] : []));
  // like for like with A and B: a figure is a total only when every loop turn reports it, else null
  const total = (f: (e: (typeof ends)[number]) => number | undefined): number | null => {
    const v = ends.map(f);
    return v.length === 0 || v.some((n) => n === undefined) ? null : (v as number[]).reduce((x, y) => x + y, 0);
  };
  const turnsWithoutCost = ends.filter((e) => e.agentUsd === undefined || e.agentTurns === undefined).length;
  const at = events.map((e) => Date.parse(e.at)).filter(Number.isFinite);
  const usd = total((e) => e.agentUsd);
  const head = (await git(abs, ["rev-parse", "--short", "HEAD"])).stdout.trim() || null;
  const dirty = (await git(abs, ["status", "--porcelain"])).stdout.trim().length > 0;
  const run: ArmRun = {
    arm: "C",
    appDir: abs,
    model,
    calls: ends.length,
    retries: 0,
    turns: total((e) => e.agentTurns),
    agentUsd: usd === null ? null : round2(usd),
    breakerUsd: round2(state.breakerUsd),
    wallMin: at.length > 1 ? round2((Math.max(...at) - buildStart) / 60_000) : null,
    claimedDone: gate(state).allowStop,
    stopReason: "holdback",
    kaneCredits: round2(state.kaneCredits - spec.kaneCredits),
    specCredits: round2(spec.kaneCredits),
    specMinutes: round2((buildStart - Math.min(...at)) / 60_000),
    kaneUnmeasured: state.kaneUnmeasured - spec.kaneUnmeasured,
    turnsWithoutCost,
    head,
    dirty,
    prdSha256,
    stackSha256,
    recordedAt: (opts.now?.() ?? new Date()).toISOString(),
  };
  await writeRun(resultsDir, run);
  return run;
}
