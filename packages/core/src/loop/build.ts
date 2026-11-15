import { constants, existsSync } from "node:fs";
import { copyFile, lstat, mkdir, rm } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { contractPath, guardMainPath, runClaudeTurn } from "../agent/claude.js";
import { guardHookCommand, writeAgentSettings } from "../agent/guard.js";
import { AppStartError, PortInUse, startApp, type RunningApp } from "../app.js";
import { appEnv, freshDataDir } from "../datadir.js";
import { changedFiles, commitAll, EMPTY_HOOKS_DIR, ensureHead, excludeFromGit, headSha, isRepoRoot, type GitOptions } from "../git.js";
import { balance } from "../kane/assurance.js";
import { notAnAppFailure, runSettled, runTests, type TestRunResult } from "../kane/testmd.js";
import { KaneMeter, type BalanceReader } from "../ledger/credits.js";
import { gate } from "../ledger/gate.js";
import { reduce } from "../ledger/reduce.js";
import { parseEvents } from "../ledger/store.js";
import type { AcState, LedgerEvent, LedgerState } from "../ledger/types.js";
import { appendVouched, LedgerTampered, markOf, readLedger, verifiedLedger, type EventBody, type LedgerMark } from "../ledger/vouched.js";
import type { Project } from "../project.js";
import { checkRecordings, checkSeal } from "../seal.js";
import { checkRecordingsAnchor, gitConfigHash, markTampered, snapshotRecordings, tamperMarker, type RecordingsSnapshot } from "../tamper.js";
import { bisectRegression, BisectTampered, blameOf, lastGoodTurn } from "./bisect.js";
import { buildBrief, byAcId, type AcFailure } from "./brief.js";
import { attemptsText, specAttemptsSince } from "../agent/attempts.js";
import { appSealFiles, driftHint, isSpecKey, specChangeEvent, specFileOf } from "./spec.js";

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
  /** Kane's balance, read around every Kane batch (`credits` events); leave out to log none. */
  balance?: BalanceReader;
};

// the wrapper keeps bisect.ts (which imports this file) out of this module's start-up
export const defaultBuildDeps: BuildDeps = { claude: runClaudeTurn, tests: runTests, app: startApp, bisect: (...a) => bisectRegression(...a), balance };

export type BuildOptions = {
  /** A human raising the turn cap for this run; turn numbers are global, so this is the highest turn allowed. */
  maxTurnsOverride?: number;
  /** Aborts the loop: it stops after the current step (never mid-batch) and returns reason `aborted`. */
  signal?: AbortSignal;
};

/**
 * `inconclusive`: only Kane runs that proved nothing keep the gate shut, and a re-check proved nothing again.
 * `drift`: a spec file (and nothing else sealed) changed since the seal: a human re-plans it with `holdback drift`.
 */
export type BuildStopReason = "gate-open" | "max-turns" | "tamper" | "error" | "aborted" | "inconclusive" | "drift";
/**
 * `error` carries the detail for an `error` stop (and for a `tamper` stop on a tamper already on
 * record); `inconclusive` the tests that keep the gate shut, for an `inconclusive` stop.
 */
export type BuildResult = {
  allowStop: boolean;
  turns: number;
  reason: BuildStopReason;
  error?: string;
  inconclusive?: LedgerState["inconclusive"];
  /** For a `drift` stop: the spec files that changed, and whether the coding agent may have made the change (R37). */
  specChange?: { files: string[]; duringAgentTurn: boolean };
};

/**
 * What a session's Kane batches did. `tampered`: a sealed file changed meanwhile, and nothing but
 * `tamper` was logged for that batch. `drift`: a spec file (only) changed: the batch's results stand,
 * and nothing more ran.
 */
