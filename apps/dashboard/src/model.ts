import { eventCredits, gate as coreGate, notAnAppFailure, reduce, retiredTests, verdict as coreVerdict } from "@holdback/core/browser";
import type { AcState, AcStatus, LedgerEvent, LedgerState, PendingPrompt, TestRunResult, Verdict } from "@holdback/core/browser";

/* ------------------------------------------------------------------ the wire: GET /api/state */

export type GateInfo = {
  open: boolean;
  allowStop: boolean;
  tampered: boolean;
  owed: string[];
  regressed: string[];
  vacuous: string[];
  needsSpec: string[];
  /** Criteria a human turned down when approving the design (older servers leave it out). */
  rejected?: string[];
  inconclusive: LedgerState["inconclusive"];
};

/** `configSummary` in core's server.ts: what the dashboard may show of holdback.config.json. */
export type ConfigSummary = {
  spec: string[];
  start: { port: number; readyPath: string };
  agent: { model: string | null };
  kane: { parallel: number; timeoutS: number; designMax: number };
  breaker: { model: string; capUsd: number; parallel?: number };
  loop: { maxTurns: number };
};

export type ApiState = {
  state: LedgerState;
  gate: GateInfo;
  config: ConfigSummary | null;
  counts: { events: number; acs: number; byStatus: Record<string, number> };
  credits: { kane: number; unmeasured: number };
  breakerUsd: number;
  tamper: { detail: string; marker: string | null; changed: string[] } | null;
  specChanged: string[];
  pending: PendingPrompt[];
  /** The one verdict (R44): what `holdback run` exits with and `status` prints (older servers leave it out). */
  verdict?: Verdict;
};

/**
 * `/api/state` built in the browser from the ledger alone, exactly as core's server maps
 * snapshot() to JSON. Replay has no disk to hold the seal against: a tamper shows only when the
 * ledger records one, and nothing is pending.
 */
export function stateFromLedger(events: LedgerEvent[], config: ConfigSummary | null): ApiState {
  const state = reduce(events);
  const g = coreGate(state);
  const acs = Object.values(state.acs);
  const byStatus: Record<string, number> = {};
  for (const a of acs) byStatus[a.status] = (byStatus[a.status] ?? 0) + 1;
  const lastTamper = events.findLast((e) => e.t === "tamper");
  return {
    state,
    gate: {
      open: g.allowStop && acs.length > 0,
      allowStop: g.allowStop,
      tampered: g.tampered,
      owed: g.owed.map((a) => a.id),
      regressed: g.regressed.map((a) => a.id),
      vacuous: g.vacuous.map((a) => a.id),
      needsSpec: g.needsSpec.map((a) => a.id),
      rejected: g.rejected.map((a) => a.id),
      inconclusive: g.inconclusive,
    },
    config,
    counts: { events: events.length, acs: acs.length, byStatus },
    credits: { kane: state.kaneCredits, unmeasured: state.kaneUnmeasured },
    breakerUsd: state.breakerUsd,
    tamper: state.tampered ? { detail: lastTamper?.t === "tamper" ? lastTamper.detail : "the ledger records a tamper", marker: null, changed: [] } : null,
    specChanged: [],
    pending: [],
    verdict: coreVerdict(state),
  };
}

/* ------------------------------------------------------------------ helpers */

type RunEvent = Extract<LedgerEvent, { t: "run" }>;
type MutantEvent = Extract<LedgerEvent, { t: "mutant" }>;

const isRun = (e: LedgerEvent): e is RunEvent & { at: string } => e.t === "run";

/** ac-2 before ac-10. */
export const byId = (a: string, b: string) => a.localeCompare(b, undefined, { numeric: true });

/** `prd L10-L10` reads as `prd L10`. */
export function anchorLabel(anchor: string): string {
  const m = /^L(\d+)-L?(\d+)$/i.exec(anchor.trim());
  return m && m[1] === m[2] ? `L${m[1]}` : anchor;
}

