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
  /** Kane credits the call that paused consumed (it is billed whether or not the session goes on). */
  credits: number;
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
/**
 * A gap Kane left in a design: what it did not cover, and why (`kind`: "budget-evicted" when the
 * design cap left it out, "incomplete" when the sources lack what a test needs, ...), with the
 * question Kane would ask about it. `useCase`: the use case it is about, when Kane's store says.
 */
export type GapNode = {
  id: string;
  title: string;
  kind: string;
  acs: string[];
  useCase?: string;
  question?: { header: string; prompt: string; options: { label: string; detail?: string }[] };
};
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
    credits: sumCredits(events),
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

/** One source Kane registered, from its `ingested` event (`PRD.md` is `prd`). */
export type IngestedSource = { id: string; cid: string; status: string };

export async function ingest(cwd: string, sources: string[]): Promise<IngestResult & { sources: IngestedSource[] }> {
  const r = await runKane(["context", "ingest", ...sources, "--mode", "agent"], { cwd, timeoutMs: AI_TIMEOUT_MS });
  const ingested = r.events
    .filter((e) => e.type === "ingested" && str(e.source_id) !== "")
    .map((e) => ({ id: str(e.source_id), cid: str(e.cid), status: str(e.status) }));
  return { ...ingestOutcome(r), sources: ingested };
}