export type Verified = { tampered: boolean; drift: boolean; ran: Set<string>; regressed: { ac: string; turn: number }[] };

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
  // the agent's environment carries no HOLDBACK_* variable: a guard log path goes on the command line
  const ctx = { home: p.home, verifierDir: p.verifierDir, appDir: p.appDir, specFiles: p.config.spec };
  return guardHookCommand(ctx, main, process.execPath, process.env.HOLDBACK_GUARD_LOG || undefined);
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
 * Why a session cannot go on before (or between) Kane batches. `unsealed`: no seal or no criteria
 * yet. `drift`: a spec file, and nothing else sealed, changed since the seal.
 */
export type SessionStop = { reason: "tamper" | "unsealed" | "error" | "drift"; error?: string };

/**
 * The Kane-facing half of the build loop, shared with the single-shot check (`checkOnce`): the
 * vouched ledger, the two-tier seal and the git-config/recordings baseline, the app under test,
 * Kane batches and their evidence. Every ledger append goes through `emit`.
 * `log` must append to `p.ledgerFile`: the session re-reads and verifies it.
 */
export class VerifySession {
  /** The ledger as Holdback last read or wrote it. */
  events: LedgerEvent[] = [];
  /** The ledger bytes Holdback vouches for; set when the ledger is first read. */
  mark: LedgerMark | undefined;
  /** Tier 1: the last `seal` in the ledger. */
  manifest: Manifest | undefined;
  /** Tier 2 (Kane's `output-*` recordings) and the repo's git config, as of the last Kane batch or session start. */
  baseline: RecordingsSnapshot | undefined;
  /** True from the start of a Kane batch until the recordings are snapshotted again. */
  kaneWindow = false;
  /** The spec files changed since the seal when nothing else sealed did (drift, not a tamper), as of the last check. */
  specDrift: string[] = [];
  app: RunningApp | undefined;
  /** The port and data-dir label the app was last started with (a re-run starts it the same way). */
  private started: { port: number; label: string } | undefined;
  /** Every git call of Holdback's runs with no repo hook, fsmonitor or signing program. */
  readonly gitOpts: GitOptions;
  /** Each Kane batch is metered by Kane's balance (`credits` events). */
  readonly meter: KaneMeter;

  constructor(
    readonly p: Project,
    readonly deps: Pick<BuildDeps, "tests" | "app" | "balance">,
    readonly log: Log,
    /** What the batches are logged as in `credits` events: the headless build loop, or the hooks' single-shot check. */
    readonly source: "build" | "check" = "build",
  ) {
    this.gitOpts = { hooksDir: path.join(p.home, EMPTY_HOOKS_DIR) };
    this.meter = new KaneMeter(deps.balance, (e) => this.emit(e));
  }

  at(): string {
    return new Date().toISOString();
  }

  /** Append one event; the ledger must be untouched since Holdback's last append, before and after. */
  async emit(body: EventBody): Promise<void> {
    if (!this.mark) throw new Error("internal: ledger not read before the first append");
    const e = { at: this.at(), ...body } as LedgerEvent;
    this.mark = await appendVouched(this.p.ledgerFile, this.mark, this.log, e);
    this.events.push(e);
    this.meter.add(e);
  }

  /**
   * The marker goes first: it must survive a ledger that cannot take the event. A marker that cannot
   * be written must not keep the event out of the ledger either.
   */
  async recordTamper(detail: string): Promise<void> {
    let logged = detail;
    try {
      await markTampered(this.p, detail);
    } catch (e) {
      logged = `${detail} (tamper marker not written: ${errText(e)})`;
    }
    await this.emit({ t: "tamper", detail: logged });
  }

  async stopApp(): Promise<void> {
    const a = this.app;
    this.app = undefined;
    await a?.stop();
  }

