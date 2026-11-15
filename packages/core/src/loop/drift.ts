import { watch, type FSWatcher } from "node:fs";
import { copyFile, mkdir } from "node:fs/promises";
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
import { readEvents } from "../ledger/store.js";
import type { LedgerEvent } from "../ledger/types.js";
import type { EventBody } from "../ledger/vouched.js";
import type { Project } from "../project.js";
import { checkSeal } from "../seal.js";
import { logRecordings } from "../tamper.js";
import { lastSeal } from "./build.js";
import { changedTests, copySealed, restoreSealed } from "./falsify.js";
import type { HumanIO } from "./human.js";
import { checkSpecPaths, drivePaused, reseal } from "./spec.js";

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

/** A drift run that cannot go ahead; the verifier is rolled back. */
class DriftDropped extends Error {}

const errText = (e: unknown): string => (e instanceof Error ? e.message : String(e));

/** Kane names a source after its file: `PRD.md` is `prd`. */
const sourceIdOf = (rel: string): string => path.basename(rel, path.extname(rel)).toLowerCase();

/** Spec files whose app-side hash no longer matches the latest seal (relative `/` paths). */
async function changedSpecs(p: Project, manifest: Record<string, string>): Promise<string[]> {
  const bad = new Set(await checkSeal(p.verifierDir, manifest, p.appDir));
  return p.config.spec.map((f) => f.split(path.sep).join("/")).filter((rel) => bad.has(`app:${rel}`));
}

/**
 * The human edited the spec after the build went green: have Kane plan which use cases changed, show
 * the plan, apply it once approved, design tests for the ADD/MODIFY use cases (the human approves
 * them), then re-seal so the new acceptance criteria are owed and the build loop resumes. The edit
 * itself is the human's (this is run by hand), so the re-seal covers the new spec hash. Rolled back
 * (sealed files restored, `redesign.dropped` logged) when nothing is approved or Kane writes a test
 * file nobody approved. ARCHIVE/REMOVE rows are shown but never applied headless.
 * `log` must append to `p.ledgerFile`.
 */
export async function runDrift(
  p: Project,
  io: HumanIO,
  log: Log,
  deps: { kane?: DriftKane } = {},
): Promise<{ changed: boolean }> {
  const kane = deps.kane ?? defaultDriftKane;
  const emit = (e: EventBody) => log({ at: new Date().toISOString(), ...e } as LedgerEvent);
  const cwd = p.verifierDir;
  checkSpecPaths(p);

  const events = await readEvents(p.ledgerFile);
  const manifest = lastSeal(events);
  if (!manifest) throw new Error("drift: nothing is sealed yet, run the spec stage first");
  const changed = await changedSpecs(p, manifest);
  if (changed.length === 0) return { changed: false };

  const rows: ReconcileRow[] = [];
  let planCredits = 0;
  for (const rel of changed) {
    const dest = path.join(cwd, rel);
    await mkdir(path.dirname(dest), { recursive: true });
    await copyFile(path.join(p.appDir, rel), dest);
    const plan = await drivePaused(p, io, emit, await kane.reconcile(cwd, rel, sourceIdOf(rel), "plan"), kane);
    rows.push(...plan.rows);
    planCredits += plan.credits;
  }
  await emit({ t: "drift", rows, applied: false, credits: planCredits });

  const designable = rows.filter((r) => r.kind === "ADD" || r.kind === "MODIFY");
  if (designable.length > 0) {
    const approved = await io.approve(rows.map((r) => ({ ref: r.ref, title: `${r.kind}: ${r.why}`, kind: "drift" })));
    if (designable.some((r) => !approved.includes(r.ref))) return { changed: true }; // nothing applied, nothing sealed
  }
  const ucs = [...new Set(designable.map((r) => r.ref))];

  const gitOpts = await holdbackGitOptions(p.home);
  const copy = await copySealed(p);
  const credits = { apply: 0, design: new Map<string, number>() };
  const designs: Extract<EventBody, { t: "design" }>[] = [];
  const designNode = (n: ListedNode) => n.trust === "derived" && ["ac", "scenario", "test"].includes(n.label);
  try {
    if (designable.length > 0) {
      for (const rel of changed) {
        const applied = await drivePaused(p, io, emit, await kane.reconcile(cwd, rel, sourceIdOf(rel), "apply"), kane);
        credits.apply += applied.credits;
      }
      // approving the plan row is the human's approval of that use case
      await kane.review(cwd, ucs);
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
        g.tests.filter((t) => refs.includes(t.id) && t.file).map((t) => path.relative(p.verifierDir, path.resolve(p.verifierDir, t.file)).split(path.sep).join("/")),
      );
      const unapproved = (await changedTests(p, copy)).filter((f) => !approvedFiles.has(f));
      if (unapproved.length > 0) throw new DriftDropped(`Kane changed test files nobody approved: ${unapproved.join(", ")}`);
      await kane.review(cwd, refs);
    }
  } catch (e) {
    let restoreError: unknown;
    try {
      await restoreSealed(p, copy);
    } catch (re) {
      restoreError = re;
    }
    if (restoreError !== undefined) throw new Error(`drift rolled back incompletely: ${errText(restoreError)}: re-seal before building`);
    if (await isRepoRoot(p.appDir, gitOpts)) await logRecordings(p, log, gitOpts);
    const detail = e instanceof DriftDropped ? e.message : `Kane failed during drift: ${errText(e)}`;
    const spent = credits.apply + [...credits.design.values()].reduce((a, b) => a + b, 0);
    await emit({ t: "redesign.dropped", useCases: ucs, detail, credits: spent });
    return { changed: true };
  }
  await emit({ t: "drift", rows, applied: designable.length > 0, credits: credits.apply });
  for (const d of designs) await emit(d);
  await reseal(p, log, gitOpts);
  return { changed: true };
}

/**
 * Watch the spec files in the app dir; `onChange` fires once after edits go quiet for `debounceMs`
 * (default 1 s). Returns a function that stops watching.
 */
export function watchSpec(p: Project, onChange: () => void, opts: { debounceMs?: number } = {}): () => void {
  const wait = opts.debounceMs ?? 1000;
  const watchers: FSWatcher[] = [];
  let timer: NodeJS.Timeout | undefined;
  let stopped = false;
  const fire = () => {
    if (stopped) return;
    if (timer) clearTimeout(timer);
    timer = setTimeout(() => {
      timer = undefined;
      if (!stopped) onChange();
    }, wait);
  };
  for (const rel of p.config.spec) watchers.push(watch(path.join(p.appDir, rel), fire));
  return () => {
    stopped = true;
    if (timer) clearTimeout(timer);
    for (const w of watchers) w.close();
  };
}
