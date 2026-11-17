import { readFile } from "node:fs/promises";
import { createInterface, type Interface } from "node:readline";
import type { PendingQuestion } from "../kane/assurance.js";
import { escapeControls } from "../text.js";

/** `note`: what Holdback did to the item, or found wrong with it, for the human to see as they approve (a repaired import). */
export type ApprovalItem = { ref: string; title: string; kind: string; note?: string };

/**
 * A test variable Kane declared but left empty, which an approved test types (`{{name}}`). Holdback
 * asks the human for its value: `suggested` is a test value Holdback derived from the description
 * (taken as is on Enter), `placeholder` only an example the human must replace, `sameAs` the variable
 * whose digits a formatted one repeats. A secret has neither, and its value is never shown back.
 */
export type VariableAsk = { name: string; description: string; secret: boolean; suggested?: string; placeholder?: string; sameAs?: string; usedBy: string[] };

/** The human in the loop. No implementation approves anything on its own. */
export interface HumanIO {
  answer(qs: PendingQuestion[]): Promise<Record<string, string>>;
  approve(items: ApprovalItem[]): Promise<string[]>;
  /** A value for each variable, by name; "" (or a name left out) leaves it empty, which stops the spec stage before its seal. */
  values(asks: VariableAsk[]): Promise<Record<string, string>>;
  /** A person answers at the moment (the terminal, the dashboard), not a file: a drift they approve starts a fresh spec-provenance window (I-2). */
  readonly interactive?: boolean;
}

/**
 * The one reader of an input stream (stdin) for the whole process (N-C1): every prompt, the
 * terminal human IO's and a command's yes/no alike, takes its line from one readline and one queue,
 * so a line typed once is consumed once, in order, and no prompt pauses the stream under another.
 * Lines nobody waits for yet are queued (piped stdin never loses input). The readline stays open
 * while anyone holds the reader and is closed when the last holder lets go, which pauses the stream
 * so the process can exit; queued lines stay, and the next prompt opens it again.
 */
export class LineReader {
  private rl: Interface | null = null;
  private lines: string[] = [];
  private waiting: ((l: string | null) => void)[] = [];
  /** The stream itself ended: no line will come. */
  private ended = false;
  private holders = 0;

  constructor(
    private readonly input: NodeJS.ReadableStream,
    private readonly output: NodeJS.WritableStream,
  ) {}

  private open(): void {
    if (this.rl || this.ended) return;
    const rl = createInterface({ input: this.input, output: this.output, terminal: false });
    rl.on("line", (l) => {
      const w = this.waiting.shift();
      if (w) w(l);
      else this.lines.push(l);
    });
    rl.on("close", () => {
      if (this.rl !== rl) return; // closed by `release`, not by the stream's end
      this.rl = null;
      this.ended = true;
      for (const w of this.waiting.splice(0)) w(null);
    });
    this.rl = rl;
  }

  /** Keeps the reader open until the matching `release`. */
  hold(): void {
    this.holders += 1;
  }

  /** The last holder gone and nobody waiting: the readline is closed and the stream paused. */
  release(): void {
    this.holders = Math.max(0, this.holders - 1);
    if (this.holders > 0 || this.waiting.length > 0 || !this.rl) return;
    const rl = this.rl;
    this.rl = null;
    rl.close();
  }

  /** Writes `prompt` and returns the next line, trimmed; null when the input ended first. */
  async ask(prompt: string): Promise<string | null> {
    this.open();
    this.output.write(prompt);
    const queued = this.lines.shift();
    if (queued !== undefined) return queued.trim();
    if (this.ended) return null;
    const l = await new Promise<string | null>((res) => this.waiting.push(res));
    return l === null ? null : l.trim();
  }
}

const readers = new WeakMap<object, LineReader>();

/** The process's one reader of `input` (N-C1). */
export function lineReaderFor(input: NodeJS.ReadableStream, output: NodeJS.WritableStream): LineReader {
  let r = readers.get(input);
  if (!r) readers.set(input, (r = new LineReader(input, output)));
  return r;
}

