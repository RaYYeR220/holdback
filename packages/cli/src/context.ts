import { realpath } from "node:fs/promises";
import path from "node:path";
import { createInterface } from "node:readline";
import {
  acquireCheckLock,
  appendEvent,
  checkSeal,
  CliHumanIO,
  ScriptedHumanIO,
  defaultBuildDeps,
  defaultFalsifyDeps,
  forAgent,
  gate,
  isAppKeyOf,
  lastSeal,
  readEvents,
  reduce,
  reseal,
  runBuildLoop,
  runDrift,
  runFalsify,
  runSpecStage,
  runTests,
  startApp,
  sweepStaleWorktrees,
  tamperMarker,
  watchSpec,
  LedgerTampered,
  type BuildDeps,
  type FalsifyDeps,
  type HumanIO,
  type LedgerEvent,
  type LedgerState,
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
  runDrift: typeof runDrift;
  runBuildLoop: typeof runBuildLoop;
  runFalsify: typeof runFalsify;
  reseal: typeof reseal;
  sweepStaleWorktrees: typeof sweepStaleWorktrees;
  watchSpec: typeof watchSpec;
  buildDeps: BuildDeps;
  falsifyDeps: FalsifyDeps;
  /** The human in the loop: the terminal, or the scripted answers file a command was given (`--answers`). */
  humanIO: (answersFile?: string) => ClosableIO | Promise<ClosableIO>;
  confirm: (question: string) => Promise<boolean>;
  /** The environment the commands read (CLAUDECODE, CLAUDE_PROJECT_DIR). */
  env: NodeJS.ProcessEnv;
  /** Claude Code hooks: their background check, timing and the CLI entry they run. */
  hooks: HookDeps;
  /** How long a command that writes the ledger waits for a background check (Claude Code hooks) to finish. */
  lockWaitMs: number;
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

/** The coding agent never sees the breaker's key: the loop's agent turns run with it blanked. */
export function scrubAgentEnv(base: BuildDeps): BuildDeps {
  return { ...base, claude: (o) => base.claude({ ...o, env: { ...o.env, VENICE_API_KEY: "" } }) };
}

/** One Ctrl-C asks the run to stop after its current step; a second one quits at once. */
export function installSignals(
  proc: { on(ev: string, fn: () => void): unknown; off(ev: string, fn: () => void): unknown; exit(code: number): unknown },
  err: (line: string) => void,
): Signals {
  const ctl = new AbortController();
  const hit = () => {
    if (ctl.signal.aborted) {
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
      runDrift,
      runBuildLoop,
      runFalsify,
      reseal,
      sweepStaleWorktrees,
      watchSpec,
      buildDeps: defaultBuildDeps,
      falsifyDeps: defaultFalsifyDeps,
      humanIO: (file) => (file ? ScriptedHumanIO.fromFile(file) : new CliHumanIO(stdin, stdout)),
      confirm: (q) => askYesNo(stdin, stdout, q),
      env: process.env,
      hooks: defaultHookDeps({ tests: runTests, app: startApp }),
      lockWaitMs: 20 * 60_000,
    },
  };
}

/**
 * Opens the human in the loop when a command starts, before any agent turn: the terminal, or the
 * `--answers <file>` script (a path relative to the app folder). The script is read and checked
 * here, once; later approvals (a falsify re-design mid-run) answer from that snapshot. A file
 * inside the app folder is refused, links resolved: the coding agent can edit anything there.
 */
export async function openHumanIO(ctx: Ctx, p: Project, answers: string | undefined): Promise<ClosableIO> {
  if (answers === undefined) return await ctx.deps.humanIO();
  const file = path.resolve(ctx.cwd, answers);
  let real: string;
  try {
    real = await realpath(file);
  } catch (e) {
    throw new Error(`cannot read the answers file ${file}: ${(e as NodeJS.ErrnoException).code ?? String(e)}`);
  }
  const rel = path.relative(await realpath(p.appDir), real);
  if (!rel.startsWith("..") && !path.isAbsolute(rel)) {
    throw new Error(`the answers file must be outside the app folder, where the coding agent cannot edit it: ${file}`);
  }
  return await ctx.deps.humanIO(real);
}

/** The ledger's only writer for the CLI: exactly one JSON line per event, which the loops' integrity check relies on. */
export const ledgerLog = (p: Project) => (e: LedgerEvent) => appendEvent(p.ledgerFile, e);

export type Snapshot = {
  events: LedgerEvent[];
  state: LedgerState;
  gate: ReturnType<typeof gate>;
  manifest: Record<string, string> | undefined;
  /** Text of the TAMPERED marker, when one is on record. */
  marker: string | null;
  /** Sealed entries that differ from the last seal, spec files apart. */
  changed: string[];
  /** The spec files edited since the last seal (`app:<file>` entries): drift, not a tamper. */
  specChanged: string[];
  /** What the human is told when the gate is shut by a tamper; null when there is none. */
  tamper: string | null;
};

/**
 * The ledger as the CLI sees it. A ledger that cannot be read throws: a read error is never "no
 * criteria yet", it is a failure that stops the command.
 */
export async function snapshot(p: Project): Promise<Snapshot> {
  const events = await readEvents(p.ledgerFile);
  const state = reduce(events);
  const marker = await tamperMarker(p);
  const manifest = lastSeal(events);
  const broken = manifest ? await checkSeal(p.verifierDir, manifest, p.appDir) : [];
  const isSpec = (k: string) => p.config.spec.some((f) => isAppKeyOf(k, f));
  const specChanged = broken.filter(isSpec);
  const changed = broken.filter((k) => !isSpec(k));
  const lastTamper = events.findLast((e) => e.t === "tamper");
  const fromLedger = state.tampered && lastTamper?.t === "tamper" ? lastTamper.detail : null;
  const fromDisk = changed.length > 0 ? `sealed files changed: ${changed.join(", ")}` : null;
  const detail = marker ?? fromLedger ?? fromDisk;
  const tampered = state.tampered || marker !== null || changed.length > 0;
  return {
    events,
    state,
    gate: gate(state),
    manifest,
    marker,
    changed,
    specChanged,
    tamper: tampered ? tamperMessage(detail ?? "the ledger records a tamper") : null,
  };
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

/** Prints why a command failed. A tamper (on record or just found) is reported as one and exits 2. */
export async function explainFailure(ctx: Ctx, e: unknown, p?: Project): Promise<number> {
  const msg = e instanceof Error ? e.message : String(e);
  if (e instanceof LedgerTampered) {
    ctx.err(tamperMessage(msg));
    return EXIT.tamper;
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
