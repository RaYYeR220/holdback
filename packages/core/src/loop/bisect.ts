import { mkdir } from "node:fs/promises";
import path from "node:path";
import { freePort, startApp } from "../app.js";
import { holdbackGitOptions, worktreeAdd } from "../git.js";
import { runTests, type TestRunResult } from "../kane/testmd.js";
import { reduce } from "../ledger/reduce.js";
import { parseEvents } from "../ledger/store.js";
import type { LedgerEvent } from "../ledger/types.js";
import { readLedger } from "../ledger/vouched.js";
import type { Project } from "../project.js";
import { logRecordings } from "../tamper.js";
import type { Blame } from "./brief.js";
import { assertTestsSealed, filesOf, lastSeal, testFileMap } from "./build.js";
import { dropWorktreeSafely, linkAppNodeModules } from "./falsify.js";

type Log = (e: LedgerEvent) => Promise<void>;

export type BisectDeps = {
  tests: typeof runTests;
  app: typeof startApp;
  /** A spare port for each probe. Default: `freePort`. */
  port?: () => Promise<number>;
  /**
   * Called after each probe's Kane run, before its results are logged: true when a sealed file
   * changed meanwhile (the caller has recorded the tamper). The bisect then throws `BisectTampered`.
   */
  guard?: () => Promise<boolean>;
};

/** Sealed files changed while a bisect ran; nothing it produced reached the ledger. */
export class BisectTampered extends Error {
  constructor() {
    super("sealed files changed during the regression bisect");
    this.name = "BisectTampered";
  }
}

const BISECT_DIR = "bisect";
type Verdict = "pass" | "fail" | "error";

/** One probe's reading of its Kane results: the AC failing is a fail; every test passing is a pass; anything else proves nothing. */
export function probeVerdict(acId: string, results: TestRunResult[]): Verdict {
  if (results.some((r) => r.criteriaFailed.includes(acId))) return "fail";
  return results.length > 0 && results.every((r) => r.status === "passed") ? "pass" : "error";
}

/**
 * The last turn at which `ac` was green (`passing` or `proved`) before the build runs of
 * `beforeTurn`, or 0 when it never was.
 */
export function lastGoodTurn(events: LedgerEvent[], ac: string, beforeTurn: number): number {
  const seen: LedgerEvent[] = [];
  let good = 0;
  for (const e of events) {
    if (e.t === "run" && e.kind === "build" && (e.turn ?? 0) >= beforeTurn) continue;
    seen.push(e);
    // only a run of one of the AC's own tests says anything about it at that turn
    if (e.t !== "run" || e.kind !== "build" || e.turn === undefined) continue;
    const a = reduce(seen).acs[ac];
    if (a && e.result.testId != null && a.tests.includes(e.result.testId) && (a.status === "passing" || a.status === "proved")) good = e.turn;
  }
  return good;
}

/** The blame the latest `regression` of each AC carries, with the files its turn changed. */
export function blameOf(events: LedgerEvent[]): Map<string, Blame> {
  const out = new Map<string, Blame>();
  for (const e of events) {
    if (e.t !== "regression") continue;
    if (e.blamedTurn === undefined || e.blamedCommit === undefined) {
      out.delete(e.ac); // a newer regression nobody has blamed (yet)
      continue;
    }
    const end = events.find((x) => x.t === "turn.end" && x.n === e.blamedTurn);
    out.set(e.ac, { turn: e.blamedTurn, commit: e.blamedCommit, files: end && end.t === "turn.end" ? end.filesChanged : [] });
  }
  return out;
}

/**
 * Binary-search the agent's own turn commits for the turn that broke `ac`, which passed at
 * `goodTurn` and fails at `badTurn`: each probe checks out a commit in a throwaway worktree,
 * starts the app there on a spare port with its own data dir, and replays the AC's sealed tests
 * with healing off (logged as `run{kind:"bisect"}`, which never changes an AC's status).
 * The first failing turn is blamed and logged as `regression{blamedTurn, blamedCommit}`.
 * A probe that proves nothing (app down, Kane error) is tried once more; a second miss gives null.
 */
