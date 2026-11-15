import { existsSync } from "node:fs";
import path from "node:path";
import { contractPath, guardMainPath, runClaudeTurn } from "../agent/claude.js";
import { writeAgentSettings } from "../agent/guard.js";
import { AppStartError, startApp, type RunningApp } from "../app.js";
import { changedFiles, commitAll, ensureHead, headSha, isRepoRoot } from "../git.js";
import { runTests } from "../kane/testmd.js";
import { gate } from "../ledger/gate.js";
import { reduce } from "../ledger/reduce.js";
import { readEvents } from "../ledger/store.js";
import type { AcState, LedgerEvent } from "../ledger/types.js";
import type { Project } from "../project.js";
import { checkSeal, seal } from "../seal.js";
import { buildBrief, byAcId } from "./brief.js";
import { appSealFiles } from "./spec.js";

type Log = (e: LedgerEvent) => Promise<void>;
type EventBody = LedgerEvent extends infer E ? (E extends { at: string } ? Omit<E, "at"> : never) : never;
type Manifest = Record<string, string>;

export type BuildDeps = {
  claude: typeof runClaudeTurn;
  tests: typeof runTests;
  app: typeof startApp;
  /** Shell command for the agent's PreToolUse guard. Default: the built guard entry run through node. */
  guardCommand?: string;
};

export const defaultBuildDeps: BuildDeps = { claude: runClaudeTurn, tests: runTests, app: startApp };

export type BuildStopReason = "gate-open" | "max-turns" | "tamper" | "error";
export type BuildResult = { allowStop: boolean; turns: number; reason: BuildStopReason; error?: string };

const TURN_TIMEOUT_MS = 30 * 60_000;
/** Every Nth turn (and on the turn that empties the owed list) the passing ACs' tests are replayed too. */
const REPLAY_EVERY = 3;
const SETTINGS_FILE = "agent-settings.json";
const APP_PREFIX = "app:";

function defaultGuardCommand(p: Project): string {
  const main = guardMainPath();
  // a hook command that cannot start exits 1, which Claude Code treats as "allow": refuse to run without it
  if (!existsSync(main)) throw new Error(`guard entry not found at ${main}: build @holdback/core first`);
  return `node "${main}" --home "${p.home}" --verifier "${p.verifierDir}"`;
}

