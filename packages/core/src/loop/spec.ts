import { createHash } from "node:crypto";
import { appendFile, copyFile, mkdir, mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import os from "node:os";
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
import { commitPaths, git, headSha, holdbackGitOptions, isRepoRoot, type GitOptions } from "../git.js";
import { KaneMeter, type BalanceReader } from "../ledger/credits.js";
import { reduce } from "../ledger/reduce.js";
import { readEvents } from "../ledger/store.js";
import type { LedgerEvent } from "../ledger/types.js";
import type { EventBody } from "../ledger/vouched.js";
import type { Project } from "../project.js";
import { attemptsText, specAttemptsSince } from "../agent/attempts.js";
import { appSealKey, checkSeal, isAppKeyOf, seal } from "../seal.js";
import { clearTamper, logRecordings, markTampered, tamperMarker } from "../tamper.js";
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

type SpecChanged = Extract<LedgerEvent, { t: "spec.changed" }>;

/** The latest `spec.changed` since the latest seal: how Holdback first saw the spec edit a drift is about to re-plan. */
export function latestSpecChange(events: LedgerEvent[]): SpecChanged | undefined {
  for (let i = events.length - 1; i >= 0; i--) {
    const e = events[i]!;
    if (e.t === "seal") return undefined;
    if (e.t === "spec.changed") return e;
  }
  return undefined;
}

const sha256 = (b: Buffer) => createHash("sha256").update(b).digest("hex");
const hashOf = (file: string): Promise<string> =>
  readFile(file).then(sha256, (e: NodeJS.ErrnoException) => (e.code === "ENOENT" ? "absent" : Promise.reject(e)));

/**
 * The `spec.changed` event for `files` (spec files, as `specFileOf` names them) against `manifest`,
 * or undefined when the latest one since the seal already says the same (it is logged once per edit;
 * one seen during an agent turn is never re-logged as seen outside one).
 */
export async function specChangeEvent(
  p: Project,
  events: LedgerEvent[],
  manifest: Record<string, string>,
  files: string[],
  duringAgentTurn: boolean,
): Promise<Omit<SpecChanged, "at"> | undefined> {
  const before: Record<string, string> = {};
  const after: Record<string, string> = {};
  for (const f of files) {
    before[f] = manifest[appSealKey(f)] ?? "absent";
    after[f] = await hashOf(path.join(p.appDir, ...f.split("/")));
  }
  const last = latestSpecChange(events);
  if (last && JSON.stringify(last.after) === JSON.stringify(after) && (last.duringAgentTurn || !duringAgentTurn)) return undefined;
  return { t: "spec.changed", files, duringAgentTurn, before, after };
}

/**
 * How a spec change (spec files only, nothing else sealed) seen now is classed (R38, fail closed):
 * - a write at the spec the guard logged since the latest seal makes it a tamper;
 * - otherwise it counts as the human's only when no agent turn started since that seal, no agent
 *   runs right now (`agentRunning`), and no record since the seal already calls it unverified (an
 *   unverified record stays so until the next seal or drift approval).
 * `event`: the `spec.changed` to log, or undefined when the latest record already says the same.
 */
export async function classifySpecChange(
  p: Project,
  events: LedgerEvent[],
  manifest: Record<string, string>,
  files: string[],
  agentRunning: boolean,
): Promise<{ tamper: string } | { unverified: boolean; event?: Omit<SpecChanged, "at"> }> {
  const sealAt = events.findLastIndex((e) => e.t === "seal");
  const sinceMs = sealAt < 0 ? 0 : Date.parse(events[sealAt]!.at) || 0;
  const tries = await specAttemptsSince(p.home, sinceMs);
  if (tries.length > 0) return { tamper: `the spec changed (${files.join(", ")}) after the agent tried to write it: ${attemptsText(tries)}` };
  const turned = events.slice(sealAt + 1).some((e) => e.t === "turn.start");
  const unverified = agentRunning || turned || latestSpecChange(events)?.duringAgentTurn === true;
  const event = await specChangeEvent(p, events, manifest, files, unverified);
  return event ? { unverified, event } : { unverified };
}

/** What the CLI makes of the spec as it is now, before a drift (`settleSpecChange`). */
export type SpecChangeNow = { kind: "none" } | { kind: "tamper"; detail: string } | { kind: "drift"; files: string[]; unverified: boolean };

/**
 * For the CLI before it re-plans a spec change (`run`, `watch`, `drift`): classes the change as
 * `classifySpecChange` does and logs what it found (a tamper, marked and logged; or the
 * `spec.changed` record). `none` when only the spec is not what changed (or nothing did).
 */
export async function settleSpecChange(p: Project, log: Log): Promise<SpecChangeNow> {
  const events = await readEvents(p.ledgerFile);
  let manifest: Record<string, string> | undefined;
  for (const e of events) if (e.t === "seal") manifest = e.manifest;
  if (!manifest) return { kind: "none" };
  const bad = await checkSeal(p.verifierDir, manifest, p.appDir);
  if (bad.length === 0 || !bad.every((k) => isSpecKey(p, k))) return { kind: "none" };
  const files = bad.map(specFileOf);
  const at = new Date().toISOString();
  const c = await classifySpecChange(p, events, manifest, files, false);
  if ("tamper" in c) {
    let detail = c.tamper;
    try {
      await markTampered(p, detail);
    } catch (e) {
      detail = `${detail} (tamper marker not written: ${e instanceof Error ? e.message : String(e)})`;
    }
    await log({ at, t: "tamper", detail });
    return { kind: "tamper", detail };
  }
  if (c.event) await log({ at, ...c.event });
  return { kind: "drift", files, unverified: c.unverified };
}

/**
 * Text fit for a terminal: every C0 and C1 control character but tab and newline shown as `\xNN`
 * (an escape sequence in a spec diff must never reach the terminal as one).
 */
export function escapeControls(text: string): string {
  return text.replace(/[\u0000-\u0008\u000b-\u001f\u007f-\u009f]/g, (c) => `\\x${c.charCodeAt(0).toString(16).padStart(2, "0")}`);
}

/** `<home>/sealed/<spec>`: each spec file as the latest seal hashed it, for the diff drift shows the human (R37). */
export const SEALED_DIR = "sealed";

/** Keeps a copy of each spec file the seal just hashed (never one whose old hash it kept). Best effort: the diff falls back to git. */
async function keepSealedCopies(p: Project, manifest: Record<string, string>, kept: Record<string, string>): Promise<void> {
  for (const f of p.config.spec) {
    const key = appSealKey(f);
    if (key in kept || manifest[key] === "absent") continue;
    const rel = specFileOf(key);
    const dest = path.join(p.home, SEALED_DIR, ...rel.split("/"));
    try {
      await mkdir(path.dirname(dest), { recursive: true });
      await copyFile(path.join(p.appDir, ...rel.split("/")), dest);
    } catch {
      await rm(dest, { force: true }).catch(() => {});
    }
  }
}

/** The bytes of `rel` as the seal in `manifest` hashed them: the kept copy, else HEAD's when it matches; null when neither does. */
async function sealedBytes(p: Project, manifest: Record<string, string>, rel: string): Promise<Buffer | null> {
  const want = manifest[appSealKey(rel)];
  if (want === undefined) return null;
  if (want === "absent") return Buffer.alloc(0);
  const copy = await readFile(path.join(p.home, SEALED_DIR, ...rel.split("/"))).catch(() => null);
  if (copy && sha256(copy) === want) return copy;
  try {
    const gitOpts = await holdbackGitOptions(p.home);
    if (!(await isRepoRoot(p.appDir, gitOpts))) return null;
    const r = await git(p.appDir, ["show", `HEAD:${rel}`], gitOpts);
    if (r.code !== 0) return null;
    const head = Buffer.from(r.stdout, "utf8");
    return sha256(head) === want ? head : null;
  } catch {
    return null;
  }
}

/**
 * The unified diff of spec file `rel` from the sealed version (`manifest`) to the app dir's, headed
 * `--- <rel> (sealed)` / `+++ <rel> (now)`; "" when they are the same; null when the sealed version
 * is no longer at hand.
 */
export async function specDiff(p: Project, manifest: Record<string, string>, rel: string): Promise<string | null> {
  const sealed = await sealedBytes(p, manifest, rel);
  if (sealed === null) return null;
  const tmp = await mkdtemp(path.join(os.tmpdir(), "holdback-diff-"));
  try {
    const old = path.join(tmp, "sealed");
    await writeFile(old, sealed);
    const now = path.join(p.appDir, ...rel.split("/"));
    let nowFile = now;
    if ((await hashOf(now)) === "absent") {
      nowFile = path.join(tmp, "absent");
      await writeFile(nowFile, "");
    }
    const r = await git(tmp, ["diff", "--no-index", "--no-color", "--no-ext-diff", "-U3", "--", old, nowFile]);
    if (r.code === 0) return "";
    if (r.code !== 1) return null;
    const lines = r.stdout.split(/\r?\n/);
    const hunk = lines.findIndex((l) => l.startsWith("@@"));
    return escapeControls([`--- ${rel} (sealed)`, `+++ ${rel} (now)`, ...(hunk < 0 ? [] : lines.slice(hunk))].join("\n").trimEnd());
  } finally {
    await rm(tmp, { recursive: true, force: true }).catch(() => {});
  }
}

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
  await keepSealedCopies(p, manifest, opts.keep ?? {});
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
export async function commitSpec(p: Project, changed: string[], before: Buffer | null, warn: Warn = stderrWarn, opts: { unverified?: boolean } = {}): Promise<void> {
  try {
    const now = await clarifiedFile(p);
    const clarified = now !== null && (before === null || !now.equals(before));
    const paths = [...new Set([...changed.map((f) => f.split(path.sep).join("/")), ...(clarified ? [CLARIFIED_FILE] : [])])];
    if (paths.length === 0) return;
    const gitOpts = await holdbackGitOptions(p.home);
    if (!(await isRepoRoot(p.appDir, gitOpts)) || (await headSha(p.appDir, gitOpts)) === null) return;
    // a change first seen right after an agent turn may be the agent's: the commit never says the human wrote it
    await commitPaths(p.appDir, `spec: ${paths.join(", ")}${opts.unverified ? " (origin unverified)" : ""}`, paths, gitOpts);
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

/** sha256 over the spec files' bytes (as they are in the app dir) and the spec links: what an extraction was made from. */
async function specSourceHash(p: Project): Promise<string> {
  const files: [string, string][] = [];
  for (const rel of p.config.spec) files.push([rel, await hashOf(path.join(p.appDir, rel))]);
  return createHash("sha256").update(JSON.stringify({ files, urls: p.config.specUrls })).digest("hex");
}

export const ALREADY_SEALED =
  "already sealed: to change the criteria, edit the spec and run `holdback drift` (after a tamper, `holdback reseal`)";

/**
 * The spec stage, once per project: Kane ingests the spec and asks its questions, the human approves
 * the use cases, Kane designs criteria and tests per use case, the human approves the design, and
 * the seal follows. Refuses once anything is sealed (a later spec change is drift). A stage cut short
 * resumes where it stopped: no new ingest while the spec and links still hash as they did when the
 * extraction finished, no question again for a use case already approved, no new design for one
 * already designed; then the design approval and the seal. What the human turns down in the design
 * approval is logged on each use case's design (`rejected`): such a criterion is never owed, such a
 * test never runs (I3).
 */
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
  const earlier = await readEvents(p.ledgerFile);
  if (earlier.some((e) => e.t === "seal")) throw new Error(ALREADY_SEALED);
  // a resumed stage commits the Clarifications an earlier attempt appended too
  const clarifiedBefore = earlier.length > 0 ? null : await clarifiedFile(p);
  const designed = new Map<string, Extract<EventBody, { t: "design" }>>();
  for (const e of earlier) if (e.t === "design") designed.set(e.useCase, e);

  // 1-2. the spec copied into the verifier store (kept outside the app repo), then ingest and
  // extraction, answering Kane's questions (one metered Kane batch); skipped when an earlier attempt
  // finished them for the spec as it is now
  const hash = await specSourceHash(p);
  if (!earlier.some((e) => e.t === "spec.extracted" && e.hash === hash)) {
    for (const rel of p.config.spec) {
      const dest = path.join(cwd, rel);
      await mkdir(path.dirname(dest), { recursive: true });
      await copyFile(path.join(p.appDir, rel), dest);
    }
    const sources = [...p.config.spec, ...p.config.specUrls];
    await meter.batch("spec", async () => {
      const first = await ingest(cwd, sources);
      if (first.status === "error") throw new Error(`spec ingest failed: ${first.message}`);
      const files = mapIngestedFiles(first.sources, p.config.spec);
      await emit({
        t: "spec.ingested",
        sources: first.sources.map((s) => ({ id: s.id, cid: s.cid, status: s.status, ...(files.has(s.id) ? { file: files.get(s.id)! } : {}) })),
        credits: first.status === "complete" ? first.credits : 0,
      });
      const extracted = await drive<IngestResult>(first);
      if (extracted.status === "error") throw new Error(`spec extraction failed: ${extracted.message}`);
      // hashed after the answers went into PRD.md: a resumed stage compares the spec as it is now
      await emit({ t: "spec.extracted", hash: await specSourceHash(p) });
    });
  }

  // 3. human approves the extracted use cases (ones approved by an earlier attempt are not asked again)
  const nodes = (await listNodes(cwd)).filter((n) => n.label === "usecase");
  const asked = nodes.filter((n) => n.trust === "derived");
  const approvedBefore = nodes.filter((n) => n.trust !== "derived").map((n) => n.id);
  let approvedNow: string[] = [];
  if (asked.length > 0 || approvedBefore.length === 0) {
    const picked = asked.length ? await io.approve(asked.map((n) => ({ ref: n.id, title: n.title, kind: "usecase" }))) : [];
    approvedNow = picked.filter((r) => asked.some((n) => n.id === r));
    await emit({ t: "spec.approved", refs: approvedNow, rejected: asked.map((n) => n.id).filter((id) => !approvedNow.includes(id)) });
  }
  const designable = [...approvedBefore, ...approvedNow];
  if (designable.length === 0) throw new Error("spec stage: no use case approved, nothing to design");
  if (approvedNow.length > 0) await review(cwd, approvedNow);

  // 4. design acceptance criteria + tests per use case not designed yet (a metered Kane batch each)
  for (const uc of designable.filter((u) => !designed.has(u))) {
    await meter.batch("design", async () => {
      const d = await drive(await designTests(cwd, uc, { max: p.config.kane.designMax }));
      if (d.status !== "complete") throw new Error(`design for ${uc} ${d.status}: ${d.message ?? ""}`);
      const g = await readGraph(cwd);
      const acs = g.acs.filter((a) => a.useCase === uc);
      const acIds = new Set(acs.map((a) => a.id));
      const e: Extract<EventBody, { t: "design" }> = {
        t: "design",
        useCase: uc,
        acs,
        tests: g.tests.filter((t) => t.verifies.some((v) => acIds.has(v))),
        gaps: g.gaps,
        credits: d.credits,
      };
      await emit(e);
      designed.set(uc, e);
    });
  }

  // 5. human approves the derived design (ACs, scenarios, tests); what they turn down goes on each
  //    use case's design, so it is never owed (a criterion) and never run (a test)
  const derived = (await listNodes(cwd)).filter((n) => n.trust === "derived" && ["ac", "scenario", "test"].includes(n.label));
  if (derived.length > 0) {
    const approved = await io.approve(derived.map((n) => ({ ref: n.id, title: n.title, kind: n.label })));
    const approvedSet = derived.map((n) => n.id).filter((id) => approved.includes(id));
    const turnedDown = derived.map((n) => n.id).filter((id) => !approvedSet.includes(id));
    await emit({ t: "spec.approved", refs: approvedSet, rejected: turnedDown });
    if (approvedSet.length === 0) throw new Error("spec stage: no designed test was approved, refusing to seal");
    await review(cwd, approvedSet);
    for (const d of designed.values()) {
      const mine = new Set([...d.acs.map((a) => a.id), ...d.tests.map((t) => t.id)]);
      const rejected = turnedDown.filter((id) => mine.has(id));
      if (JSON.stringify(rejected) !== JSON.stringify(d.rejected ?? [])) await emit({ ...d, credits: 0, rejected });
    }
  }

  // 6. point the tests at the app, commit Holdback's own spec edit, then seal (a fresh seal is the only thing that lifts a tamper)
  await writeStartUrl(cwd, `http://127.0.0.1:${p.config.start.port}/`);
  await commitClarifications(p, clarifiedBefore, deps.warn);
  await reseal(p, log);
}

/**
 * Which spec file each source Kane registered came from (M6): matched on Kane's source id, which it
 * derives from the file name (`PRD.md` is `prd`), never on the order of its events. A file no id
 * matches is paired only when it is the one file and the one source left unmatched.
 */
export function mapIngestedFiles(sources: { id: string }[], specFiles: string[]): Map<string, string> {
  const slug = (s: string) =>
    s
      .toLowerCase()
      .replace(/[^a-z0-9]+/g, "-")
      .replace(/^-+|-+$/g, "");
  const stem = (f: string) => path.basename(f.split("\\").join("/")).replace(/\.[^.]*$/, "");
  const out = new Map<string, string>();
  const left = new Set(specFiles);
  for (const s of sources) {
    const hit = [...left].filter((f) => s.id.toLowerCase() === stem(f).toLowerCase() || s.id.toLowerCase() === slug(stem(f)));
    if (hit.length === 1) {
      out.set(s.id, hit[0]!);
      left.delete(hit[0]!);
    }
  }
  const unmatched = sources.filter((s) => !out.has(s.id));
  if (left.size === 1 && unmatched.length === 1) out.set(unmatched[0]!.id, [...left][0]!);
  return out;
}
