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
  type Paused,
} from "../kane/assurance.js";
import { holdbackGitOptions, isRepoRoot, type GitOptions } from "../git.js";
import { reduce } from "../ledger/reduce.js";
import { readEvents } from "../ledger/store.js";
import type { LedgerEvent } from "../ledger/types.js";
import type { Project } from "../project.js";
import { seal } from "../seal.js";
import { clearTamper, logRecordings, tamperMarker } from "../tamper.js";
import type { HumanIO } from "./human.js";

type Log = (e: LedgerEvent) => Promise<void>;
type EventBody = LedgerEvent extends infer E ? (E extends { at: string } ? Omit<E, "at"> : never) : never;

const CLARIFICATIONS = "## Clarifications";
const CONFIG_FILE = "holdback.config.json";

const oneLine = (t: string): string => t.replace(/\s+/g, " ").trim();

function inside(root: string, target: string): boolean {
  const rel = path.relative(root, target);
  return rel !== "" && !rel.startsWith("..") && !path.isAbsolute(rel);
}

/** Validate config.spec entries: relative, inside appDir, destination inside verifierDir. */
function checkSpecPaths(p: Project): void {
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
export async function reseal(p: Project, log: Log, git?: GitOptions): Promise<Record<string, string>> {
  const at = () => new Date().toISOString();
  const gitOpts = git ?? (await holdbackGitOptions(p.home));
  const marker = await tamperMarker(p);
  // an unreadable ledger throws here: nothing is sealed and the marker stays
  if (marker !== null && !reduce(await readEvents(p.ledgerFile)).tampered) await log({ at: at(), t: "tamper", detail: marker });
  const manifest = await seal(p.verifierDir, { appDir: p.appDir, files: appSealFiles(p) });
  await log({ at: at(), t: "seal", manifest });
  await clearTamper(p);
  if (await isRepoRoot(p.appDir, gitOpts)) await logRecordings(p, log, gitOpts);
  return manifest;
}

/** Append-only: creates the heading once, then only adds lines. */
async function appendClarifications(appDir: string, lines: string[]): Promise<void> {
  if (lines.length === 0) return;
  const file = path.join(appDir, "PRD.md");
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

export async function runSpecStage(p: Project, io: HumanIO, log: Log): Promise<void> {
  const emit = (e: EventBody) => log({ at: new Date().toISOString(), ...e } as LedgerEvent);
  const cwd = p.verifierDir;

  /** Route every pause to the human until the session completes. */
  async function drive<R extends IngestResult | DesignResult>(first: R): Promise<Exclude<R, Paused>> {
    let r: R = first;
    while (r.status === "paused") {
      const paused = r as Paused;
      await emit({ t: "spec.paused", sid: paused.sid, questions: paused.questions });
      const answers = await io.answer(paused.questions);
      await appendClarifications(
        p.appDir,
        paused.questions.filter((q) => answers[q.id] !== undefined).map((q) => `- Q: ${oneLine(q.text)} — A: ${oneLine(String(answers[q.id]))}`),
      );
      r = (paused.verb === "extract" ? await extractResume(cwd, paused.sid, answers) : await resumeSession(cwd, paused, answers)) as R;
      // credits of a resumed call are logged here, so zero them on the result to avoid double counting in `design`
      const credits = "credits" in r ? r.credits : 0;
      await emit({ t: "spec.answered", sid: paused.sid, answers, credits });
      if ("credits" in r) r = { ...r, credits: 0 };
    }
    return r as Exclude<R, Paused>;
  }

  checkSpecPaths(p);

  // 1. copy the spec into the verifier store (kept outside the app repo)
  for (const rel of p.config.spec) {
    const dest = path.join(cwd, rel);
    await mkdir(path.dirname(dest), { recursive: true });
    await copyFile(path.join(p.appDir, rel), dest);
  }
  const sources = [...p.config.spec, ...p.config.specUrls];

  // 2. ingest + extraction, answering Kane's questions
  const first = await ingest(cwd, sources);
  if (first.status === "error") throw new Error(`spec ingest failed: ${first.message}`);
  await emit({ t: "spec.ingested", sources: sources.map((id) => ({ id, cid: "" })), credits: first.status === "complete" ? first.credits : 0 });
  const extracted = await drive<IngestResult>(first);
  if (extracted.status === "error") throw new Error(`spec extraction failed: ${extracted.message}`);

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

  // 4. design acceptance criteria + tests per use case
  for (const uc of designable) {
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

  // 6. point the tests at the app, then seal (a fresh seal is the only thing that lifts a tamper)
  await writeStartUrl(cwd, `http://127.0.0.1:${p.config.start.port}/`);
  await reseal(p, log);
}