  /**
   * Logs `tamper` and returns true when anything sealed changed: tier 1 (tests, variables, app
   * spec/config), the repo's git config, and, unless Kane may just have written them, its recordings.
   * A change to spec files alone is drift, not a tamper: false, with `specDrift` naming them (a spec
   * file is no input to Kane's runs; a human re-plans it). Next to any other change it is a tamper too.
   */
  async tampered(withRecordings: boolean): Promise<boolean> {
    const { p, baseline } = this;
    const bad = this.manifest ? await checkSeal(p.verifierDir, this.manifest, p.appDir) : [];
    if (baseline && (await gitConfigHash(baseline.gitConfigFile, this.gitOpts)) !== baseline.gitConfig) bad.push(".git/config");
    if (withRecordings && baseline) bad.push(...(await checkRecordings(p.verifierDir, baseline.manifest)));
    if (bad.every((k) => isSpecKey(p, k))) {
      this.specDrift = bad.map(specFileOf);
      return false;
    }
    this.specDrift = [];
    await this.recordTamper(`sealed files changed: ${bad.join(", ")}`);
    return true;
  }

  /**
   * Logs the spec drift just found (`specDrift`) as a `spec.changed` event, once per edit (R37):
   * `duringAgentTurn` when the coding agent may have made it.
   */
  async noteSpecDrift(duringAgentTurn: boolean): Promise<void> {
    if (this.specDrift.length === 0 || !this.manifest) return;
    const e = await specChangeEvent(this.p, this.events, this.manifest, this.specDrift, duringAgentTurn);
    if (e) await this.emit(e);
  }

  assertSealed(files: string[]): void {
    assertTestsSealed(this.p.verifierDir, this.manifest, files);
  }

  /** Copy a failed run's screenshot to where the agent may open it (an app failure's only). A failed copy just drops the brief line. */
  async keepEvidence(r: TestRunResult, turn: number): Promise<void> {
    if (r.status === "passed" || notAnAppFailure(r) !== undefined || !r.screenshot || !r.testId) return;
    const { appDir } = this.p;
    const src = path.resolve(r.screenshot.replace(/^~(?=[\\/])/, os.homedir()));
    const dest = path.join(appDir, ...evidencePath(turn, r.testId, r.failedStep).split("/"));
    try {
      // the agent can plant links in its own work tree: never write through one
      for (const dir of [path.join(appDir, EVIDENCE_DIR), path.dirname(dest)]) {
        await mkdir(dir, { recursive: true });
        const st = await lstat(dir);
        if (st.isSymbolicLink() || !st.isDirectory()) return;
      }
      await rm(dest, { force: true });
      await copyFile(src, dest, constants.COPYFILE_EXCL);
    } catch {
      /* the brief omits the Screenshot line */
    }
  }

  /** Where the brief points the agent for a failure's screenshot (undefined drops the line). */
  readonly screenshot = (f: AcFailure): string | undefined => {
    if (f.turn === undefined) return undefined;
    const rel = evidencePath(f.turn, f.test, f.step);
    return existsSync(path.join(this.p.appDir, ...rel.split("/"))) ? rel : undefined;
  };

  /** After a Kane batch, with the app stopped: the recordings as they are now become the baseline, and are logged. */
  async closeKaneWindow(): Promise<void> {
    const snap = await snapshotRecordings(this.p, this.gitOpts);
    this.baseline = { ...snap, gitConfig: this.baseline!.gitConfig }; // the config itself was checked just before, never re-trusted
    await this.emit({ t: "recordings", digest: this.baseline.digest, gitConfig: this.baseline.gitConfig });
    this.kaneWindow = false;
  }

