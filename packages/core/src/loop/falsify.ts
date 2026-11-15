import { existsSync } from "node:fs";
import { lstat, mkdir, readdir, readFile, readlink, rm, stat, symlink, unlink, writeFile } from "node:fs/promises";
import path from "node:path";
import { freePort, startApp, type RunningApp } from "../app.js";
import { BreakerError, BreakerUnavailable, BudgetRefused, checkPatch, pickFiles, proposeMutant, type Mutant } from "../breaker/mutate.js";
import { Budget, veniceChat } from "../breaker/venice.js";
import { git, holdbackGitOptions, isRepoRoot, worktreeAdd, worktreeRemove, type GitOptions } from "../git.js";
import { balance, designTests, extractResume, listNodes, readGraph, resumeSession, review, type ListedNode } from "../kane/assurance.js";
import { inconclusiveNote, notAnAppFailure, runSettled, runTests, type TestRunResult } from "../kane/testmd.js";
import { KaneMeter, type BalanceReader } from "../ledger/credits.js";
import { reduce } from "../ledger/reduce.js";
import { parseEvents } from "../ledger/store.js";
import type { AcState, LedgerEvent } from "../ledger/types.js";
import { appendVouched, LedgerTampered, markOf, readLedger, verifiedLedger, type EventBody, type LedgerMark } from "../ledger/vouched.js";
import type { Project } from "../project.js";
import { checkSeal, tier1Entries, type SealEntry } from "../seal.js";
import { checkRecordingsAnchor, gitConfigHash, logRecordings, markTampered, tamperMarker, type RecordingsSnapshot } from "../tamper.js";
import { byAcId } from "./brief.js";
import { assertTestsSealed, filesOf, lastSeal, startFailureText, testFileMap } from "./build.js";
import type { HumanIO } from "./human.js";
import { appSealFiles, drivePaused, reseal } from "./spec.js";

type Log = (e: LedgerEvent) => Promise<void>;
type Verdict = Extract<LedgerEvent, { t: "mutant" }>["verdict"];

/** The Kane Assurance calls a re-design makes (injectable for tests). */
export type FalsifyKane = {
  designTests: typeof designTests;
  listNodes: typeof listNodes;
  review: typeof review;
  readGraph: typeof readGraph;
  resumeSession: typeof resumeSession;
  extractResume: typeof extractResume;
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
  kane: { designTests, listNodes, review, readGraph, resumeSession, extractResume },
  balance,
};

export type FalsifyStopReason = "done" | "budget" | "tamper" | "error" | "aborted";

export type FalsifyResult = {
  /** ACs whose mutant Kane caught: now `proved`. */
  killed: string[];
  /** ACs whose mutant passed every test (`survived` or `survived-by-heal`): now `vacuous`. */
  survived: string[];
  /** ACs whose mutant proved nothing: the patch never applied, the mutant did not start, or a test failed on other ACs only. */
  invalid: string[];
  /** Use cases Kane re-designed after a survivor: their ACs are `owed` again (back to the build loop). */
  redesigned: string[];
  /** Survivors left `vacuous` (a second survival, or a re-design that failed or was turned down): reported, not blocked on. */
  vacuous: string[];
  /** Passing ACs not attacked because the next breaker call could pass the budget cap. */
  skipped: string[];
  /** Breaker USD spent in this pass. */
  usd: number;
  reason: FalsifyStopReason;
  error?: string;
  /** Why a re-design was rolled back. */
  redesignError?: string;
  /** Why the closing replay against the real build did not run. */
  replayError?: string;
};

const MUT_DIR = "mut";
/** Where regression-bisect probes check out commits. */
export const BISECT_DIR = "bisect";
const RESEAL_HINT = "a tamper is on record: re-seal (the spec stage, or a human re-seal) before falsifying";
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

/** Use cases already re-designed after a survivor: a `design` of the use case after a surviving mutant of one of its ACs. */
function redesignedAfterSurvival(events: LedgerEvent[]): Set<string> {
  const ucOf = new Map<string, string>();
  const survived = new Set<string>();
  const out = new Set<string>();
  for (const e of events) {
    if (e.t === "design") {
      if (survived.delete(e.useCase)) out.add(e.useCase);
      for (const a of e.acs) ucOf.set(a.id, e.useCase);
    } else if (e.t === "mutant" && (e.verdict === "survived" || e.verdict === "survived-by-heal")) {
      const uc = ucOf.get(e.ac);
      if (uc !== undefined) survived.add(uc);
    }
  }
  return out;
}

