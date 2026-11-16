import { existsSync } from "node:fs";
import { lstat, mkdir, readdir, readFile, readlink, rm, stat, symlink, unlink, writeFile } from "node:fs/promises";
import path from "node:path";
import { freePort, startApp, type RunningApp } from "../app.js";
import { appEnv, freshDataDir } from "../datadir.js";
import { BreakerError, BreakerUnavailable, BudgetRefused, checkPatch, patchedFiles, pickFiles, proposeMutant, type Mutant, type Slip, type SourceFile } from "../breaker/mutate.js";
import { Budget, MAX_TOKENS, RETRY_MAX_TOKENS, veniceChat } from "../breaker/venice.js";
import { git, holdbackGitOptions, isRepoRoot, uncommitted, worktreeAdd, worktreeRemove, type GitOptions } from "../git.js";
import { balance, evolve, readGraph, type Graph, type TestNode } from "../kane/assurance.js";
import { inconclusiveNote, notAnAppFailure, runSettled, runTests, type TestRunResult } from "../kane/testmd.js";
import { KaneCapReached, KaneMeter, type BalanceReader } from "../ledger/credits.js";
import { reduce } from "../ledger/reduce.js";
import { parseEvents } from "../ledger/store.js";
import type { AcState, LedgerEvent } from "../ledger/types.js";
import { appendVouched, LedgerTampered, markOf, readLedger, verifiedLedger, type EventBody, type LedgerMark } from "../ledger/vouched.js";
import { kaneCapCredits, type Project } from "../project.js";
import { checkSeal, tier1Entries, type SealEntry } from "../seal.js";
import { checkRecordingsAnchor, gitConfigHash, logRecordings, markTampered, tamperMarker, type RecordingsSnapshot } from "../tamper.js";
import { escapeControls } from "../text.js";
import { byAcId } from "./brief.js";
import { logMarkedTamper, recordTamperIn } from "./session.js";
import { assertTestsSealed, EVIDENCE_DIR, filesOf, lastSeal, startFailureText, testFileMap } from "./build.js";
import type { HumanIO } from "./human.js";
import { appMovedFrom, appPinOf, appSealFiles, classifySpecChange, driftHint, isSpecKey, reseal, specFileOf, type AppPin, type Warn } from "./spec.js";

type Log = (e: LedgerEvent) => Promise<void>;
type Verdict = Extract<LedgerEvent, { t: "mutant" }>["verdict"];
type MutantEvent = Extract<LedgerEvent, { t: "mutant" }>;

/** The Kane Assurance calls falsify makes after a survivor (injectable for tests). */
export type FalsifyKane = {
  evolve: typeof evolve;
  readGraph: typeof readGraph;
};

export type FalsifyDeps = {
  /** The breaker's chat call. */
  chat: typeof veniceChat;
  tests: typeof runTests;
  app: typeof startApp;
  kane: FalsifyKane;
  /** A spare port for each mutant. Default: `freePort`. */
  port?: () => Promise<number>;
  /** Default: `process.env.VENICE_API_KEY`. */
  apiKey?: string;
  /** Kane's balance, read around every Kane batch (`credits` events); leave out to log none. */
  balance?: BalanceReader;
};

export const defaultFalsifyDeps: FalsifyDeps = {
  chat: veniceChat,
  tests: runTests,
  app: startApp,
  kane: { evolve, readGraph },
  balance,
};

/**
 * `budget`: the breaker's USD cap (the pass went on as far as it could). `kane-budget`: the project's
 * Kane credit cap was reached (I6): the pass stopped. `drift`: a spec file (and nothing else sealed)
 * changed: the pass stopped attacking, for a human to re-plan the spec.
 */
export type FalsifyStopReason = "done" | "budget" | "kane-budget" | "tamper" | "error" | "aborted" | "drift";

export type FalsifyResult = {
  /** ACs whose mutant Kane caught: now `proved`. */
  killed: string[];
  /** ACs whose mutant passed every test (`survived` or `survived-by-heal`): now `vacuous`. */
  survived: string[];
  /** ACs whose mutant proved nothing: the patch never applied, the mutant did not start, or a test failed on other ACs only. */
  invalid: string[];
  /** Use cases Kane evolved after a survivor (R40): their ACs are `owed` again (back to the build loop, then a re-check). */
  redesigned: string[];
  /** What Kane was told for each evolve that was sealed: for the human's own output (`holdback run`), never `status` (I-4). */
  evolved?: { uc: string; because: string; followUp?: boolean }[];
  /**
   * Survivors left `vacuous`: Kane's evolve added no test, the run's evolves of the use case are
   * spent, or a re-checked survivor got past the new tests too. Reported, not blocked on.
   */
  vacuous: string[];
  /** Passing ACs not attacked because the next breaker call could pass the budget cap. */
  skipped: string[];
  /** Breaker USD spent in this pass. */
  usd: number;
  reason: FalsifyStopReason;
  error?: string;
  /** Why the last evolve added no test. */
  redesignError?: string;
  /** Why the closing replay against the real build did not run. */
  replayError?: string;
  /** For a `drift` stop on a spec that moved while Kane evolved the tests (N-I2): what changed; its origin is unverified. */
  specChange?: { files: string[]; duringAgentTurn: boolean };
  /**
   * Every planted bug that got past the tests in this pass (or an earlier pass's, sent to Kane in
   * this one: `earlier`): the criterion, the mutant and the slip in plain words. For the human's own
   * output (`holdback run`), never `status` (I-4).
   */
  survivors?: { ac: string; mutant: string; slip: string; recheck?: true; earlier?: true }[];
  /** Survivors whose use case Kane did not evolve in this pass, and why (R44). */
  notEvolved?: { uc: string; acs: string[]; why: string }[];
};

const MUT_DIR = "mut";
/** Where regression-bisect probes check out commits. */
export const BISECT_DIR = "bisect";
const RESEAL_HINT = "a tamper is on record: a human re-seals (`holdback reseal`) before falsifying";
const NO_SEAL = "no seal in the ledger: run the spec stage first";
const errText = (e: unknown) => (e instanceof Error ? e.message : String(e));

/**
 * The verdict on one mutant from its Kane runs (healing off). Only a failure Kane blames on the app
 * kills it; a run that failed for any other reason (R34: after one re-run) leaves it `invalid`.
 */
export function falsifyVerdict(acId: string, results: TestRunResult[]): { verdict: Verdict; note?: string } {
  if (results.some((r) => notAnAppFailure(r) === undefined && r.criteriaFailed.includes(acId))) return { verdict: "killed" };
  const unsure = results.filter((r) => notAnAppFailure(r) !== undefined);
  if (unsure.length > 0) return { verdict: "invalid", note: `inconclusive: ${unsure.map(inconclusiveNote).join("; ")}` };
  const failed = results.filter((r) => r.status !== "passed");
  if (failed.length > 0) {
    const what = failed.map((r) => `${r.testId ?? r.testFile} ${r.status}${r.criteriaFailed.length > 0 ? ` (${r.criteriaFailed.join(", ")})` : ""}`);
    return { verdict: "invalid", note: `collateral: ${what.join("; ")}; ${acId} not among the failed criteria` };
  }
  const healed = results.filter((r) => r.healTriggered || r.authorDecisions > 0);
  if (healed.length > 0) {
    const what = healed.map((r) => `${r.testId ?? r.testFile} (${r.healTriggered ? "heal triggered" : `${r.authorDecisions} author decisions`})`);
    return { verdict: "survived-by-heal", note: `passed only after a heal or re-authoring: ${what.join(", ")}` };
  }
  return { verdict: "survived" };
}

/** Files changed by the agent's turns, most recent first. */
function recentChanges(events: LedgerEvent[]): string[] {
  const out: string[] = [];
  for (let i = events.length - 1; i >= 0; i--) {
    const e = events[i]!;
    if (e.t === "turn.end") for (const f of e.filesChanged) if (!out.includes(f)) out.push(f);
  }
  return out;
}

/**
 * R40, R44: at most this many survivor-triggered `maintain evolve` calls per use case per run. Each
 * may be followed by one cover evolve (criteria its new set left without a test), which does not
 * count; the Kane credit cap still bounds them all.
 */
export const MAX_EVOLVES = 2;
/** The longest `--because` Holdback sends Kane. */
const MAX_BECAUSE = 1500;
/** Why a survivor stays vacuous when Kane's evolve adds no test (plain words, for the human). */
export const NO_TEST = "Kane could not add a test that catches this planted bug";
/** Why a criterion an evolve left without a test needs the spec. */
const UNCOVERED = "Kane's evolved tests no longer cover it";

/** A survivor of this pass: what Kane is told about it if its use case is evolved. */
type Survivor = { ac: AcState; id: string; patch: string; rationale: string; slip?: Slip };