  /**
   * Session start. A tamper on record (marker or ledger) is answered before anything else; then the
   * app dir must be a repo root, the ledger (trusted as found) must hold a seal and criteria, and
   * Kane's recordings and the repo's git config are held to the latest `recordings` event, unless a
   * seal came after it (spec stage, drift, human re-seal): then the disk seeds a new one.
   * `kane-evidence/` is kept out of git.
   */
  async open(): Promise<SessionStop | undefined> {
    const { p } = this;
    const marker = await tamperMarker(p);
    if (marker !== null) {
      // a tamper only the marker knows (the ledger could not take it) goes into the ledger once, so
      // whatever seal comes next drops the results from before it; later starts find it there
      try {
        if (!reduce(parseEvents((await readLedger(p.ledgerFile)).toString("utf8"))).tampered) await this.log({ at: this.at(), t: "tamper", detail: marker });
      } catch {
        /* best effort: the marker blocks either way */
      }
      return { reason: "tamper", error: RESEAL_HINT };
    }
    await mkdir(this.gitOpts.hooksDir!, { recursive: true });
    if (!(await isRepoRoot(p.appDir, this.gitOpts))) return { reason: "error", error: `the app dir must be the root of a git repository: ${p.appDir}` };
    const found = await readLedger(p.ledgerFile); // trusted as found at session start
    this.mark = markOf(found);
    this.events = parseEvents(found.toString("utf8"));
    const initial = reduce(this.events);
    if (initial.tampered) return { reason: "tamper", error: RESEAL_HINT };
    if (!lastSeal(this.events)) return { reason: "unsealed", error: NO_SEAL };
    if (Object.keys(initial.acs).length === 0) return { reason: "unsealed", error: NO_ACS };

    const anchor = await checkRecordingsAnchor(p, this.events, this.gitOpts);
    this.baseline = anchor.snapshot;
    if (anchor.moved.length > 0) {
      await this.recordTamper(`changed since Holdback last recorded them: ${anchor.moved.join(", ")}`);
      return { reason: "tamper" };
    }
    if (!anchor.anchored) await this.emit({ t: "recordings", digest: this.baseline.digest, gitConfig: this.baseline.gitConfig });
    // anchored and without a trailing slash: also matches a file or link planted under that name
    await excludeFromGit(p.appDir, `/${EVIDENCE_DIR}`, this.gitOpts);
    return undefined;
  }

  /**
   * Before any decision: the vouched ledger re-read, the seal it names, and a check that nothing
   * sealed changed at any point since the last check. Returns the reduced state, or why to stop.
   */
  async refresh(): Promise<{ state: LedgerState } | SessionStop> {
    this.events = parseEvents((await verifiedLedger(this.p.ledgerFile, this.mark!)).toString("utf8"));
    this.manifest = lastSeal(this.events);
    if (!this.manifest) return { reason: "unsealed", error: NO_SEAL };
    const state = reduce(this.events);
    if (state.tampered) return { reason: "tamper", error: RESEAL_HINT };
    if (Object.keys(state.acs).length === 0) return { reason: "unsealed", error: NO_ACS };
    if (await this.tampered(true)) return { reason: "tamper" };
    if (this.specDrift.length > 0) {
      await this.noteSpecDrift(false); // no agent runs between Holdback's checks
      return { reason: "drift", error: driftHint(this.specDrift) };
    }
    return { state };
  }

  /**
   * Starts the app for a Kane batch on `port`, on a new, empty data dir (`freshDataDir`, named after
   * `label`): rows an earlier batch wrote never reach this one. Returns why it did not start (log tail
   * and reason), or undefined. Throws `PortInUse`: another program on the port is for the human, not
   * the agent, to fix.
   */
  async startApp(port: number, label: string): Promise<string | undefined> {
    const { p } = this;
    this.started = { port, label };
    try {
      this.app = await this.deps.app({
        cwd: p.appDir,
        cmd: p.config.start.cmd,
        port,
        readyPath: p.config.start.readyPath,
        env: appEnv(p, await freshDataDir(p, label)),
      });
      return undefined;
    } catch (e) {
      if (e instanceof PortInUse) throw e;
      return startFailureText(e);
    }
  }

