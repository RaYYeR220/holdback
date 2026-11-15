import { appendFile, copyFile, mkdir, readFile, writeFile } from "node:fs/promises";
import path from "node:path";
import {
  designTests,
  extractResume,
  ingest,
  listNodes,
  readGraph,
  resumeSession,
  review,
  type DesignResult,
  type IngestResult,
  type ReconcileResult,
  type Paused,
} from "../kane/assurance.js";
import { commitPaths, headSha, holdbackGitOptions, isRepoRoot, type GitOptions } from "../git.js";
import { KaneMeter, type BalanceReader } from "../ledger/credits.js";
import { reduce } from "../ledger/reduce.js";
import { readEvents } from "../ledger/store.js";
import type { LedgerEvent } from "../ledger/types.js";
import type { EventBody } from "../ledger/vouched.js";
import type { Project } from "../project.js";
import { appSealKey, isAppKeyOf, seal } from "../seal.js";
import { clearTamper, logRecordings, tamperMarker } from "../tamper.js";
import type { HumanIO } from "./human.js";

type Log = (e: LedgerEvent) => Promise<void>;

const CLARIFICATIONS = "## Clarifications";
/** The app-side file Holdback appends the human's answers to. */
const CLARIFIED_FILE = "PRD.md";
const CONFIG_FILE = "holdback.config.json";

const oneLine = (t: string): string => t.replace(/\s+/g, " ").trim();

/** True when `target` is strictly below `root` (a child folder named `..x` is inside). */
function inside(root: string, target: string): boolean {
  const rel = path.relative(root, target);
  return rel !== "" && rel !== ".." && !rel.startsWith(`..${path.sep}`) && !path.isAbsolute(rel);
}

/** Validate config.spec entries: relative, inside appDir, destination inside verifierDir. */
export function checkSpecPaths(p: Project): void {
  for (const rel of p.config.spec) {
    if (typeof rel !== "string" || rel === "" || path.isAbsolute(rel) || /^[a-zA-Z]:/.test(rel) || rel.startsWith("/") || rel.startsWith("\\")) {
      throw new Error(`spec path must be relative to the app dir: ${String(rel)}`);
    }
    if (!inside(p.appDir, path.resolve(p.appDir, rel))) throw new Error(`spec path escapes the app dir: ${rel}`);
    if (!inside(p.verifierDir, path.resolve(p.verifierDir, rel))) throw new Error(`spec path escapes the verifier dir: ${rel}`);
  }
}

/** App-dir files the seal covers: the config and every spec file. */
export function appSealFiles(p: Project): string[] {
  return [CONFIG_FILE, ...p.config.spec.map((f) => f.split(path.sep).join("/"))];
}

/** True when the seal key `key` is one of the config's spec files (`app:PRD.md`). */
export function isSpecKey(p: Pick<Project, "config">, key: string): boolean {
  return p.config.spec.some((f) => isAppKeyOf(key, f));
}

/** The spec file a seal key names (`app:PRD.md` -> `PRD.md`). */
export const specFileOf = (key: string): string => appSealKey(key).slice("app:".length);

/**
 * What a spec edit after the seal means: drift for a human to re-plan with Kane, never a tamper,
 * and never something a re-seal or the coding agent settles.
 */
export const driftHint = (files: string[]): string =>
  `the spec changed since the last seal (${files.join(", ")}): run \`holdback drift\` so Kane re-plans the criteria with you`;

/**
 * Re-hash the sealed app files (call after any later Holdback append to the
 * spec, e.g. more Clarifications) and return the updated manifest.
 */
export async function resealAppFiles(p: Project, manifest: Record<string, string>): Promise<Record<string, string>> {
  const fresh = await seal(p.verifierDir, { appDir: p.appDir, files: appSealFiles(p) });
  const out = { ...manifest };
  for (const [k, v] of Object.entries(fresh)) if (k.startsWith("app:")) out[k] = v;
  return out;
}

/**
 * Every human re-seal goes through here (the spec stage, and a re-seal after a tamper or drift).
 * `log` must append to `p.ledgerFile`.
 * 1. A tamper known only to the `TAMPERED` marker (the ledger could not take it) is logged first, so
 *    the seal below drops every build result from before it instead of keeping forged ones.
 * 2. A fresh seal of the verifier side and the app's spec/config files, then the marker is cleared.
 * 3. When the app dir is a git repo, Kane's recordings and the git config are anchored as they are
 *    now, so the next build loop holds the disk to this moment instead of seeding from it later.
 */
