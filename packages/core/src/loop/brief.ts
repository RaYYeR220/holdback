import { gate } from "../ledger/gate.js";
import type { AcState, LedgerState } from "../ledger/types.js";

export type BriefOptions = {
  /** The app failed to start after the last turn: the brief is only this log (tail). */
  appStartError?: string;
  /** List at most this many criteria (the header still counts all of them). */
  maxItems?: number;
  /** Stack and style notes file the agent should follow (config.agentNotes). */
  notes?: string;
  /**
   * Where the agent can open a failure's screenshot. When given, its result replaces Kane's own
   * path on the `Screenshot:` line, and `undefined` drops the line.
   */
  screenshot?: (failure: AcFailure) => string | undefined;
};

export type AcFailure = NonNullable<AcState["lastFailure"]>;

const LOG_TAIL_LINES = 40;

const oneLine = (t: string): string => t.replace(/\s+/g, " ").trim();

const acNumber = (id: string): number => {
  const m = /(\d+)$/.exec(id);
  return m ? Number(m[1]) : Number.POSITIVE_INFINITY;
};
/** ac-2 before ac-10; ties (non-numeric ids) fall back to plain string order. */
export function byAcId(a: { id: string }, b: { id: string }): number {
  return acNumber(a.id) - acNumber(b.id) || (a.id < b.id ? -1 : a.id > b.id ? 1 : 0);
}

/** A code fence longer than any backtick run inside `text`. */
function fenceFor(text: string): string {
  const longest = Math.max(2, ...(text.match(/`+/g) ?? []).map((m) => m.length));
  return "`".repeat(longest + 1);
}

function startFailure(log: string): string {
  const lines = log.replace(/\r\n/g, "\n").replace(/\n+$/, "").split("\n");
  const tail = lines.slice(-LOG_TAIL_LINES).join("\n") || "(the app printed nothing)";
  const fence = fenceFor(tail);
  return [
    "# Holdback — The app does not start",
    "",
    "The app does not start, so Kane could not check any criterion this turn. Make it boot and answer HTTP on the port in the PORT environment variable before anything else.",
    "",
    "Last lines of the app log:",
    "",
    fence,
    tail,
    fence,
    "",
  ].join("\n");
}

/** Kane's step text names the app's URL as a variable; say it in words. */
const stepText = (t: string): string => oneLine(t.replace(/\{\{\s*start_url\s*\}\}/gi, "the app's start page"));

/** One criterion as a bug report: what the spec says, what Kane did, saw and thinks. Never the test itself. */
function section(ac: AcState, opts: BriefOptions): string[] {
  const out = [`## ${ac.id} — ${oneLine(ac.text)}`];
  if (ac.status === "regressed") out.push("Regressed: this passed on an earlier turn and fails now.");
  const cite = ac.cites[0];
  if (cite) out.push(`Spec: "${oneLine(cite.quote)}" (${cite.source} ${cite.anchor})`);
  const f = ac.lastFailure;
  if (!f) return out;
  const v = f.verdict;
  if (f.stepText) out.push(`Kane ran: ${stepText(f.stepText)}`);
  const saw = v?.observed ?? v?.oneLiner;
  if (saw) out.push(`Kane saw: ${oneLine(saw)}`);
  if (v?.bugTitle) out.push(`Kane's diagnosis: ${oneLine(v.bugTitle)}${v.rootCause ? ` — ${oneLine(v.rootCause)}` : ""}`);
  if (v?.suggestion) out.push(`Suggested: ${oneLine(v.suggestion)}`);
  if (!v && f.reason) out.push(`Kane reported: ${oneLine(f.reason)}`);
  if (f.screenshot) {
    const shot = opts.screenshot ? opts.screenshot(f) : f.screenshot;
    if (shot) out.push(`Screenshot: ${shot}`);
  }
  return out;
}

/**
 * The agent's whole prompt for one turn: every owed or regressed criterion
 * (regressed first) as a bug report built from the ledger.
 */
export function buildBrief(state: LedgerState, opts: BriefOptions = {}): string {
  if (opts.appStartError !== undefined) return startFailure(opts.appStartError);
  const g = gate(state);
  const items = [...[...g.regressed].sort(byAcId), ...[...g.owed].sort(byAcId)];
  const n = items.length;
  const lines = [`# Holdback — ${n} ${n === 1 ? "criterion" : "criteria"} still owed`];
  if (opts.notes) lines.push("", `Stack and style notes: ${opts.notes}`);
  const max = Math.max(0, Math.floor(opts.maxItems ?? n));
  for (const ac of items.slice(0, max)) lines.push("", ...section(ac, opts));
  if (n > max) lines.push("", `…and ${n - max} more not shown.`);
  return lines.join("\n") + "\n";
}
