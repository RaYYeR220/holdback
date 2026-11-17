import { createHash } from "node:crypto";
import { watch, type FSWatcher } from "node:fs";
import { mkdir, readFile, rm, writeFile } from "node:fs/promises";
import path from "node:path";
import {
  designTests,
  extractResume,
  listNodes,
  readGraph,
  reconcile,
  resumeSession,
  review,
  gapsOf,
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
import { appSealKey, checkSeal, isAppKeyOf } from "../seal.js";
import { checkRecordingsAnchor, markTampered, tamperMarker } from "../tamper.js";
import { lastSeal } from "./build.js";
import { changedTests, copySealed, restoreSealed, stateDiffersFrom, verifierDiffersFrom } from "./falsify.js";
import type { HumanIO } from "./human.js";
import {
  appPinOf,
  appMovedFrom,
  checkSpecPaths,
  clarifiedFile,
  classifySpecChange,
  commitSpec,
  drivePaused,
  designNotes,
  latestSpecChange,
  ledgerCap,
  pinnedSeal,
  reseal,
  specFileOf,
  specMovedFrom,
  type SpecPin,
  type Warn,
} from "./spec.js";

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
  /** A human's Kane credit cap for this command (`--kane-cap`), over `kane.capCredits` (I6). */
  kaneCap?: number;
  /**
   * The sha256 of each changed spec file (by its path in the config) as the human reviewed its diff
   * (N-I2): drift re-plans and seals exactly those bytes. A spec that no longer hashes so is not
   * re-planned: it is recorded as an unverified change, for the human to review again.
   */
  reviewed?: Record<string, string>;
  /** The human typed yes in the terminal to this spec change (an unverified one, R38): the drift counts as approved interactively (I-2). */
  confirmed?: boolean;
};

export type DriftResult =
  | { changed: false }
  | { changed: true; applied: true }
  /** The spec differs from the seal but nothing was applied or sealed: the build loop must not start; run drift again or revert the edit. */
  | { changed: true; applied: false; reason: string; needsInteractive?: boolean; specMoved?: string[] };

