import { readFileSync, readdirSync } from "node:fs";
import { join } from "node:path";
import { runKane, type RunKaneResult } from "./run.js";
import type { KaneEvent } from "./ndjson.js";
import { parseTestMd } from "./testmd-parse.js";

// ---------------------------------------------------------------- types

export type PendingQuestion = {
  id: string;
  text: string;
  risk: "low" | "med" | "high";
  rationale: string;
  options: { label: string; detail?: string }[];
  recommendedIndex: number;
  allowFreeText: boolean;
};

export type Paused = {
  status: "paused";
  /** Which Kane verb paused: "extract", "design" or "reconcile". */
  verb: string;
  sid: string;
  resume: string;
  questions: PendingQuestion[];
};

export type IngestResult =
  | { status: "complete"; minted: string[]; credits: number }
  | Paused
  | { status: "error"; message: string; code?: string };

export type DesignResult =
  | {
      status: "complete" | "refused" | "error";
      /** Set when status is "error" (or "refused" with a reason). */
      message?: string;
      code?: string;
      tests: string[];
      acs: string[];
      gaps: string[];
      variables: { name: string; description: string; secret: boolean }[];
      credits: number;
      next: string[];
    }
  | Paused;

export type UseCaseNode = { id: string; title: string; trust: string };
export type AcNode = {
  id: string;
  text: string;
  useCase: string;
  cites: { source: string; anchor: string; quote: string }[];
  trust: string;
};
export type TestNode = { id: string; title: string; file: string; verifies: string[] };
export type GapNode = { id: string; title: string; kind: string; acs: string[] };
export type Graph = { useCases: UseCaseNode[]; acs: AcNode[]; tests: TestNode[]; gaps: GapNode[] };

export type ReconcileRow = { kind: "ADD" | "MODIFY" | "ARCHIVE" | "REMOVE"; ref: string; why: string };
export type ReconcileResult =
  | { status: "complete"; rows: ReconcileRow[]; planPath?: string; summary: Record<string, number>; credits: number }
  | Paused;

// ---------------------------------------------------------------- helpers

/** Agent turns (LLM calls) can run for many minutes; read-only commands are quick. */
const AI_TIMEOUT_MS = 20 * 60_000;
const READ_TIMEOUT_MS = 60_000;

const str = (v: unknown): string => (typeof v === "string" ? v : "");
const isObj = (v: unknown): v is Record<string, unknown> => v !== null && typeof v === "object" && !Array.isArray(v);
const arr = (v: unknown): unknown[] => (Array.isArray(v) ? v : []);

export function sumCredits(events: KaneEvent[]): number {
  let total = 0;
  for (const e of events) {
    if (e.type === "usage" && typeof e.credits === "number") total += e.credits;
  }
  return Math.round(total * 1e4) / 1e4;
}

function pendingQuestion(raw: unknown): PendingQuestion | null {
  if (!isObj(raw)) return null;
  const risk = raw.risk === "low" || raw.risk === "high" ? raw.risk : "med";
  return {
    id: str(raw.id),
    text: str(raw.text),
    risk,
    rationale: str(raw.rationale),
    options: arr(raw.options)
      .filter(isObj)
      .map((o) => (typeof o.detail === "string" ? { label: str(o.label), detail: o.detail } : { label: str(o.label) })),
    recommendedIndex: typeof raw.recommended_index === "number" ? raw.recommended_index : 0,
    allowFreeText: raw.allow_free_text === true,
  };
}

function pausedFrom(events: KaneEvent[]): Paused | null {
  const p = events.find((e) => e.type === "session_paused");
  if (!p) return null;
  const done = events.find((e) => e.type === "done");
  if (done && done.status !== "paused") return null;
  return {
    status: "paused",
    verb: str(p.verb),
    sid: str(p.sid),
    resume: str(p.resume),
    questions: arr(p.pending_questions)
      .map(pendingQuestion)
      .filter((q): q is PendingQuestion => q !== null),
  };
}

function errorFrom(r: RunKaneResult): { status: "error"; message: string; code?: string } {
  const ev = r.events.find((e) => e.type === "error");
  const message =
    str(ev?.message) ||
    (r.timedOut ? "kane-cli timed out" : "") ||
    r.stderr.trim() ||
    r.stdout.trim() ||
    `kane-cli exited with code ${r.exitCode}`;
  const code = str(ev?.code);
  return code ? { status: "error", message, code } : { status: "error", message };
}

/** done.status when the stream ended cleanly, else null (no done event). */
function doneStatus(r: RunKaneResult): string | null {
  const d = r.events.find((e) => e.type === "done");
  return d ? str(d.status) : null;
}

