import { watch, type FSWatcher } from "node:fs";
import { copyFile, mkdir, readFile, rm, writeFile } from "node:fs/promises";
import path from "node:path";
import {
  designTests,
  extractResume,
  listNodes,
  readGraph,
  reconcile,
  resumeSession,
  review,
  type ListedNode,
  type ReconcileRow,
} from "../kane/assurance.js";
import { holdbackGitOptions, isRepoRoot } from "../git.js";
import { KaneMeter, type BalanceReader } from "../ledger/credits.js";
import { reduce } from "../ledger/reduce.js";
import { readEvents } from "../ledger/store.js";
import type { LedgerEvent } from "../ledger/types.js";
import type { EventBody } from "../ledger/vouched.js";
import type { Project } from "../project.js";
import { checkSeal, isAppKeyOf } from "../seal.js";
import { checkRecordingsAnchor, markTampered, tamperMarker } from "../tamper.js";
import { lastSeal } from "./build.js";
import { changedTests, copySealed, restoreSealed } from "./falsify.js";
import type { HumanIO } from "./human.js";
import { checkSpecPaths, clarifiedFile, commitSpec, drivePaused, reseal, type Warn } from "./spec.js";

type Log = (e: LedgerEvent) => Promise<void>;

/** The Kane Assurance calls a drift run makes (injectable for tests). */
export type DriftKane = {
  reconcile: typeof reconcile;
  designTests: typeof designTests;
  listNodes: typeof listNodes;
  readGraph: typeof readGraph;
  review: typeof review;
  resumeSession: typeof resumeSession;
  extractResume: typeof extractResume;
};

export const defaultDriftKane: DriftKane = { reconcile, designTests, listNodes, readGraph, review, resumeSession, extractResume };

export type DriftDeps = {
  kane?: DriftKane;
  /** Kane's balance, read before and after the run's Kane calls (a `credits` event); leave out to log none. */
  balance?: BalanceReader;
  /** Warnings that do not stop the run. Default: stderr. */
  warn?: Warn;
};

export type DriftResult =
  | { changed: false }
  | { changed: true; applied: true }
  /** The spec differs from the seal but nothing was applied or sealed: the build loop must not start; run drift again or revert the edit. */
  | { changed: true; applied: false; reason: string; needsInteractive?: boolean };

/** A drift run that cannot go ahead; the verifier is rolled back. */
class DriftDropped extends Error {}
/** A tamper found during the run: rolled back, recorded, and the run stops. */
class DriftTamper extends Error {}

const errText = (e: unknown): string => (e instanceof Error ? e.message : String(e));
const slash = (f: string): string => f.split(path.sep).join("/");

/**
 * The human edited the spec after the build went green: have Kane plan which use cases changed, show
 * the plan, apply it once approved, design tests for the ADD/MODIFY use cases (the human approves
 * them), then re-seal so the new acceptance criteria are owed and the build loop resumes. The edit
 * itself is the human's (this is run by hand), so the re-seal covers the new spec hash.
 *
 * Preflight first: a tamper marker or tampered ledger refuses outright; any sealed entry broken other
 * than the changed `app:<spec>` ones, or moved recordings, records a tamper. A declined plan, a design
 * that is not approved, or a test file nobody approved rolls the verifier back byte for byte
 * (`redesign.dropped` logged for a drop). ARCHIVE/REMOVE-only plans are never applied headless. The
 * app-side spec stays as the human left it. `log` must append to `p.ledgerFile`.
 */