/** Kane's evolve cannot be used; the verifier is rolled back. */
class EvolveFailed extends Error {}
/** Kane's evolve touched sealed verifier entries outside its own use case's tests: a tamper. */
class EvolveStray extends Error {
  constructor(readonly paths: string[]) {
    super(paths.join(", "));
  }
}
/** A tamper found in an evolve, already on record: the pass stops with reason `tamper`. */
class EvolveTampered extends Error {}

/** One line, control and format characters escaped: text a model wrote, on its way to a command line. */
const oneLine = (t: string): string => escapeControls(t.replace(/\s+/g, " ").trim());

/**
 * What Kane is told slipped through (R40): each surviving bug in a user's terms, the inputs that show
 * it, and what the page should show against what it showed, from the breaker's own account (else its
 * rationale and the lines it changed). Kane is the verifier and may see it; the builder never does.
 */
export function becauseText(list: Pick<Survivor, "ac" | "patch" | "rationale" | "slip">[]): string {
  const one = (s: (typeof list)[number]) => {
    const head = `${s.ac.id} ("${s.ac.text}")`;
    if (s.slip) return `${head}: ${s.slip.behaviour} With ${s.slip.inputs}, the page should show ${s.slip.expected}, but it showed ${s.slip.observed}.`;
    const changed = s.patch
      .split("\n")
      .filter((l) => /^[-+]/.test(l) && !/^(---|\+\+\+) /.test(l))
      .slice(0, 8)
      .join(" | ");
    return `${head}: ${s.rationale || "a planted change"}. The planted change: ${changed}.`;
  };
  const intro = list.length === 1 ? "A planted bug got past every test of this use case." : `${list.length} planted bugs got past every test of this use case.`;
  const text = oneLine(`${intro} ${list.map(one).join(" ")} Add a test that catches ${list.length === 1 ? "it" : "each"}.`);
  return text.length > MAX_BECAUSE ? `${text.slice(0, MAX_BECAUSE - 1)}…` : text;
}

/**
 * The bug a criterion's tests must now catch (R40, m-3): when its use case was evolved and no mutant of
 * the criterion came since, the criterion's own survivor that an evolve of that use case answered
 * (this one or an earlier one: a later evolve replaces the tests that caught it, so it is re-checked
 * again). None once a drift the human applied came since: the old bug may not break the new spec.
 */
export function pendingRecheck(events: LedgerEvent[], ac: { id: string; useCase: string }): MutantEvent | undefined {
  let i = events.length - 1;
  for (; i >= 0; i--) {
    const e = events[i]!;
    if ((e.t === "mutant" && e.ac === ac.id) || (e.t === "drift" && e.applied)) return undefined;
    if (e.t === "falsify.evolved" && e.uc === ac.useCase) break;
  }
  for (; i >= 0; i--) {
    const e = events[i]!;
    if (e.t === "drift" && e.applied) return undefined;
    if (e.t !== "falsify.evolved" || e.uc !== ac.useCase) continue;
    const m = events.find((x): x is MutantEvent => x.t === "mutant" && x.ac === ac.id && e.mutants.includes(x.id));
    if (m) return m;
  }
  return undefined;
}

/** Why a survivor whose use case Kane did not get to evolve this run stays vacuous for now: the next pass tries again (m-2). */
export const EVOLVE_BOUND = "Kane already evolved this use case twice in this run: the next `holdback run` tries again";
/** Why a re-checked survivor is not sent to Kane again. */
export const RECHECK_SURVIVED = "the planted bug got past Kane's evolved tests too, so Kane is not asked again in this run";
/** Why survivors wait when the pass stopped before their evolve. */
const STOPPED = "the run was stopped before Kane could evolve its tests";
/** Why survivors wait when the spec changed during the pass. */
const SPEC_MOVED = "the spec changed during the pass: run `holdback drift`, then `holdback run`";
export const EVOLVE_CAP = "the Kane credit cap was reached before Kane could evolve its tests";

/**
 * Survivors whose use case Kane never evolved (m-2): the latest mutant of a vacuous criterion survived
 * (not a re-check), no evolve answered it, and Kane was not found unable to add a test for it (a pass
 * stopped, the run's bound or the cap came first, or the spec moved meanwhile). The next pass sends
 * them to Kane without attacking them again.
 */
export function unevolvedSurvivors(events: LedgerEvent[]): MutantEvent[] {
  const state = reduce(events);
  const out: MutantEvent[] = [];
  for (const ac of Object.values(state.acs)) {
    if (ac.status !== "vacuous") continue;
    const at = events.findLastIndex((e) => e.t === "mutant" && e.ac === ac.id);
    const m = events[at] as MutantEvent | undefined;
    if (!m || m.recheck !== undefined || (m.verdict !== "survived" && m.verdict !== "survived-by-heal")) continue;
    const after = events.slice(at + 1);
    if (after.some((e) => e.t === "falsify.evolved" && e.mutants.includes(m.id))) continue;
    if (after.some((e) => e.t === "redesign.dropped" && e.acs?.includes(ac.id) && e.reason === NO_TEST)) continue;
    out.push(m);
  }
  return out;
}

/** The files `rel` (app-relative) as the breaker is shown them, from `dir`; missing ones left out. */
async function readSources(dir: string, rels: string[]): Promise<SourceFile[]> {
  const out: SourceFile[] = [];
  for (const rel of rels) {
    const content = await readFile(path.join(dir, ...rel.split("/")), "utf8").catch(() => null);
    if (content !== null) out.push({ path: rel, content: content.replace(/\r\n/g, "\n") });
  }
  return out;
}

/**
 * The tier-1 entries as the seal lists them (file bytes, or a link's target), Kane's own state in the
 * verifier (`state`, `dirs`: its graph store in `.context/` and every other file Kane may write
 * there, I-3) and the sealed app files (null when absent), taken before Kane changes the verifier (a
 * drift, an evolve) so it can be rolled back whole.
 */
export type SealedCopy = { verifier: Map<string, Buffer | string>; state: Map<string, Buffer | string>; dirs: Set<string>; app: Map<string, Buffer | null> };

const inVerifier = (p: Project, rel: string) => path.join(p.verifierDir, ...rel.split("/"));

/**
 * Left out of Kane's state: tier 1 (`.testmuai/tests`, `.testmuai/variables`, copied on its own, with
 * the run recordings next to the tests, which the recordings anchor holds) and the evidence of
 * Kane's runs (`.testmuai/evidence`), which neither an evolve nor a drift writes.
 */
const NOT_STATE = new Set([".testmuai/tests", ".testmuai/variables", ".testmuai/evidence"]);

/** Every entry of Kane's state in the verifier (links and special files by kind, never followed), and its folders. */
async function stateEntries(p: Project): Promise<{ files: Map<string, SealEntry["kind"]>; dirs: Set<string> }> {
  const files = new Map<string, SealEntry["kind"]>();
  const dirs = new Set<string>();
  const walk = async (dir: string, rel: string) => {
    const entries = await readdir(dir, { withFileTypes: true }).catch((e: NodeJS.ErrnoException) => (e.code === "ENOENT" ? [] : Promise.reject(e)));
    for (const ent of entries) {
      const r = rel === "" ? ent.name : `${rel}/${ent.name}`;
      if (NOT_STATE.has(r)) continue;
      if (ent.isDirectory()) {
        dirs.add(r);
        await walk(path.join(dir, ent.name), r);
      } else files.set(r, ent.isSymbolicLink() ? "symlink" : ent.isFile() ? "file" : "special");
    }
  };
  await walk(p.verifierDir, "");
  return { files, dirs };
}

/** Kane's state entries that are not as `copy` holds them: added, changed or gone (folders too). */
export async function stateDiffersFrom(p: Project, copy: SealedCopy): Promise<string[]> {
  const out: string[] = [];
  const now = await stateEntries(p);
  for (const [rel, kind] of now.files) {
    const was = copy.state.get(rel);
    if (was === undefined || !same(was, await entryValue(inVerifier(p, rel), kind))) out.push(rel);
  }
  for (const rel of copy.state.keys()) if (!now.files.has(rel)) out.push(rel);
  for (const d of now.dirs) if (!copy.dirs.has(d)) out.push(`${d}/`);
  for (const d of copy.dirs) if (!now.dirs.has(d)) out.push(`${d}/`);
  return out;
}

async function entryValue(file: string, kind: SealEntry["kind"]): Promise<Buffer | string> {
  if (kind === "file") return readFile(file);
  if (kind === "symlink") return `symlink:${await readlink(file).catch(() => "?")}`;
  return "special";
}