/** A drift run that cannot go ahead; the verifier is rolled back. */
class DriftDropped extends Error {}
/** A tamper found during the run: rolled back, recorded, and the run stops. */
class DriftTamper extends Error {}
/** The spec moved away from the bytes the human reviewed while Kane re-planned them (N-I2). */
class SpecMoved extends Error {}

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
  const meter = new KaneMeter(deps.balance, (e) => log({ at: at(), ...e }), ledgerCap(p, deps.kaneCap));
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

  // N-I2: the bytes of every spec file, read once: what Kane re-plans and the seal holds, plus the
  // Clarifications Holdback appends meanwhile (m-4: the unchanged files too, at the bytes the last
  // seal hashed, so an append to one is Holdback's, and an edit to one is never sealed). A changed
  // file must be the bytes the human reviewed; a deleted one is pinned as absent (m-5)
  const pin: SpecPin = { bytes: new Map() };
  const norm = (rel: string) => specFileOf(appSealKey(rel));
  const readSpec = (rel: string) => readFile(path.join(p.appDir, ...rel.split("/"))).catch((e: NodeJS.ErrnoException) => (e.code === "ENOENT" ? null : Promise.reject(e)));
  for (const rel of specs) pin.bytes.set(norm(rel), await readSpec(rel));
  const pinHashOf = (rel: string) => {
    const b = pin.bytes.get(norm(rel));
    return b === null || b === undefined ? "absent" : createHash("sha256").update(b).digest("hex");
  };
  /** Every app-side file as this drift pinned it (I-1): the config as the last seal holds it, the spec as pinned. */
  const appPin = () => ({ ...appPinOf(p, manifest), ...pinnedSeal(pin).keep });
  /**
   * The spec moved away from what the human reviewed: an unverified change on record (a tamper when
   * the guard logged a write at the spec since the seal), never one Kane re-plans or Holdback seals.
   */
  const specMoved = async (files: string[], reason: string): Promise<DriftResult> => {
    const c = await classifySpecChange(p, await readEvents(p.ledgerFile), manifest, files, true);
    if ("tamper" in c) {
      await recordTamper(c.tamper);
      throw new Error(`drift stopped: ${c.tamper}`);
    }
    if (c.event) await emit(c.event);
    return { changed: true, applied: false, reason, specMoved: files };
  };
  const reviewedAway = (rel: string) => deps.reviewed !== undefined && deps.reviewed[norm(rel)] !== pinHashOf(rel);
  // every pin must be the state the human reviewed: a changed file the bytes whose diff they saw, an
  // unchanged one the bytes the last seal hashed (it may have moved since the seal check)
  const away = specs.filter((rel) => (changed.includes(rel) ? reviewedAway(rel) : pinHashOf(rel) !== (manifest[appSealKey(rel)] ?? "absent")));
  if (away.length > 0) return specMoved(away.map(norm), `the spec changed again after you reviewed it (${away.map(norm).join(", ")}): nothing was re-planned; review it again`);

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
  /**
   * Undoes the run: the verifier byte for byte (its tests and Kane's own store, I-3), and Holdback's
   * own writes to the app (its Clarifications); the config is never written back (n-2). A spec file
   * that moved away from what Holdback expects is someone else's newer edit: never overwritten
   * (N-I2). Returns those spec files (`moved`) and a config that differs, left as found (`configLeft`).
   */
  const restore = async (): Promise<{ moved: string[]; configLeft: string[] }> => {
    const moved = await specMovedFrom(p, pin, manifest);
    await restoreSealed(p, copy, { appFiles: false });
    const configLeft: string[] = [];
    for (const [rel, bytes] of copy.app) {
      // n-2: drift never writes the config, so one that differs is someone else's edit (or a tamper,
      // whose evidence stays): left as found, and reported
      if (!specs.some((s) => isAppKeyOf(appSealKey(rel), s))) {
        const cfgNow = await readFile(path.join(p.appDir, ...rel.split("/"))).catch(() => null);
        if (!(bytes === null ? cfgNow === null : cfgNow !== null && cfgNow.equals(bytes))) configLeft.push(rel);
        continue;
      }
      if (moved.includes(specFileOf(appSealKey(rel)))) continue;
      const file = path.join(p.appDir, ...rel.split("/"));
      const now = await readFile(file).catch(() => null);
      if (bytes === null ? now === null : now !== null && now.equals(bytes)) continue;
      if (bytes === null) await rm(file, { force: true });
      else await writeFile(file, bytes);
    }
    for (const [rel, bytes] of specCopies) {
      const f = path.join(cwd, rel);
      if (bytes === null) await rm(f, { force: true });
      else await writeFile(f, bytes);
    }
    const left = [...(await verifierDiffersFrom(p, copy)), ...(await stateDiffersFrom(p, copy))];
    if (left.length > 0) throw new Error(`the verifier still differs (${left.join(", ")})`);
    return { moved, configLeft };
  };
  const decline = async (reason: string, needsInteractive?: boolean): Promise<DriftResult> => {
    const { moved, configLeft } = await restore();
    const why = configLeft.length > 0 ? `${reason}; ${configLeft.join(", ")} changed while drift ran and was left as found` : reason;
    if (moved.length > 0) return specMoved(moved, `${why}; and the spec changed while Kane re-planned it (${moved.join(", ")})`);
    return { changed: true, applied: false, reason: why, ...(needsInteractive ? { needsInteractive } : {}) };
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
        const bytes = pin.bytes.get(norm(rel))!;
        if (bytes === null) await rm(dest, { force: true });
        else await writeFile(dest, bytes);
        const plan = await drivePaused(p, io, emit, await kane.reconcile(cwd, rel, sourceIds.get(rel)!, "plan"), kane, "later", pin);
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
        const applied = await drivePaused(p, io, emit, await kane.reconcile(cwd, rel, sourceIds.get(rel)!, "apply"), kane, "later", pin);
        credits.apply += applied.credits;
      }
      // approving the plan row is the human's approval of that use case
      await kane.review(cwd, ucs);
      const designNode = (n: ListedNode) => n.trust === "derived" && ["ac", "scenario", "test"].includes(n.label);
      const derivedBefore = new Set((await kane.listNodes(cwd)).filter(designNode).map((n) => n.id));
      for (const uc of ucs) {
        const kind = designable.find((r) => r.ref === uc)?.kind;
        const first = await kane.designTests(cwd, uc, { force: kind === "MODIFY", max: p.config.kane.designMax });
        const d = await drivePaused(p, io, emit, first, kane, "later", pin);
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
        // read on Kane's own set of the use case, before the human's rejections (m-5)
        const kaneAcs = g.acs.filter((a) => a.useCase === uc);
        const kaneIds = new Set(kaneAcs.map((a) => a.id));
        const notes = designNotes(kaneAcs, g.tests.filter((t) => t.verifies.some((v) => kaneIds.has(v))), p.config.kane.designMax, rejected);
        designs.push({ t: "design", useCase: uc, acs, tests, gaps: gapsOf(g, uc), credits: credits.design.get(uc) ?? 0, ...(notes ? { notes } : {}) });
      }
      // the seal hashes whatever is on disk: every test byte Kane wrote must be one the human approved
      const approvedFiles = new Set(
        g.tests.filter((t) => refs.includes(t.id) && t.file).map((t) => slash(path.relative(p.verifierDir, path.resolve(p.verifierDir, t.file)))),
      );
      const unapproved = (await changedTests(p, copy)).filter((f) => !approvedFiles.has(f));
      if (unapproved.length > 0) throw new DriftDropped(`Kane changed test files nobody approved: ${unapproved.join(", ")}`);
      const moved = await recordingsMoved();
      if (moved.length > 0) throw new DriftTamper(`${moved.join(", ")} changed while Kane ran`);
      // what is sealed next is what the human reviewed and the config as drift found it (N-I2, I-1):
      // a config that moved is a tamper; a spec that moved is not re-planned. Checked before Kane
      // hears of the approval, and again after it, right before the events and the seal
      const pinsHold = async () => {
        const config = (await appMovedFrom(p, appPin())).filter((k) => !specs.some((rel) => isAppKeyOf(k, rel)));
        if (config.length > 0) throw new DriftTamper(`${config.join(", ")} changed while Kane re-planned the spec`);
        const specNow = await specMovedFrom(p, pin, manifest);
        if (specNow.length > 0) throw new SpecMoved(`the spec changed while Kane re-planned it (${specNow.join(", ")}): nothing was applied; review it again`);
      };
      await pinsHold();
      await kane.review(cwd, refs);
      await pinsHold();
    } catch (e) {
      let specGone: string[];
      try {
        specGone = (await restore()).moved;
      } catch (re) {
        throw new Error(`drift rolled back incompletely (${errText(re)}): re-seal before building`);
      }
      // anything that moved Kane's recordings during this run is a tamper, not a re-anchor
      const moved = e instanceof DriftTamper ? [errText(e)] : await recordingsMoved().catch(() => []);
      if (moved.length > 0) await recordTamper(`changed during drift: ${moved.join(", ")}`);
      if (e instanceof DriftTamper) throw new Error(`drift stopped: ${errText(e)}`);
      const detail = e instanceof DriftDropped || e instanceof SpecMoved ? e.message : `Kane failed during drift: ${errText(e)}`;
      const spent = credits.apply + [...credits.design.values()].reduce((a, b) => a + b, 0);
      await emit({ t: "redesign.dropped", useCases: ucs, detail, credits: spent });
      if (specGone.length > 0) return specMoved(specGone, detail);
      return { changed: true, applied: false, reason: detail };
    }
    await emit({ t: "drift", rows, applied: true, credits: credits.apply });
    for (const d of designs) await emit(d);
    return undefined;
  });
  if (declined) return declined;
  // kept only now: a rollback restores PRD.md, and a commit made right after the append would be left behind.
  // The spec edit goes in too: left in the work tree, it would land in the agent's next turn commit
  await commitSpec(p, changed, clarifiedBefore, deps.warn, { unverified: latestSpecChange(events)?.duringAgentTurn === true });
  // the seal holds the reviewed bytes (and Holdback's Clarifications), whatever lands on disk now: an
  // edit after the last check reads as an unverified change on the next run (N-I1, N-I2). A drift a
  // person approved at the moment (not an answers file alone) starts a fresh provenance window (I-2)
  const checkpoint = io.interactive === true || deps.confirmed === true;
  await reseal(p, log, gitOpts, { app: appPin(), copies: pinnedSeal(pin).copies, ...(checkpoint ? { checkpoint } : {}) });
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
