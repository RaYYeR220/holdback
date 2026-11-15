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
import type { LedgerEvent } from "../ledger/types.js";
import type { Project } from "../project.js";
import { seal } from "../seal.js";
import type { HumanIO } from "./human.js";

type Log = (e: LedgerEvent) => Promise<void>;
type EventBody = LedgerEvent extends infer E ? (E extends { at: string } ? Omit<E, "at"> : never) : never;

const CLARIFICATIONS = "## Clarifications";

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
      await emit({ t: "spec.answered", sid: paused.sid, answers });
      await appendClarifications(
        p.appDir,
        paused.questions.filter((q) => answers[q.id] !== undefined).map((q) => `- Q: ${q.text} — A: ${answers[q.id]}`),
      );
      r = (paused.verb === "extract" ? await extractResume(cwd, paused.sid, answers) : await resumeSession(cwd, paused, answers)) as R;
    }
    return r as Exclude<R, Paused>;
  }

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
  await emit({ t: "spec.ingested", sources: sources.map((id) => ({ id, cid: "" })) });
  const extracted = await drive<IngestResult>(first);
  if (extracted.status === "error") throw new Error(`spec extraction failed: ${extracted.message}`);

  // 3. human approves the extracted use cases
  const ucs = (await listNodes(cwd)).filter((n) => n.label === "usecase" && n.trust === "derived");
  const approvedUcs = ucs.length ? await io.approve(ucs.map((n) => ({ ref: n.id, title: n.title, kind: "usecase" }))) : [];
  const designable = approvedUcs.filter((r) => ucs.some((n) => n.id === r));
  if (designable.length === 0) throw new Error("spec stage: no use case approved, nothing to design");
  await review(cwd, designable);
  await emit({ t: "spec.approved", refs: designable });

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
    if (approved.length > 0) {
      await review(cwd, approved);
      await emit({ t: "spec.approved", refs: approved });
    }
  }

  // 6. point the tests at the app, then seal
  await writeStartUrl(cwd, `http://127.0.0.1:${p.config.start.port}/`);
  await emit({ t: "seal", manifest: await seal(cwd) });
}