/** The first line a patch removes and the first it adds, trimmed: the breaker's bug in one line. */
export function patchOneLiner(patch: string): { file?: string; removed?: string; added?: string } {
  let file: string | undefined;
  let removed: string | undefined;
  let added: string | undefined;
  for (const line of patch.split("\n")) {
    if (line.startsWith("+++ ")) file = line.slice(4).replace(/^b\//, "").trim();
    else if (line.startsWith("---")) continue;
    else if (line.startsWith("-") && removed === undefined) removed = line.slice(1).trim();
    else if (line.startsWith("+") && added === undefined) added = line.slice(1).trim();
  }
  return { file, removed, added };
}

/* ------------------------------------------------------------------ the board */

export type Observation = {
  kind: "build" | "falsify";
  at?: string;
  turn?: number;
  mutantId?: string;
  test: string;
  status: TestRunResult["status"] | "unknown";
  /** Why the run proved nothing, when it did not. */
  inconclusive?: string;
  step?: number;
  stepText?: string;
  /** The page text Kane saw at the failing step (its verdict's `observed`). */
  observed?: string;
  /** Kane's one-line account of the failure, or the reason the run ended. */
  note?: string;
  title?: string;
  screenshot?: string;
  healed: boolean;
  /** The second replay of a test that killed the mutant (R44): the kill counts only when it fails again. */
  again?: true;
};

export type MutantView = {
  id: string;
  ac: string;
  verdict: MutantEvent["verdict"];
  model: string;
  usd: number;
  note?: string;
  file?: string;
  removed?: string;
  added?: string;
  /** The replay that caught it (or let it through). */
  run?: Observation;
};

export type TestMark = "pass" | "fail" | "inconclusive" | "none";

export type Card = {
  ac: AcState;
  quote?: { text: string; source: string; anchor: string };
  observation?: Observation;
  mutant?: MutantView;
  tests: { id: string; title?: string; mark: TestMark; turn?: number }[];
  regressed: boolean;
  inconclusive: LedgerState["inconclusive"];
};

export type ColumnKey = "owed" | "passing" | "proved" | "vacuous" | "needs-spec" | "rejected";
export const COLUMNS: { key: ColumnKey; label: string; note: string }[] = [
  { key: "owed", label: "Owed", note: "Kane has not passed it yet, or it broke again" },
  { key: "passing", label: "Passing", note: "Kane passed every test that verifies it" },
  { key: "proved", label: "Proved", note: "Passing, and Kane caught a planted bug" },
  { key: "vacuous", label: "Vacuous", note: "A planted bug got past its tests" },
  { key: "needs-spec", label: "Needs spec", note: "No test verifies it: Kane's design cap left it out, or the spec gives Kane nothing to test" },
  { key: "rejected", label: "Rejected", note: "You turned it down when approving the design: never owed" },
];

export const columnOf = (s: AcStatus): ColumnKey => (s === "regressed" ? "owed" : s);

function observe(e: RunEvent, at?: string): Observation {
  const r = e.result;
  const why = notAnAppFailure(r);
  const v = r.verdict;
  return {
    kind: e.kind === "falsify" ? "falsify" : "build",
    ...(at ? { at } : {}),
    ...(e.turn !== undefined ? { turn: e.turn } : {}),
    ...(e.mutantId ? { mutantId: e.mutantId } : {}),
    test: r.testId ?? r.testFile,
    status: r.status,
    ...(why !== undefined ? { inconclusive: why } : {}),
    ...(r.failedStep !== undefined && r.status !== "passed" ? { step: r.failedStep } : {}),
    ...(r.failedStepText && r.status !== "passed" ? { stepText: r.failedStepText } : {}),
    ...(r.status !== "passed" && v?.observed ? { observed: v.observed } : {}),
    ...(r.status !== "passed" && (v?.oneLiner || r.reason) ? { note: v?.oneLiner ?? r.reason } : {}),
    ...(v?.bugTitle && r.status !== "passed" ? { title: v.bugTitle } : {}),
    ...(r.screenshot ? { screenshot: r.screenshot } : {}),
    healed: r.healTriggered,
    ...(e.confirm ? { again: true as const } : {}),
  };
}

type Marks = { byAc: Map<string, Map<string, { mark: TestMark; turn?: number }>>; unsure: Map<string, { turn?: number }> };

/**
 * Per criterion, per test: the latest conclusive build verdict on that criterion, and per test
 * whether its latest build run proved nothing, as the reducer reads them.
 */
function testMarks(events: LedgerEvent[]): Marks {
  const out = new Map<string, Map<string, { mark: TestMark; turn?: number }>>();
  const unsure = new Map<string, { turn?: number }>();
  const verifies = new Map<string, Set<string>>(); // test -> acs
  let tampered = false;
  const set = (ac: string, test: string, mark: TestMark, run: RunEvent) => {
    let m = out.get(ac);
    if (!m) out.set(ac, (m = new Map()));
    m.set(test, { mark, ...(run.turn !== undefined ? { turn: run.turn } : {}) });
  };
  for (const e of events) {
    if (e.t === "tamper") tampered = true;
    else if (e.t === "seal") {
      if (tampered) {
        out.clear();
        unsure.clear();
      }
      tampered = false;
    } else if (e.t === "design") {
      for (const ac of e.acs) out.delete(ac.id);
      for (const t of e.tests) {
        verifies.set(t.id, new Set(t.verifies));
        unsure.delete(t.id);
      }
    } else if (e.t === "run" && e.kind === "build" && e.result.testId != null) {
      const r = e.result;
      const test = r.testId!;
      const acs = verifies.get(test) ?? new Set<string>();
      if (notAnAppFailure(r) !== undefined) {
        unsure.set(test, e.turn !== undefined ? { turn: e.turn } : {});
        continue;
      }
      unsure.delete(test);
      if (r.criteriaPassed.length === 0 && r.criteriaFailed.length === 0) {
        for (const ac of acs) set(ac, test, r.status === "passed" ? "pass" : "fail", e);
      } else {
        for (const ac of r.criteriaPassed) if (acs.has(ac)) set(ac, test, "pass", e);
        for (const ac of r.criteriaFailed) if (acs.has(ac)) set(ac, test, "fail", e);
      }
    }
  }
  return { byAc: out, unsure };
}

/** The criteria as cards, by board column. */
export function board(api: ApiState, events: LedgerEvent[]): Record<ColumnKey, Card[]> {
  const titles = new Map<string, string>();
  for (const e of events) if (e.t === "design") for (const t of e.tests) titles.set(t.id, t.title);
  const marks = testMarks(events);
  const runs = events.filter(isRun);
  const mutants = events.filter((e): e is MutantEvent & { at: string } => e.t === "mutant");
  const inconclusiveByTest = new Map(api.gate.inconclusive.map((u) => [u.test, u]));

  const cols: Record<ColumnKey, Card[]> = { owed: [], passing: [], proved: [], vacuous: [], "needs-spec": [], rejected: [] };
  for (const ac of Object.values(api.state.acs)) {
    // Kane lists the cite it leans on first
    const best = ac.cites[0];
    const m = marks.byAc.get(ac.id);
    const tests = ac.tests.map((id) => {
      const u = marks.unsure.get(id);
      const got = u ? { mark: "inconclusive" as TestMark, ...u } : m?.get(id);
      return { id, ...(titles.has(id) ? { title: titles.get(id)! } : {}), mark: got?.mark ?? ("none" as TestMark), ...(got?.turn !== undefined ? { turn: got.turn } : {}) };
    });

    const mut = mutants.findLast((x) => x.ac === ac.id);
    let mutant: MutantView | undefined;
    if (mut) {
      const run = runs.findLast((r) => r.kind === "falsify" && r.mutantId === mut.id);
      mutant = {
        id: mut.id,
        ac: mut.ac,
        verdict: mut.verdict,
        model: mut.model,
        usd: mut.usd,
        ...(mut.note ? { note: mut.note } : {}),
        ...patchOneLiner(mut.patch),
        ...(run ? { run: observe(run, run.at) } : {}),
      };
    }

    let observation: Observation | undefined;
    const lf = ac.lastFailure;
    if ((ac.status === "owed" || ac.status === "regressed") && lf) {
      const run = runs.findLast((r) => r.kind === "build" && r.result.testId === lf.test && (lf.turn === undefined || r.turn === lf.turn));
      observation = run
        ? observe(run, run.at)
        : {
            kind: "build",
            test: lf.test,
            status: "failed",
            ...(lf.turn !== undefined ? { turn: lf.turn } : {}),
            ...(lf.step !== undefined ? { step: lf.step } : {}),
            ...(lf.stepText ? { stepText: lf.stepText } : {}),
            ...(lf.verdict?.observed ? { observed: lf.verdict.observed } : {}),
            ...(lf.verdict?.oneLiner || lf.reason ? { note: lf.verdict?.oneLiner ?? lf.reason } : {}),
            ...(lf.verdict?.bugTitle ? { title: lf.verdict.bugTitle } : {}),
            ...(lf.screenshot ? { screenshot: lf.screenshot } : {}),
            healed: false,
          };
    } else if ((ac.status === "proved" || ac.status === "vacuous") && mutant?.run) {
      observation = mutant.run;
    } else {
      // the latest build run of a test that has not (yet) passed this criterion, else the latest of any of its tests
      const open = new Set(tests.filter((t) => t.mark !== "pass").map((t) => t.id));
      const mine = runs.filter((r) => r.kind === "build" && r.result.testId != null && ac.tests.includes(r.result.testId));
      const run = mine.findLast((r) => open.has(r.result.testId!)) ?? mine.at(-1);
      if (run) observation = observe(run, run.at);
    }

    cols[columnOf(ac.status)].push({
      ac,
      ...(best ? { quote: { text: best.quote, source: best.source, anchor: best.anchor } } : {}),
      ...(observation ? { observation } : {}),
      ...(mutant ? { mutant } : {}),
      tests,
      regressed: ac.status === "regressed",
      inconclusive: ac.tests.flatMap((t) => (inconclusiveByTest.has(t) ? [inconclusiveByTest.get(t)!] : [])),
    });
  }
  for (const k of Object.keys(cols) as ColumnKey[]) {
    cols[k].sort((a, b) => Number(b.regressed) - Number(a.regressed) || byId(a.ac.id, b.ac.id));
  }
  return cols;
}

/* ------------------------------------------------------------------ the loop timeline */

export type Item =
  | { kind: "spec"; at: string; title: string; detail?: string; credits?: number }
  | {
      kind: "agent";
      at: string;
      turn: number;
      owedIn: number;
      done: boolean;
      commit?: string;
      files?: string[];
      durationMs?: number;
      exit?: number;
      appUp?: boolean;
      usd?: number;
    }
  | { kind: "run"; at: string; run: Observation; title?: string; credits: number; durationS: number; retried?: string }
  | { kind: "mutant"; at: string; mutant: MutantView }
  | { kind: "regression"; at: string; ac: string; turn: number; blamedTurn?: number; blamedCommit?: string; detail?: string }
  | { kind: "tamper"; at: string; detail: string }
  | { kind: "seal"; at: string; files: number; reseal: boolean }
  | { kind: "drift"; at: string; rows: number; applied: boolean; credits?: number }
  | { kind: "meter"; at: string; source: string; delta: number | null; perRunSum: number; error?: string }
  | { kind: "dropped"; at: string; useCases: string[]; detail: string; credits: number }
  /** R40: a planted bug got past every test of `uc`, and Kane evolved it: what it was told, what it minted and retired. */
  | { kind: "evolved"; at: string; uc: string; because: string; minted: string[]; retired: string[]; credits: number; followUp: boolean };

export type Segment = {
  key: string;
  label: string;
  turn?: number;
  items: Item[];
  credits: number;
  kaneS: number;
  from: string;
  to: string;
};

const plural = (n: number, one: string, many = one + "s") => `${n} ${n === 1 ? one : many}`;

/** The ledger as the loop ran it: the spec stage, then one segment per agent turn and the checks after it. */
export function timeline(events: LedgerEvent[]): Segment[] {
  const titles = new Map<string, string>();
  const segs: Segment[] = [];
  let cur: Segment | undefined;
  let tampered = false;
  const open = (key: string, label: string, at: string, turn?: number) => {
    cur = { key, label, ...(turn !== undefined ? { turn } : {}), items: [], credits: 0, kaneS: 0, from: at, to: at };
    segs.push(cur);
    return cur;
  };
  for (const e of events) {
    const seg = cur ?? open("spec", "Spec", e.at);
    if (e.t === "turn.start") {
      const s = open(`turn-${e.n}`, `Turn ${e.n}`, e.at, e.n);
      s.items.push({ kind: "agent", at: e.at, turn: e.n, owedIn: e.owed.length, done: false });
      continue;
    }
    seg.to = e.at;
    seg.credits += eventCredits(e);
    switch (e.t) {
      case "spec.ingested":
        seg.items.push({
          kind: "spec",
          at: e.at,
          title: `Kane read ${e.sources.map((s) => s.file ?? s.id).join(", ")}`,
          detail: e.sources.map((s) => `${s.id} ${s.status ?? ""}`.trim()).join(" · "),
          ...(e.credits !== undefined ? { credits: e.credits } : {}),
        });
        break;
      case "spec.paused":
        seg.items.push({ kind: "spec", at: e.at, title: `Kane asked ${plural(e.questions.length, "question")}`, detail: e.questions.map((q) => q.text).join(" / "), ...(e.credits !== undefined ? { credits: e.credits } : {}) });
        break;
      case "spec.answered": {
        const a = Object.entries(e.answers);
        seg.items.push({ kind: "spec", at: e.at, title: `A human answered ${plural(a.length, "question")}`, detail: a.map(([k, v]) => `${k}: ${v}`).join(" · "), ...(e.credits !== undefined ? { credits: e.credits } : {}) });
        break;
      }
      case "spec.approved": {
        const rej = e.rejected ?? [];
        seg.items.push({ kind: "spec", at: e.at, title: `A human approved ${plural(e.refs.length, "item")}${rej.length ? `, rejected ${rej.length}` : ""}`, detail: e.refs.join(" ") });
        break;
      }
      case "design":
        for (const t of e.tests) titles.set(t.id, t.title);
        seg.items.push({
          kind: "spec",
          at: e.at,
          title: `Kane designed ${e.useCase}: ${plural(e.acs.length, "criterion", "criteria")}, ${plural(e.tests.length, "test")}`,
          detail: e.tests.map((t) => `${t.id} ${t.title}`).join(" · "),
          credits: e.credits,
        });
        break;
      case "seal":
        seg.items.push({ kind: "seal", at: e.at, files: Object.keys(e.manifest).length, reseal: tampered });
        tampered = false;
        break;
      case "turn.end": {
        const a = [...seg.items].reverse().find((i): i is Extract<Item, { kind: "agent" }> => i.kind === "agent" && i.turn === e.n);
        const done = {
          done: true,
          commit: e.commit,
          files: e.filesChanged,
          durationMs: e.durationMs,
          exit: e.agentExit,
          appUp: e.appUp,
          ...(e.agentUsd !== undefined ? { usd: e.agentUsd } : {}),
        };
        if (a) Object.assign(a, done);
        else seg.items.push({ kind: "agent", at: e.at, turn: e.n, owedIn: 0, ...done });
        break;
      }
      case "run": {
        const r = e.result;
        seg.kaneS += r.durationS;
        const id = r.testId ?? r.testFile;
        seg.items.push({
          kind: "run",
          at: e.at,
          run: observe(e, e.at),
          ...(titles.has(id) ? { title: titles.get(id)! } : {}),
          credits: r.credits,
          durationS: r.durationS,
          ...(r.retried ? { retried: r.retried } : {}),
        });
        break;
      }
      case "mutant": {
        seg.items.push({
          kind: "mutant",
          at: e.at,
          mutant: { id: e.id, ac: e.ac, verdict: e.verdict, model: e.model, usd: e.usd, ...(e.note ? { note: e.note } : {}), ...patchOneLiner(e.patch) },
        });
        break;
      }
      case "regression":
        seg.items.push({
          kind: "regression",
          at: e.at,
          ac: e.ac,
          turn: e.turn,
          ...(e.blamedTurn !== undefined ? { blamedTurn: e.blamedTurn } : {}),
          ...(e.blamedCommit ? { blamedCommit: e.blamedCommit } : {}),
          ...(e.detail ? { detail: e.detail } : {}),
        });
        break;
      case "tamper":
      case "falsify.evolve.stray":
        tampered = true;
        seg.items.push({ kind: "tamper", at: e.at, detail: e.detail });
        break;
      case "drift":
        seg.items.push({ kind: "drift", at: e.at, rows: e.rows.length, applied: e.applied, ...(e.credits !== undefined ? { credits: e.credits } : {}) });
        break;
      case "spec.changed":
        seg.items.push({ kind: "spec", at: e.at, title: e.duringAgentTurn ? "The spec changed after an agent turn: origin unverified" : "The spec changed", detail: e.files.join(", ") });
        break;
      case "credits":
        seg.items.push({ kind: "meter", at: e.at, source: e.source, delta: e.delta, perRunSum: e.perRunSum, ...(e.error ? { error: e.error } : {}) });
        break;
      case "redesign.dropped":
        seg.items.push({ kind: "dropped", at: e.at, useCases: e.useCases, detail: e.detail, credits: e.credits });
        break;
      case "falsify.evolved":
        seg.items.push({ kind: "evolved", at: e.at, uc: e.uc, because: e.because, minted: e.minted, retired: e.retired, credits: e.credits, followUp: e.followUp === true });
        break;
      default:
        break; // recordings: Holdback's own baseline, nothing to show
    }
  }
  for (const s of segs) s.credits = Math.round(s.credits * 1e4) / 1e4;
  return segs;
}

/* ------------------------------------------------------------------ drift */

export type DriftRow = { at: string; kind: string; ref: string; why: string; applied: boolean };

export function driftRows(events: LedgerEvent[]): DriftRow[] {
  return events.flatMap((e) => (e.t === "drift" ? e.rows.map((r) => ({ at: e.at, kind: r.kind, ref: r.ref, why: r.why, applied: e.applied })) : []));
}

/* ------------------------------------------------------------------ meters */

export type Meters = {
  kaneCredits: number;
  /** Batches metered by `kane-cli balance`; 0 means the total is Kane's per-run figures. */
  metered: number;
  unmeasured: number;
  split: { key: string; label: string; credits: number }[];
  breakerUsd: number;
  capUsd: number | null;
  breakerModel: string | null;
  mutants: LedgerState["mutants"];
  turns: number;
  maxTurns: number | null;
  runs: number;
  kaneS: number;
};

export function meters(api: ApiState, events: LedgerEvent[]): Meters {
  const split = { spec: 0, design: 0, build: 0, falsify: 0, other: 0 };
  let kaneS = 0;
  let metered = 0;
  for (const e of events) {
    const c = eventCredits(e);
    if (e.t === "design") split.design += c;
    else if (e.t.startsWith("spec.")) split.spec += c;
    else if (e.t === "run") {
      kaneS += e.result.durationS;
      if (e.kind === "build") split.build += c;
      else if (e.kind === "falsify") split.falsify += c;
      else split.other += c;
    } else split.other += c;
    if (e.t === "credits") metered += 1;
  }
  const r = (n: number) => Math.round(n * 1e4) / 1e4;
  return {
    kaneCredits: api.credits.kane,
    metered,
    unmeasured: api.credits.unmeasured,
    split: [
      { key: "spec", label: "Spec questions", credits: r(split.spec) },
      { key: "design", label: "Test design", credits: r(split.design) },
      { key: "build", label: "Build checks", credits: r(split.build) },
      { key: "falsify", label: "Breaker replays", credits: r(split.falsify) },
      { key: "other", label: "Other", credits: r(split.other) },
    ].filter((s) => s.credits > 0),
    breakerUsd: api.breakerUsd,
    capUsd: api.config?.breaker.capUsd ?? null,
    breakerModel: api.config?.breaker.model ?? null,
    mutants: api.state.mutants,
    turns: api.state.turn,
    maxTurns: api.config?.loop.maxTurns ?? null,
    runs: api.state.runs,
    kaneS,
  };
}

/* ------------------------------------------------------------------ retired tests */

/** The tests Kane's evolve retired, in one line: their files stay sealed and are never run again. Undefined when there are none. */
export function retiredLine(events: LedgerEvent[]): string | undefined {
  const list = retiredTests(events);
  if (list.length === 0) return undefined;
  return `Retired by Kane's evolve, still sealed, never run again: ${list.map((t) => `${t.id}${t.title ? ` ${t.title}` : ""} (${t.uc})`).join("; ")}.`;
}

/* ------------------------------------------------------------------ the gate pill */

/** The run's verdict (R44): the one the CLI exits with, never "Released" unless `holdback run` would exit 0. */
export function verdictOf(api: ApiState): Verdict {
  return api.verdict ?? coreVerdict(api.state, { tampered: api.tamper !== null });
}

/** The headline: the verdict's word, then its parts (the proved count is shown on its own, so a release leaves it out). */
export function gateLabel(api: ApiState): { word: string; open: boolean; parts: string[] } {
  const v = verdictOf(api);
  return { word: v.word, open: v.released, parts: v.released ? v.parts.slice(0, 1) : v.parts };
}

/* ------------------------------------------------------------------ the eval */

export type ArmSummary = {
  examPassed: number;
  examTotal: number;
  inconclusive?: number | null;
  claimedDone?: boolean | null;
  turns?: number | null;
  kaneCredits?: number | null;
  agentUsd?: number | null;
  breakerUsd?: number | null;
  wallMin?: number | null;
};
export type EvalSummary = Partial<Record<"A" | "B" | "C", ArmSummary>>;

export const ARMS: { id: "A" | "B" | "C"; name: string; about: string }[] = [
  { id: "A", name: "Claude Code alone", about: "Builds from the spec and decides when it is done." },
  { id: "B", name: "Claude Code + its own Kane checks", about: "Also writes and runs its own Kane CLI checks." },
  { id: "C", name: "Holdback", about: "Kane's sealed criteria decide when it is done." },
];

/** A parsed summary.json, or null when it is missing or not the shape the scorer writes. */
export function parseEvalSummary(v: unknown): EvalSummary | null {
  if (!v || typeof v !== "object" || Array.isArray(v)) return null;
  const out: EvalSummary = {};
  for (const id of ["A", "B", "C"] as const) {
    const a = (v as Record<string, unknown>)[id];
    if (a && typeof a === "object" && typeof (a as ArmSummary).examPassed === "number" && typeof (a as ArmSummary).examTotal === "number") out[id] = a as ArmSummary;
  }
  return Object.keys(out).length > 0 ? out : null;
}

/* ------------------------------------------------------------------ format */

export function fmtCredits(n: number): string {
  return n >= 100 ? n.toFixed(1) : n >= 10 ? n.toFixed(2) : n.toFixed(2).replace(/\.?0+$/, "") || "0";
}

export function fmtUsd(n: number): string {
  if (n === 0) return "$0";
  if (n < 0.01) return "$" + n.toFixed(4);
  return "$" + n.toFixed(2);
}

export function fmtDuration(seconds: number): string {
  const s = Math.round(seconds);
  if (s < 60) return `${s}s`;
  const m = Math.floor(s / 60);
  if (m < 60) return `${m}m ${String(s % 60).padStart(2, "0")}s`;
  return `${Math.floor(m / 60)}h ${String(m % 60).padStart(2, "0")}m`;
}

/** 11:40:57 in UTC: the ledger's own clock, the same for every viewer. */
export function fmtClock(at: string): string {
  const d = new Date(at);
  return Number.isNaN(d.getTime()) ? at : d.toISOString().slice(11, 19);
}

export function fmtDay(at: string): string {
  const d = new Date(at);
  return Number.isNaN(d.getTime()) ? at : d.toLocaleDateString("en-GB", { day: "numeric", month: "short", year: "numeric", timeZone: "UTC" });
}