  /** `runSettled`'s re-run: the app stopped and started again on its port, on a fresh data dir. Throws when it does not come back. */
  private readonly restartApp = async (): Promise<string> => {
    const { port, label } = this.started!;
    await this.stopApp();
    const why = await this.startApp(port, `${label}-rerun`);
    // the reason is the last line of the start failure (the log tail comes first)
    if (why !== undefined || !this.app) throw new Error(why?.trim().split(/\r?\n/).at(-1) ?? "the app did not start");
    return `${this.app.url}/`;
  };

  /**
   * One Kane batch of `files` with the app up, logged as `run{kind:"build", turn}` (a criterion that
   * turns from green to failing also as `regression`) and metered as one `credits` event. A run that
   * failed for a reason other than the app is run once more (`runSettled`); one that does again is
   * logged inconclusive and changes no criterion. True (and nothing logged but `tamper`) when a
   * sealed file changed meanwhile.
   */
  private async runLogged(turn: number, files: string[], fileOf: Map<string, string>, done: Verified): Promise<boolean> {
    // no app (it did not come back for an earlier re-run): nothing to run against
    if (files.length === 0 || !this.app) return false;
    this.assertSealed(files);
    for (const f of files) done.ran.add(f);
    const { p } = this;
    const idOf = new Map([...fileOf].map(([id, f]) => [f, id]));
    const runOpts = { startUrl: `${this.app!.url}/`, timeoutS: p.config.kane.timeoutS, parallel: p.config.kane.parallel };
    return this.meter.batch(this.source, async () => {
      this.kaneWindow = true;
      const results = await runSettled(this.deps.tests, p.verifierDir, files, runOpts, this.restartApp);
      // results produced against a changed test or variable never reach the ledger
      if (await this.tampered(false)) return true;
      const was = reduce(this.events);
      for (const [i, r] of results.entries()) {
        // a run that never read its file has no id: attribute it, so the failure counts against its ACs
        const result = r.testId == null ? { ...r, testId: idOf.get(files[i]!) ?? null } : r;
        await this.keepEvidence(result, turn);
        await this.emit({ t: "run", kind: "build", turn, result });
      }
      // a spec edit meanwhile changes nothing Kane ran: the results stand, and the batches stop here
      if (this.specDrift.length > 0) {
        done.drift = true;
        await this.noteSpecDrift(false); // no agent runs while Kane does
      }
      const now = reduce(this.events);
      for (const ac of Object.values(now.acs).sort(byAcId)) {
        const prev = was.acs[ac.id]?.status;
        if ((prev === "passing" || prev === "proved") && ac.status === "regressed") {
          await this.emit({ t: "regression", ac: ac.id, turn });
          done.regressed.push({ ac: ac.id, turn });
        }
      }
      return false;
    });
  }

  /**
   * With the app up: the seal checked, then `batches` (each true on a tamper), unless the spec has
   * drifted; the app is stopped afterwards whatever happens.
   */
  private async withApp(batches: (done: Verified) => Promise<boolean>): Promise<Verified> {
    const done: Verified = { tampered: false, drift: false, ran: new Set(), regressed: [] };
    try {
      if (await this.tampered(true)) done.tampered = true;
      else if (this.specDrift.length > 0) {
        done.drift = true;
        await this.noteSpecDrift(false);
      } else done.tampered = await batches(done);
      return done;
    } finally {
      await this.stopApp();
    }
  }

  /**
   * With the app up (`startApp`): Kane runs the owed files, then, when `replay` is set or nothing is
   * owed any more, the files not run yet of the green criteria and of every test whose latest run
   * proved nothing (whatever its criteria's status: a vacuous one's too, else it would keep the
   * gate shut for good). Build runs keep adaptive heal on: the UI is expected to change between
   * turns. Each batch goes through `runLogged`.
   */
  async verify(turn: number, owedFiles: string[], fileOf: Map<string, string>, replay: boolean): Promise<Verified> {
    return this.withApp(async (done) => {
      if (await this.runLogged(turn, owedFiles, fileOf, done)) return true;
      if (done.drift) return false;
      const state = reduce(this.events);
      const left = gate(state);
      if (!replay && (left.owed.length > 0 || left.regressed.length > 0)) return false;
      const green = Object.values(state.acs)
        .filter((a) => a.status === "passing" || a.status === "proved")
        .sort(byAcId);
      const unsure = left.inconclusive.flatMap((u) => fileOf.get(u.test) ?? []);
      const again = [...new Set([...filesOf(green, fileOf), ...unsure])].filter((f) => !done.ran.has(f));
      return this.runLogged(turn, again, fileOf, done);
    });
  }

