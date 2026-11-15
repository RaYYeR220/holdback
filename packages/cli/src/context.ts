import { existsSync } from "node:fs";
import { realpath } from "node:fs/promises";
import path from "node:path";
import { createInterface } from "node:readline";
import { fileURLToPath } from "node:url";
import {
  acquireCheckLock,
  appendEvent,
  balance,
  CliHumanIO,
  ScriptedHumanIO,
  DEFAULT_PORT,
  defaultBuildDeps,
  defaultFalsifyDeps,
  forAgent,
  reseal,
  runBuildLoop,
  runDrift,
  runFalsify,
  runSpecStage,
  runTests,
  serve,
  snapshot as coreSnapshot,
  withoutHoldbackEnv,
  killTrackedChildrenSync,
  escapeControls,
  specDiff,
  type Snapshot as CoreSnapshot,
  startApp,
  sweepStaleWorktrees,
  tamperMarker,
  watchSpec,
  LedgerTampered,
  type BalanceReader,
  type BuildDeps,
  type FalsifyDeps,
  type HumanIO,
  type LedgerEvent,
  type Project,
} from "@holdback/core";
import { defaultHookDeps, type HookDeps } from "./hooks.js";
import { HUMAN_ONLY, tamperMessage } from "./messages.js";

/** Process exit codes: 2 is only ever a tamper, 3 a finished run that is not fully green, 130 an interrupt. */
export const EXIT = { ok: 0, error: 1, tamper: 2, unfinished: 3, aborted: 130 } as const;

export type ClosableIO = HumanIO & { close(): void };
export type Signals = { signal: AbortSignal; dispose(): void };

/** Everything the commands call in `@holdback/core`, so tests can run them without Kane or Claude Code. */
export type Deps = {
  runSpecStage: typeof runSpecStage;
  serve: typeof serve;
  runDrift: typeof runDrift;
  runBuildLoop: typeof runBuildLoop;
  runFalsify: typeof runFalsify;
  reseal: typeof reseal;
  sweepStaleWorktrees: typeof sweepStaleWorktrees;
  watchSpec: typeof watchSpec;
  buildDeps: BuildDeps;
  falsifyDeps: FalsifyDeps;
  /** Kane's balance, read around the spec stage's and drift's Kane calls (`buildDeps`, `falsifyDeps` and the hooks' check carry their own). */
  balance: BalanceReader;
  /** The human in the loop: the terminal, or the scripted answers file a command was given (`--answers`). */
  humanIO: (answersFile?: string) => ClosableIO | Promise<ClosableIO>;
  confirm: (question: string) => Promise<boolean>;
  /** The environment the commands read (CLAUDECODE, CLAUDE_PROJECT_DIR). */
  env: NodeJS.ProcessEnv;
  /** Claude Code hooks: their background check, timing and the CLI entry they run. */
  hooks: HookDeps;
  /** How long a command that writes the ledger waits for a background check (Claude Code hooks) to finish. */
  lockWaitMs: number;
  /** The built dashboard `serve` and `--dashboard` show at `/` when no `--static` is given; undefined when there is none. */
  dashboardDir: () => string | undefined;
};

export type Ctx = {
  cwd: string;
  /** One line of output (a newline is added). */
  out: (line: string) => void;
  err: (line: string) => void;
  stdin: NodeJS.ReadableStream;
  stdout: NodeJS.WritableStream;
  deps: Deps;
  /** Interrupt handling for the commands that run long. */
  signals: () => Signals;
};

export type CtxOverrides = Partial<Omit<Ctx, "deps">> & { deps?: Partial<Deps> };

/**
 * The coding agent never sees the breaker's key, nor any of Holdback's own variables (`HOLDBACK_HOME`
 * names where the sealed tests live): the loop's agent turns run with them taken out (I8).
 */
export function scrubAgentEnv(base: BuildDeps): BuildDeps {
  return { ...base, claude: (o) => base.claude({ ...o, env: { ...withoutHoldbackEnv(o.env), VENICE_API_KEY: "" } }) };
}