export async function reseal(p: Project, log: Log, git?: GitOptions, opts: ResealOptions = {}): Promise<Record<string, string>> {
  const at = () => new Date().toISOString();
  const gitOpts = git ?? (await holdbackGitOptions(p.home));
  const marker = await tamperMarker(p);
  // an unreadable ledger throws here: nothing is sealed and the marker stays
  if (marker !== null && !reduce(await readEvents(p.ledgerFile)).tampered) await log({ at: at(), t: "tamper", detail: marker });
  const manifest = { ...(await seal(p.verifierDir, { appDir: p.appDir, files: appSealFiles(p) })), ...opts.keep };
  await log({ at: at(), t: "seal", manifest });
  await clearTamper(p);
  if (await isRepoRoot(p.appDir, gitOpts)) await logRecordings(p, log, gitOpts);
  return manifest;
}

export type ResealOptions = {
  /**
   * Seal entries kept as the last seal had them instead of re-hashed: a human re-seal after a tamper
   * keeps a changed spec file's old hash, so the edit still reads as drift for Kane to re-plan.
   */
  keep?: Record<string, string>;
};

/** Append-only: creates the heading once, then only adds lines. */
async function appendClarifications(appDir: string, lines: string[]): Promise<void> {
  if (lines.length === 0) return;
  const file = path.join(appDir, CLARIFIED_FILE);
  let existing = "";
  try {
    existing = await readFile(file, "utf8");
  } catch (e) {
    if ((e as NodeJS.ErrnoException).code !== "ENOENT") throw e;
  }
  let add = "";
  if (!existing.split("\n").some((l) => l.trim() === CLARIFICATIONS)) {
    if (existing !== "") add += existing.endsWith("\n\n") ? "" : existing.endsWith("\n") ? "\n" : "\n\n";
    add += CLARIFICATIONS + "\n\n";
  } else if (!existing.endsWith("\n")) add += "\n";
  add += lines.join("\n") + "\n";
  await appendFile(file, add, "utf8");
}

async function writeStartUrl(verifierDir: string, url: string): Promise<void> {
  const file = path.join(verifierDir, ".testmuai", "variables", "assurance.json");
  let doc: Record<string, unknown> = {};
  try {
    const parsed: unknown = JSON.parse(await readFile(file, "utf8"));
    if (parsed && typeof parsed === "object" && !Array.isArray(parsed)) doc = parsed as Record<string, unknown>;
  } catch (e) {
    if ((e as NodeJS.ErrnoException).code !== "ENOENT") throw e;
  }
  const prev = doc.start_url && typeof doc.start_url === "object" ? (doc.start_url as Record<string, unknown>) : {};
  doc.start_url = { secret: false, description: "URL of the app under test", ...prev, value: url };
  await mkdir(path.dirname(file), { recursive: true });
  await writeFile(file, JSON.stringify(doc, null, 2) + "\n", "utf8");
}

/** The Kane calls that continue a paused session (injectable for tests). */
export type ResumeCalls = { extractResume: typeof extractResume; resumeSession: typeof resumeSession };

/**
 * Route every pause of a Kane session to the human until it completes. Each answer is appended
 * to the PRD's Clarifications (re-seal afterwards); credits of the call that paused are logged in
 * `spec.paused`, those of a resumed call in `spec.answered` and zeroed on the result, so the
 * caller does not count them twice.
 */