/**
 * A yes/no question on the terminal, through the process's one reader of `input`: `y` or `yes`
 * (any case) is a yes; anything else, or the input ending, is a no.
 */
export async function confirmLine(input: NodeJS.ReadableStream, output: NodeJS.WritableStream, question: string): Promise<boolean> {
  const r = lineReaderFor(input, output);
  r.hold();
  try {
    const a = await r.ask(question);
    return a !== null && /^y(es)?$/i.test(a);
  } finally {
    r.release();
  }
}

/** Interactive terminal implementation. */
export class CliHumanIO implements HumanIO {
  readonly interactive = true;
  /** Shared with every other prompt on the same input (N-C1). */
  private readonly reader: LineReader;
  private holding = false;

  constructor(
    input: NodeJS.ReadableStream = process.stdin,
    private readonly output: NodeJS.WritableStream = process.stdout,
  ) {
    this.reader = lineReaderFor(input, output);
  }

  /** Release stdin once the session is over. */
  close(): void {
    if (!this.holding) return;
    this.holding = false;
    this.reader.release();
  }

  private async ask(prompt: string): Promise<string> {
    // the session holds the reader from its first prompt until `close`
    if (!this.holding) {
      this.holding = true;
      this.reader.hold();
    }
    const l = await this.reader.ask(prompt);
    if (l === null) throw new Error("CliHumanIO: input closed before an answer was given");
    return l;
  }

  async answer(qs: PendingQuestion[]): Promise<Record<string, string>> {
    const out: Record<string, string> = {};
    for (const q of qs) {
      const lines = [`\n[${q.id}] (${q.risk}) ${q.text}`, q.rationale ? `  why: ${q.rationale}` : ""];
      q.options.forEach((o, i) => {
        const rec = i === q.recommendedIndex ? "  <- recommended" : "";
        lines.push(`  ${i + 1}) ${o.label}${o.detail ? ` - ${o.detail}` : ""}${rec}`);
      });
      const hint = q.allowFreeText ? "number or free text" : "number";
      const rec = q.options[q.recommendedIndex];
      // Kane wrote these: shown with their control and format characters escaped
      this.output.write(escapeControls(lines.filter(Boolean).join("\n")) + "\n");
      const raw = await this.ask(escapeControls(`Answer (${hint}, Enter = ${rec ? rec.label : "recommended"}): `));
      const picked = /^\d+$/.test(raw) ? q.options[Number(raw) - 1] : undefined;
      out[q.id] = raw === "" ? (rec?.label ?? "") : (picked?.label ?? raw);
    }
    return out;
  }

  async approve(items: ApprovalItem[]): Promise<string[]> {
    this.output.write("\nApprove:\n" + escapeControls(items.map((i) => `  ${i.ref} [${i.kind}] ${i.title}${i.note ? `\n      ${i.note}` : ""}`).join("\n")) + "\n");
    const raw = await this.ask("Enter = approve all, or type ids to REJECT (space/comma separated): ");
    const reject = new Set(raw.split(/[\s,]+/).filter(Boolean));
    return items.map((i) => i.ref).filter((r) => !reject.has(r));
  }

  async values(asks: VariableAsk[]): Promise<Record<string, string>> {
    this.output.write("\nKane's tests type these values, and Kane left them empty. A test runs with exactly what you give here:\n");
    const out: Record<string, string> = {};
    for (const a of asks) {
      const same = a.sameAs ? ` (same digits as ${a.sameAs})` : "";
      this.output.write(escapeControls(`\n  {{${a.name}}} ${a.description} (used by ${a.usedBy.join(", ")})${same}`) + "\n");
      const how = a.secret
        ? "secret: never printed or logged; Enter leaves it empty"
        : a.suggested !== undefined
          ? `Enter = ${a.suggested}`
          : `no suggestion${a.placeholder ? `, e.g. ${a.placeholder}` : ""}; Enter leaves it empty`;
      const raw = await this.ask(escapeControls(`  value (${how}): `));
      out[a.name] = raw === "" && !a.secret ? (a.suggested ?? "") : raw;
    }
    return out;
  }
}