  /** With the app up: only `files`, in one batch (`runLogged`), no replay. */
  async recheck(turn: number, files: string[], fileOf: Map<string, string>): Promise<Verified> {
    return this.withApp((done) => this.runLogged(turn, files, fileOf, done));
  }

  /**
   * Every exit re-checks the ledger (and, on an error, the seal): a forgery never leaves as a plain error.
   * An exit from inside a Kane batch (Kane threw, too few results, the app's stop() threw) still
   * anchors the recordings Kane left, once the seal and config check out; otherwise the next run
   * would take them for a tamper. True when the exit must be reported as a tamper instead.
   */
  async settle(exit: "ok" | "error" | "tamper", thrown?: unknown): Promise<boolean> {
    try {
      if (thrown instanceof LedgerTampered) throw thrown;
      if (exit === "tamper") return false;
      if (this.mark) await verifiedLedger(this.p.ledgerFile, this.mark);
      if (exit === "error" || this.kaneWindow) {
        await this.stopApp().catch(() => {}); // a failed stop must not skip the checks
        if (await this.tampered(!this.kaneWindow)) return true;
        if (this.kaneWindow) await this.closeKaneWindow();
      }
      return false;
    } catch (e) {
      if (!(e instanceof LedgerTampered)) return false;
      await this.stopApp().catch(() => {});
      await markTampered(this.p, e.message).catch(() => {});
      try {
        await this.log({ at: this.at(), t: "tamper", detail: e.message });
      } catch {
        /* the marker blocks the next run either way */
      }
      return true;
    }
  }
}

/**
 * Headless build loop: brief the agent with what Kane says is still owed, commit
 * its turn, restart the app, re-run the tests of the owed ACs (plus a replay of
 * the passing ones every few turns), and repeat until the gate opens, the turn
 * cap is hit, or a sealed file, Kane's recordings, the repo's git config or the
 * ledger change behind Holdback's back. When only Kane runs that proved nothing
 * keep the gate shut, Kane re-runs just those tests once, with no agent turn;
 * proving nothing again stops the loop with reason `inconclusive`.
 * `log` must append to `p.ledgerFile`: the loop re-reads and verifies it every turn.
 */