function mintedIds(events: KaneEvent[], prefix: string): string[] {
  const out: string[] = [];
  for (const e of events) {
    if (e.type !== "commit") continue;
    for (const m of arr(e.minted)) {
      if (isObj(m) && str(m.logical_id).startsWith(prefix) && !out.includes(str(m.logical_id))) {
        out.push(str(m.logical_id));
      }
    }
  }
  return out;
}

function ingestOutcome(r: RunKaneResult): IngestResult {
  const paused = pausedFrom(r.events);
  if (paused) return paused;
  const status = doneStatus(r);
  if (r.exitCode !== 0 || status === "error" || status === null) return errorFrom(r);
  return { status: "complete", minted: mintedIds(r.events, "uc-"), credits: sumCredits(r.events) };
}

// ---------------------------------------------------------------- context ingest / extract / review

export async function ingest(cwd: string, sources: string[]): Promise<IngestResult> {
  const r = await runKane(["context", "ingest", ...sources, "--mode", "agent"], { cwd, timeoutMs: AI_TIMEOUT_MS });
  return ingestOutcome(r);
}

export async function extractResume(cwd: string, sid: string, answers: Record<string, string>): Promise<IngestResult> {
  const paused: Paused = {
    status: "paused",
    verb: "extract",
    sid,
    resume: `kane-cli context extract --resume ${sid} --mode agent`,
    questions: [],
  };
  return (await resumeSession(cwd, paused, answers)) as IngestResult;
}

/** Split a command line into argv, honouring single and double quotes. */
export function tokenize(cmd: string): string[] {
  const out: string[] = [];
  const re = /"([^"]*)"|'([^']*)'|(\S+)/g;
  let m: RegExpExecArray | null;
  while ((m = re.exec(cmd)) !== null) out.push(m[1] ?? m[2] ?? m[3] ?? "");
  return out;
}

/**
 * Continue a paused extract / design / reconcile session using the exact
 * command Kane printed in `session_paused.resume`, plus one `--answer` each.
 */
export async function resumeSession(
  cwd: string,
  paused: Paused,
  answers: Record<string, string>,
): Promise<IngestResult | DesignResult | ReconcileResult> {
  const args = tokenize(paused.resume);
  if (args[0] === "kane-cli") args.shift();
  if (args.length === 0) throw new Error("resumeSession: empty resume command");
  for (const [id, value] of Object.entries(answers)) args.push("--answer", `${id}=${value}`);
  const r = await runKane(args, { cwd, timeoutMs: AI_TIMEOUT_MS });
  if (args[0] === "design") return parseDesign(r);
  if (args[0] === "maintain") return parseReconcile(r);
  if (args[0] === "context" && args[1] === "extract") return ingestOutcome(r);
  throw new Error(`resumeSession: unsupported resume command: ${paused.resume}`);
}

export async function review(cwd: string, refs: string[]): Promise<void> {
  // Prints a non-JSON summary line; the exit code is the signal.
  const r = await runKane(["context", "review", "--approve", ...refs, "--json"], { cwd, timeoutMs: READ_TIMEOUT_MS });
  if (r.exitCode !== 0) {
    const detail = r.stderr.trim() || r.stdout.trim() || "no output";
    throw new Error(`context review failed (exit ${r.exitCode}): ${detail}`);
  }
}

// ---------------------------------------------------------------- design

export async function designTests(
  cwd: string,
  useCase: string,
  opts: { max?: number; force?: boolean },
): Promise<DesignResult> {
  const args = ["design", "tests", "--use-case", useCase, "--mode", "agent"];
  if (opts.max !== undefined) args.push("--max", String(opts.max));
  if (opts.force) args.push("--force");
  return parseDesign(await runKane(args, { cwd, timeoutMs: AI_TIMEOUT_MS }));
}

function parseDesign(r: RunKaneResult): DesignResult {
  const paused = pausedFrom(r.events);
  if (paused) return paused;

  const doneEv = r.events.find((e) => e.type === "done");
  const raw = doneStatus(r);
  const status: "complete" | "refused" | "error" =
    r.exitCode === 0 && raw === "complete" ? "complete" : raw === "refused" ? "refused" : "error";

  const declared = r.events.find((e) => e.type === "variables_summary") ?? r.events.find((e) => e.type === "variables_declared");
  const variables = arr(declared?.variables)
    .filter(isObj)
    .map((v) => ({ name: str(v.name), description: str(v.description), secret: v.secret === true }));

  const failure = status === "complete" ? null : errorFrom(r);
  return {
    status,
    ...(failure ? { message: failure.message, ...(failure.code ? { code: failure.code } : {}) } : {}),
    tests: mintedIds(r.events, "t-"),
    acs: mintedIds(r.events, "ac-"),
    gaps: mintedIds(r.events, "gap-"),
    variables,
    credits: sumCredits(r.events),
    next: arr(doneEv?.next)
      .filter(isObj)
      .map((n) => str(n.cmd))
      .filter((c) => c.length > 0),
  };
}