/** A human's scripted answers, approvals and test variable values, as read (once) from their file. */
export type HumanScript = { answers: Record<string, string>; recommended: boolean; approve: "all" | string[]; variables: Record<string, string> };

const isRecord = (v: unknown): v is Record<string, unknown> => typeof v === "object" && v !== null && !Array.isArray(v);

/** Validates a scripted answers document; throws with what is wrong and where. */
export function parseHumanScript(text: string, file: string): HumanScript {
  let doc: unknown;
  try {
    doc = JSON.parse(text);
  } catch (e) {
    throw new Error(`answers file is not valid JSON (${file}): ${e instanceof Error ? e.message : String(e)}`);
  }
  const bad = (what: string) => new Error(`answers file ${file}: ${what}`);
  if (!isRecord(doc)) throw bad("expected a JSON object");
  const answers = doc.answers ?? {};
  if (!isRecord(answers) || Object.values(answers).some((v) => typeof v !== "string")) throw bad('"answers" must map question texts or ids to strings');
  if (doc.default !== undefined && doc.default !== "recommended") throw bad(`"default" must be "recommended", got ${JSON.stringify(doc.default)}`);
  const approve = doc.approve ?? [];
  if (approve !== "all" && !(Array.isArray(approve) && approve.every((r) => typeof r === "string"))) throw bad('"approve" must be "all" or a list of ids');
  const variables = doc.variables ?? {};
  if (!isRecord(variables) || Object.values(variables).some((v) => typeof v !== "string")) throw bad('"variables" must map test variable names to strings');
  return {
    answers: { ...(answers as Record<string, string>) },
    recommended: doc.default === "recommended",
    approve: approve === "all" ? "all" : [...(approve as string[])],
    variables: { ...(variables as Record<string, string>) },
  };
}

/**
 * Answers + approvals from a JSON file the human wrote, for reproducible runs:
 * `{ "answers": { "<question text or id>": "<answer>" }, "default": "recommended", "approve": "all" | [ids], "variables": { "<name>": "<value>" } }`.
 * Kane writes its questions at run time, so `default: "recommended"` (the human's standing choice)
 * takes Kane's recommended option for any question the file does not name; without it an
 * unnamed question fails the run. It takes Holdback's suggested value for a test variable the file
 * does not name, too (never for a secret, which has none); a variable with no value stays empty, and
 * the spec stage stops before its seal.
 * The file is read and validated once, up front (`fromFile`), before any agent turn: a later
 * approval (a drift mid-run) answers from that snapshot, never from the file again.
 */
export class ScriptedHumanIO implements HumanIO {
  private readonly script: HumanScript;

  constructor(script: HumanScript) {
    this.script = structuredClone(script);
  }

  static async fromFile(file: string): Promise<ScriptedHumanIO> {
    return new ScriptedHumanIO(parseHumanScript(await readFile(file, "utf8"), file));
  }

  async answer(qs: PendingQuestion[]): Promise<Record<string, string>> {
    const { answers, recommended } = this.script;
    const out: Record<string, string> = {};
    for (const q of qs) {
      const a = answers[q.text] ?? answers[q.id] ?? (recommended ? q.options[q.recommendedIndex]?.label : undefined);
      if (a === undefined) throw new Error(`ScriptedHumanIO: no scripted answer for question: ${q.text}`);
      out[q.id] = a;
    }
    return out;
  }

  async approve(items: ApprovalItem[]): Promise<string[]> {
    const { approve } = this.script;
    if (approve === "all") return items.map((i) => i.ref);
    return items.map((i) => i.ref).filter((r) => approve.includes(r));
  }

  async values(asks: VariableAsk[]): Promise<Record<string, string>> {
    const { variables, recommended } = this.script;
    return Object.fromEntries(asks.map((a) => [a.name, variables[a.name] ?? (recommended && !a.secret ? a.suggested : undefined) ?? ""]));
  }

  /** Nothing to release: the file was read once, up front. */
  close(): void {}
}