export async function runBuildLoop(p: Project, deps: BuildDeps, log: Log, opts: BuildOptions = {}): Promise<BuildResult> {
  let turns = 0;
  const s = new VerifySession(p, deps, log);

  const done = (allowStop: boolean, reason: BuildStopReason, error?: string): BuildResult =>
    error === undefined ? { allowStop, turns, reason } : { allowStop, turns, reason, error };
  /** A drift stop, with what changed and where it was seen. */
  const drift = (duringAgentTurn: boolean): BuildResult => ({ ...done(false, "drift", driftHint(s.specDrift)), specChange: { files: s.specDrift, duringAgentTurn } });
  const stopped = (r: SessionStop): BuildResult => (r.reason === "drift" ? drift(false) : done(false, r.reason === "unsealed" ? "error" : r.reason, r.error));

  /**
   * For each criterion a batch just regressed that was green at least two turns ago: find the turn
   * that broke it (the app is down). True when a sealed file changed during the bisect.
   */
  const blame = async (regressed: Verified["regressed"]): Promise<boolean> => {
    if (!deps.bisect) return false;
    for (const r of regressed) {
      const good = lastGoodTurn(s.events, r.ac, r.turn);
      if (r.turn - good < 2) continue;
      s.kaneWindow = true;
      try {
        const blamed = await deps.bisect(
          p,
          r.ac,
          good,
          r.turn,
          { tests: deps.tests, app: deps.app, guard: () => s.tampered(false), ...(deps.balance ? { balance: deps.balance } : {}) },
          (e) => s.emit(e as EventBody),
        );
        if (blamed === null) await s.emit({ t: "regression", ac: r.ac, turn: r.turn, detail: "bisect inconclusive: no turn could be blamed" });
      } catch (e) {
        if (e instanceof BisectTampered) return true;
        if (e instanceof LedgerTampered) throw e;
        // best effort: the brief omits the blame line, but the failure is on record
        await s.emit({ t: "regression", ac: r.ac, turn: r.turn, detail: `bisect failed: ${errText(e)}` });
      }
    }
    return false;
  };

  const loop = async (): Promise<BuildResult> => {
    const maxTurns = opts.maxTurnsOverride ?? p.config.loop.maxTurns;
    if (typeof maxTurns !== "number" || !(maxTurns >= 0)) return done(false, "error", `loop.maxTurns must be a number, got ${JSON.stringify(maxTurns)}`);
    const start = await s.open();
    if (start) return stopped(start);

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
    await ensureHead(p.appDir, "holdback: initial commit", s.gitOpts);

    let startError: string | undefined;
    let lastTurn = 0;
    /** Kane re-checked the tests whose latest run proved nothing, without an agent turn (once per call). */
    let rechecked = false;
    for (;;) {
      // before any decision: a change made at any point since the last check is flagged
      const fresh = await s.refresh();
      if (!("state" in fresh)) return stopped(fresh);
      const state = fresh.state;
      const g = gate(state);
      if (g.allowStop) return done(true, "gate-open");
      if (opts.signal?.aborted) return done(false, "aborted");
      // only Kane runs that proved nothing keep the gate shut: Kane, not the agent, has something to
      // redo. Re-run just those tests once, under the latest turn; proving nothing again ends the run
      if (g.owed.length === 0 && g.regressed.length === 0 && g.inconclusive.length > 0) {
        if (rechecked) return { ...done(false, "inconclusive"), inconclusive: g.inconclusive };
        rechecked = true;
        const fileOf = testFileMap(s.events, p.verifierDir);
        startError = await s.startApp(p.config.start.port, `recheck-${state.turn}`);
        if (s.app) {
          const v = await s.recheck(state.turn, [...new Set(g.inconclusive.flatMap((u) => fileOf.get(u.test) ?? []))], fileOf);
          if (v.tampered || (!v.drift && (await blame(v.regressed)))) return done(false, "tamper");
          if (s.kaneWindow) await s.closeKaneWindow();
          if (v.drift) return drift(false);
          continue;
        }
        // the app does not start: that is the agent's to fix, and the next brief says so
      }
      const n = Math.max(state.turn, lastTurn) + 1;
      if (n > maxTurns) return done(false, "max-turns");

      const owed = [...[...g.regressed].sort(byAcId), ...[...g.owed].sort(byAcId)];
      const fileOf = testFileMap(s.events, p.verifierDir);
      const owedFiles = filesOf(owed, fileOf);
      s.assertSealed(owedFiles);
      lastTurn = n;
      turns += 1;
      // new code is coming: a test that proved nothing gets its re-check against it again
      rechecked = false;
      await s.emit({ t: "turn.start", n, owed: owed.map((a) => a.id) });

      // 1. agent turn
      const before = await headSha(p.appDir, s.gitOpts);
      const agentFrom = Date.now();
      const agent = await deps.claude({
        cwd: p.appDir,
        prompt: buildBrief(state, { appStartError: startError, notes: p.config.agentNotes, screenshot: s.screenshot, broke: blameOf(s.events) }),
        settingsFile,
        contractFile: contractPath(),
        maxTurns: p.config.agent.maxTurnsPerCall,
        model: p.config.agent.model,
        timeoutMs: TURN_TIMEOUT_MS,
        signal: opts.signal,
      });
      // right after the agent, before any git command of Holdback's reads what it may have planted
      if (await s.tampered(true)) return done(false, "tamper");
      // a spec edit seen right after the agent ran: the agent may have made it (R37). With a write at
      // the spec on the guard's record for this turn it is a tamper; otherwise drift of unverified
      // origin: the turn still goes on record, without it, and the run stops for a human
      const drifted = s.specDrift.length > 0;
      if (drifted) {
        const tries = await specAttemptsSince(p.home, agentFrom - 1000);
        if (tries.length > 0) {
          await s.recordTamper(`the spec changed (${s.specDrift.join(", ")}) in a turn where the agent tried to write it: ${attemptsText(tries)}`);
          return done(false, "tamper");
        }
        await s.noteSpecDrift(true);
      }
      if (agent.subtype === undefined && !agent.timedOut && agent.exitCode !== 0 && !opts.signal?.aborted) {
        // no result line at all (bad auth, bad flags, crash): another turn would fail the same way
        const why = agent.stderrTail.trim().slice(-500) || agent.resultText || "no output";
        return done(false, "error", `claude exited with code ${agent.exitCode} without a result: ${why}`);
      }

      // 2. commit the turn (never the spec files: they are the human's), restart the app
      const commit = await commitAll(p.appDir, `holdback turn ${n}: ${owed.length} owed`, s.gitOpts, p.config.spec);
      const filesChanged = commit && before ? await changedFiles(p.appDir, before, commit, s.gitOpts) : [];
      startError = await s.startApp(p.config.start.port, `turn-${n}`);
      await s.emit({
        t: "turn.end",
        n,
        commit: commit ?? (await headSha(p.appDir, s.gitOpts)) ?? "",
        filesChanged,
        durationMs: agent.durationMs,
        appUp: s.app !== undefined,
        agentExit: agent.exitCode,
        ...(agent.costUsd !== undefined ? { agentUsd: agent.costUsd } : {}),
        ...(agent.numTurns !== undefined ? { agentTurns: agent.numTurns } : {}),
      });
      if (opts.signal?.aborted) return done(false, "aborted"); // the turn is committed and on record; the app stops in `finally`
      if (drifted) return drift(true);
      if (!s.app) continue; // nothing to test; the next brief is the start failure, the next check runs at the top

      // 3. Kane: tests of the owed ACs, plus a regression replay of the passing ones now and then
      const v = await s.verify(n, owedFiles, fileOf, n % REPLAY_EVERY === 0);
      // a drift stops the run below: no bisect (its credits) for criteria a human is about to re-plan
      if (v.tampered || (!v.drift && (await blame(v.regressed)))) return done(false, "tamper");
      // this turn already ran (and re-ran) every test that still proves nothing: no separate re-check
      const left = gate(reduce(s.events)).inconclusive;
      if (left.length > 0 && left.every((u) => v.ran.has(fileOf.get(u.test) ?? ""))) rechecked = true;
      // the app is down: Kane's recordings as they are now are what the next check (and run) holds them to
      if (s.kaneWindow) await s.closeKaneWindow();
      if (v.drift) return drift(false);
    }
  };

  const finalize = async (r: BuildResult, thrown?: unknown): Promise<BuildResult> =>
    (await s.settle(r.reason === "tamper" ? "tamper" : r.reason === "error" ? "error" : "ok", thrown)) ? done(false, "tamper") : r;

  try {
    return await finalize(await loop());
  } catch (e) {
    return await finalize(done(false, "error", errText(e)), e);
  } finally {
    await s.stopApp().catch(() => {});
  }
}