/** A re-design that cannot go ahead; the verifier is rolled back. */
class RedesignDropped extends Error {}

/**
 * The tier-1 entries as the seal lists them (file bytes, or a link's target) and the sealed app
 * files (null when absent), taken before a re-design so it can be rolled back.
 */
export type SealedCopy = { verifier: Map<string, Buffer | string>; app: Map<string, Buffer | null> };

const inVerifier = (p: Project, rel: string) => path.join(p.verifierDir, ...rel.split("/"));

async function entryValue(file: string, kind: SealEntry["kind"]): Promise<Buffer | string> {
  if (kind === "file") return readFile(file);
  if (kind === "symlink") return `symlink:${await readlink(file).catch(() => "?")}`;
  return "special";
}

export async function copySealed(p: Project): Promise<SealedCopy> {
  const verifier = new Map<string, Buffer | string>();
  for (const e of await tier1Entries(p.verifierDir)) verifier.set(e.rel, await entryValue(inVerifier(p, e.rel), e.kind));
  const app = new Map<string, Buffer | null>();
  for (const rel of appSealFiles(p)) {
    try {
      app.set(rel, await readFile(path.join(p.appDir, ...rel.split("/"))));
    } catch (e) {
      if ((e as NodeJS.ErrnoException).code !== "ENOENT") throw e;
      app.set(rel, null);
    }
  }
  return { verifier, app };
}

const same = (a: Buffer | string, b: Buffer | string) => (Buffer.isBuffer(a) && Buffer.isBuffer(b) ? a.equals(b) : a === b);

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

/** Put the sealed files back as `copy` holds them (links are only removed, never written through). */
export async function restoreSealed(p: Project, copy: SealedCopy): Promise<void> {
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
};

/**
 * Falsify every `passing` AC: the breaker (a different model family, via Venice) writes the
 * smallest patch that violates exactly that AC; it is applied in a throwaway worktree of HEAD,
 * started on a spare port, and the AC's sealed tests are replayed against it with healing off.
 * Kane failing the AC kills the mutant (the AC is `proved`); a mutant that passes makes the AC
 * `vacuous`, and its use case is re-designed once by Kane (the human approves the result, then a
 * fresh seal) so it goes back to the build loop. Afterwards every test is replayed once against
 * the real build. `log` must append to `p.ledgerFile`: every append is verified against it.
 * Throws, before anything else, when VENICE_API_KEY is not set.
 */
