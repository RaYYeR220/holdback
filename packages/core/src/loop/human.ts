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

/** Answers + approvals from a JSON file the human wrote, for reproducible runs. */
export class ScriptedHumanIO implements HumanIO {
  private script: { answers: Record<string, string>; approve: "all" | string[] } | null = null;

  constructor(private readonly file: string) {}

  private async load() {
    if (!this.script) {
      const doc = JSON.parse(await readFile(this.file, "utf8")) as {
        answers?: Record<string, string>;
        approve?: "all" | string[];
      };
      this.script = { answers: doc.answers ?? {}, approve: doc.approve ?? [] };
    }
    return this.script;
  }

  async answer(qs: PendingQuestion[]): Promise<Record<string, string>> {
    const { answers } = await this.load();
    const out: Record<string, string> = {};
    for (const q of qs) {
      const a = answers[q.text] ?? answers[q.id];
      if (a === undefined) throw new Error(`ScriptedHumanIO: no scripted answer for question: ${q.text}`);
      out[q.id] = a;
    }
    return out;
  }

  async approve(items: ApprovalItem[]): Promise<string[]> {
    const { approve } = await this.load();
    if (approve === "all") return items.map((i) => i.ref);
    return items.map((i) => i.ref).filter((r) => approve.includes(r));
  }
}
