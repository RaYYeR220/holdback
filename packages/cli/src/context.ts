import { createInterface } from "node:readline";
import {
  appendEvent,
  checkSeal,
  CliHumanIO,
  defaultBuildDeps,
  defaultFalsifyDeps,
  gate,
  lastSeal,
  readEvents,
  reduce,
  reseal,
  runBuildLoop,
  runDrift,
  runFalsify,
  runSpecStage,
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
import { tamperMessage } from "./messages.js";

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
  humanIO: () => ClosableIO;
  confirm: (question: string) => Promise<boolean>;
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
      humanIO: () => new CliHumanIO(stdin, stdout),
      confirm: (q) => askYesNo(stdin, stdout, q),
    },
  };
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
  const specKeys = new Set(p.config.spec.map((f) => `app:${f.split("\\").join("/")}`));
  const specChanged = broken.filter((k) => specKeys.has(k));
  const changed = broken.filter((k) => !specKeys.has(k));
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