/**
 * One Ctrl-C asks the run to stop after its current step; a second one quits at once, after killing
 * every process Holdback started (the app, kane-cli, the coding agent), which on Windows would
 * otherwise live on: the app holding its port, Kane billing, the agent editing (I7).
 */
export function installSignals(
  proc: { on(ev: string, fn: () => void): unknown; off(ev: string, fn: () => void): unknown; exit(code: number): unknown },
  err: (line: string) => void,
  killChildren: () => void = killTrackedChildrenSync,
): Signals {
  const ctl = new AbortController();
  const hit = () => {
    if (ctl.signal.aborted) {
      killChildren();
      proc.exit(EXIT.aborted);
      return;
    }
    err("stopping after the current step (press Ctrl-C again to quit now)");
    ctl.abort();
  };
  const names = ["SIGINT", "SIGTERM"];
  for (const n of names) proc.on(n, hit);
  return { signal: ctl.signal, dispose: () => names.forEach((n) => proc.off(n, hit)) };
}

function askYesNo(stdin: NodeJS.ReadableStream, stdout: NodeJS.WritableStream, question: string): Promise<boolean> {
  return new Promise((resolve) => {
    const rl = createInterface({ input: stdin, output: stdout, terminal: false });
    let answered = false;
    rl.on("close", () => {
      if (!answered) resolve(false);
    });
    rl.question(question, (a) => {
      answered = true;
      rl.close();
      resolve(/^y(es)?$/i.test(a.trim()));
    });
  });
}

export function defaultCtx(): Ctx {
  const stdin = process.stdin;
  const stdout = process.stdout;
  const err = (l: string) => void process.stderr.write(l + "\n");
  return {
    cwd: process.cwd(),
    out: (l) => void stdout.write(l + "\n"),
    err,
    stdin,
    stdout,
    signals: () => installSignals(process, err),
    deps: {
      runSpecStage,
      serve,
      runDrift,
      runBuildLoop,
      runFalsify,
      reseal,
      sweepStaleWorktrees,
      watchSpec,
      buildDeps: defaultBuildDeps,
      falsifyDeps: defaultFalsifyDeps,
      balance,
      humanIO: (file) => (file ? ScriptedHumanIO.fromFile(file) : new CliHumanIO(stdin, stdout)),
      confirm: (q) => askYesNo(stdin, stdout, q),
      env: process.env,
      hooks: defaultHookDeps({ tests: runTests, app: startApp, balance }),
      lockWaitMs: 20 * 60_000,
      dashboardDir: builtDashboard,
    },
  };
}

/**
 * Opens the human in the loop when a command starts, before any agent turn: the terminal, or the
 * `--answers <file>` script (a path relative to the app folder). The script is read and checked
 * here, once; later approvals (a falsify re-design mid-run) answer from that snapshot. A file
 * inside the app folder is refused, links resolved: the coding agent can edit anything there.
 */
export async function openHumanIO(ctx: Ctx, p: Project, answers: string | undefined, dash?: DashboardOptions): Promise<ClosableIO> {
  if (dash?.dashboard) {
    if (answers !== undefined) throw new Error("--dashboard and --answers are alternatives: pick one");
    return await openDashboard(ctx, p, dash.port);
  }
  if (answers === undefined) return await ctx.deps.humanIO();
  const file = path.resolve(ctx.cwd, answers);
  let real: string;
  try {
    real = await realpath(file);
  } catch (e) {
    throw new Error(`cannot read the answers file ${file}: ${(e as NodeJS.ErrnoException).code ?? String(e)}`);
  }
  const rel = path.relative(await realpath(p.appDir), real);
  const outside = rel === ".." || rel.startsWith(`..${path.sep}`) || path.isAbsolute(rel);
  if (!outside) {
    throw new Error(`the answers file must be outside the app folder, where the coding agent cannot edit it: ${file}`);
  }
  return await ctx.deps.humanIO(real);
}

export type DashboardOptions = { dashboard?: boolean; port?: string };

/** Parses `--port`: digits only, 0 to 65535. */
export function parsePort(raw: string | undefined, fallback: number): number {
  if (raw === undefined) return fallback;
  const n = /^\d+$/.test(raw) ? Number(raw) : NaN;
  if (!Number.isInteger(n) || n > 65535) throw new Error(`--port must be a number from 0 to 65535, got ${raw}`);
  return n;
}

