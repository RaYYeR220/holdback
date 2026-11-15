import { createHash } from "node:crypto";
import { constants, existsSync } from "node:fs";
import { copyFile, lstat, mkdir, readFile, rm } from "node:fs/promises";
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
import type { Project } from "../project.js";
import { checkRecordings, checkSeal } from "../seal.js";
import { checkRecordingsAnchor, gitConfigHash, markTampered, snapshotRecordings, tamperMarker, type RecordingsSnapshot } from "../tamper.js";
import { buildBrief, byAcId, type AcFailure } from "./brief.js";
import { appSealFiles } from "./spec.js";

type Log = (e: LedgerEvent) => Promise<void>;
type EventBody = LedgerEvent extends infer E ? (E extends { at: string } ? Omit<E, "at"> : never) : never;
type Manifest = Record<string, string>;

export type BuildDeps = {
  claude: typeof runClaudeTurn;
  tests: typeof runTests;
  app: typeof startApp;
  /** Shell command for the agent's PreToolUse guard. Default: the built guard entry run by this node binary. */
  guardCommand?: string;
};

export const defaultBuildDeps: BuildDeps = { claude: runClaudeTurn, tests: runTests, app: startApp };

export type BuildOptions = {
  /** A human raising the turn cap for this run; turn numbers are global, so this is the highest turn allowed. */
  maxTurnsOverride?: number;
};

export type BuildStopReason = "gate-open" | "max-turns" | "tamper" | "error";
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

function lastSeal(events: LedgerEvent[]): Manifest | undefined {
  const e = events[lastIndex(events, "seal")];
  return e && e.t === "seal" ? e.manifest : undefined;
}

/** Test id -> absolute test file, from the latest `design` event that names one. */
function testFileMap(events: LedgerEvent[], verifierDir: string): Map<string, string> {
  const out = new Map<string, string>();
  for (const e of events) {
    if (e.t !== "design") continue;
    for (const t of e.tests) if (t.file) out.set(t.id, path.resolve(verifierDir, t.file));
  }
  return out;
}

/** The test files that verify `acs`, deduplicated in order. Fails when a test has no recorded file. */
function filesOf(acs: AcState[], files: Map<string, string>): string[] {
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

function startFailureText(e: unknown): string {
  if (e instanceof AppStartError) return [e.logs.replace(/\s+$/, ""), e.message].filter((s) => s.length > 0).join("\n");
  return e instanceof Error ? e.message : String(e);
}

/** `kane-evidence/turn-<N>/<test-id>-step-<K>.png`, relative to the app dir, `/`-separated. */
export function evidencePath(turn: number, testId: string, step: number | undefined): string {
  const id = testId.replace(/[^\w.-]/g, "_");
  return `${EVIDENCE_DIR}/turn-${turn}/${id}${step === undefined ? "" : `-step-${step}`}.png`;
}

/** Byte length + sha256 of the ledger as Holdback last wrote it. */
type LedgerMark = { size: number; sha256: string };

const sha256 = (b: Buffer): string => createHash("sha256").update(b).digest("hex");

async function readLedger(file: string): Promise<Buffer> {
  try {
    return await readFile(file);
  } catch (e) {
    // only "no ledger yet" is empty; any other error must not look like an empty (all-clear) ledger
    if ((e as NodeJS.ErrnoException).code !== "ENOENT") throw e;
    return Buffer.alloc(0);
  }
}

class LedgerTampered extends Error {
  constructor(detail = "ledger modified outside Holdback") {
    super(detail);
  }
}

const errText = (e: unknown) => (e instanceof Error ? e.message : String(e));

/** Once Holdback vouches for the ledger, failing to read it is as bad as finding it changed. */
async function readVouched(file: string): Promise<Buffer> {
  try {
    return await readLedger(file);
  } catch (e) {
    throw new LedgerTampered(`ledger unreadable: ${errText(e)}`);
  }
}

/** Throws LedgerTampered unless the file is byte-for-byte what `mark` vouches for. */
async function verifiedLedger(file: string, mark: LedgerMark): Promise<Buffer> {
  const raw = await readVouched(file);
  if (raw.length !== mark.size || sha256(raw) !== mark.sha256) throw new LedgerTampered();
  return raw;
}

/** After appending `e`: the file must be the vouched-for bytes plus exactly that one event. Returns the new mark. */
async function markAfterAppend(file: string, mark: LedgerMark, e: LedgerEvent): Promise<LedgerMark> {
  const raw = await readVouched(file);
  if (raw.length <= mark.size || sha256(raw.subarray(0, mark.size)) !== mark.sha256) throw new LedgerTampered();
  const tail = raw.subarray(mark.size).toString("utf8").trim();
  let added: unknown;
  try {
    added = JSON.parse(tail); // more than one line fails to parse
  } catch {
    throw new LedgerTampered();
  }
  if (JSON.stringify(added) !== JSON.stringify(e)) throw new LedgerTampered();
  return { size: raw.length, sha256: sha256(raw) };
}

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
    await verifiedLedger(p.ledgerFile, mark);
    try {
      await log(e);
    } catch (err) {
      throw new LedgerTampered(`ledger append failed: ${errText(err)}`);
    }
    mark = await markAfterAppend(p.ledgerFile, mark, e);
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
  /** Every test Kane is about to run must be a tier-1 sealed file. */
  const assertSealed = (files: string[]) => {
    for (const f of files) {
      const rel = path.relative(p.verifierDir, f).split(path.sep).join("/");
      if (!rel.startsWith(".testmuai/tests/") || !manifest || manifest[rel] === undefined) throw new Error(`test file not sealed: ${f}`);
    }
  };
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
    mark = { size: found.length, sha256: sha256(found) };
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
        prompt: buildBrief(state, { appStartError: startError, notes: p.config.agentNotes, screenshot }),
        settingsFile,
        contractFile: contractPath(),
        maxTurns: p.config.agent.maxTurnsPerCall,
        model: p.config.agent.model,
        timeoutMs: TURN_TIMEOUT_MS,
      });
      // right after the agent, before any git command of Holdback's reads what it may have planted
      if (await tampered(true)) return done(false, "tamper");
      if (agent.subtype === undefined && !agent.timedOut && agent.exitCode !== 0) {
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
          env: p.config.start.env,
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
      if (!app) continue; // nothing to test; the next brief is the start failure, the next check runs at the top

      // 3. Kane: tests of the owed ACs, plus a regression replay of the passing ones now and then.
      // Build runs keep adaptive heal on: the UI is expected to change between turns.
      if (await tampered(true)) return done(false, "tamper");
      const runOpts = { startUrl: `${app.url}/`, timeoutS: p.config.kane.timeoutS, parallel: p.config.kane.parallel };
      const ran = new Set<string>();
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
          if ((prev === "passing" || prev === "proved") && ac.status === "regressed") await emit({ t: "regression", ac: ac.id, turn: n });
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