// ---------------------------------------------------------------- reconcile / balance

export async function reconcile(
  cwd: string,
  file: string,
  sourceId: string,
  mode: "plan" | "apply",
): Promise<ReconcileResult> {
  const args = ["maintain", "reconcile", "--from", file, "--source-id", sourceId, mode === "plan" ? "--plan" : "--apply", "--mode", "agent"];
  return parseReconcile(await runKane(args, { cwd, timeoutMs: AI_TIMEOUT_MS }));
}

function parseReconcile(r: RunKaneResult): ReconcileResult {
  const paused = pausedFrom(r.events);
  if (paused) return paused;
  const status = doneStatus(r);
  if (r.exitCode !== 0 || status !== "complete") {
    throw new Error(`maintain reconcile failed: ${errorFrom(r).message}`);
  }

  const plan = r.events.find((e) => e.type === "reconcile_plan");
  const rows = arr(plan?.rows)
    .filter(isObj)
    .map((x) => ({ kind: str(x.kind) as ReconcileRow["kind"], ref: str(x.ref), why: str(x.why) }));
  const summary: Record<string, number> = {};
  const sum = r.events.find((e) => e.type === "reconcile_summary");
  if (sum) {
    for (const [k, v] of Object.entries(sum)) {
      if (typeof v === "number" && k !== "v") summary[k] = v;
    }
  }
  const planPath = str(plan?.plan_path);
  const result = { status: "complete" as const, rows, summary, credits: sumCredits(r.events) };
  return planPath ? { ...result, planPath } : result;
}

export async function balance(): Promise<number> {
  const r = await runKane(["balance"], { cwd: process.cwd(), timeoutMs: READ_TIMEOUT_MS });
  const m = /Available credits:\s*(-?[\d.]+)/i.exec(r.stdout);
  if (r.exitCode !== 0 || !m) {
    throw new Error(`balance: could not read credits (exit ${r.exitCode}): ${(r.stderr || r.stdout).trim()}`);
  }
  return Number(m[1]);
}

// ---------------------------------------------------------------- cover gaps

export async function coverGaps(cwd: string): Promise<GapNode[]> {
  const r = await runKane(["cover", "gaps", "--json"], { cwd, timeoutMs: READ_TIMEOUT_MS });
  const doc = parseJsonDoc(r.stdout);
  if (r.exitCode !== 0 || !isObj(doc)) {
    throw new Error(`cover gaps failed (exit ${r.exitCode}): ${(r.stderr || r.stdout).trim()}`);
  }
  const gaps: GapNode[] = [];
  for (const uc of arr(doc.usecases).filter(isObj)) {
    for (const p of arr(uc.pending).filter(isObj)) {
      const id = str(p.ref) || str(p.id);
      gaps.push({ id, title: str(p.title), kind: str(p.kind), acs: [str(p.id) || id] });
    }
  }
  return gaps;
}

/** Parse a whole-stdout JSON document, tolerating leading non-JSON notice lines. */
function parseJsonDoc(stdout: string): unknown {
  const lines = stdout.split("\n");
  for (let i = 0; i < lines.length; i++) {
    if ((lines[i] ?? "").trimStart().startsWith("{")) {
      try {
        return JSON.parse(lines.slice(i).join("\n"));
      } catch {
        /* keep scanning */
      }
    }
  }
  return null;
}

// ---------------------------------------------------------------- graph

type ViewNode = { cid: string; slug: string; label: string; trust: string; title: string };

const WORD = /[a-z0-9$.,]+/g;
const words = (s: string): Set<string> => new Set(s.toLowerCase().match(WORD) ?? []);

type Derives = { source: string; anchor: string; quote: string; claim: string };

/**
 * Kane records citations on DERIVES edges (source -> use case) inside the
 * extract commits under `.context/commits/`, not on AC nodes. The format is
 * not a stable contract, so any failure yields an empty map.
 */
function readDerives(cwd: string): Map<string, Derives[]> {
  const byUseCase = new Map<string, Derives[]>();
  try {
    const dir = join(cwd, ".context", "commits");
    for (const name of readdirSync(dir).filter((n) => n.endsWith(".json")).sort()) {
      let commit: unknown;
      try {
        commit = JSON.parse(readFileSync(join(dir, name), "utf8"));
      } catch {
        continue;
      }
      if (!isObj(commit)) continue;
      for (const e of arr(commit.edges).filter(isObj)) {
        if (e.type !== "DERIVES" || !isObj(e.props)) continue;
        const dst = str(e.dst);
        const list = byUseCase.get(dst) ?? [];
        list.push({
          source: str(e.props.source_id),
          anchor: str(e.props.anchor),
          quote: str(e.props.quote),
          claim: str(e.props.claim),
        });
        byUseCase.set(dst, list);
      }
    }
  } catch {
    return new Map();
  }
  return byUseCase;
}

