import { constants, existsSync } from "node:fs";
import { copyFile, lstat, mkdir, rm } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { contractPath, guardMainPath, runClaudeTurn } from "../agent/claude.js";
import { guardHookCommand, writeAgentSettings } from "../agent/guard.js";
import { AppStartError, startApp, type RunningApp } from "../app.js";
import { changedFiles, commitAll, EMPTY_HOOKS_DIR, ensureHead, excludeFromGit, headSha, isRepoRoot, type GitOptions } from "../git.js";
import { runTests, type TestRunResult } from "../kane/testmd.js";
import { gate } from "../ledger/gate.js";
import { reduce } from "../ledger/reduce.js";
import { parseEvents } from "../ledger/store.js";
import type { AcState, LedgerEvent } from "../ledger/types.js";
import { appendVouched, LedgerTampered, markOf, readLedger, verifiedLedger, type EventBody, type LedgerMark } from "../ledger/vouched.js";
import type { Project } from "../project.js";
import { checkRecordings, checkSeal } from "../seal.js";
import { checkRecordingsAnchor, gitConfigHash, markTampered, snapshotRecordings, tamperMarker, type RecordingsSnapshot } from "../tamper.js";
import { bisectRegression, BisectTampered, blameOf, lastGoodTurn } from "./bisect.js";
import { buildBrief, byAcId, type AcFailure } from "./brief.js";
import { appSealFiles } from "./spec.js";

type Log = (e: LedgerEvent) => Promise<void>;
type Manifest = Record<string, string>;

export type BuildDeps = {
  claude: typeof runClaudeTurn;
  tests: typeof runTests;
  app: typeof startApp;
  /** Finds the turn that broke an AC (default: `bisectRegression`); leave out to skip bisecting. */
  bisect?: typeof bisectRegression;
  /** Shell command for the agent's PreToolUse guard. Default: the built guard entry run by this node binary. */
  guardCommand?: string;
};

// the wrapper keeps bisect.ts (which imports this file) out of this module's start-up
export const defaultBuildDeps: BuildDeps = { claude: runClaudeTurn, tests: runTests, app: startApp, bisect: (...a) => bisectRegression(...a) };

export type BuildOptions = {
  /** A human raising the turn cap for this run; turn numbers are global, so this is the highest turn allowed. */
  maxTurnsOverride?: number;
  /** Aborts the loop: it stops after the current step (never mid-batch) and returns reason `aborted`. */
  signal?: AbortSignal;
};

export type BuildStopReason = "gate-open" | "max-turns" | "tamper" | "error" | "aborted";
/** `error` carries the detail for an `error` stop (and for a `tamper` stop on a tamper already on record). */
export type BuildResult = { allowStop: boolean; turns: number; reason: BuildStopReason; error?: string };

const TURN_TIMEOUT_MS = 30 * 60_000;
/** Every Nth turn (and on the turn that empties the owed list) the passing ACs' tests are replayed too. */
const REPLAY_EVERY = 3;
const SETTINGS_FILE = "agent-settings.json";
/** Copies of Kane's failure screenshots inside the app dir, where the agent may open them; never committed. */
export const EVIDENCE_DIR = "kane-evidence";
const RESEAL_HINT = "a tamper is on record: re-seal (the spec stage, or a human re-seal) before building again";
const NO_SEAL = "no seal in the ledger: run the spec stage first";
const NO_ACS = "no acceptance criteria in the ledger: run the spec stage first";

function defaultGuardCommand(p: Project): string {
  const main = guardMainPath();
  // a hook command that cannot start exits 1, which Claude Code treats as "allow": refuse to run without it
  if (!existsSync(main)) throw new Error(`guard entry not found at ${main}: build @holdback/core first`);
  return guardHookCommand({ home: p.home, verifierDir: p.verifierDir }, main);
}

function lastIndex(events: LedgerEvent[], t: LedgerEvent["t"]): number {
  for (let i = events.length - 1; i >= 0; i--) if (events[i]!.t === t) return i;
  return -1;
}

export function lastSeal(events: LedgerEvent[]): Manifest | undefined {
  const e = events[lastIndex(events, "seal")];
  return e && e.t === "seal" ? e.manifest : undefined;
}

/** Test id -> absolute test file, from the latest `design` event that names one. */
export function testFileMap(events: LedgerEvent[], verifierDir: string): Map<string, string> {
  const out = new Map<string, string>();
  for (const e of events) {
    if (e.t !== "design") continue;
    for (const t of e.tests) if (t.file) out.set(t.id, path.resolve(verifierDir, t.file));
  }
  return out;
}

