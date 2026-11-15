import { readFile } from "node:fs/promises";
import { createInterface, type Interface } from "node:readline";
import type { PendingQuestion } from "../kane/assurance.js";

export type ApprovalItem = { ref: string; title: string; kind: string };

/** The human in the loop. No implementation approves anything on its own. */
export interface HumanIO {
  answer(qs: PendingQuestion[]): Promise<Record<string, string>>;
  approve(items: ApprovalItem[]): Promise<string[]>;
}

/** Interactive terminal implementation. */
export class CliHumanIO implements HumanIO {
  constructor(
    private readonly input: NodeJS.ReadableStream = process.stdin,
    private readonly output: NodeJS.WritableStream = process.stdout,
  ) {}

  // One readline for the whole session; lines are queued so piped stdin never loses input.
  private rl: Interface | null = null;
  private lines: string[] = [];
  private waiting: ((l: string | null) => void)[] = [];
  private ended = false;

  private open(): Interface {
    if (this.rl) return this.rl;
    const rl = createInterface({ input: this.input, output: this.output, terminal: false });
    rl.on("line", (l) => {
      const w = this.waiting.shift();
      if (w) w(l);
      else this.lines.push(l);
    });
    rl.on("close", () => {
      this.ended = true;
      for (const w of this.waiting.splice(0)) w(null);
    });
    return (this.rl = rl);
  }

  /** Release stdin once the session is over. */
  close(): void {
    this.rl?.close();
  }

  private async ask(prompt: string): Promise<string> {
    this.open();
    this.output.write(prompt);
    const queued = this.lines.shift();
    if (queued !== undefined) return queued.trim();
    if (this.ended) throw new Error("CliHumanIO: input closed before an answer was given");
    const l = await new Promise<string | null>((res) => this.waiting.push(res));
    if (l === null) throw new Error("CliHumanIO: input closed before an answer was given");
    return l.trim();
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
      this.output.write(lines.filter(Boolean).join("\n") + "\n");
      const raw = await this.ask(`Answer (${hint}, Enter = ${rec ? rec.label : "recommended"}): `);
      const picked = /^\d+$/.test(raw) ? q.options[Number(raw) - 1] : undefined;
      out[q.id] = raw === "" ? (rec?.label ?? "") : (picked?.label ?? raw);
    }
    return out;
  }

  async approve(items: ApprovalItem[]): Promise<string[]> {
    this.output.write("\nApprove:\n" + items.map((i) => `  ${i.ref} [${i.kind}] ${i.title}`).join("\n") + "\n");
    const raw = await this.ask("Enter = approve all, or type ids to REJECT (space/comma separated): ");
    const reject = new Set(raw.split(/[\s,]+/).filter(Boolean));
    return items.map((i) => i.ref).filter((r) => !reject.has(r));
  }
}

/** A human's scripted answers and approvals, as read (once) from their file. */
export type HumanScript = { answers: Record<string, string>; recommended: boolean; approve: "all" | string[] };

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
  return { answers: { ...(answers as Record<string, string>) }, recommended: doc.default === "recommended", approve: approve === "all" ? "all" : [...(approve as string[])] };
}

/**
 * Answers + approvals from a JSON file the human wrote, for reproducible runs:
 * `{ "answers": { "<question text or id>": "<answer>" }, "default": "recommended", "approve": "all" | [ids] }`.
 * Kane writes its questions at run time, so `default: "recommended"` (the human's standing choice)
 * takes Kane's recommended option for any question the file does not name; without it an
 * unnamed question fails the run.
 * The file is read and validated once, up front (`fromFile`), before any agent turn: a later
 * approval (a falsify re-design mid-run) answers from that snapshot, never from the file again.
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

  /** Nothing to release: the file was read once, up front. */
  close(): void {}
}