export async function bisectRegression(
  p: Project,
  ac: string,
  goodTurn: number,
  badTurn: number,
  deps: BisectDeps,
  log: Log,
): Promise<{ turn: number; commit: string } | null> {
  const gitOpts = await holdbackGitOptions(p.home);
  const events = parseEvents((await readLedger(p.ledgerFile)).toString("utf8"));
  const state = reduce(events);
  const acState = state.acs[ac];
  if (!acState) return null;
  const files = filesOf([acState], testFileMap(events, p.verifierDir));
  assertTestsSealed(p.verifierDir, lastSeal(events), files);
  const idOf = new Map([...testFileMap(events, p.verifierDir)].map(([id, f]) => [f, id]));

  // the turns after the good one, up to the bad one; a turn that committed nothing is its predecessor
  const ends = events.filter((e): e is Extract<LedgerEvent, { t: "turn.end" }> => e.t === "turn.end" && e.n > goodTurn && e.n <= badTurn && e.commit !== "");
  ends.sort((a, b) => a.n - b.n);
  if (ends.length === 0 || ends[ends.length - 1]!.n !== badTurn) return null;
  const cands = ends.filter((e, i) => i === 0 || e.commit !== ends[i - 1]!.commit);

  const at = () => new Date().toISOString();
  let probes = 0;
  const probe = async (commit: string, turn: number): Promise<Verdict> => {
    probes += 1;
    const dir = path.join(p.home, BISECT_DIR, `${ac.replace(/[^\w.-]/g, "_")}-${turn}-${probes}`);
    let app: Awaited<ReturnType<typeof startApp>> | undefined;
    try {
      await mkdir(path.dirname(dir), { recursive: true });
      await worktreeAdd(p.appDir, dir, commit, gitOpts);
      await linkAppNodeModules(p, dir);
      const dataDir = path.join(dir, "data");
      await mkdir(dataDir, { recursive: true });
      try {
        app = await deps.app({
          cwd: dir,
          cmd: p.config.start.cmd,
          port: await (deps.port ?? freePort)(),
          readyPath: p.config.start.readyPath,
          env: { ...p.config.start.env, DATA_DIR: dataDir, VENICE_API_KEY: "" }, // the breaker's key never reaches an app under test
        });
      } catch {
        return "error"; // the commit does not boot: proves nothing about the AC
      }
      let results: TestRunResult[];
      try {
        results = await deps.tests(p.verifierDir, files, { startUrl: `${app.url}/`, noHeal: true, timeoutS: p.config.kane.timeoutS, parallel: p.config.kane.parallel });
      } finally {
        await app.stop().catch(() => {});
        app = undefined;
      }
      if (results.length !== files.length) return "error";
      if (deps.guard && (await deps.guard())) throw new BisectTampered();
      const attributed = results.map((r, i) => (r.testId == null ? { ...r, testId: idOf.get(files[i]!) ?? null } : r));
      for (const result of attributed) await log({ at: at(), t: "run", kind: "bisect", turn, result });
      return probeVerdict(ac, attributed);
    } catch (e) {
      if (e instanceof BisectTampered) throw e;
      return "error";
    } finally {
      await app?.stop().catch(() => {});
      await dropWorktreeSafely(p, dir, gitOpts);
    }
  };
  /** A probe that proves nothing gets one more try. */
  const settled = async (commit: string, turn: number): Promise<"pass" | "fail" | null> => {
    for (let i = 0; i < 2; i++) {
      const v = await probe(commit, turn);
      if (v !== "error") return v;
    }
    return null;
  };

  let tampered = false;
  try {
    // lo = -1 stands for goodTurn (green); cands[hi] is bad (badTurn's commit at the start)
    let lo = -1;
    let hi = cands.length - 1;
    while (hi - lo > 1) {
      const mid = (lo + hi) >> 1;
      const v = await settled(cands[mid]!.commit, cands[mid]!.n);
      if (v === null) return null;
      if (v === "pass") lo = mid;
      else hi = mid;
    }
    const blamed = cands[hi]!;
    await log({ at: at(), t: "regression", ac, turn: badTurn, blamedTurn: blamed.n, blamedCommit: blamed.commit });
    return { turn: blamed.n, commit: blamed.commit };
  } catch (e) {
    tampered = e instanceof BisectTampered;
    throw e;
  } finally {
    // Kane may have written recordings during the probes: the next build loop's anchor must match
    if (probes > 0 && !tampered) await logRecordings(p, log, gitOpts);
  }
}