/** The test files that verify `acs`, deduplicated in order. Fails when a test has no recorded file. */
export function filesOf(acs: AcState[], files: Map<string, string>): string[] {
  const out: string[] = [];
  for (const ac of acs) {
    for (const id of ac.tests) {
      const f = files.get(id);
      if (!f) throw new Error(`no test file recorded for ${id} (verifies ${ac.id}): run the spec stage again`);
      if (!out.includes(f)) out.push(f);
    }
  }
  return out;
}

/** Every test Kane is about to run must be a tier-1 sealed file. */
export function assertTestsSealed(verifierDir: string, manifest: Manifest | undefined, files: string[]): void {
  for (const f of files) {
    const rel = path.relative(verifierDir, f).split(path.sep).join("/");
    if (!rel.startsWith(".testmuai/tests/") || !manifest || manifest[rel] === undefined) throw new Error(`test file not sealed: ${f}`);
  }
}

export function startFailureText(e: unknown): string {
  if (e instanceof AppStartError) return [e.logs.replace(/\s+$/, ""), e.message].filter((s) => s.length > 0).join("\n");
  return e instanceof Error ? e.message : String(e);
}

/** `kane-evidence/turn-<N>/<test-id>-step-<K>.png`, relative to the app dir, `/`-separated. */
export function evidencePath(turn: number, testId: string, step: number | undefined): string {
  const id = testId.replace(/[^\w.-]/g, "_");
  return `${EVIDENCE_DIR}/turn-${turn}/${id}${step === undefined ? "" : `-step-${step}`}.png`;
}

const errText = (e: unknown) => (e instanceof Error ? e.message : String(e));

/**
 * Headless build loop: brief the agent with what Kane says is still owed, commit
 * its turn, restart the app, re-run the tests of the owed ACs (plus a replay of
 * the passing ones every few turns), and repeat until the gate opens, the turn
 * cap is hit, or a sealed file, Kane's recordings, the repo's git config or the
 * ledger change behind Holdback's back.
 * `log` must append to `p.ledgerFile`: the loop re-reads and verifies it every turn.
 */