export async function runDrift(p: Project, io: HumanIO, log: Log, deps: DriftDeps = {}): Promise<DriftResult> {
  const kane = deps.kane ?? defaultDriftKane;
  const at = () => new Date().toISOString();
  const meter = new KaneMeter(deps.balance, (e) => log({ at: at(), ...e }));
  const emit = async (e: EventBody) => {
    await log({ at: at(), ...e } as LedgerEvent);
    meter.add(e);
  };
  const cwd = p.verifierDir;
  checkSpecPaths(p);

  // ---- preflight (before any Kane call)
  const events = await readEvents(p.ledgerFile);
  const marker = await tamperMarker(p);
  if (marker !== null) throw new Error(`drift refused: a tamper is on record (${marker}); re-seal first`);
  if (reduce(events).tampered) throw new Error("drift refused: the ledger records a tamper; re-seal first");
  const manifest = lastSeal(events);
  if (!manifest) throw new Error("drift: nothing is sealed yet, run the spec stage first");
  const recordTamper = async (detail: string) => {
    let logged = detail;
    try {
      await markTampered(p, detail);
    } catch (e) {
      logged = `${detail} (tamper marker not written: ${errText(e)})`;
    }
    await emit({ t: "tamper", detail: logged });
  };
  const specs = p.config.spec.map(slash);
  const broken = await checkSeal(cwd, manifest, p.appDir);
  // both sides through the seal's own key normaliser: `./PRD.md` and `app:PRD.md` are one file
  const changed = specs.filter((rel) => broken.some((k) => isAppKeyOf(k, rel)));
  const other = broken.filter((k) => !changed.some((rel) => isAppKeyOf(k, rel)));
  if (other.length > 0) {
    await recordTamper(`sealed files changed: ${other.join(", ")}`);
    throw new Error(`drift refused: sealed files changed: ${other.join(", ")}`);
  }
  if (changed.length === 0) return { changed: false };
  const gitOpts = await holdbackGitOptions(p.home);
  const anchor = (await isRepoRoot(p.appDir, gitOpts)) ? await checkRecordingsAnchor(p, events, gitOpts) : { moved: [] as string[] };
  if (anchor.moved.length > 0) {
    await recordTamper(`changed since Holdback last recorded them: ${anchor.moved.join(", ")}`);
    throw new Error(`drift refused: ${anchor.moved.join(", ")} changed since Holdback last recorded them`);
  }

  // Kane's source id for each changed file comes from the ledger (spec.ingested), else Kane's own source list
  const ingested = events.flatMap((e) => (e.t === "spec.ingested" ? e.sources : []));
  const sourceIds = new Map<string, string>();
  for (const rel of changed) {
    let id = ingested.findLast((s) => s.file !== undefined && slash(s.file) === rel)?.id;
    if (id === undefined) {
      const nodes = (await kane.listNodes(cwd)).filter((n) => n.label === "source");
      id = nodes.find((n) => n.title === rel || n.title === path.basename(rel))?.id;
    }
    if (id === undefined) throw new Error(`drift: no Kane source id on record for ${rel} (re-run the spec stage)`);
    sourceIds.set(rel, id);
  }

  // ---- everything from here on is undone on a decline or a drop
  const copy = await copySealed(p);
  const clarifiedBefore = await clarifiedFile(p);
  const specCopies = new Map<string, Buffer | null>();
  for (const rel of changed) {
    try {
      specCopies.set(rel, await readFile(path.join(cwd, rel)));
    } catch (e) {
      if ((e as NodeJS.ErrnoException).code !== "ENOENT") throw e;
      specCopies.set(rel, null);
    }
  }
  const restore = async () => {
    await restoreSealed(p, copy);
    for (const [rel, bytes] of specCopies) {
      const f = path.join(cwd, rel);
      if (bytes === null) await rm(f, { force: true });
      else await writeFile(f, bytes);
    }
  };
  const decline = async (reason: string, needsInteractive?: boolean): Promise<DriftResult> => {
    await restore();
    return { changed: true, applied: false, reason, ...(needsInteractive ? { needsInteractive } : {}) };
  };
  /** Kane's reconcile/design calls write no run recordings: anything moved since the anchor is a tamper. */
  const recordingsMoved = async (): Promise<string[]> => {
    if (!(await isRepoRoot(p.appDir, gitOpts))) return [];
    return (await checkRecordingsAnchor(p, await readEvents(p.ledgerFile), gitOpts)).moved;
  };

  const rows: ReconcileRow[] = [];
  let planCredits = 0;
  const credits = { apply: 0, design: new Map<string, number>() };
  let ucs: string[] = [];
  const designs: Extract<EventBody, { t: "design" }>[] = [];
  // one metered Kane batch: the plan, the apply and the designs (the re-seal after it is local)
  const declined = await meter.batch("drift", async (): Promise<DriftResult | undefined> => {
    try {
      for (const rel of changed) {
        const dest = path.join(cwd, rel);
        await mkdir(path.dirname(dest), { recursive: true });
        await copyFile(path.join(p.appDir, rel), dest);
        const plan = await drivePaused(p, io, emit, await kane.reconcile(cwd, rel, sourceIds.get(rel)!, "plan"), kane);
        rows.push(...plan.rows);
        planCredits += plan.credits;
      }
      await emit({ t: "drift", rows, applied: false, credits: planCredits });

      const designable = rows.filter((r) => r.kind === "ADD" || r.kind === "MODIFY");
      if (rows.length === 0) return await decline("Kane found nothing to change in the spec edit");
      if (designable.length === 0) {
        return await decline(
          `the plan only has ARCHIVE/REMOVE rows, which Kane never applies headless: run \`kane-cli maintain reconcile\` interactively in ${cwd}, then run drift again`,
          true,
        );
      }
      const approvedRows = await io.approve(rows.map((r) => ({ ref: r.ref, title: `${r.kind}: ${r.why}`, kind: "drift" })));
      if (designable.some((r) => !approvedRows.includes(r.ref))) return await decline("the plan was not approved");

      // only use cases are designed; any other ref is shown to the human and skipped
      const known = new Set((await kane.listNodes(cwd)).filter((n) => n.label === "usecase").map((n) => n.id));
      ucs = [...new Set(designable.map((r) => r.ref).filter((ref) => ref.startsWith("uc-") || known.has(ref)))];
      if (ucs.length === 0) return await decline("no ADD/MODIFY row names a use case");

      for (const rel of changed) {
        const applied = await drivePaused(p, io, emit, await kane.reconcile(cwd, rel, sourceIds.get(rel)!, "apply"), kane);
        credits.apply += applied.credits;
      }
      // approving the plan row is the human's approval of that use case
      await kane.review(cwd, ucs);
      const designNode = (n: ListedNode) => n.trust === "derived" && ["ac", "scenario", "test"].includes(n.label);
      const derivedBefore = new Set((await kane.listNodes(cwd)).filter(designNode).map((n) => n.id));
      for (const uc of ucs) {
        const kind = designable.find((r) => r.ref === uc)?.kind;
        const first = await kane.designTests(cwd, uc, { force: kind === "MODIFY", max: p.config.kane.designMax });
        const d = await drivePaused(p, io, emit, first, kane);
        credits.design.set(uc, d.credits);
        if (d.status !== "complete") throw new DriftDropped(`design of ${uc} ${d.status}${d.message ? `: ${d.message}` : ""}`);
      }
      const g = await kane.readGraph(cwd);
      const ucAcs = new Set(g.acs.filter((a) => ucs.includes(a.useCase)).map((a) => a.id));
      const ucTests = new Set(g.tests.filter((t) => t.verifies.some((v) => ucAcs.has(v))).map((t) => t.id));
      const derived = (await kane.listNodes(cwd)).filter((n) => designNode(n) && (!derivedBefore.has(n.id) || ucAcs.has(n.id) || ucTests.has(n.id)));
      if (derived.length === 0) throw new DriftDropped("the design produced nothing to approve");
      const approved = await io.approve(derived.map((n) => ({ ref: n.id, title: n.title, kind: n.label })));
      const refs = derived.map((n) => n.id).filter((id) => approved.includes(id));
      const rejected = new Set(derived.map((n) => n.id).filter((id) => !refs.includes(id)));
      await emit({ t: "spec.approved", refs, rejected: [...rejected] });
      if (refs.length === 0) throw new DriftDropped("no designed test was approved");

      for (const uc of ucs) {
        const acs = g.acs.filter((a) => a.useCase === uc && !rejected.has(a.id));
        const ids = new Set(acs.map((a) => a.id));
        const tests = g.tests.filter((t) => !rejected.has(t.id) && t.verifies.some((v) => ids.has(v)));
        designs.push({ t: "design", useCase: uc, acs, tests, gaps: g.gaps, credits: credits.design.get(uc) ?? 0 });
      }
      // the seal hashes whatever is on disk: every test byte Kane wrote must be one the human approved
      const approvedFiles = new Set(
        g.tests.filter((t) => refs.includes(t.id) && t.file).map((t) => slash(path.relative(p.verifierDir, path.resolve(p.verifierDir, t.file)))),
      );
      const unapproved = (await changedTests(p, copy)).filter((f) => !approvedFiles.has(f));
      if (unapproved.length > 0) throw new DriftDropped(`Kane changed test files nobody approved: ${unapproved.join(", ")}`);
      const moved = await recordingsMoved();
      if (moved.length > 0) throw new DriftTamper(`${moved.join(", ")} changed while Kane ran`);
      await kane.review(cwd, refs);
    } catch (e) {
      try {
        await restore();
      } catch (re) {
        throw new Error(`drift rolled back incompletely (${errText(re)}): re-seal before building`);
      }
      // anything that moved Kane's recordings during this run is a tamper, not a re-anchor
      const moved = e instanceof DriftTamper ? [errText(e)] : await recordingsMoved().catch(() => []);
      if (moved.length > 0) await recordTamper(`changed during drift: ${moved.join(", ")}`);
      if (e instanceof DriftTamper) throw new Error(`drift stopped: ${errText(e)}`);
      const detail = e instanceof DriftDropped ? e.message : `Kane failed during drift: ${errText(e)}`;
      const spent = credits.apply + [...credits.design.values()].reduce((a, b) => a + b, 0);
      await emit({ t: "redesign.dropped", useCases: ucs, detail, credits: spent });
      return { changed: true, applied: false, reason: detail };
    }
    await emit({ t: "drift", rows, applied: true, credits: credits.apply });
    for (const d of designs) await emit(d);
    return undefined;
  });
  if (declined) return declined;
  // kept only now: a rollback restores PRD.md, and a commit made right after the append would be left behind.
  // The human's edit goes in too: left in the work tree, it would land in the agent's next turn commit
  await commitSpec(p, changed, clarifiedBefore, deps.warn);
  await reseal(p, log, gitOpts);
  return { changed: true, applied: true };
}

