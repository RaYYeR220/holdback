import type { AcState } from "../ledger/types.js";
import { escapeControls } from "../text.js";
import { BreakerError, BreakerUnavailable, BudgetRefused } from "./mutate.js";
import { Budget, estimateUsd, veniceChat, VeniceHttpError, VeniceOutputError, VeniceUnreachable, type ChatMessage } from "./venice.js";

/** The referee's completion-token cap (estimated in full against the USD cap). */
export const REFEREE_MAX_TOKENS = 800;
/** The longest any field of the referee's reply is kept. */
export const REFEREE_FIELD_MAX = 300;
const MAX_CITES = 3;
const MAX_QUOTE = 800;
const MAX_PATCH = 12_000;

export const REFEREE_SCHEMA = {
  type: "object",
  properties: {
    verdict: { type: "string", enum: ["violates", "off-target", "no-change"] },
    input: { type: "string" },
    expected: { type: "string" },
    observed: { type: "string" },
    reason: { type: "string" },
  },
  required: ["verdict", "input", "expected", "observed", "reason"],
  additionalProperties: false,
};

/** `violates`: the planted bug visibly breaks this criterion; `off-target`: something else, if anything; `no-change`: nothing a user sees. */
export type RefereeCall = "violates" | "off-target" | "no-change";

/**
 * The referee's judgment of one survivor: `confirmed` only when it named a concrete input whose
 * expected result (by the criterion) and observed result (the mutant's) visibly differ. An LLM's
 * judgment, not a proof. Every string is the referee's own, one line, capped, control characters escaped.
 * `model`: the Venice model that judged it.
 */
export type RefereeFinding = { confirmed: boolean; call: RefereeCall; input: string; expected: string; observed: string; reason: string; usd: number; model: string };

export const REFEREE_SYSTEM = [
  "You are the referee in a mutation test of a web app.",
  "A breaker changed the app's source (the patch below) to make the running app violate one acceptance criterion (AC), and the AC's browser tests did not catch the change. That counts against the tests only if the change really breaks this AC where a user can see it. Judge from the AC, its spec quotes and the patch alone, reading the code line by line: never assume the change does what it was meant to do.",
  "Verdicts:",
  '- "violates": there is a concrete input or action, within what this AC covers, for which this AC and its spec quotes say the page must show one thing (expected) and the changed app shows something visibly different (observed). Work both out from the code.',
  '- "no-change": a user sees nothing different for any input: the removed and added lines do the same thing, a value the change sets is overwritten or never read, or only whitespace or comments change.',
  '- "off-target": a user may see a difference, but not one this AC is about: it breaks another rule, or only for inputs this AC does not cover.',
  'If you cannot name such an input with certainty, the verdict is not "violates".',
  'Reply with JSON {"verdict": "violates" | "off-target" | "no-change", "input": string, "expected": string, "observed": string, "reason": string}. For "violates", `input` is what the user enters or does, `expected` what the page must show for it by this AC, `observed` what the changed app shows instead; for the other verdicts they may be empty. `reason` is one sentence on why. Keep every string under 300 characters.',
].join("\n");

const isObj = (v: unknown): v is Record<string, unknown> => v !== null && typeof v === "object" && !Array.isArray(v);

/** At most `max` characters, cut at a word boundary with an ellipsis when longer. */
function clip(s: string, max: number): string {
  if (s.length <= max) return s;
  const cut = s.slice(0, max - 1);
  const at = cut.lastIndexOf(" ");
  return `${(at > max / 2 ? cut.slice(0, at) : cut).trimEnd()}…`;
}

/** A field of the referee's reply as Holdback keeps it: one line, control characters escaped, capped. */
const field = (s: string) => clip(escapeControls(s.replace(/\s+/g, " ").trim()), REFEREE_FIELD_MAX);

/** The same result in other words? Case, whitespace and closing punctuation aside. */
const sameResult = (a: string, b: string) => {
  const n = (s: string) => s.toLowerCase().replace(/\s+/g, " ").replace(/[\s.!]+$/, "").trim();
  return n(a) === n(b);
};