/** The URL the human opens: the token rides in the fragment, which is never sent to a server or logged. */
export const dashboardUrl = (srv: { host: string; port: number; token: string }, withStatic = true) =>
  `http://${srv.host}:${srv.port}/${withStatic ? `#token=${srv.token}` : ""}`;

/**
 * Starts the dashboard server in this process and answers through it: the questions and
 * approvals a command raises wait in the browser (the URL, with the token, goes to the human's
 * terminal only). Closing the IO stops the server and fails any prompt still waiting.
 */
async function openDashboard(ctx: Ctx, p: Project, portRaw: string | undefined): Promise<ClosableIO> {
  const port = parsePort(portRaw, DEFAULT_PORT);
  const staticDir = ctx.deps.dashboardDir();
  const srv = await ctx.deps.serve(p, { port, ...(staticDir ? { staticDir } : {}) });
  ctx.out(`Answer in the dashboard: ${dashboardUrl(srv, staticDir !== undefined)}${staticDir ? "" : "  (no dashboard build found: the API alone is up)"}`);
  ctx.out(`API token (header x-holdback-token): ${srv.token}`);
  return {
    answer: (qs) => srv.human.answer(qs),
    approve: (items) => srv.human.approve(items),
    close: () => void srv.close(),
  };
}

/**
 * The dashboard build that ships with the CLI (`<cli>/dashboard`) or, in this monorepo,
 * `apps/dashboard/dist` (`pnpm --filter @holdback/dashboard build`). Only a folder with an
 * index.html counts.
 */
export function builtDashboard(): string | undefined {
  const here = path.dirname(fileURLToPath(import.meta.url));
  const candidates = [path.resolve(here, "../dashboard"), path.resolve(here, "../../../apps/dashboard/dist")];
  return candidates.find((d) => existsSync(path.join(d, "index.html")));
}

/** The ledger's only writer for the CLI: exactly one JSON line per event, which the loops' integrity check relies on. */
export const ledgerLog = (p: Project) => (e: LedgerEvent) => appendEvent(p.ledgerFile, e);

export type Snapshot = Omit<CoreSnapshot, "tamperDetail"> & {
  /** What the human is told when the gate is shut by a tamper; null when there is none. */
  tamper: string | null;
};

/**
 * Prints the unified diff of each changed spec file, from the sealed version to the one on disk,
 * before drift asks the human to approve anything (R37).
 */
export async function showSpecDiff(ctx: Ctx, p: Project, s: Pick<Snapshot, "manifest" | "specChanged">): Promise<void> {
  if (!s.manifest) return;
  for (const key of s.specChanged) {
    const rel = key.replace(/^app:/, "");
    const d = await specDiff(p, s.manifest, rel);
    if (d === null) ctx.out(`(no sealed copy of ${rel} to compare with: see \`git diff -- ${rel}\`)`);
    else if (d !== "") ctx.out(d);
  }
}

/** The core snapshot, with the tamper worded for the human. A ledger that cannot be read throws. */
export async function snapshot(p: Project): Promise<Snapshot> {
  const { tamperDetail, ...rest } = await coreSnapshot(p);
  return { ...rest, tamper: tamperDetail === null ? null : tamperMessage(tamperDetail) };
}

/**
 * True when the command runs inside a Claude Code session (its shells set CLAUDECODE): the coding
 * agent, not the human. Commands that lift a tamper or take the hooks out refuse to run there.
 */
export function insideClaudeCode(ctx: Ctx): boolean {
  return !!ctx.deps.env.CLAUDECODE;
}

/**
 * The output side of a read-only command (status, owed) as the coding agent may see it: inside
 * Claude Code every line goes through `forAgent`, so counts, ids and the re-seal hint stay while
 * Kane's file names and Holdback's folders do not. Outside Claude Code it is `ctx` unchanged.
 */
export function readerView(ctx: Ctx, p: Project): Ctx {
  if (!insideClaudeCode(ctx)) return ctx;
  return { ...ctx, out: (l) => ctx.out(forAgent(p, l)), err: (l) => ctx.err(forAgent(p, l)) };
}