export async function copySealed(p: Project): Promise<SealedCopy> {
  const verifier = new Map<string, Buffer | string>();
  for (const e of await tier1Entries(p.verifierDir)) verifier.set(e.rel, await entryValue(inVerifier(p, e.rel), e.kind));
  const state = new Map<string, Buffer | string>();
  const kane = await stateEntries(p);
  for (const [rel, kind] of kane.files) state.set(rel, await entryValue(inVerifier(p, rel), kind));
  const app = new Map<string, Buffer | null>();
  for (const rel of appSealFiles(p)) {
    try {
      app.set(rel, await readFile(path.join(p.appDir, ...rel.split("/"))));
    } catch (e) {
      if ((e as NodeJS.ErrnoException).code !== "ENOENT") throw e;
      app.set(rel, null);
    }
  }
  return { verifier, state, dirs: kane.dirs, app };
}

const same = (a: Buffer | string, b: Buffer | string) => (Buffer.isBuffer(a) && Buffer.isBuffer(b) ? a.equals(b) : a === b);

/** Tier-1 entries (tests and variables) that are not as `copy` holds them: added, changed or gone. */
export async function verifierDiffersFrom(p: Project, copy: SealedCopy): Promise<string[]> {
  const out: string[] = [];
  const now = await tier1Entries(p.verifierDir);
  for (const e of now) {
    const was = copy.verifier.get(e.rel);
    if (was === undefined || !same(was, await entryValue(inVerifier(p, e.rel), e.kind))) out.push(e.rel);
  }
  for (const rel of copy.verifier.keys()) if (!now.some((e) => e.rel === rel)) out.push(rel);
  return out;
}

/** Tier-1 test entries added or changed since `copy`. */
export async function changedTests(p: Project, copy: SealedCopy): Promise<string[]> {
  const out: string[] = [];
  for (const e of await tier1Entries(p.verifierDir)) {
    if (!e.rel.startsWith(".testmuai/tests/")) continue;
    const was = copy.verifier.get(e.rel);
    if (was === undefined || !same(was, await entryValue(inVerifier(p, e.rel), e.kind))) out.push(e.rel);
  }
  return out;
}

/** Remove a file, link or junction without ever following it. */
async function removeEntry(file: string): Promise<void> {
  try {
    if ((await lstat(file)).isSymbolicLink()) await unlink(file);
    else await rm(file, { force: true });
  } catch (e) {
    if ((e as NodeJS.ErrnoException).code !== "ENOENT") throw e;
  }
}

/**
 * Put the sealed files and Kane's state back as `copy` holds them (links are only removed, never
 * written through; folders Kane added are removed). `appFiles: false` leaves the app side (config
 * and spec) alone: a caller that must not overwrite a newer spec edit puts back only what it wrote
 * itself (N-I2).
 */
export async function restoreSealed(p: Project, copy: SealedCopy, opts: { appFiles?: boolean } = {}): Promise<void> {
  const kane = await stateEntries(p);
  for (const [rel, kind] of kane.files) {
    const was = copy.state.get(rel);
    if (was === undefined || kind !== "file" || !Buffer.isBuffer(was)) {
      if (was === undefined || !same(was, await entryValue(inVerifier(p, rel), kind))) await removeEntry(inVerifier(p, rel));
    }
  }
  for (const d of [...kane.dirs].filter((x) => !copy.dirs.has(x)).sort((a, b) => b.length - a.length)) {
    await rm(inVerifier(p, d), { recursive: true, force: true });
  }
  for (const [rel, bytes] of copy.state) {
    if (!Buffer.isBuffer(bytes)) continue;
    const file = inVerifier(p, rel);
    const now = await readFile(file).catch(() => null);
    if (now !== null && now.equals(bytes)) continue;
    await mkdir(path.dirname(file), { recursive: true });
    await writeFile(file, bytes);
  }
  for (const d of copy.dirs) await mkdir(inVerifier(p, d), { recursive: true });
  for (const e of await tier1Entries(p.verifierDir)) {
    const was = copy.verifier.get(e.rel);
    if (was === undefined || e.kind !== "file" || !Buffer.isBuffer(was)) {
      if (was === undefined || !same(was, await entryValue(inVerifier(p, e.rel), e.kind))) await removeEntry(inVerifier(p, e.rel));
    }
  }
  for (const [rel, bytes] of copy.verifier) {
    if (!Buffer.isBuffer(bytes)) continue;
    const file = inVerifier(p, rel);
    await mkdir(path.dirname(file), { recursive: true });
    await writeFile(file, bytes);
  }
  if (opts.appFiles === false) return;
  for (const [rel, bytes] of copy.app) {
    const file = path.join(p.appDir, ...rel.split("/"));
    await removeEntry(file);
    if (bytes !== null) await writeFile(file, bytes);
  }
}

/**
 * Removes a throwaway worktree of the app repo; the node_modules link goes first, so no recursive
 * delete can reach the app's own. Used for mutants and bisect probes.
 */
export async function dropWorktreeSafely(p: Project, dir: string, gitOpts: GitOptions): Promise<void> {
  const nm = path.join(dir, "node_modules");
  try {
    if ((await lstat(nm)).isSymbolicLink()) await unlink(nm);
  } catch (e) {
    if ((e as NodeJS.ErrnoException).code !== "ENOENT") return; // leave the directory rather than risk the link's target
  }
  try {
    await worktreeRemove(p.appDir, dir, gitOpts);
  } catch {
    await rm(dir, { recursive: true, force: true }).catch(() => {});
    await git(p.appDir, ["worktree", "prune"], gitOpts).catch(() => {});
  }
}

/**
 * Removes the throwaway worktrees (and mutant patch files) a crashed falsify pass or regression
 * bisect left under `<home>/mut` and `<home>/bisect`, unlinking each node_modules junction first,
 * then prunes git's worktree list. Also for `holdback clean`.
 */
export async function sweepStaleWorktrees(p: Project, gitOpts?: GitOptions): Promise<void> {
  const opts = gitOpts ?? (await holdbackGitOptions(p.home));
  for (const sub of [MUT_DIR, BISECT_DIR]) {
    const root = path.join(p.home, sub);
    const entries = await readdir(root, { withFileTypes: true }).catch(() => []);
    for (const ent of entries) {
      if (ent.isDirectory()) await dropWorktreeSafely(p, path.join(root, ent.name), opts);
      else if (ent.isFile() && ent.name.endsWith(".patch")) await rm(path.join(root, ent.name), { force: true });
    }
  }
  await git(p.appDir, ["worktree", "prune"], opts);
}

/** Shares the app's dependencies with a worktree through a directory junction (a symlink off Windows). */
export async function linkAppNodeModules(p: Project, dir: string): Promise<void> {
  const src = path.join(p.appDir, "node_modules");
  try {
    if (!(await stat(src)).isDirectory()) return;
  } catch {
    return;
  }
  const dst = path.join(dir, "node_modules");
  if (existsSync(dst)) return; // committed with the app
  await symlink(src, dst, "junction");
}

export type FalsifyOptions = {
  /** Aborts the pass: it stops after the current AC, still replays the real build, and returns reason `aborted`. */
  signal?: AbortSignal;
  /** Warnings that do not stop the pass. Default: stderr. */
  warn?: Warn;
  /** A human's Kane credit cap for this command (`--kane-cap`), over `kane.capCredits` (I6). */
  kaneCap?: number;
  /**
   * The `maintain evolve` calls made so far in this run, by use case (R40: at most `MAX_EVOLVES` each):
   * `holdback run` passes one map to each of its falsify passes. Default: this pass's own.
   */
  evolves?: Map<string, number>;
};

/**
 * Falsify every `passing` AC: the breaker (a different model family, via Venice) writes the
 * smallest patch that violates exactly that AC; it is applied in a throwaway worktree of HEAD,
 * started on a spare port, and the AC's sealed tests are replayed against it with healing off.
 * Kane failing the AC kills the mutant (the AC is `proved`); a mutant that passes makes the AC
 * `vacuous`, and Kane evolves its use case (R40): it is told what slipped through, its new tests
 * replace the old ones and are sealed with Kane as their author, and every AC of the use case is
 * owed again, so it goes back to the build loop; the next pass re-checks the survivor's own bug
 * against the new tests first. Afterwards every test is replayed once against the real build. `log` must append to `p.ledgerFile`: every append is verified against it.
 * Throws, before anything else, when VENICE_API_KEY is not set.
 */