function messagesFor(ac: AcState, patch: string): ChatMessage[] {
  const parts = [`AC ${ac.id}: ${ac.text}`];
  for (const c of ac.cites.slice(0, MAX_CITES)) parts.push(`Spec quote (${c.source} ${c.anchor}): "${clip(c.quote, MAX_QUOTE)}"`);
  parts.push(`Patch:\n${patch.length > MAX_PATCH ? `${patch.slice(0, MAX_PATCH)}\n[patch cut at ${MAX_PATCH} characters]` : patch}`);
  return [
    { role: "system", content: REFEREE_SYSTEM },
    { role: "user", content: parts.join("\n\n") },
  ];
}

export type RefereeOptions = {
  model: string;
  apiKey: string;
  budget: Budget;
  /** Default: `veniceChat`. */
  chat?: typeof veniceChat;
};

/**
 * Asks the referee, once, whether a planted bug that got past the tests visibly breaks `ac`: a second
 * Venice call with its own prompt (the criterion, its spec quotes and the patch; never the breaker's
 * account or the source), at temperature 0, under the breaker's USD cap. Its reply is untrusted data:
 * held to the schema (else a paid BreakerError), every field one line and capped, never executed.
 * Refused before any call (BudgetRefused) when the worst case would pass the cap; an outage is a
 * BreakerUnavailable, as for the breaker.
 */
export async function refereeMutant(ac: AcState, patch: string, opts: RefereeOptions): Promise<RefereeFinding> {
  const messages = messagesFor(ac, patch);
  const est = estimateUsd(opts.model, messages, REFEREE_MAX_TOKENS);
  if (!opts.budget.canSpend(est)) throw new BudgetRefused(est, opts.budget.spent, opts.budget.capUsd);
  const chat = opts.chat ?? veniceChat;
  let reply;
  try {
    reply = await chat({ model: opts.model, messages, schema: REFEREE_SCHEMA, schemaName: "referee", apiKey: opts.apiKey, maxTokens: REFEREE_MAX_TOKENS, temperature: 0 });
  } catch (e) {
    if (e instanceof VeniceOutputError) throw new BreakerError(e.message, opts.budget.charge(opts.model, e.usage), e.cutOff);
    if (e instanceof VeniceUnreachable) {
      const chars = messages.reduce((n, m) => n + m.content.length, 0);
      throw new BreakerUnavailable(e.message, opts.budget.charge(opts.model, { prompt_tokens: chars / 4, completion_tokens: REFEREE_MAX_TOKENS }));
    }
    if (e instanceof VeniceHttpError) throw new BreakerUnavailable(e.message, 0);
    throw e;
  }
  const usd = opts.budget.charge(opts.model, reply.usage);
  const j = reply.json;
  if (!isObj(j)) throw new BreakerError("the referee's reply is not a JSON object", usd);
  const call = j.verdict;
  if (call !== "violates" && call !== "off-target" && call !== "no-change") throw new BreakerError(`the referee's reply has no verdict (${clip(escapeControls(String(call)), 40)})`, usd);
  const text: Record<"input" | "expected" | "observed" | "reason", string> = { input: "", expected: "", observed: "", reason: "" };
  for (const k of Object.keys(text) as (keyof typeof text)[]) {
    if (typeof j[k] !== "string") throw new BreakerError(`the referee's reply has no ${k}`, usd);
    text[k] = field(j[k] as string);
  }
  const confirmed = call === "violates" && text.input !== "" && text.expected !== "" && text.observed !== "" && !sameResult(text.expected, text.observed);
  return { confirmed, call, ...text, usd, model: opts.model };
}

/** Why the referee did not confirm a survivor, in its own words where it gave them; undefined when it did. */
export function refereeNote(f: RefereeFinding): string | undefined {
  if (f.confirmed) return undefined;
  if (f.call === "no-change") return f.reason ? `no observable change: ${f.reason}` : "no observable change";
  if (f.call === "off-target") return f.reason ? `off target: ${f.reason}` : "off target";
  if (f.input === "" || f.expected === "" || f.observed === "") return "off target: the referee named no input where it breaks this criterion";
  return "no observable change: the referee's expected and observed results are the same";
}