export async function drivePaused<R extends IngestResult | DesignResult | ReconcileResult>(
  p: Project,
  io: HumanIO,
  emit: (e: EventBody) => Promise<void>,
  first: R,
  kane: ResumeCalls = { extractResume, resumeSession },
  /** "spec": the spec stage proper. Later stages (drift, a falsify re-design) append no Clarifications when `loop.appendClarifications` is "spec-only". */
  stage: "spec" | "later" = "later",
): Promise<Exclude<R, Paused>> {
  const cwd = p.verifierDir;
  let r: R = first;
  while (r.status === "paused") {
    const paused = r as Paused;
    // the call that paused is billed: its credits count once, here (a resumed call's in `spec.answered`)
    await emit({ t: "spec.paused", sid: paused.sid, questions: paused.questions, credits: paused.credits });
    const answers = await io.answer(paused.questions);
    // an answer is always on the ledger (`spec.answered`); whether it also goes into PRD.md is the config's call
    if (stage === "spec" || p.config.loop.appendClarifications !== "spec-only") {
      await appendClarifications(
        p.appDir,
        paused.questions.filter((q) => answers[q.id] !== undefined).map((q) => `- Q: ${oneLine(q.text)} — A: ${oneLine(String(answers[q.id]))}`),
      );
    }
    r = (paused.verb === "extract" ? await kane.extractResume(cwd, paused.sid, answers) : await kane.resumeSession(cwd, paused, answers)) as R;
    const credits = "credits" in r ? r.credits : 0;
    await emit({ t: "spec.answered", sid: paused.sid, answers, credits });
    if ("credits" in r) r = { ...r, credits: 0 };
  }
  return r as Exclude<R, Paused>;
}

/** Where a stage reports what went wrong without stopping it (the CLI prints it). */
export type Warn = (line: string) => void;
const stderrWarn: Warn = (line) => void process.stderr.write(line + "\n");

/** The app's PRD.md as it is now (null when there is none): what `commitClarifications` compares with. */
export async function clarifiedFile(p: Project): Promise<Buffer | null> {
  return readFile(path.join(p.appDir, CLARIFIED_FILE)).catch((e: NodeJS.ErrnoException) => (e.code === "ENOENT" ? null : Promise.reject(e)));
}

/**
 * The Clarifications a stage (spec, drift, a falsify re-design) appended to PRD.md since `before`
 * go into the app repo as a commit of their own, before that stage's seal, so no agent turn
 * carries or lists them. Only that file is committed; nothing else the human has staged or not.
 * No repo, or an unborn HEAD (the build loop's first commit then takes the whole tree): nothing to
 * do. Git runs with Holdback's safe options. A commit that fails is a warning, never a failed
 * stage (that would throw away what Kane was paid for): PRD.md then goes into the next commit.
 */
export async function commitClarifications(p: Project, before: Buffer | null, warn: Warn = stderrWarn): Promise<void> {
  try {
    const now = await clarifiedFile(p);
    if (now === null || (before !== null && now.equals(before))) return;
    const gitOpts = await holdbackGitOptions(p.home);
    if (!(await isRepoRoot(p.appDir, gitOpts)) || (await headSha(p.appDir, gitOpts)) === null) return;
    await commitPaths(p.appDir, "spec: clarifications", [CLARIFIED_FILE], gitOpts);
  } catch (e) {
    warn(`warning: could not commit the Clarifications Holdback added to ${CLARIFIED_FILE} (${e instanceof Error ? e.message : String(e)}); they will go into the next commit`);
  }
}

/**
 * A drift's spec edit (the human's) and the Clarifications it appended to PRD.md since `before` go
 * into the app repo as one commit of their own (`spec: <files>`), before the re-seal, so no agent
 * turn carries or lists them. Only those files are committed. No repo, or an unborn HEAD: nothing to
 * do. A commit that fails is a warning, never a failed drift.
 */
export async function commitSpec(p: Project, changed: string[], before: Buffer | null, warn: Warn = stderrWarn): Promise<void> {
  try {
    const now = await clarifiedFile(p);
    const clarified = now !== null && (before === null || !now.equals(before));
    const paths = [...new Set([...changed.map((f) => f.split(path.sep).join("/")), ...(clarified ? [CLARIFIED_FILE] : [])])];
    if (paths.length === 0) return;
    const gitOpts = await holdbackGitOptions(p.home);
    if (!(await isRepoRoot(p.appDir, gitOpts)) || (await headSha(p.appDir, gitOpts)) === null) return;
    await commitPaths(p.appDir, `spec: ${paths.join(", ")}`, paths, gitOpts);
  } catch (e) {
    warn(`warning: could not commit the spec change (${e instanceof Error ? e.message : String(e)}); it will go into the next commit`);
  }
}

export type SpecDeps = {
  /** Kane's balance, read around the ingest and each design (`credits` events); leave out to log none. */
  balance?: BalanceReader;
  /** Warnings that do not stop the stage. Default: stderr. */
  warn?: Warn;
};