function rankCites(candidates: Derives[], acText: string): AcNode["cites"] {
  const target = words(acText);
  const scored = candidates
    .map((c, i) => {
      const w = words(`${c.claim} ${c.quote}`);
      let overlap = 0;
      for (const t of w) if (target.has(t)) overlap++;
      return { c, i, overlap };
    })
    .sort((a, b) => b.overlap - a.overlap || a.i - b.i);
  return scored.slice(0, 2).map(({ c }) => ({ source: c.source, anchor: c.anchor, quote: c.quote }));
}

type TestFile = { file: string; verifies: string[] };

/** Map assurance test id -> file + @verifies tags by scanning `.testmuai/tests`. */
function readTestFiles(cwd: string): Map<string, TestFile> {
  const out = new Map<string, TestFile>();
  try {
    const dir = join(cwd, ".testmuai", "tests");
    for (const name of readdirSync(dir).filter((n) => n.endsWith("_test.md"))) {
      const file = join(dir, name);
      const parsed = parseTestMd(readFileSync(file, "utf8"));
      const id = parsed.id;
      if (!id) continue;
      const verifies: string[] = [];
      for (const st of parsed.steps) for (const ac of st.verifies) if (!verifies.includes(ac)) verifies.push(ac);
      out.set(id, { file, verifies });
    }
  } catch {
    /* no tests folder yet */
  }
  return out;
}

export async function readGraph(cwd: string): Promise<Graph> {
  const r = await runKane(["context", "view", "--json"], { cwd, timeoutMs: READ_TIMEOUT_MS });
  const view = parseJsonDoc(r.stdout);
  if (r.exitCode !== 0 || !isObj(view)) {
    throw new Error(`context view failed (exit ${r.exitCode}): ${(r.stderr || r.stdout).trim()}`);
  }

  const nodes: ViewNode[] = arr(view.nodes)
    .filter(isObj)
    .filter((n) => n.superseded !== true)
    .map((n) => ({ cid: str(n.cid), slug: str(n.slug), label: str(n.label), trust: str(n.trust), title: str(n.title) }));
  const byCid = new Map(nodes.map((n) => [n.cid, n]));
  const edges = arr(view.edges).filter(isObj);

  const derives = readDerives(cwd);
  const testFiles = readTestFiles(cwd);

  // ac cid -> use case node (scoped_to edges)
  const ucOfAc = new Map<string, ViewNode>();
  // test cid -> verified ac slugs (fallback when the test file is unreadable)
  const verifiesByTest = new Map<string, string[]>();
  for (const e of edges) {
    const src = byCid.get(str(e.src));
    const dst = byCid.get(str(e.dst));
    if (!src || !dst) continue;
    if (e.type === "scoped_to" && src.label === "ac" && dst.label === "usecase") ucOfAc.set(src.cid, dst);
    if (e.type === "verifies" && src.label === "test" && dst.label === "ac") {
      const list = verifiesByTest.get(src.cid) ?? [];
      if (!list.includes(dst.slug)) list.push(dst.slug);
      verifiesByTest.set(src.cid, list);
    }
  }

  return {
    useCases: nodes.filter((n) => n.label === "usecase").map((n) => ({ id: n.slug, title: n.title, trust: n.trust })),
    acs: nodes
      .filter((n) => n.label === "ac")
      .map((n) => {
        const uc = ucOfAc.get(n.cid);
        return {
          id: n.slug,
          text: n.title,
          useCase: uc?.slug ?? "",
          cites: uc ? rankCites(derives.get(uc.cid) ?? [], n.title) : [],
          trust: n.trust,
        };
      }),
    tests: nodes
      .filter((n) => n.label === "test")
      .map((n) => {
        const tf = testFiles.get(n.slug);
        return {
          id: n.slug,
          title: n.title,
          file: tf?.file ?? "",
          verifies: tf && tf.verifies.length > 0 ? tf.verifies : (verifiesByTest.get(n.cid) ?? []),
        };
      }),
    // Kane 0.10.4 renders gap titles as "[object Object]"; fall back to the id.
    gaps: nodes
      .filter((n) => n.label === "gap")
      .map((n) => ({
        id: n.slug,
        title: n.title && !n.title.includes("[object Object]") ? n.title : n.slug,
        kind: "gap",
        acs: [],
      })),
  };
}