/**
 * The output side of a command whose lines carry text an agent, the app or Kane wrote (a brief, a
 * status line, Kane's verdicts, an agent's stderr) for a human to act on: every line goes through
 * `escapeControls`, so no escape sequence or bidi control reaches the terminal as one.
 */
export function humanView(ctx: Ctx): Ctx {
  return { ...ctx, out: (l) => ctx.out(escapeControls(l)), err: (l) => ctx.err(escapeControls(l)) };
}

/**
 * JSON for a terminal (`--json`): DEL, every C1 control and every Unicode format character (bidi
 * controls, zero-width characters, the BOM) written as `\uXXXX` escapes (C0 ones already are), so
 * the output is still valid JSON with the same strings, and none of them reaches the terminal raw.
 */
export function jsonForTerminal(json: string): string {
  return json.replace(/[\u007f-\u009f\p{Cf}]/gu, (c) =>
    c
      .split("")
      .map((u) => `\\u${u.charCodeAt(0).toString(16).padStart(4, "0")}`)
      .join(""),
  );
}

/** Refuses a human-only command inside Claude Code: true (and the reason printed) when it must not run. */
export function refuseInsideClaudeCode(ctx: Ctx, cmd: string): boolean {
  if (!insideClaudeCode(ctx)) return false;
  ctx.err(HUMAN_ONLY(cmd));
  return true;
}

/**
 * Runs a command that writes the ledger under the check lock, so a background check started by
 * the Claude Code hooks never sees a foreign append mid-check (which it would record as a tamper).
 * Waits for a check in flight, saying so; fails with a clear error when the wait runs out.
 */
export async function withCheckLock(ctx: Ctx, p: Project, run: () => Promise<number>): Promise<number> {
  let lock = await acquireCheckLock(p.home, { waitMs: 0 });
  if (!lock) {
    ctx.out("Waiting for Holdback's background check (from the Claude Code hooks) to finish…");
    lock = await acquireCheckLock(p.home, { waitMs: ctx.deps.lockWaitMs });
  }
  if (!lock) {
    const min = Math.max(1, Math.round(ctx.deps.lockWaitMs / 60_000));
    ctx.err(`A background check is still running after ${min} minute${min === 1 ? "" : "s"}. Nothing was changed: run this again when it finishes.`);
    return EXIT.error;
  }
  try {
    return await run();
  } finally {
    await lock.release();
  }
}

/**
 * Parses `--kane-cap`: a number of credits, 0 or more (undefined when not given). The cap is on the
 * project's whole measured Kane spend, like `kane.capCredits`, which it overrides for one command.
 */
export function parseKaneCap(raw: string | undefined): number | undefined {
  if (raw === undefined) return undefined;
  const n = /^\d+(\.\d+)?$/.test(raw.trim()) ? Number(raw) : NaN;
  if (!Number.isFinite(n)) throw new Error(`--kane-cap must be a number of credits (0 or more), got ${raw}`);
  return n;
}

/**
 * Prints why a command failed. A tamper (on record or just found) is reported as one and exits 2;
 * the Kane credit cap reached is a stop (exit 3), not an error.
 */
export async function explainFailure(ctx: Ctx, e: unknown, p?: Project): Promise<number> {
  const msg = e instanceof Error ? e.message : String(e);
  if (e instanceof LedgerTampered) {
    ctx.err(tamperMessage(msg));
    return EXIT.tamper;
  }
  if (e instanceof Error && e.name === "KaneCapReached") {
    ctx.err(msg);
    return EXIT.unfinished;
  }
  ctx.err(`error: ${msg}`);
  if (p) {
    let marker: string | null;
    try {
      marker = await tamperMarker(p);
    } catch (m) {
      // never swallowed: a marker that cannot be read is itself a reason to stop
      marker = `tamper marker unreadable: ${m instanceof Error ? m.message : String(m)}`;
    }
    if (marker !== null) {
      ctx.err(tamperMessage(marker));
      return EXIT.tamper;
    }
  }
  return EXIT.error;
}