export async function extractResume(cwd: string, sid: string, answers: Record<string, string>): Promise<IngestResult> {
  const paused: Paused = {
    status: "paused",
    verb: "extract",
    sid,
    resume: `kane-cli context extract --resume ${sid} --mode agent`,
    questions: [],
    credits: 0,
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
  // a human's answer goes on one line, as it does into the Clarifications: a line break never reaches a command line
  for (const [id, value] of Object.entries(answers)) args.push("--answer", `${id}=${String(value).replace(/\s+/g, " ").trim()}`);
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

// ---------------------------------------------------------------- maintain evolve (R40)

/** A scenario and the test that runs it, as `evolve_diff` pairs them. */
export type EvolvePair = { scenario: string; test: string };

/**
 * What `kane-cli maintain evolve` did. `complete`: Kane re-designed the use case and minted at
 * least one new test (`done` complete, exit 0, a non-empty `evolve_diff.minted`, a `commit` with a
 * test). Its new set replaces the use case's old one: `superseded` pairs are retired, whatever the
 * reason said (live, 2026-11-15). `nothing`: it ran but minted no test. `paused`: it stopped on
 * questions of Kane's own (`questions`) that Holdback does not answer on its own: on the evolve itself
 * (`evolve_paused`, other than the re-design gate) or in the design session it started
 * (`session_paused`, the evolve `done` paused). Nothing was minted. `error`: it failed.
 */
export type EvolveResult =
  | {
      status: "complete";
      minted: EvolvePair[];
      superseded: EvolvePair[];
      retained: EvolvePair[];
      /** Per criterion, the tests that verified it before and after (Kane's own map). */
      moves: { ac: string; before: string[]; after: string[] }[];
      testsCommitted: number;
      credits: number;
    }
  | { status: "nothing"; note: string; credits: number }
  | { status: "paused"; questions: PendingQuestion[]; credits: number }
  | { status: "error"; message: string; code?: string; credits: number };

const questionsOf = (e: KaneEvent | undefined): PendingQuestion[] =>
  arr(e?.pending_questions)
    .map(pendingQuestion)
    .filter((q): q is PendingQuestion => q !== null && q.text !== "");

/**
 * The questions an evolve run stopped on, when it ended paused on some (its `done` paused, or an
 * `evolve_paused`): the evolve's own, but `gate` (the re-design question Holdback answers itself),
 * else its design session's (`session_paused`). Undefined when it did not pause on a question.
 */
function pausedOn(r: RunKaneResult, gate: string): PendingQuestion[] | undefined {
  const own = r.events.find((e) => e.type === "evolve_paused");
  if (!own && doneStatus(r) !== "paused") return undefined;
  const qs = [...questionsOf(own).filter((q) => q.id !== gate), ...questionsOf(r.events.find((e) => e.type === "session_paused"))];
  return qs.length > 0 ? qs : undefined;
}

const pairs = (v: unknown): EvolvePair[] =>
  arr(v)
    .filter(isObj)
    .map((x) => ({ scenario: str(x.scenario), test: str(x.test) }));

function evolveOutcome(r: RunKaneResult, credits: number): EvolveResult {
  const nothing = r.events.find((e) => e.type === "nothing_to_change");
  if (r.exitCode !== 0 || doneStatus(r) !== "complete") {
    if (nothing && r.exitCode === 0) return { status: "nothing", note: str(nothing.note), credits };
    return { ...errorFrom(r), credits };
  }
  if (nothing) return { status: "nothing", note: str(nothing.note) || "Kane found nothing to change", credits };
  const diff = r.events.find((e) => e.type === "evolve_diff");
  const testsCommitted = r.events.filter((e) => e.type === "commit").reduce((n, e) => n + (typeof e.tests === "number" ? e.tests : 0), 0);
  const minted = pairs(diff?.minted).filter((m) => m.test !== "");
  if (!diff) return { status: "nothing", note: "Kane reported no evolve_diff", credits };
  if (minted.length === 0 || testsCommitted < 1) return { status: "nothing", note: "Kane minted no new test", credits };
  const moves = arr(diff.moves)
    .filter(isObj)
    .map((m) => ({ ac: str(m.ac), before: arr(m.before).map(str), after: arr(m.after).map(str) }));
  return { status: "complete", minted, superseded: pairs(diff.superseded), retained: pairs(diff.retained), moves, testsCommitted, credits };
}

/**
 * `kane-cli maintain evolve <useCase> --because <because> --mode agent`, run in the verifier. Kane
 * pauses on its own re-design gate (`evolve_paused`, question `evolve:<useCase>`, exit 3); Holdback
 * answers it with the same argv plus `--answer evolve:<useCase>=<proceed>`. Any other question, on
 * the evolve or in the design session it starts, is never answered: the result is `paused`, with
 * Kane's questions (live, 2026-11-18: it asked whether the reason it was given contradicts the spec).
 * The credits are both calls' `usage`.
 */
export async function evolve(cwd: string, useCase: string, because: string): Promise<EvolveResult> {
  const args = ["maintain", "evolve", useCase, "--because", because, "--mode", "agent"];
  const gate = `evolve:${useCase}`;
  const first = await runKane(args, { cwd, timeoutMs: AI_TIMEOUT_MS });
  let credits = sumCredits(first.events);
  const asked = pausedOn(first, gate);
  if (asked) return { status: "paused", questions: asked, credits };
  const paused = first.events.find((e) => e.type === "evolve_paused");
  if (!paused) return evolveOutcome(first, credits);
  const qs = questionsOf(paused);
  if (qs.length !== 1 || qs[0]!.id !== gate) return { status: "error", message: "Kane paused the evolve without a question", credits };
  const proceed = qs[0]!.options.findIndex((o) => o.label === "proceed");
  const second = await runKane([...args, "--answer", `${gate}=${proceed >= 0 ? proceed + 1 : 1}`], { cwd, timeoutMs: AI_TIMEOUT_MS });
  credits = Math.round((credits + sumCredits(second.events)) * 1e4) / 1e4;
  const again = pausedOn(second, gate);
  if (again) return { status: "paused", questions: again, credits };
  if (second.events.some((e) => e.type === "evolve_paused")) return { status: "error", message: "Kane paused the evolve again after Holdback answered its re-design question", credits };
  return evolveOutcome(second, credits);
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

// ---------------------------------------------------------------- list

export type ListedNode = { id: string; label: string; title: string; trust: string };

/** `kane-cli context list --json`: one JSON object per stdout line. */
export async function listNodes(cwd: string): Promise<ListedNode[]> {
  const r = await runKane(["context", "list", "--json"], { cwd, timeoutMs: READ_TIMEOUT_MS });
  if (r.exitCode !== 0) {
    throw new Error(`context list failed (exit ${r.exitCode}): ${(r.stderr || r.stdout).trim()}`);
  }
  const out: ListedNode[] = [];
  for (const line of r.stdout.split("\n")) {
    const t = line.trim();
    if (!t.startsWith("{")) continue;
    let o: unknown;
    try {
      o = JSON.parse(t);
    } catch {
      continue;
    }
    if (!isObj(o)) continue;
    const id = str(o.id) || str(o.slug) || str(o.logical_id);
    if (!id) continue;
    out.push({ id, label: str(o.label) || str(o.kind), title: str(o.title), trust: str(o.trust) });
  }
  return out;
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

/**
 * Map assurance test id -> file + @verifies tags by scanning `.testmuai/tests`. Two files that claim
 * one id are refused (M5): a stale file must never shadow a re-designed one, whichever is read last.
 */
function readTestFiles(cwd: string): Map<string, TestFile> {
  const out = new Map<string, TestFile>();
  const dir = join(cwd, ".testmuai", "tests");
  let names: string[];
  try {
    names = readdirSync(dir).filter((n) => n.endsWith("_test.md")).sort();
  } catch {
    return out; // no tests folder yet
  }
  for (const name of names) {
    const file = join(dir, name);
    let parsed: ReturnType<typeof parseTestMd>;
    try {
      parsed = parseTestMd(readFileSync(file, "utf8"));
    } catch {
      continue; // unreadable: Kane reports it when it runs
    }
    const id = parsed.id;
    if (!id) continue;
    const seen = out.get(id);
    if (seen) throw new Error(`two test files claim ${id}: ${seen.file.split(/[\\/]/).pop()} and ${name}; remove the stale one from ${dir}, then run the stage again`);
    const verifies: string[] = [];
    for (const st of parsed.steps) for (const ac of st.verifies) if (!verifies.includes(ac)) verifies.push(ac);
    out.set(id, { file, verifies });
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
  let commitGaps: Map<string, unknown> | undefined;
  const commitNodes = () => (commitGaps ??= readCommitGaps(cwd));

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
    // Kane 0.10.4 renders gap titles as "[object Object]": the gap's own content (kind, question)
    // is read from Kane's store; a gap with none falls back to its id
    gaps: nodes
      .filter((n) => n.label === "gap")
      .map((n) => {
        const c = gapContent(cwd, n.cid, commitNodes);
        const question = c?.question;
        const uc = c?.uc ? byCid.get(c.uc) : undefined;
        return {
          id: n.slug,
          title: n.title && !n.title.includes("[object Object]") ? n.title : question?.header || n.slug,
          kind: c?.kind || "gap",
          acs: [],
          ...(uc?.label === "usecase" ? { useCase: uc.slug } : {}),
          ...(question ? { question } : {}),
        };
      }),
  };
}

/** The gaps of a graph that are about use case `uc`, and those Kane's store does not tie to one. */
export const gapsOf = (g: Pick<Graph, "gaps">, uc: string): GapNode[] => g.gaps.filter((x) => x.useCase === undefined || x.useCase === uc);

type GapContent = { kind: string; uc: string; question?: NonNullable<GapNode["question"]> };

/** A gap node's content as Kane stores it: `{ kind, uc, question: { header, prompt, options } }`. */
function gapFrom(content: unknown): GapContent | null {
  if (!isObj(content)) return null;
  const q = isObj(content.question) ? content.question : null;
  const options = arr(q?.options)
    .map((o) => (typeof o === "string" ? { label: o } : isObj(o) ? (typeof o.detail === "string" ? { label: str(o.label), detail: o.detail } : { label: str(o.label) }) : null))
    .filter((o): o is { label: string; detail?: string } => o !== null && o.label !== "");
  const question = q && (str(q.header) || str(q.prompt)) ? { header: str(q.header), prompt: str(q.prompt), options } : undefined;
  return { kind: str(content.kind), uc: str(content.uc), ...(question ? { question } : {}) };
}

/** Every gap node's content in Kane's commits under `.context/commits/`, by cid; empty when there are none. */
function readCommitGaps(cwd: string): Map<string, unknown> {
  const out = new Map<string, unknown>();
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
      for (const n of arr(commit.nodes).filter(isObj)) if (n.label === "gap" && str(n.cid)) out.set(str(n.cid), n.content);
    }
  } catch {
    return out;
  }
  return out;
}

/**
 * A gap's content: its derived node file (`.context/derived/nodes/<2>/<rest>.json`, by its cid's
 * hex), else the commit that minted it. Kane's store is not a stable contract: anything unreadable
 * is no content.
 */
function gapContent(cwd: string, cid: string, commits: () => Map<string, unknown>): GapContent | null {
  const hex = cid.replace(/^sha256:/, "");
  if (/^[0-9a-f]{3,}$/i.test(hex)) {
    try {
      const node: unknown = JSON.parse(readFileSync(join(cwd, ".context", "derived", "nodes", hex.slice(0, 2), `${hex.slice(2)}.json`), "utf8"));
      if (isObj(node) && node.label === "gap") return gapFrom(node.content);
    } catch {
      /* not there: the commits */
    }
  }
  return gapFrom(commits().get(cid));
}