/**
 * Watch the spec files in the app dir; `onChange` fires once after edits go quiet for `debounceMs`
 * (default 1 s). Each file's directory is watched and filtered by name, so an editor's atomic
 * rename-save still fires. A watcher error stops watching and is passed to `onError`.
 * Returns a function that stops watching.
 */
export function watchSpec(
  p: Project,
  onChange: () => void,
  opts: { debounceMs?: number; onError?: (e: Error) => void } = {},
): () => void {
  const wait = opts.debounceMs ?? 1000;
  const watchers: FSWatcher[] = [];
  let timer: NodeJS.Timeout | undefined;
  let stopped = false;
  const stop = () => {
    stopped = true;
    if (timer) clearTimeout(timer);
    for (const w of watchers) w.close();
  };
  const fire = () => {
    if (stopped) return;
    if (timer) clearTimeout(timer);
    timer = setTimeout(() => {
      timer = undefined;
      if (!stopped) onChange();
    }, wait);
  };
  try {
    for (const rel of p.config.spec) {
      const abs = path.resolve(p.appDir, rel);
      const base = path.basename(abs);
      const w = watch(path.dirname(abs), (_ev, name) => {
        if (name === null || name === undefined || String(name) === base) fire();
      });
      w.on("error", (e) => {
        stop();
        opts.onError?.(e);
      });
      watchers.push(w);
    }
  } catch (e) {
    stop();
    throw e;
  }
  return stop;
}