export async function runFalsify(p: Project, deps: FalsifyDeps, io: HumanIO, log: Log, opts: FalsifyOptions = {}): Promise<FalsifyResult> {
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

  const at = () => new Date().toISOString();
  /** Every append goes through the same integrity check as the build loop's. */
  const append = async (e: LedgerEvent) => {
    if (!mark) throw new Error("internal: ledger not read before the first append");
    mark = await appendVouched(p.ledgerFile, mark, log, e);
    events.push(e);
    meter.add(e);
  };
  const emit = (body: EventBody) => append({ at: at(), ...body } as LedgerEvent);
  /** Each Kane batch (a mutant's replay, the closing replay, a re-design) is metered by Kane's balance. */
  const meter = new KaneMeter(deps.balance, emit);
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
    const a = running;
    running = undefined;
    await a?.stop();
  };
  /** Tier 1 and the repo's git config, against the seal and the baseline. */
  const sealBroken = async (): Promise<string[]> => {
    const bad = manifest ? await checkSeal(p.verifierDir, manifest, p.appDir) : [];
    if (baseline && (await gitConfigHash(baseline.gitConfigFile, gitOpts)) !== baseline.gitConfig) bad.push(".git/config");
    return bad;
  };
  /** After a Kane batch, with the app stopped: Kane's recordings as they are now are what the next run holds them to. */
  const closeKaneWindow = async () => {
    const snap = await logRecordings(p, append, gitOpts);
    baseline = { ...snap, gitConfig: baseline!.gitConfig };
    kaneWindow = false;
  };
  /** The breaker's key never reaches an app under test. */
  const appEnv = (extra: Record<string, string> = {}) => ({ ...p.config.start.env, ...extra, VENICE_API_KEY: "" });

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

  /** One mutant against one AC. Returns "budget" when the breaker call was refused before anything was spent. */
  const falsifyOne = async (ac: AcState, files: string[], lastChanged: string[], budget: Budget): Promise<"budget" | "tamper" | "done"> => {
    const model = p.config.breaker.model;
    const id = nextMutantId(ac.id);
    const dir = path.join(p.home, MUT_DIR, id);
    const patchFile = path.join(p.home, MUT_DIR, `${id}.patch`);
    let usd = 0;
    let patch = "";
    let logged = false;
    let stopNote = "results discarded: the pass stopped";
    const finish = async (verdict: Verdict, note?: string, results: TestRunResult[] = []) => {
      logged = true;
      out.usd += usd;
      await emit({ t: "mutant", id, ac: ac.id, patch, model, usd, verdict, ...(note === undefined ? {} : { note }) });
      for (const r of results) await emit({ t: "run", kind: "falsify", mutantId: id, result: r });
      (verdict === "killed" ? out.killed : verdict === "invalid" ? out.invalid : out.survived).push(ac.id);
    };
    try {
      await mkdir(path.dirname(dir), { recursive: true });
      await worktreeAdd(p.appDir, dir, "HEAD", gitOpts);
      await linkNodeModules(dir);
      const shown = await pickFiles(dir, ac, lastChanged, { exclude: appSealFiles(p) });
      if (shown.length === 0) {
        await finish("invalid", "no source file to mutate");
        return "done";
      }

      // 1. the breaker's patch, applied; one retry with git's (or the check's) complaint
      let failure: string | undefined;
      for (let attempt = 0; attempt < 2; attempt++) {
        let m: Mutant;
        try {
          m = await proposeMutant(ac, shown, {
            model,
            apiKey,
            budget,
            chat: deps.chat,
            ...(attempt === 0 ? {} : { retry: { patch, error: failure ?? "" } }),
          });
        } catch (e) {
          if (e instanceof BreakerError) {
            usd += e.usd;
            failure = e.message;
            continue;
          }
          if (e instanceof BudgetRefused) {
            if (attempt === 0) return "budget"; // nothing spent, nothing to log
            await finish("invalid", `patch did not apply: ${failure}; retry refused: ${e.message}`);
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
        failure = await applyPatch(dir, patchFile, m.patch, shown.map((f) => f.path));
        if (failure === undefined) break;
      }
      if (failure !== undefined) {
        await finish("invalid", `patch did not apply: ${failure}`);
        return "done";
      }

      // 2. the mutant app on a spare port, with its own data dir
      const dataDir = path.join(dir, "data");
      await mkdir(dataDir, { recursive: true });
      try {
        running = await deps.app({
          cwd: dir,
          cmd: p.config.start.cmd,
          port: await (deps.port ?? freePort)(),
          readyPath: p.config.start.readyPath,
          env: appEnv({ DATA_DIR: dataDir }),
        });
      } catch (e) {
        await finish("invalid", `mutant did not start: ${startFailureText(e).slice(-1000)}`);
        return "done";
      }

      // 3. Kane replays the AC's sealed tests against it, healing off (a run that failed for a reason
      //    other than the app once more, while the mutant is still up)
      const app = running;
      return await meter.batch("falsify", async () => {
        kaneWindow = true;
        attacked = true;
        let results: TestRunResult[];
        try {
          results = await runSettled(deps.tests, cwd, files, { startUrl: `${app.url}/`, noHeal: true, timeoutS: p.config.kane.timeoutS, parallel: p.config.kane.parallel });
        } finally {
          await stopApp();
        }
        const bad = await sealBroken();
        if (bad.length > 0) {
          // results produced against a changed test or variable never reach the ledger
          await recordTamper(`sealed files changed: ${bad.join(", ")}`);
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
   * Re-design the use cases once (Kane `design tests --force`), let the human approve the derived
   * nodes of those use cases, then log the new design and re-seal. It is rolled back (sealed files
   * restored byte for byte, recordings re-anchored, `redesign.dropped` logged with Kane's credits)
   * unless the human approved something, every survivor is still in the approved design, and every
   * test file Kane added or changed is one the human approved here.
   */
  const redesign = async (ucs: string[], survivors: string[]): Promise<void> => {
    // one metered Kane batch: the designs and the human's approval (the re-seal after it is local)
    if (!(await meter.batch("design", () => designAgain(ucs, survivors)))) return;
    await reseal(p, append, gitOpts); // also anchors the recordings as they are now
    kaneWindow = false;
    manifest = lastSeal(events);
    out.redesigned.push(...ucs);
  };
  /** The re-design up to the seal: true once the approved design is logged, false when it was rolled back. */
  const designAgain = async (ucs: string[], survivors: string[]): Promise<boolean> => {
    const copy = await copySealed(p);
    const credits = new Map<string, number>();
    const designs: Extract<EventBody, { t: "design" }>[] = [];
    const designNode = (n: ListedNode) => n.trust === "derived" && ["ac", "scenario", "test"].includes(n.label);
    kaneWindow = true; // Kane writes into the verifier while it designs
    try {
      const derivedBefore = new Set((await deps.kane.listNodes(cwd)).filter(designNode).map((n) => n.id));
      for (const uc of ucs) {
        const first = await deps.kane.designTests(cwd, uc, { force: true, max: p.config.kane.designMax });
        const d = await drivePaused(p, io, emit, first, deps.kane);
        credits.set(uc, d.credits);
        if (d.status !== "complete") throw new RedesignDropped(`re-design of ${uc} ${d.status}${d.message ? `: ${d.message}` : ""}`);
      }
      // only nodes of these use cases: new since the re-design started, or attributed to them by the graph
      const g = await deps.kane.readGraph(cwd);
      const ucAcs = new Set(g.acs.filter((a) => ucs.includes(a.useCase)).map((a) => a.id));
      const ucTests = new Set(g.tests.filter((t) => t.verifies.some((v) => ucAcs.has(v))).map((t) => t.id));
      const derived = (await deps.kane.listNodes(cwd)).filter((n) => designNode(n) && (!derivedBefore.has(n.id) || ucAcs.has(n.id) || ucTests.has(n.id)));
      if (derived.length === 0) throw new RedesignDropped("the re-design produced nothing to approve");
      const approved = await io.approve(derived.map((n) => ({ ref: n.id, title: n.title, kind: n.label })));
      const refs = derived.map((n) => n.id).filter((id) => approved.includes(id));
      const rejected = new Set(derived.map((n) => n.id).filter((id) => !refs.includes(id)));
      await emit({ t: "spec.approved", refs, rejected: [...rejected] });
      if (refs.length === 0) throw new RedesignDropped("no re-designed test was approved");

      for (const uc of ucs) {
        const acs = g.acs.filter((a) => a.useCase === uc && !rejected.has(a.id));
        const ids = new Set(acs.map((a) => a.id));
        const tests = g.tests.filter((t) => !rejected.has(t.id) && t.verifies.some((v) => ids.has(v)));
        designs.push({ t: "design", useCase: uc, acs, tests, gaps: g.gaps, credits: credits.get(uc) ?? 0 });
      }
      // a survivor never leaves the gate silently: it stays vacuous unless the new design still holds it
      const kept = new Set(designs.flatMap((d) => d.acs.map((a) => a.id)));
      const gone = survivors.filter((id) => !kept.has(id));
      if (gone.length > 0) throw new RedesignDropped(`the approved re-design no longer holds ${gone.join(", ")} (rejected or not re-derived)`);
      // the seal below hashes whatever is on disk: every test byte Kane wrote must be one the human approved
      const approvedFiles = new Set(
        g.tests.filter((t) => refs.includes(t.id) && t.file).map((t) => path.relative(p.verifierDir, path.resolve(p.verifierDir, t.file)).split(path.sep).join("/")),
      );
      const unapproved = (await changedTests(p, copy)).filter((f) => !approvedFiles.has(f));
      if (unapproved.length > 0) throw new RedesignDropped(`Kane changed test files nobody approved: ${unapproved.join(", ")}`);
      // only now is Kane told what the human approved
      await deps.kane.review(cwd, refs);
    } catch (e) {
      // the sealed files go back first, whatever happened (local files only)
      let restoreError: unknown;
      try {
        await restoreSealed(p, copy);
      } catch (re) {
        restoreError = re;
      }
      if (e instanceof LedgerTampered) throw e;
      const left = restoreError === undefined && manifest ? await checkSeal(p.verifierDir, manifest, p.appDir) : [];
      if (restoreError !== undefined || left.length > 0) {
        const why = restoreError !== undefined ? errText(restoreError) : `sealed files still differ (${left.join(", ")})`;
        throw new Error(`re-design rolled back incompletely: ${why}: re-seal before building`);
      }
      await closeKaneWindow();
      const detail = e instanceof RedesignDropped ? e.message : `Kane failed during the re-design: ${errText(e)}`;
      out.redesignError = detail;
      await emit({ t: "redesign.dropped", useCases: ucs, detail, credits: [...credits.values()].reduce((a, b) => a + b, 0) });
      return false;
    }
    for (const d of designs) await emit(d);
    return true;
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
    if (bad.length > 0) {
      await recordTamper(`sealed files changed: ${bad.join(", ")}`);
      return "tamper";
    }
    try {
      running = await deps.app({ cwd: p.appDir, cmd: p.config.start.cmd, port: p.config.start.port, readyPath: p.config.start.readyPath, env: appEnv() });
    } catch (e) {
      out.replayError = `the app did not start: ${startFailureText(e).slice(-1000)}`;
      return "done";
    }
    const app = running;
    return meter.batch("falsify", async () => {
      kaneWindow = true;
      let results: TestRunResult[];
      try {
        results = await runSettled(deps.tests, cwd, files, { startUrl: `${app.url}/`, timeoutS: p.config.kane.timeoutS, parallel: p.config.kane.parallel });
      } finally {
        await stopApp();
      }
      const again = await sealBroken();
      if (again.length > 0) {
        await recordTamper(`sealed files changed: ${again.join(", ")}`);
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
      try {
        if (!reduce(parseEvents((await readLedger(p.ledgerFile)).toString("utf8"))).tampered) await log({ at: at(), t: "tamper", detail: marker });
      } catch {
        /* best effort: the marker blocks either way */
      }
      return result("tamper", RESEAL_HINT);
    }
    if (!(await isRepoRoot(p.appDir, gitOpts))) return result("error", `the app dir must be the root of a git repository: ${p.appDir}`);
    const found = await readLedger(p.ledgerFile);
    mark = markOf(found);
    events = parseEvents(found.toString("utf8"));
    const state = reduce(events);
    if (state.tampered) return result("tamper", RESEAL_HINT);
    manifest = lastSeal(events);
    if (!manifest) return result("error", NO_SEAL);
    const broken = await checkSeal(p.verifierDir, manifest, p.appDir);
    if (broken.length > 0) {
      await recordTamper(`sealed files changed: ${broken.join(", ")}`);
      return result("tamper");
    }
    // Kane's recordings and the git config are held to the latest `recordings` event before any Kane batch
    const anchor = await checkRecordingsAnchor(p, events, gitOpts);
    baseline = anchor.snapshot;
    if (anchor.moved.length > 0) {
      await recordTamper(`changed since Holdback last recorded them: ${anchor.moved.join(", ")}`);
      return result("tamper");
    }
    if (!anchor.anchored) await emit({ t: "recordings", digest: baseline.digest, gitConfig: baseline.gitConfig });

    const budget = new Budget(p.config.breaker.capUsd, state.breakerUsd);
    const fileOf = testFileMap(events, p.verifierDir);
    const lastChanged = recentChanges(events);
    const passing = Object.values(state.acs)
      .filter((a) => a.status === "passing")
      .sort(byAcId);
    let budgetOut = false;
    let aborted = false;
    for (const ac of passing) {
      if (opts.signal?.aborted) {
        aborted = true;
        break;
      }
      if (budgetOut) {
        out.skipped.push(ac.id);
        continue;
      }
      const files = filesOf([ac], fileOf);
      assertTestsSealed(p.verifierDir, manifest, files);
      const before = out.killed.length + out.survived.length + out.invalid.length;
      const r = await falsifyOne(ac, files, lastChanged, budget);
      if (r === "tamper") return result("tamper");
      if (r === "budget") {
        budgetOut = true;
        if (out.killed.length + out.survived.length + out.invalid.length === before) out.skipped.push(ac.id);
      }
    }

    // survivors: one re-design per use case and pass; a use case already re-designed for a survivor stays vacuous
    if (out.survived.length > 0 && !aborted) {
      const again = redesignedAfterSurvival(events);
      const ucOf = new Map(out.survived.map((id) => [id, state.acs[id]!.useCase]));
      const ucs = [...new Set(ucOf.values())].filter((uc) => !again.has(uc)).sort();
      for (const [id, uc] of ucOf) if (again.has(uc)) out.vacuous.push(id);
      if (ucs.length > 0) {
        await redesign(
          ucs,
          [...ucOf].filter(([, uc]) => ucs.includes(uc)).map(([id]) => id),
        );
        if (out.redesigned.length === 0) for (const [id, uc] of ucOf) if (ucs.includes(uc)) out.vacuous.push(id);
      }
    }

    // falsify runs left failing coverage in Kane's project store: replay the real build once
    if (attacked && (await replayRealBuild()) === "tamper") return result("tamper");
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
        const bad = mark ? await sealBroken() : [];
        if (bad.length > 0) {
          await recordTamper(`sealed files changed: ${bad.join(", ")}`);
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
    return await finalize(result("error", errText(e)), e);
  } finally {
    await stopApp().catch(() => {});
  }
}