export async function runFalsify(p: Project, deps: FalsifyDeps, _io: HumanIO, log: Log, opts: FalsifyOptions = {}): Promise<FalsifyResult> {
  const apiKey = deps.apiKey ?? process.env.VENICE_API_KEY ?? "";
  if (!apiKey) throw new Error("VENICE_API_KEY is not set: the falsify stage needs it for the breaker (Venice API)");

  const out: FalsifyResult = { killed: [], survived: [], invalid: [], redesigned: [], vacuous: [], skipped: [], usd: 0, reason: "done" };
  const result = (reason: FalsifyStopReason, error?: string): FalsifyResult => ({ ...out, reason, ...(error === undefined ? {} : { error }) });
  const gitOpts: GitOptions = await holdbackGitOptions(p.home);
  const cwd = p.verifierDir;
  let mark: LedgerMark | undefined;
  let events: LedgerEvent[] = [];
  let manifest: Record<string, string> | undefined;
  let baseline: RecordingsSnapshot | undefined;
  /** True from the start of a Kane batch until its recordings are logged. */
  let kaneWindow = false;
  /** A Kane batch ran against a mutant in this pass (its coverage now sits in Kane's project store). */
  let attacked = false;
  let running: RunningApp | undefined;
  /** This pass's surviving mutants, for Kane's evolve (R40). */
  const survivors: Survivor[] = [];
  const evolves = opts.evolves ?? new Map<string, number>();
  /** The config and spec as the pass found them sealed: what Kane's seal holds for them (I-1). */
  let appPin: AppPin = {};
  /** Every verifier path an evolve of this pass was allowed to change (its minted and retired tests): nothing else may differ at the seal (I-1). */
  const allowedPaths = new Set<string>();
  /** How many of this pass's Kane replays run at once (`breaker.parallel`, R44), checked before anything runs. */
  let replays = 1;

  const at = () => new Date().toISOString();
  /** A survivor named for the human's output: the slip in plain words, else the breaker's rationale. */
  const named = (ac: string, mutant: string, slip: Slip | undefined, rationale: string, extra: { recheck?: true; earlier?: true } = {}) =>
    void (out.survivors ??= []).push({ ac, mutant, slip: oneLine(slip?.behaviour || rationale || "a planted change"), ...extra });
  /** Survivors of `uc` Kane did not evolve in this pass, and why. */
  const notEvolved = (uc: string, acs: string[], why: string) => {
    if (acs.length > 0) (out.notEvolved ??= []).push({ uc, acs, why });
  };
  /** Every append goes through the same integrity check as the build loop's. */
  const append = async (e: LedgerEvent) => {
    if (!mark) throw new Error("internal: ledger not read before the first append");
    mark = await appendVouched(p.ledgerFile, mark, log, e);
    events.push(e);
    meter.add(e);
  };
  const emit = (body: EventBody) => append({ at: at(), ...body } as LedgerEvent);
  /** Each Kane batch (a mutant's replay, the closing replay, an evolve) is metered by Kane's balance. */
  const capCredits = kaneCapCredits(p.config, opts.kaneCap);
  const meter = new KaneMeter(deps.balance, emit, capCredits === undefined ? undefined : { credits: capCredits, spent: () => reduce(events).kaneCredits });
  const recordTamper = (detail: string) => recordTamperIn(p, emit, detail);
  const stopApp = async () => {
    const a = running;
    running = undefined;
    await a?.stop();
  };
  /** The spec files changed since the seal when nothing else sealed did (drift, not a tamper), as of the last check. */
  let specDrift: string[] = [];
  /**
   * Tier 1 and the repo's git config, against the seal and the baseline: what a tamper names. A
   * change to spec files alone is drift (`specDrift`), not a tamper: a spec file is no input to Kane's runs.
   */
  const sealBroken = async (): Promise<string | undefined> => {
    const bad = manifest ? await checkSeal(p.verifierDir, manifest, p.appDir) : [];
    if (baseline && (await gitConfigHash(baseline.gitConfigFile, gitOpts)) !== baseline.gitConfig) bad.push(".git/config");
    if (!bad.every((k) => isSpecKey(p, k))) {
      specDrift = [];
      return `sealed files changed: ${bad.join(", ")}`;
    }
    specDrift = bad.map(specFileOf);
    return specDrift.length > 0 ? specChanged(specDrift) : undefined;
  };
  /**
   * Spec files alone changed: classed (R38) and logged as `spec.changed`. The tamper detail when the
   * guard logged a write at the spec since the seal.
   */
  const specChanged = async (files: string[]): Promise<string | undefined> => {
    if (!manifest) return undefined;
    const c = await classifySpecChange(p, events, manifest, files, false);
    if ("tamper" in c) return c.tamper;
    if (c.event) await emit(c.event);
    return undefined;
  };
  /** After a Kane batch, with the app stopped: Kane's recordings as they are now are what the next run holds them to. */
  const closeKaneWindow = async () => {
    const snap = await logRecordings(p, append, gitOpts);
    baseline = { ...snap, gitConfig: baseline!.gitConfig };
    kaneWindow = false;
  };
  /**
   * Starts an app under test (a mutant's worktree, or the real build) on a new, empty data dir under
   * the home, never one inside the worktree, where a committed database would seed it.
   */
  const launch = async (cwd: string, port: number, label: string): Promise<RunningApp> => {
    running = await deps.app({ cwd, cmd: p.config.start.cmd, port, readyPath: p.config.start.readyPath, env: appEnv(p, await freshDataDir(p, label)) });
    return running;
  };
  /** `runSettled`'s re-run: the same app stopped and started again, on a fresh data dir. */
  const relaunch = (cwd: string, port: number, label: string) => async (): Promise<string> => {
    await stopApp();
    return `${(await launch(cwd, port, `${label}-rerun`)).url}/`;
  };

  const dropWorktree = (dir: string) => dropWorktreeSafely(p, dir, gitOpts);

  /** Mutant and bisect worktrees a crashed pass left behind still link the app's node_modules: remove them the safe way. */
  const dropStaleMutants = () => sweepStaleWorktrees(p, gitOpts);

  const linkNodeModules = (dir: string) => linkAppNodeModules(p, dir);

  /** Returns git's complaint, or undefined once the patch is applied. */
  const applyPatch = async (dir: string, patchFile: string, patch: string, shown: string[]): Promise<string | undefined> => {
    const c = checkPatch(patch, shown);
    if ("error" in c) return c.error;
    await writeFile(patchFile, patch, "utf8");
    const args = ["apply", `-p${c.strip}`, "--recount", "--ignore-whitespace", "--whitespace=nowarn"];
    for (const extra of [["--check"], []]) {
      const r = await git(dir, [...args, ...extra, patchFile], gitOpts);
      if (r.code !== 0) return (r.stderr || r.stdout).trim() || `git apply exited with code ${r.code}`;
    }
    return undefined;
  };

  const nextMutantId = (acId: string): string => {
    const safe = acId.replace(/[^\w.-]/g, "_");
    const used = new Set(events.flatMap((e) => (e.t === "mutant" ? [e.id] : [])));
    let k = events.filter((e) => e.t === "mutant" && e.ac === acId).length + 1;
    while (used.has(`m-${safe}-${k}`) || existsSync(path.join(p.home, MUT_DIR, `m-${safe}-${k}`))) k++;
    return `m-${safe}-${k}`;
  };

  /**
   * One mutant against one AC. Returns "budget" when the breaker call was refused before anything was
   * spent. `recheck`: the surviving mutant whose use case Kane evolved since (R40): its own patch is
   * planted again (re-planted by the breaker, once, when the code moved under it), and the new tests
   * must kill it; any other verdict leaves the AC vacuous.
   */
  const falsifyOne = async (ac: AcState, files: string[], lastChanged: string[], budget: Budget, recheck?: MutantEvent): Promise<"budget" | "tamper" | "done"> => {
    let model = recheck?.model ?? p.config.breaker.model;
    const id = nextMutantId(ac.id);
    const dir = path.join(p.home, MUT_DIR, id);
    const patchFile = path.join(p.home, MUT_DIR, `${id}.patch`);
    let usd = 0;
    let patch = "";
    let slip: Slip | undefined = recheck?.slip;
    let rationale = "";
    let logged = false;
    let stopNote = "results discarded: the pass stopped";
    const finish = async (verdict: Verdict, note?: string, results: TestRunResult[] = []) => {
      logged = true;
      out.usd += usd;
      await emit({
        t: "mutant",
        id,
        ac: ac.id,
        patch,
        model,
        usd,
        verdict,
        ...(note === undefined ? {} : { note }),
        ...(slip ? { slip } : {}),
        ...(recheck ? { recheck: recheck.id } : {}),
      });
      for (const r of results) await emit({ t: "run", kind: "falsify", mutantId: id, result: r });
      (verdict === "killed" ? out.killed : verdict === "invalid" ? out.invalid : out.survived).push(ac.id);
      const survived = verdict === "survived" || verdict === "survived-by-heal";
      if (survived) named(ac.id, id, slip, rationale, recheck ? { recheck: true } : {});
      // a re-checked survivor never goes back to Kane: killed proves it, anything else leaves it vacuous
      if (recheck && verdict !== "killed") {
        out.vacuous.push(ac.id);
        if (survived) notEvolved(ac.useCase, [ac.id], RECHECK_SURVIVED);
      } else if (survived) survivors.push({ ac, id, patch, rationale, ...(slip ? { slip } : {}) });
    };
    // at the Kane credit cap no batch could judge the mutant: never pay the breaker for one (N-m2)
    await meter.assertBudget();
    try {
      await mkdir(path.dirname(dir), { recursive: true });
      await worktreeAdd(p.appDir, dir, "HEAD", gitOpts);
      await linkNodeModules(dir);
      let shown: SourceFile[];
      let failure: string | undefined;
      /** The patch is in place (a re-checked survivor's own, planted as it was): no breaker call. */
      let planted = false;
      /** The patch and error the next call is told about (one retry, with the error fed back). */
      let feedback: { patch: string; error: string } | undefined;
      if (recheck) {
        // 1. the survivor's own patch, against the code as it is now
        const touched = patchedFiles(recheck.patch);
        shown = await readSources(dir, touched);
        patch = recheck.patch;
        failure = shown.length === touched.length && shown.length > 0 ? await applyPatch(dir, patchFile, patch, touched) : "a file it changes is gone";
        if (failure === undefined) planted = true;
        else {
          // the code moved under it: the breaker plants the same bug in the code as it is now, once
          if (shown.length === 0) shown = await pickFiles(dir, ac, lastChanged, { exclude: appSealFiles(p) });
          const moved = `the code changed since this bug was planted (${failure}): plant the same bug in the code as it is now`;
          failure = `patch did not apply: ${moved}`;
          feedback = { patch, error: moved };
          model = p.config.breaker.model;
        }
      } else shown = await pickFiles(dir, ac, lastChanged, { exclude: appSealFiles(p) });
      if (shown.length === 0) {
        await finish("invalid", "no source file to mutate");
        return "done";
      }

      // 1. the breaker's patch, applied. Never the same call twice: a reply the token limit cut off
      //    (or an empty one) is asked again once with a larger cap; a patch that did not apply (or a
      //    reply with no usable patch) once with the error fed back. Each call is held to the USD cap.
      let calls = 0;
      let maxTokens = MAX_TOKENS;
      let raised = false;
      let fixed = feedback !== undefined; // a re-check's breaker call is already its one retry
      while (!planted) {
        let m: Mutant;
        try {
          calls++;
          m = await proposeMutant(ac, shown, {
            model,
            apiKey,
            budget,
            chat: deps.chat,
            ...(maxTokens === MAX_TOKENS ? {} : { maxTokens }),
            ...(feedback ? { retry: feedback } : {}),
          });
        } catch (e) {
          if (e instanceof BreakerError) {
            usd += e.usd;
            failure = `no usable patch: ${e.message}`;
            if (e.cutOff && !raised) {
              raised = true;
              maxTokens = RETRY_MAX_TOKENS;
              continue;
            }
            if (!e.cutOff && !fixed) {
              fixed = true;
              feedback = { patch: "", error: e.message };
              continue;
            }
            break;
          }
          if (e instanceof BudgetRefused) {
            if (calls === 1 && !recheck) return "budget"; // nothing spent, nothing to log
            await finish("invalid", `${failure ?? "no patch"}; retry refused: ${e.message}`);
            return "budget";
          }
          if (e instanceof BreakerUnavailable) {
            // an outage proves nothing about the AC; the pass goes on (and still ends with the replay)
            usd += e.usd;
            await finish("invalid", `breaker unavailable: ${e.message}`);
            return "done";
          }
          throw e;
        }
        usd += m.usd;
        patch = m.patch;
        rationale = m.rationale;
        if (!recheck?.slip && m.slip) slip = m.slip;
        const applied = await applyPatch(dir, patchFile, m.patch, shown.map((f) => f.path));
        if (applied === undefined) {
          failure = undefined;
          break;
        }
        failure = `patch did not apply: ${applied}`;
        if (fixed) break;
        fixed = true;
        feedback = { patch, error: applied };
      }
      if (failure !== undefined) {
        await finish("invalid", failure);
        return "done";
      }

      // 2. the mutant app on a spare port, with its own data dir
      const port = await (deps.port ?? freePort)();
      let app: RunningApp;
      try {
        app = await launch(dir, port, id);
      } catch (e) {
        await finish("invalid", `mutant did not start: ${startFailureText(e).slice(-1000)}`);
        return "done";
      }

      // 3. Kane replays the AC's sealed tests against it, healing off (a run that failed for a reason
      //    other than the app once more, against the mutant started again)
      return await meter.batch("falsify", async () => {
        kaneWindow = true;
        attacked = true;
        let results: TestRunResult[];
        try {
          const opts = { startUrl: `${app.url}/`, noHeal: true, timeoutS: p.config.kane.timeoutS, parallel: replays };
          results = await runSettled(deps.tests, cwd, files, opts, relaunch(dir, port, id));
        } finally {
          await stopApp();
        }
        const bad = await sealBroken();
        if (bad !== undefined) {
          // results produced against a changed test or variable never reach the ledger
          await recordTamper(bad);
          return "tamper";
        }
        const fileId = testIdsByFile();
        const attributed = results.map((r, i) => (r.testId == null ? { ...r, testId: fileId.get(files[i]!) ?? null } : r));
        const v = falsifyVerdict(ac.id, attributed);
        await finish(v.verdict, v.note, attributed);
        await closeKaneWindow();
        return "done";
      });
    } catch (e) {
      stopNote = `stopped before a verdict: ${errText(e)}`;
      throw e;
    } finally {
      await stopApp().catch(() => {});
      await dropWorktree(dir);
      await rm(patchFile, { force: true }).catch(() => {});
      // spend that never got a verdict (an error or tamper stop) still counts against the cap
      if (!logged && usd > 0) await finish("invalid", stopNote).catch(() => {});
    }
  };

  const testIdsByFile = () => new Map([...testFileMap(events, p.verifierDir)].map(([id, f]) => [f, id]));

  /**
   * R40: a planted bug got past every test of use case `uc`. Kane evolves the use case
   * (`maintain evolve --because <what slipped through>`), and its new set replaces the old tests.
   * When the new set leaves criteria of the use case without a test, one bounded follow-up evolve
   * asks Kane to cover them again; still uncovered, they need the spec. At most `MAX_EVOLVES` evolves
   * per use case per run, each a metered batch under the credit cap. Returns the events to log once
   * the whole pass checks out (`falsify.evolved`, the new `design`), or undefined when the use case
   * was not evolved: the verifier is then rolled back and its survivors stay vacuous with a reason.
   */
  const evolveUseCase = async (uc: string, list: Survivor[]): Promise<EventBody[] | undefined> => {
    const ids = list.map((s) => s.ac.id);
    const mutants = list.map((s) => s.id);
    const spent = evolves.get(uc) ?? 0;
    const giveUp = async (detail: string, credits: number, reason = NO_TEST) => {
      out.redesignError = detail;
      out.vacuous.push(...ids);
      notEvolved(uc, ids, reason === NO_TEST ? `${NO_TEST}: ${detail}` : reason);
      await emit({ t: "redesign.dropped", useCases: [uc], detail, credits, acs: ids, reason });
      return undefined;
    };
    if (spent >= MAX_EVOLVES) return giveUp(`Kane already evolved ${uc} ${MAX_EVOLVES} times in this run`, 0, EVOLVE_BOUND);
    // R44: only this survivor-triggered evolve counts toward the run's bound; its follow-up does not
    evolves.set(uc, spent + 1);
    const because = becauseText(list);
    const first = await evolveOnce(uc, because, list);
    if ("stray" in first) return strayTamper(uc, first.stray, first.credits);
    if ("failed" in first) return giveUp(first.failed, first.credits);
    const out_: EventBody[] = [{ t: "falsify.evolved", uc, because, minted: first.minted, retired: first.retired, credits: first.credits, mutants }];
    let g = first.graph;
    let left = uncoveredIn(g, uc);
    let why = UNCOVERED;
    if (left.length > 0) {
      // measured as the ledger will be once this evolve is logged
      const capped = capCredits !== undefined && reduce([...events, ...(out_ as LedgerEvent[])]).kaneCredits >= capCredits;
      if (capped) why = `${UNCOVERED}; no follow-up evolve: the Kane credit cap is reached`;
      else {
        const cover = `cover ${left.map((a) => `${a.id} ("${a.text}")`).join(", ")} again, and keep a test that catches what slipped through before: ${because}`;
        // the follow-up may retire what the first evolve minted, as it may the sealed tests
        const minted1 = g.tests.filter((t) => first.minted.includes(t.id));
        // at the cap the follow-up never starts (m-1): the first evolve stands
        const again = await evolveOnce(uc, oneLine(cover).slice(0, MAX_BECAUSE), list, minted1, first.retired).catch((e: unknown) => {
          if (e instanceof KaneCapReached) return { capped: e.message } as const;
          throw e;
        });
        if ("capped" in again) why = `${UNCOVERED}; no follow-up evolve: the Kane credit cap is reached`;
        else if ("stray" in again) return strayTamper(uc, again.stray, again.credits);
        else if ("failed" in again) {
          // the first evolve stands; the follow-up's spend is still on record, after it on the timeline (m-7)
          out_.push({ t: "redesign.dropped", useCases: [uc], detail: `follow-up evolve of ${uc}: ${again.failed}`, credits: again.credits });
          why = `${UNCOVERED}; a follow-up evolve did not cover it either`;
        } else {
          out_.push({ t: "falsify.evolved", uc, because: oneLine(cover).slice(0, MAX_BECAUSE), minted: again.minted, retired: again.retired, credits: again.credits, mutants, followUp: true });
          g = again.graph;
          left = uncoveredIn(g, uc);
          why = `${UNCOVERED}; a follow-up evolve did not cover it either`;
        }
      }
    }
    // the use case as Kane now has it: every criterion owed again; one left without a test needs the spec
    const prev = events.findLast((e): e is Extract<LedgerEvent, { t: "design" }> => e.t === "design" && e.useCase === uc);
    const acs = g.acs.filter((a) => a.useCase === uc);
    const acIds = new Set(acs.map((a) => a.id));
    const tests = g.tests.filter((t) => t.verifies.some((v) => acIds.has(v)));
    const rejected = (prev?.rejected ?? []).filter((id) => acIds.has(id));
    const notes = Object.fromEntries(left.filter((a) => !rejected.includes(a.id)).map((a) => [a.id, why]));
    out_.push({
      t: "design",
      useCase: uc,
      acs,
      tests,
      gaps: g.gaps,
      credits: 0,
      ...(rejected.length > 0 ? { rejected } : {}),
      ...(Object.keys(notes).length > 0 ? { notes } : {}),
    });
    return out_;
  };

  /** The criteria of `uc` in `g` that no live test verifies. */
  const uncoveredIn = (g: Graph, uc: string) => {
    const covered = new Set(g.tests.flatMap((t) => t.verifies));
    return g.acs.filter((a) => a.useCase === uc && !covered.has(a.id));
  };

  /**
   * One `maintain evolve` of `uc`: a metered Kane batch (the caller counts it against the run's bound). Kane's new
   * set is checked before anything is logged: it minted a test with a file, changed no sealed verifier
   * entry but its minted tests and the tests of this use case it retired, and still holds every
   * criterion of the use case. Otherwise the verifier is put back as it was before this call and the
   * reason is returned; any other sealed entry it touched (`stray`) is a tamper, never sealed.
   */
  const evolveOnce = async (
    uc: string,
    because: string,
    list: Survivor[],
    /** Tests an earlier evolve of this use case minted in this pass (not sealed yet): this one may retire them too. */
    prior: TestNode[] = [],
    /** Tests an earlier evolve of this use case retired in this pass (the ledger still has them live). */
    priorRetired: string[] = [],
  ): Promise<{ minted: string[]; retired: string[]; credits: number; graph: Graph } | { failed: string; credits: number } | { stray: string[]; credits: number }> => {
    /** A verifier path exactly: relative to the verifier, `/`-separated. The allowlist matches only these. */
    const key = (f: string) => path.relative(p.verifierDir, path.resolve(p.verifierDir, f)).split(path.sep).join("/");
    /** The same, case-folded on every platform: only to catch a collision (a duplicate, a shared file), which is stricter. */
    const folded = (f: string) => key(f).toLowerCase();
    /** dev+ino of a verifier file, or undefined when it does not exist. */
    const identity = (f: string) =>
      stat(path.resolve(p.verifierDir, f), { bigint: true }).then(
        (s) => `${s.dev}:${s.ino}`,
        () => undefined,
      );
    /** True when `f` may be one of `others`: the same path but for its case, or the same file where both exist. */
    const sameAsAny = async (f: string, others: string[]): Promise<boolean> => {
      const id = await identity(f);
      for (const o of others) if (folded(o) === folded(f) || (id !== undefined && (await identity(o)) === id)) return true;
      return false;
    };
    // every sealed test as the ledger last designed it (file, verified criteria), and this use case's
    // criteria and tests: what Kane may retire
    const sealedTests = new Map<string, { file: string; verifies: string[] }>();
    for (const e of events) if (e.t === "design") for (const t of e.tests) if (t.file) sealedTests.set(t.id, { file: t.file, verifies: t.verifies });
    const state = reduce(events);
    const ucAcs = new Set(Object.values(state.acs).filter((a) => a.useCase === uc).map((a) => a.id));
    const ucTests = new Set(Object.values(state.acs).filter((a) => a.useCase === uc).flatMap((a) => a.tests));
    /** Every test live in the ledger before this evolve, of any use case (with this pass's earlier evolve applied). */
    const liveBefore = new Set([...Object.values(state.acs).flatMap((a) => a.tests), ...prior.map((t) => t.id)].filter((id) => !priorRetired.includes(id)));
    for (const t of prior) {
      sealedTests.set(t.id, { file: t.file, verifies: t.verifies });
      ucTests.add(t.id);
    }
    return meter.batch("evolve", async () => {
      const copy = await copySealed(p);
      kaneWindow = true; // Kane writes into the verifier while it evolves
      let credits = 0;
      try {
        const r = await deps.kane.evolve(cwd, uc, because);
        credits = r.credits;
        // the event that books these credits is logged after this batch: count them in it now
        meter.count(credits);
        if (r.status === "nothing") throw new EvolveFailed(`Kane added no test to ${uc}: ${r.note}`);
        if (r.status === "error") throw new EvolveFailed(`Kane's evolve of ${uc} failed: ${r.message}`);
        const g = await deps.kane.readGraph(cwd);
        const minted = r.minted.map((m) => m.test);
        // one entry per test id and per file, or the graph says two things at once: a tamper
        const keys = g.tests.filter((t) => t.file).map((t) => folded(t.file));
        const twiceIds = g.tests.filter((t, i) => g.tests.findIndex((x) => x.id === t.id) !== i).map((t) => t.id);
        const twice = [
          ...new Set([...keys.filter((k, i) => keys.indexOf(k) !== i), ...g.tests.filter((t) => twiceIds.includes(t.id)).map((t) => (t.file ? key(t.file) : t.id))]),
        ];
        if (twice.length > 0) throw new EvolveStray(twice);
        const fileOf = new Map(g.tests.filter((t) => t.file).map((t) => [t.id, t.file]));
        const missing = minted.filter((t) => !fileOf.has(t));
        if (missing.length > 0) throw new EvolveFailed(`Kane minted ${missing.join(", ")} but no test file of it is in the verifier`);
        // the seal hashes whatever is on disk: Kane may write the tests it minted and change or remove
        // the tests of this use case it retired; any other sealed entry it added, changed or removed
        // (a variable, another use case's test, an unknown file) is never sealed: a tamper
        const retired = r.superseded.map((s) => s.test).filter((t) => t !== "");
        /** Exact relative path -> the file Kane named: a changed entry is allowed only on an exact match. */
        const allowed = new Map<string, string>();
        const bad: string[] = [];
        // criteria this use case may be verified by: the ledger's own, and ones Kane newly adds under it
        // (never one the ledger has under another use case)
        const mayVerify = new Set([...ucAcs, ...g.acs.filter((a) => a.useCase === uc && !(a.id in state.acs)).map((a) => a.id)]);
        const sealedKeys = [...copy.verifier.keys()];
        const sealedFiles = [...sealedTests.values()].map((s) => s.file);
        /**
         * I-5: Kane may name a new test as a retired one (it names files by their title) when every
         * test the ledger has at that exact path is a retired test of this use case (reported retired
         * now, or no longer live), none of them is in the new graph, and the new test is the only one
         * there. Then only that path may be taken over: any other sealed entry it collides with
         * (by case or by being the same file) is still a tamper.
         */
        const takesOver = (t: TestNode): boolean => {
          const at = [...sealedTests].filter(([, s]) => key(s.file) === key(t.file));
          if (at.length === 0) return false;
          for (const [old, s] of at) {
            if (old === t.id || g.tests.some((x) => x.id === old)) return false;
            if (!retired.includes(old) && !priorRetired.includes(old) && liveBefore.has(old)) return false;
            if (s.verifies.length === 0 || !s.verifies.every((v) => mayVerify.has(v))) return false;
          }
          return g.tests.filter((x) => x.file && folded(x.file) === folded(t.file)).length === 1;
        };
        // a minted test: a new regular file under the tests folder (or a retired test's, I-5), verifying this use case's criteria only
        for (const id of minted) {
          const t = g.tests.find((x) => x.id === id)!;
          const k = key(t.file);
          const st = await lstat(path.resolve(p.verifierDir, t.file)).catch(() => undefined);
          const over = takesOver(t);
          const collides = over
            ? sealedKeys.some((s) => s !== k && s.toLowerCase() === folded(t.file)) || (await sameAsAny(t.file, sealedFiles.filter((f) => key(f) !== k)))
            : sealedKeys.some((s) => s.toLowerCase() === folded(t.file)) || (await sameAsAny(t.file, sealedFiles));
          const ok =
            k.startsWith(".testmuai/tests/") &&
            !k.split("/").includes("..") &&
            st !== undefined &&
            st.isFile() &&
            !st.isSymbolicLink() &&
            !collides &&
            t.verifies.length > 0 &&
            t.verifies.every((v) => mayVerify.has(v));
          if (ok) allowed.set(k, t.file);
          else bad.push(k);
        }
        // a retired test: one of this use case's, verifying its criteria only, no longer live, its file
        // gone or referenced by no live test, and shared with no other sealed test
        for (const id of retired) {
          const was = sealedTests.get(id);
          if (!was || !ucTests.has(id) || !was.verifies.every((v) => mayVerify.has(v))) continue;
          if (g.tests.some((t) => t.id === id && t.verifies.length > 0)) continue;
          if (await sameAsAny(was.file, g.tests.filter((t) => t.id !== id && t.file).map((t) => t.file))) continue;
          if (await sameAsAny(was.file, [...sealedTests].filter(([other]) => other !== id).map(([, o]) => o.file))) continue;
          allowed.set(key(was.file), was.file);
        }
        const changed: string[] = [];
        for (const d of await verifierDiffersFrom(p, copy)) {
          const k = key(d);
          const named = allowed.get(k);
          // an exact path and, where both exist, the very file Kane named
          const [a, b] = named === undefined ? [undefined, undefined] : [await identity(d), await identity(named)];
          if (named === undefined || (a !== undefined && b !== undefined && a !== b)) changed.push(k);
        }
        const stray = [...new Set([...bad, ...changed])];
        if (stray.length > 0) throw new EvolveStray(stray);
        // a criterion never leaves the gate silently: the use case keeps every one it had
        const now = new Set(g.acs.filter((a) => a.useCase === uc).map((a) => a.id));
        const had = Object.values(reduce(events).acs).filter((a) => a.useCase === uc).map((a) => a.id);
        const gone = [...new Set([...had, ...list.map((s) => s.ac.id)])].filter((id) => !now.has(id));
        if (gone.length > 0) throw new EvolveFailed(`Kane's evolve of ${uc} no longer holds ${gone.join(", ")}`);
        for (const k of allowed.keys()) allowedPaths.add(k);
        return { minted, retired, credits, graph: g };
      } catch (e) {
        if (e instanceof LedgerTampered || e instanceof KaneCapReached) throw e;
        await rollBack(copy);
        if (e instanceof EvolveStray) return { stray: e.paths, credits };
        return { failed: e instanceof EvolveFailed ? e.message : `Kane failed during the evolve of ${uc}: ${errText(e)}`, credits };
      }
    });
  };

  /**
   * Kane's evolve of `uc` touched sealed verifier entries it had no business changing: rolled back,
   * on record as a tamper (`falsify.evolve.stray`, the marker first), and the pass stops.
   */
  const strayTamper = async (uc: string, paths: string[], credits: number): Promise<never> => {
    const detail = `Kane's evolve of ${uc} changed sealed verifier files it did not mint or retire: ${paths.join(", ")}`;
    let logged = detail;
    try {
      await markTampered(p, detail);
    } catch (e) {
      logged = `${detail} (tamper marker not written: ${errText(e)})`;
    }
    await emit({ t: "falsify.evolve.stray", uc, paths, credits, detail: logged });
    throw new EvolveTampered(logged);
  };

  /** The verifier put back as `copy` holds it, never the app side (a newer spec edit stays: N-I2), and its recordings re-anchored. */
  const rollBack = async (copy: SealedCopy): Promise<void> => {
    let restoreError: unknown;
    try {
      await restoreSealed(p, copy, { appFiles: false });
    } catch (re) {
      restoreError = re;
    }
    const left = restoreError === undefined ? [...(await verifierDiffersFrom(p, copy)), ...(await stateDiffersFrom(p, copy))] : [];
    if (restoreError !== undefined || left.length > 0) {
      const why = restoreError !== undefined ? errText(restoreError) : `sealed files still differ (${left.join(", ")})`;
      throw new Error(`Kane's evolve rolled back incompletely: ${why}: re-seal before building`);
    }
    await closeKaneWindow();
  };

  /** Every test once against the real build, logged as build runs (Kane's own coverage then reflects the real build). */
  const replayRealBuild = async (): Promise<"tamper" | "done"> => {
    const state = reduce(events);
    const acs = Object.values(state.acs)
      .filter((a) => a.tests.length > 0)
      .sort(byAcId);
    const files = filesOf(acs, testFileMap(events, p.verifierDir));
    if (files.length === 0) return "done";
    assertTestsSealed(p.verifierDir, manifest, files);
    const bad = await sealBroken();
    if (bad !== undefined) {
      await recordTamper(bad);
      return "tamper";
    }
    const port = p.config.start.port;
    let app: RunningApp;
    try {
      app = await launch(p.appDir, port, "replay");
    } catch (e) {
      out.replayError = `the app did not start: ${startFailureText(e).slice(-1000)}`;
      return "done";
    }
    return meter.batch("falsify", async () => {
      kaneWindow = true;
      let results: TestRunResult[];
      try {
        const opts = { startUrl: `${app.url}/`, timeoutS: p.config.kane.timeoutS, parallel: replays };
        results = await runSettled(deps.tests, cwd, files, opts, relaunch(p.appDir, port, "replay"));
      } finally {
        await stopApp();
      }
      const again = await sealBroken();
      if (again !== undefined) {
        await recordTamper(again);
        return "tamper";
      }
      const fileId = testIdsByFile();
      const was = reduce(events);
      for (const [i, r] of results.entries()) {
        const res = r.testId == null ? { ...r, testId: fileId.get(files[i]!) ?? null } : r;
        await emit({ t: "run", kind: "build", turn: state.turn, result: res });
      }
      const now = reduce(events);
      for (const ac of Object.values(now.acs).sort(byAcId)) {
        const prev = was.acs[ac.id]?.status;
        if ((prev === "passing" || prev === "proved") && ac.status === "regressed") await emit({ t: "regression", ac: ac.id, turn: state.turn });
      }
      await closeKaneWindow();
      return "done" as const;
    });
  };

  const run = async (): Promise<FalsifyResult> => {
    await dropStaleMutants(); // touches nothing sealed
    const marker = await tamperMarker(p);
    if (marker !== null) {
      await logMarkedTamper(p, log, marker);
      return result("tamper", RESEAL_HINT);
    }
    if (!(await isRepoRoot(p.appDir, gitOpts))) return result("error", `the app dir must be the root of a git repository: ${p.appDir}`);
    const par: unknown = p.config.breaker.parallel;
    if (typeof par !== "number" || !Number.isInteger(par) || par < 1) return result("error", `breaker.parallel must be a whole number of 1 or more, got ${JSON.stringify(par)}`);
    replays = par;
    const found = await readLedger(p.ledgerFile);
    mark = markOf(found);
    events = parseEvents(found.toString("utf8"));
    const state = reduce(events);
    if (state.tampered) return result("tamper", RESEAL_HINT);
    manifest = lastSeal(events);
    if (!manifest) return result("error", NO_SEAL);
    const broken = await checkSeal(p.verifierDir, manifest, p.appDir);
    if (broken.length > 0 && broken.every((k) => isSpecKey(p, k))) {
      const why = await specChanged(broken.map(specFileOf));
      if (why !== undefined) {
        await recordTamper(why);
        return result("tamper");
      }
      return result("drift", driftHint(broken.map(specFileOf)));
    }
    if (broken.length > 0) {
      await recordTamper(`sealed files changed: ${broken.join(", ")}`);
      return result("tamper");
    }
    // mutants are planted in a worktree of HEAD: the code Kane proved must be the code they break
    const dirty = await uncommitted(p.appDir, gitOpts, [EVIDENCE_DIR, ".claude"]);
    if (dirty.length > 0) {
      const shown = dirty.slice(0, 8).join(", ") + (dirty.length > 8 ? `, and ${dirty.length - 8} more` : "");
      return result(
        "error",
        `the app has uncommitted changes (${shown}): commit them first (an app data folder, such as data/, goes in .gitignore instead). Falsify plants its bugs in the last commit, so it must be the code Kane proved`,
      );
    }
    // Kane's recordings and the git config are held to the latest `recordings` event before any Kane batch
    const anchor = await checkRecordingsAnchor(p, events, gitOpts);
    baseline = anchor.snapshot;
    if (anchor.moved.length > 0) {
      await recordTamper(`changed since Holdback last recorded them: ${anchor.moved.join(", ")}`);
      return result("tamper");
    }
    if (!anchor.anchored) await emit({ t: "recordings", digest: baseline.digest, gitConfig: baseline.gitConfig });
    // checked against the disk just above: the seal after an evolve holds these, never a fresh read (I-1)
    appPin = appPinOf(p, manifest);

    // m-2: survivors an earlier pass never got to Kane go to it in this one, without a new attack
    for (const m of unevolvedSurvivors(events)) {
      const ac = state.acs[m.ac]!;
      survivors.push({ ac, id: m.id, patch: m.patch, rationale: "", ...(m.slip ? { slip: m.slip } : {}) });
      named(m.ac, m.id, m.slip, "", { earlier: true });
    }
    const budget = new Budget(p.config.breaker.capUsd, state.breakerUsd);
    const fileOf = testFileMap(events, p.verifierDir);
    const lastChanged = recentChanges(events);
    const passing = Object.values(state.acs)
      .filter((a) => a.status === "passing")
      .sort(byAcId);
    let budgetOut = false;
    let aborted = false;
    /** The spec changed meanwhile: nothing more is attacked or evolved until a human re-plans it. */
    let drifted = false;
    let driftFiles: string[] = [];
    for (const ac of passing) {
      if (opts.signal?.aborted) {
        aborted = true;
        break;
      }
      if (specDrift.length > 0) {
        drifted = true;
        driftFiles = specDrift;
        break;
      }
      if (budgetOut) {
        out.skipped.push(ac.id);
        continue;
      }
      const files = filesOf([ac], fileOf);
      assertTestsSealed(p.verifierDir, manifest, files);
      const before = out.killed.length + out.survived.length + out.invalid.length;
      // R40: a survivor whose use case Kane evolved since is re-checked first, with its own planted bug
      const r = await falsifyOne(ac, files, lastChanged, budget, pendingRecheck(events, ac));
      if (r === "tamper") return result("tamper");
      if (r === "budget") {
        budgetOut = true;
        if (out.killed.length + out.survived.length + out.invalid.length === before) out.skipped.push(ac.id);
      }
    }

    // an evolve re-seals the tests: never over a spec edit Kane has not re-planned
    if (survivors.length > 0 && !aborted && !drifted) {
      const bad = await sealBroken();
      if (bad !== undefined) {
        await recordTamper(bad);
        return result("tamper");
      }
      drifted = specDrift.length > 0;
      if (drifted) driftFiles = specDrift;
    }
    if (drifted || aborted) {
      if (drifted) out.vacuous.push(...survivors.map((s) => s.ac.id));
      for (const uc of [...new Set(survivors.map((s) => s.ac.useCase))].sort()) {
        notEvolved(uc, survivors.filter((s) => s.ac.useCase === uc).map((s) => s.ac.id), drifted ? SPEC_MOVED : STOPPED);
      }
    }
    /** The Kane credit cap met at a use case's evolve (m-1): the rest wait, what passed is still sealed. */
    let capStop: string | undefined;
    // R40: each use case with a survivor goes back to Kane, which evolves its tests
    if (survivors.length > 0 && !aborted && !drifted) {
      const byUc = new Map<string, Survivor[]>();
      for (const s of survivors) byUc.set(s.ac.useCase, [...(byUc.get(s.ac.useCase) ?? []), s]);
      const before = await copySealed(p);
      const logged: EventBody[] = [];
      const evolved: string[] = [];
      let sealed = false;
      try {
        for (const uc of [...byUc.keys()].sort()) {
          const list = byUc.get(uc)!;
          if (capStop === undefined) {
            try {
              const evs = await evolveUseCase(uc, list);
              if (evs) {
                logged.push(...evs);
                evolved.push(uc);
              }
              continue;
            } catch (e) {
              if (!(e instanceof KaneCapReached)) throw e;
              capStop = e.message;
            }
          }
          const ids = list.map((s) => s.ac.id);
          out.vacuous.push(...ids);
          notEvolved(uc, ids, EVOLVE_CAP);
          await emit({ t: "redesign.dropped", useCases: [uc], detail: `no evolve of ${uc}: ${capStop}`, credits: 0, acs: ids, reason: EVOLVE_CAP });
        }
        if (evolved.length > 0) {
          const ids = survivors.filter((s) => evolved.includes(s.ac.useCase)).map((s) => s.ac.id);
          const spent = logged.reduce((n, e) => n + (e.t === "falsify.evolved" || e.t === "redesign.dropped" ? e.credits : 0), 0);
          // I-1: the config, and every sealed verifier file but the ones an evolve was allowed to
          // change, are as the pass found them; anything else is a tamper, never sealed
          const appMoved = await appMovedFrom(p, appPin);
          const strays = [...appMoved.filter((k) => !isSpecKey(p, k)), ...(await verifierDiffersFrom(p, before)).filter((k) => !allowedPaths.has(k))];
          if (strays.length > 0) {
            await rollBack(before);
            await emit({
              t: "redesign.dropped",
              useCases: evolved,
              detail: `sealed files changed while Kane evolved the tests (${strays.join(", ")}): nothing was sealed`,
              credits: spent,
              acs: ids,
              reason: "sealed files changed while Kane evolved its tests, so nothing was sealed: a human re-seals (`holdback reseal`), then `holdback run`",
            });
            out.vacuous.push(...ids);
            await recordTamper(`sealed files changed while Kane evolved the tests: ${strays.join(", ")}`);
            return result("tamper");
          }
          // N-I2: the seal after it holds the spec as it was sealed; one that moved meanwhile is not sealed
          const moved = appMoved.map(specFileOf);
          if (moved.length > 0) {
            await rollBack(before);
            const c = await classifySpecChange(p, events, manifest!, moved, true);
            if ("tamper" in c) {
              await recordTamper(c.tamper);
              return result("tamper");
            }
            if (c.event) await emit(c.event);
            await emit({
              t: "redesign.dropped",
              useCases: evolved,
              detail: `the spec changed while Kane evolved the tests (${moved.join(", ")}): nothing was sealed`,
              credits: spent,
              acs: ids,
              reason: "the spec changed while Kane evolved its tests, so nothing was sealed: run `holdback drift`, then `holdback run`",
            });
            out.vacuous.push(...ids);
            for (const uc of evolved) notEvolved(uc, survivors.filter((s) => s.ac.useCase === uc).map((s) => s.ac.id), SPEC_MOVED);
            out.specChange = { files: moved, duringAgentTurn: true };
            drifted = true;
            driftFiles = moved;
          } else {
            for (const e of logged) {
              await emit(e);
              if (e.t === "falsify.evolved") (out.evolved ??= []).push({ uc: e.uc, because: e.because, ...(e.followUp ? { followUp: true } : {}) });
            }
            // Kane authored the change: the new tests are sealed, the config and spec as pinned (N-I2, I-1)
            await reseal(p, append, gitOpts, { app: appPin, by: "kane" }); // also anchors the recordings
            sealed = true;
            kaneWindow = false;
            manifest = lastSeal(events);
            out.redesigned.push(...evolved);
          }
        }
      } catch (e) {
        // a stop mid-evolve (a forged ledger, the credit cap) leaves no unsealed test of Kane's behind
        if (!sealed) await restoreSealed(p, before, { appFiles: false }).catch(() => {});
        throw e;
      }
    }

    // at the cap no Kane batch runs, the closing replay included
    if (capStop !== undefined) return result("kane-budget", capStop);
    // falsify runs left failing coverage in Kane's project store: replay the real build once
    if (attacked && (await replayRealBuild()) === "tamper") return result("tamper");
    if (drifted || specDrift.length > 0) {
      return result("drift", driftHint(specDrift.length > 0 ? specDrift : driftFiles));
    }
    return result(aborted ? "aborted" : budgetOut ? "budget" : "done");
  };

  /**
   * Every exit re-checks the ledger; an exit from inside a Kane batch still anchors the recordings
   * Kane left once the seal and git config check out (else the next run would see a tamper).
   */
  const finalize = async (r: FalsifyResult, thrown?: unknown): Promise<FalsifyResult> => {
    try {
      if (thrown instanceof LedgerTampered) throw thrown;
      if (r.reason === "tamper") return r;
      if (mark) await verifiedLedger(p.ledgerFile, mark);
      if (r.reason === "error" || kaneWindow) {
        await stopApp().catch(() => {});
        const bad = mark ? await sealBroken() : undefined;
        if (bad !== undefined) {
          await recordTamper(bad);
          return result("tamper");
        }
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
      return result("tamper", e.message);
    }
  };

  try {
    return await finalize(await run());
  } catch (e) {
    if (e instanceof KaneCapReached) return await finalize(result("kane-budget", e.message));
    if (e instanceof EvolveTampered) return await finalize(result("tamper", e.message));
    return await finalize(result("error", errText(e)), e);
  } finally {
    await stopApp().catch(() => {});
  }
}