function lastSeal(events: LedgerEvent[]): Manifest | undefined {
  for (let i = events.length - 1; i >= 0; i--) {
    const e = events[i]!;
    if (e.t === "seal") return e.manifest;
  }
  return undefined;
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

const appEntries = (m: Manifest): Manifest => Object.fromEntries(Object.entries(m).filter(([k]) => k.startsWith(APP_PREFIX)));

function sameManifest(a: Manifest, b: Manifest): boolean {
  const ka = Object.keys(a);
  return ka.length === Object.keys(b).length && ka.every((k) => b[k] === a[k]);
}

function startFailureText(e: unknown): string {
  if (e instanceof AppStartError) return [e.logs.replace(/\s+$/, ""), e.message].filter((s) => s.length > 0).join("\n");
  return e instanceof Error ? e.message : String(e);
}

/**
 * Headless build loop: brief the agent with what Kane says is still owed, commit
 * its turn, restart the app, re-run the tests of the owed ACs (plus a replay of
 * the passing ones every few turns), and repeat until the gate opens, the turn
 * cap is hit, or a sealed file changes. `log` must append to `p.ledgerFile`:
 * every turn starts from a fresh read of the ledger.
 */
export async function runBuildLoop(p: Project, deps: BuildDeps, log: Log): Promise<BuildResult> {
  let turns = 0;
  let app: RunningApp | undefined;
  let events: LedgerEvent[] = [];

  const done = (allowStop: boolean, reason: BuildStopReason, error?: string): BuildResult =>
    error === undefined ? { allowStop, turns, reason } : { allowStop, turns, reason, error };
  const emit = async (body: EventBody) => {
    const e = { at: new Date().toISOString(), ...body } as LedgerEvent;
    await log(e);
    events.push(e);
  };
  const stopApp = async () => {
    const a = app;
    app = undefined;
    await a?.stop();
  };
  /** Logs `tamper` and returns true when a sealed test, variable or app spec/config file changed. */
  const tampered = async (manifest: Manifest): Promise<boolean> => {
    const bad = await checkSeal(p.verifierDir, manifest, p.appDir);
    if (bad.length === 0) return false;
    await emit({ t: "tamper", detail: `sealed files changed: ${bad.join(", ")}` });
    return true;
  };

  try {
    const maxTurns = p.config.loop.maxTurns;
    if (typeof maxTurns !== "number" || !(maxTurns >= 0)) return done(false, "error", `loop.maxTurns must be a number, got ${JSON.stringify(maxTurns)}`);
    if (!(await isRepoRoot(p.appDir))) return done(false, "error", `the app dir must be the root of a git repository: ${p.appDir}`);
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
    await ensureHead(p.appDir, "holdback: initial commit");

    let startError: string | undefined;
    let lastTurn = 0;
    for (;;) {
      events = await readEvents(p.ledgerFile); // throws on anything but "no ledger yet": fail closed
      const manifest = lastSeal(events);
      if (!manifest) return done(false, "error", "no seal in the ledger: run the spec stage first");
      let state = reduce(events);
      if (Object.keys(state.acs).length === 0) return done(false, "error", "no acceptance criteria in the ledger: run the spec stage first");
      const g = gate(state);
      if (g.allowStop) return done(true, "gate-open");
      if (turns >= maxTurns) return done(false, "max-turns");
      if (await tampered(manifest)) return done(false, "tamper");

      const owed = [...[...g.regressed].sort(byAcId), ...[...g.owed].sort(byAcId)];
      const fileOf = testFileMap(events, p.verifierDir);
      const idOf = new Map([...fileOf].map(([id, f]) => [f, id]));
      const owedFiles = filesOf(owed, fileOf);
      const n = Math.max(state.turn, lastTurn) + 1;
      lastTurn = n;
      turns += 1;
      await emit({ t: "turn.start", n, owed: owed.map((a) => a.id) });

      // 1. agent turn
      const before = await headSha(p.appDir);
      const agent = await deps.claude({
        cwd: p.appDir,
        prompt: buildBrief(state, { appStartError: startError, notes: p.config.agentNotes }),
        settingsFile,
        contractFile: contractPath(),
        maxTurns: p.config.agent.maxTurnsPerCall,
        model: p.config.agent.model,
        timeoutMs: TURN_TIMEOUT_MS,
      });
      if (agent.subtype === undefined && !agent.timedOut && agent.exitCode !== 0) {
        // no result line at all (bad auth, bad flags, crash): another turn would fail the same way
        const why = agent.stderrTail.trim().slice(-500) || agent.resultText || "no output";
        return done(false, "error", `claude exited with code ${agent.exitCode} without a result: ${why}`);
      }

      // 2. commit the turn, restart the app
      const commit = await commitAll(p.appDir, `holdback turn ${n}: ${owed.length} owed`);
      const filesChanged = commit && before ? await changedFiles(p.appDir, before, commit) : [];
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
        commit: commit ?? (await headSha(p.appDir)) ?? "",
        filesChanged,
        durationMs: agent.durationMs,
        appUp: app !== undefined,
        agentExit: agent.exitCode,
      });
      if (!app) continue; // nothing to test; the next brief is the start failure

      // 3. Kane: tests of the owed ACs, plus a regression replay of the passing ones now and then
      if (await tampered(manifest)) return done(false, "tamper");
      const opts = { startUrl: `${app.url}/`, timeoutS: p.config.kane.timeoutS, parallel: p.config.kane.parallel };
      const ran = new Set<string>();
      const runBatch = async (batch: string[]) => {
        if (batch.length === 0) return;
        for (const f of batch) ran.add(f);
        const results = await deps.tests(p.verifierDir, batch, opts);
        if (results.length !== batch.length) throw new Error(`Kane returned ${results.length} results for ${batch.length} tests`);
        const was = reduce(events);
        for (const [i, r] of results.entries()) {
          // a run that never read its file has no id: attribute it, so the failure counts against its ACs
          const result = r.testId == null ? { ...r, testId: idOf.get(batch[i]!) ?? null } : r;
          await emit({ t: "run", kind: "build", turn: n, result });
        }
        const now = reduce(events);
        for (const ac of Object.values(now.acs).sort(byAcId)) {
          const prev = was.acs[ac.id]?.status;
          if ((prev === "passing" || prev === "proved") && ac.status === "regressed") await emit({ t: "regression", ac: ac.id, turn: n });
        }
      };
      try {
        await runBatch(owedFiles);
        state = reduce(events);
        if (n % REPLAY_EVERY === 0 || gate(state).allowStop) {
          const green = Object.values(state.acs)
            .filter((a) => a.status === "passing" || a.status === "proved")
            .sort(byAcId);
          await runBatch(filesOf(green, fileOf).filter((f) => !ran.has(f)));
        }
      } finally {
        await stopApp();
        // Kane writes its recordings into the test files it runs: re-seal the verifier side
        // (only Kane ran since the check above); app entries keep their originally sealed hashes.
        const resealed = { ...(await seal(p.verifierDir)), ...appEntries(manifest) };
        if (!sameManifest(resealed, manifest)) await emit({ t: "seal", manifest: resealed });
      }
    }
  } catch (e) {
    return done(false, "error", e instanceof Error ? e.message : String(e));
  } finally {
    await stopApp().catch(() => {});
  }
}