export async function runSpecStage(p: Project, io: HumanIO, log: Log, deps: SpecDeps = {}): Promise<void> {
  const at = () => new Date().toISOString();
  const meter = new KaneMeter(deps.balance, (e) => log({ at: at(), ...e }));
  const emit = async (e: EventBody) => {
    await log({ at: at(), ...e } as LedgerEvent);
    meter.add(e);
  };
  const cwd = p.verifierDir;

  const drive = <R extends IngestResult | DesignResult>(first: R) => drivePaused(p, io, emit, first, undefined, "spec");

  checkSpecPaths(p);
  const clarifiedBefore = await clarifiedFile(p);

  // 1. copy the spec into the verifier store (kept outside the app repo)
  for (const rel of p.config.spec) {
    const dest = path.join(cwd, rel);
    await mkdir(path.dirname(dest), { recursive: true });
    await copyFile(path.join(p.appDir, rel), dest);
  }
  const sources = [...p.config.spec, ...p.config.specUrls];

  // 2. ingest + extraction, answering Kane's questions (one metered Kane batch)
  await meter.batch("spec", async () => {
    const first = await ingest(cwd, sources);
    if (first.status === "error") throw new Error(`spec ingest failed: ${first.message}`);
    // Kane's own source ids (`PRD.md` is `prd`); `file` keeps the spec path each came from, so drift can map back
    const mapped = first.sources.length === sources.length;
    await emit({
      t: "spec.ingested",
      sources: first.sources.map((s, i) => ({ id: s.id, cid: s.cid, status: s.status, ...(mapped ? { file: sources[i]! } : {}) })),
      credits: first.status === "complete" ? first.credits : 0,
    });
    const extracted = await drive<IngestResult>(first);
    if (extracted.status === "error") throw new Error(`spec extraction failed: ${extracted.message}`);
  });

  // 3. human approves the extracted use cases
  const ucs = (await listNodes(cwd)).filter((n) => n.label === "usecase" && n.trust === "derived");
  const approvedUcs = ucs.length ? await io.approve(ucs.map((n) => ({ ref: n.id, title: n.title, kind: "usecase" }))) : [];
  const designable = approvedUcs.filter((r) => ucs.some((n) => n.id === r));
  await emit({
    t: "spec.approved",
    refs: designable,
    rejected: ucs.map((n) => n.id).filter((id) => !designable.includes(id)),
  });
  if (designable.length === 0) throw new Error("spec stage: no use case approved, nothing to design");
  await review(cwd, designable);

  // 4. design acceptance criteria + tests per use case (a metered Kane batch each)
  for (const uc of designable) {
    await meter.batch("design", async () => {
      const d = await drive(await designTests(cwd, uc, { max: p.config.kane.designMax }));
      if (d.status !== "complete") throw new Error(`design for ${uc} ${d.status}: ${d.message ?? ""}`);
      const g = await readGraph(cwd);
      const acs = g.acs.filter((a) => a.useCase === uc);
      const acIds = new Set(acs.map((a) => a.id));
      await emit({
        t: "design",
        useCase: uc,
        acs,
        tests: g.tests.filter((t) => t.verifies.some((v) => acIds.has(v))),
        gaps: g.gaps,
        credits: d.credits,
      });
    });
  }

  // 5. human approves the derived design (ACs, scenarios, tests)
  const derived = (await listNodes(cwd)).filter((n) => n.trust === "derived" && ["ac", "scenario", "test"].includes(n.label));
  if (derived.length > 0) {
    const approved = await io.approve(derived.map((n) => ({ ref: n.id, title: n.title, kind: n.label })));
    const approvedSet = derived.map((n) => n.id).filter((id) => approved.includes(id));
    await emit({ t: "spec.approved", refs: approvedSet, rejected: derived.map((n) => n.id).filter((id) => !approvedSet.includes(id)) });
    if (approvedSet.length === 0) throw new Error("spec stage: no designed test was approved, refusing to seal");
    await review(cwd, approvedSet);
  }

  // 6. point the tests at the app, commit Holdback's own spec edit, then seal (a fresh seal is the only thing that lifts a tamper)
  await writeStartUrl(cwd, `http://127.0.0.1:${p.config.start.port}/`);
  await commitClarifications(p, clarifiedBefore, deps.warn);
  await reseal(p, log);
}