export async function runBuildLoop(p: Project, deps: BuildDeps, log: Log, opts: BuildOptions = {}): Promise<BuildResult> {
  let turns = 0;
  let app: RunningApp | undefined;
  let events: LedgerEvent[] = [];
  /** The ledger bytes Holdback vouches for; set when the ledger is first read. */
  let mark: LedgerMark | undefined;
  /** Tier 1: the last `seal` in the ledger. */
  let manifest: Manifest | undefined;
  /** Tier 2 (Kane's `output-*` recordings) and the repo's git config, as of the last Kane batch or loop start. */
  let baseline: RecordingsSnapshot | undefined;
  /** True from the start of a Kane batch until the recordings are snapshotted again. */
  let kaneWindow = false;
  const hooksDir = path.join(p.home, EMPTY_HOOKS_DIR);
  /** Every git call of Holdback's runs with no repo hook, fsmonitor or signing program. */
  const gitOpts: GitOptions = { hooksDir };

  const done = (allowStop: boolean, reason: BuildStopReason, error?: string): BuildResult =>
    error === undefined ? { allowStop, turns, reason } : { allowStop, turns, reason, error };
  const at = () => new Date().toISOString();
  /** Append one event; the ledger must be untouched since Holdback's last append, before and after. */
  const emit = async (body: EventBody) => {
    if (!mark) throw new Error("internal: ledger not read before the first append");
    const e = { at: at(), ...body } as LedgerEvent;
    mark = await appendVouched(p.ledgerFile, mark, log, e);
    events.push(e);
  };
  /**
   * The marker goes first: it must survive a ledger that cannot take the event. A marker that cannot
   * be written must not keep the event out of the ledger either.
   */
  const recordTamper = async (detail: string) => {
    let logged = detail;
    try {
      await markTampered(p, detail);
    } catch (e) {
      logged = `${detail} (tamper marker not written: ${errText(e)})`;
    }
    await emit({ t: "tamper", detail: logged });
  };
  const stopApp = async () => {
    const a = app;
    app = undefined;
    await a?.stop();
  };
  /**
   * Logs `tamper` and returns true when anything sealed changed: tier 1 (tests, variables, app
   * spec/config), the repo's git config, and, unless Kane may just have written them, its recordings.
   */
  const tampered = async (withRecordings: boolean): Promise<boolean> => {
    const bad = manifest ? await checkSeal(p.verifierDir, manifest, p.appDir) : [];
    if (baseline && (await gitConfigHash(baseline.gitConfigFile, gitOpts)) !== baseline.gitConfig) bad.push(".git/config");
    if (withRecordings && baseline) bad.push(...(await checkRecordings(p.verifierDir, baseline.manifest)));
    if (bad.length === 0) return false;
    await recordTamper(`sealed files changed: ${bad.join(", ")}`);
    return true;
  };
  const assertSealed = (files: string[]) => assertTestsSealed(p.verifierDir, manifest, files);
  /** Copy a failed run's screenshot to where the agent may open it. A failed copy just drops the brief line. */
  const keepEvidence = async (r: TestRunResult, turn: number) => {
    if (r.status === "passed" || !r.screenshot || !r.testId) return;
    const src = path.resolve(r.screenshot.replace(/^~(?=[\\/])/, os.homedir()));
    const dest = path.join(p.appDir, ...evidencePath(turn, r.testId, r.failedStep).split("/"));
    try {
      // the agent can plant links in its own work tree: never write through one
      for (const dir of [path.join(p.appDir, EVIDENCE_DIR), path.dirname(dest)]) {
        await mkdir(dir, { recursive: true });
        const st = await lstat(dir);
        if (st.isSymbolicLink() || !st.isDirectory()) return;
      }
      await rm(dest, { force: true });
      await copyFile(src, dest, constants.COPYFILE_EXCL);
    } catch {
      /* the brief omits the Screenshot line */
    }
  };
  const screenshot = (f: AcFailure): string | undefined => {
    if (f.turn === undefined) return undefined;
    const rel = evidencePath(f.turn, f.test, f.step);
    return existsSync(path.join(p.appDir, ...rel.split("/"))) ? rel : undefined;
  };
  /** After a Kane batch, with the app stopped: the recordings as they are now become the baseline, and are logged. */
  const closeKaneWindow = async () => {
    const snap = await snapshotRecordings(p, gitOpts);
    baseline = { ...snap, gitConfig: baseline!.gitConfig }; // the config itself was checked just before, never re-trusted
    await emit({ t: "recordings", digest: baseline.digest, gitConfig: baseline.gitConfig });
    kaneWindow = false;
  };

  const loop = async (): Promise<BuildResult> => {
    const maxTurns = opts.maxTurnsOverride ?? p.config.loop.maxTurns;
    if (typeof maxTurns !== "number" || !(maxTurns >= 0)) return done(false, "error", `loop.maxTurns must be a number, got ${JSON.stringify(maxTurns)}`);
    // a tamper on record, in the marker or the ledger, is answered before anything else is checked
    const marker = await tamperMarker(p);
    if (marker !== null) {
      // a tamper only the marker knows (the ledger could not take it) goes into the ledger once, so
      // whatever seal comes next drops the results from before it; later starts find it there
      try {
        if (!reduce(parseEvents((await readLedger(p.ledgerFile)).toString("utf8"))).tampered) await log({ at: at(), t: "tamper", detail: marker });
      } catch {
        /* best effort: the marker blocks either way */
      }
      return done(false, "tamper", RESEAL_HINT);
    }
    await mkdir(hooksDir, { recursive: true });
    if (!(await isRepoRoot(p.appDir, gitOpts))) return done(false, "error", `the app dir must be the root of a git repository: ${p.appDir}`);
    const found = await readLedger(p.ledgerFile); // trusted as found at loop start
    mark = markOf(found);
    events = parseEvents(found.toString("utf8"));
    const initial = reduce(events);
    if (initial.tampered) return done(false, "tamper", RESEAL_HINT);
    if (!lastSeal(events)) return done(false, "error", NO_SEAL);
    if (Object.keys(initial.acs).length === 0) return done(false, "error", NO_ACS);

    // Kane's recordings and the repo's git config are held to the latest `recordings` event,
    // unless a seal came after it (spec stage, drift, human re-seal): then the disk seeds a new one.
    const anchor = await checkRecordingsAnchor(p, events, gitOpts);
    baseline = anchor.snapshot;
    if (anchor.moved.length > 0) {
      await recordTamper(`changed since Holdback last recorded them: ${anchor.moved.join(", ")}`);
      return done(false, "tamper");
    }
    if (!anchor.anchored) await emit({ t: "recordings", digest: baseline.digest, gitConfig: baseline.gitConfig });

    const settingsFile = path.join(p.home, SETTINGS_FILE);
    await writeAgentSettings(
      settingsFile,
      { home: p.home, verifierDir: p.verifierDir },
      {
        guardCommand: deps.guardCommand ?? defaultGuardCommand(p),
        denyWeb: p.config.loop.denyWeb === true,
        protect: { appDir: p.appDir, files: appSealFiles(p) },
      },
    );
    // anchored and without a trailing slash: also matches a file or link planted under that name
    await excludeFromGit(p.appDir, `/${EVIDENCE_DIR}`, gitOpts);
    await ensureHead(p.appDir, "holdback: initial commit", gitOpts);

    let startError: string | undefined;
    let lastTurn = 0;
    for (;;) {
      events = parseEvents((await verifiedLedger(p.ledgerFile, mark)).toString("utf8"));
      manifest = lastSeal(events);
      if (!manifest) return done(false, "error", NO_SEAL);
      let state = reduce(events);
      if (state.tampered) return done(false, "tamper", RESEAL_HINT);
      if (Object.keys(state.acs).length === 0) return done(false, "error", NO_ACS);
      // before any decision: a change made at any point since the last check is flagged
      if (await tampered(true)) return done(false, "tamper");
      const g = gate(state);
      if (g.allowStop) return done(true, "gate-open");
      if (opts.signal?.aborted) return done(false, "aborted");
      const n = Math.max(state.turn, lastTurn) + 1;
      if (n > maxTurns) return done(false, "max-turns");

      const owed = [...[...g.regressed].sort(byAcId), ...[...g.owed].sort(byAcId)];
      const fileOf = testFileMap(events, p.verifierDir);
      const idOf = new Map([...fileOf].map(([id, f]) => [f, id]));
      const owedFiles = filesOf(owed, fileOf);
      assertSealed(owedFiles);
      lastTurn = n;
      turns += 1;
      await emit({ t: "turn.start", n, owed: owed.map((a) => a.id) });

      // 1. agent turn
      const before = await headSha(p.appDir, gitOpts);
      const agent = await deps.claude({
        cwd: p.appDir,
        prompt: buildBrief(state, { appStartError: startError, notes: p.config.agentNotes, screenshot, broke: blameOf(events) }),
        settingsFile,
        contractFile: contractPath(),
        maxTurns: p.config.agent.maxTurnsPerCall,
        model: p.config.agent.model,
        timeoutMs: TURN_TIMEOUT_MS,
      });
      // right after the agent, before any git command of Holdback's reads what it may have planted
      if (await tampered(true)) return done(false, "tamper");
      if (agent.subtype === undefined && !agent.timedOut && agent.exitCode !== 0 && !opts.signal?.aborted) {
        // no result line at all (bad auth, bad flags, crash): another turn would fail the same way
        const why = agent.stderrTail.trim().slice(-500) || agent.resultText || "no output";
        return done(false, "error", `claude exited with code ${agent.exitCode} without a result: ${why}`);
      }

      // 2. commit the turn, restart the app
      const commit = await commitAll(p.appDir, `holdback turn ${n}: ${owed.length} owed`, gitOpts);
      const filesChanged = commit && before ? await changedFiles(p.appDir, before, commit, gitOpts) : [];
      startError = undefined;
      try {
        app = await deps.app({
          cwd: p.appDir,
          cmd: p.config.start.cmd,
          port: p.config.start.port,
          readyPath: p.config.start.readyPath,
          env: { ...p.config.start.env, VENICE_API_KEY: "" }, // the breaker's key never reaches the app
        });
      } catch (e) {
        startError = startFailureText(e);
      }
      await emit({
        t: "turn.end",
        n,
        commit: commit ?? (await headSha(p.appDir, gitOpts)) ?? "",
        filesChanged,
        durationMs: agent.durationMs,
        appUp: app !== undefined,
        agentExit: agent.exitCode,
      });
      if (opts.signal?.aborted) return done(false, "aborted"); // the turn is committed and on record; the app stops in `finally`
      if (!app) continue; // nothing to test; the next brief is the start failure, the next check runs at the top

      // 3. Kane: tests of the owed ACs, plus a regression replay of the passing ones now and then.
      // Build runs keep adaptive heal on: the UI is expected to change between turns.
      if (await tampered(true)) return done(false, "tamper");
      const runOpts = { startUrl: `${app.url}/`, timeoutS: p.config.kane.timeoutS, parallel: p.config.kane.parallel };
      const ran = new Set<string>();
      const regressed: { ac: string; turn: number }[] = [];
      /** Runs one batch and logs it; true (and nothing logged but `tamper`) when a sealed file changed meanwhile. */
      const runBatch = async (batch: string[]): Promise<boolean> => {
        if (batch.length === 0) return false;
        assertSealed(batch);
        for (const f of batch) ran.add(f);
        kaneWindow = true;
        const results = await deps.tests(p.verifierDir, batch, runOpts);
        if (results.length !== batch.length) throw new Error(`Kane returned ${results.length} results for ${batch.length} tests`);
        // results produced against a changed test or variable never reach the ledger
        if (await tampered(false)) return true;
        const was = reduce(events);
        for (const [i, r] of results.entries()) {
          // a run that never read its file has no id: attribute it, so the failure counts against its ACs
          const result = r.testId == null ? { ...r, testId: idOf.get(batch[i]!) ?? null } : r;
          await keepEvidence(result, n);
          await emit({ t: "run", kind: "build", turn: n, result });
        }
        const now = reduce(events);
        for (const ac of Object.values(now.acs).sort(byAcId)) {
          const prev = was.acs[ac.id]?.status;
          if ((prev === "passing" || prev === "proved") && ac.status === "regressed") {
            await emit({ t: "regression", ac: ac.id, turn: n });
            regressed.push({ ac: ac.id, turn: n });
          }
        }
        return false;
      };
      try {
        if (await runBatch(owedFiles)) return done(false, "tamper");
        state = reduce(events);
        const left = gate(state);
        if (n % REPLAY_EVERY === 0 || (left.owed.length === 0 && left.regressed.length === 0)) {
          const green = Object.values(state.acs)
            .filter((a) => a.status === "passing" || a.status === "proved")
            .sort(byAcId);
          if (await runBatch(filesOf(green, fileOf).filter((f) => !ran.has(f)))) return done(false, "tamper");
        }
      } finally {
        await stopApp();
      }
      // a criterion that was green at least two turns ago: find the turn that broke it (the app is down)
      if (deps.bisect) {
        for (const r of regressed) {
          const good = lastGoodTurn(events, r.ac, r.turn);
          if (r.turn - good < 2) continue;
          kaneWindow = true;
          try {
            const blamed = await deps.bisect(p, r.ac, good, r.turn, { tests: deps.tests, app: deps.app, guard: () => tampered(false) }, (e) => emit(e as EventBody));
            if (blamed === null) await emit({ t: "regression", ac: r.ac, turn: r.turn, detail: "bisect inconclusive: no turn could be blamed" });
          } catch (e) {
            if (e instanceof BisectTampered) return done(false, "tamper");
            if (e instanceof LedgerTampered) throw e;
            // best effort: the brief omits the blame line, but the failure is on record
            await emit({ t: "regression", ac: r.ac, turn: r.turn, detail: `bisect failed: ${errText(e)}` });
          }
        }
      }
      // the app is down: Kane's recordings as they are now are what the next check (and run) holds them to
      if (kaneWindow) await closeKaneWindow();
    }
  };

  /**
   * Every exit re-checks the ledger (and, on an error, the seal): a forgery never leaves as a plain error.
   * An exit from inside a Kane batch (Kane threw, too few results, the app's stop() threw) still
   * anchors the recordings Kane left, once the seal and config check out; otherwise the next run
   * would take them for a tamper.
   */
  const finalize = async (r: BuildResult, thrown?: unknown): Promise<BuildResult> => {
    try {
      if (thrown instanceof LedgerTampered) throw thrown;
      if (r.reason === "tamper") return r;
      if (mark) await verifiedLedger(p.ledgerFile, mark);
      if (r.reason === "error" || kaneWindow) {
        await stopApp().catch(() => {}); // a failed stop must not skip the checks
        if (await tampered(!kaneWindow)) return done(false, "tamper");
        if (kaneWindow) await closeKaneWindow();
      }
      return r;
    } catch (e) {
      if (!(e instanceof LedgerTampered)) return r;
      await stopApp().catch(() => {});
      await markTampered(p, e.message).catch(() => {});
      try {
        await log({ at: at(), t: "tamper", detail: e.message });
      } catch {
        /* the marker blocks the next run either way */
      }
      return done(false, "tamper");
    }
  };

  try {
    return await finalize(await loop());
  } catch (e) {
    return await finalize(done(false, "error", errText(e)), e);
  } finally {
    await stopApp().catch(() => {});
  }
}
