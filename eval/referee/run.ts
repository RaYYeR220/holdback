/**
 * Offline harness: runs the referee exactly as falsify calls it (`refereeMutant`: its prompt and
 * schema, temperature 0, its token cap, Venice's 120-second timeout) against labelled survivors and
 * kills from live runs (`cases.json`), for several Venice models. Paid calls: never part of
 * `pnpm test`. Run it by hand, with VENICE_API_KEY in the environment:
 *
 *   node eval/referee/run.ts run --models deepseek-v4-flash,z-ai-glm-5-3-flash [--repeat 3] [--cases id,id] [--cap 0.30]
 *   node eval/referee/run.ts table
 *
 * Each run writes eval/referee/results/<model>.json (every case, `--repeat` times: temperature 0 on
 * Venice is not deterministic); `table` sums every result file. A model must have a price in
 * `PRICES` (packages/core/src/breaker/venice.ts), so every call is held to the cap.
 */
import { mkdir, readFile, readdir, writeFile } from "node:fs/promises";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { parseArgs } from "node:util";
import { Budget, BudgetRefused, refereeMutant, type AcState } from "@holdback/core";

const HERE = path.dirname(fileURLToPath(import.meta.url));
const RESULTS = path.join(HERE, "results");

export type Case = {
  id: string;
  from: string;
  ac: { id: string; text: string; cites: AcState["cites"] };
  patch: string;
  /** True when the patch visibly breaks its criterion: the referee should confirm it. */
  label: boolean;
  truth: "violates" | "off-target" | "no-change";
  why: string;
  /** What the referee said on this patch in the live run, where it was asked. */
  live?: { model: string; confirmed: boolean; input: string; reason: string };
};

export type Outcome = {
  case: string;
  rep: number;
  label: boolean;
  /** Null when the call gave no usable answer (falsify then sets the survivor aside as well). */
  confirmed: boolean | null;
  call?: string;
  input?: string;
  expected?: string;
  observed?: string;
  reason?: string;
  error?: string;
  usd: number;
  ms?: number;
};

export type Summary = { model: string; n: number; right: number; falseConfirms: number; falseRejects: number; errors: number; usd: number };

/** A call with no usable answer counts as not confirmed, as in falsify. */
export function summarize(model: string, out: Outcome[]): Summary {
  const confirmed = (o: Outcome) => o.confirmed === true;
  return {
    model,
    n: out.length,
    right: out.filter((o) => confirmed(o) === o.label).length,
    falseConfirms: out.filter((o) => !o.label && confirmed(o)).length,
    falseRejects: out.filter((o) => o.label && !confirmed(o)).length,
    errors: out.filter((o) => o.error !== undefined).length,
    usd: out.reduce((n, o) => n + o.usd, 0),
  };
}

async function loadCases(): Promise<Case[]> {
  return (JSON.parse(await readFile(path.join(HERE, "cases.json"), "utf8")) as { cases: Case[] }).cases;
}

async function run(models: string[], only: string[] | undefined, capUsd: number, repeat: number): Promise<void> {
  const apiKey = process.env.VENICE_API_KEY ?? "";
  if (!apiKey) throw new Error("VENICE_API_KEY is not set");
  const cases = (await loadCases()).filter((c) => !only || only.includes(c.id));
  // one cap across every model of this invocation
  const budget = new Budget(capUsd, 0);
  await mkdir(RESULTS, { recursive: true });
  for (const model of models) {
    const out: Outcome[] = [];
    for (let rep = 1; rep <= repeat; rep++) {
      for (const c of cases) {
        const ac: AcState = { ...c.ac, useCase: "uc", tests: ["t"], status: "passing" };
        const before = budget.spent;
        const t0 = Date.now();
        try {
          const f = await refereeMutant(ac, c.patch, { model, apiKey, budget });
          out.push({ case: c.id, rep, label: c.label, confirmed: f.confirmed, call: f.call, input: f.input, expected: f.expected, observed: f.observed, reason: f.reason, usd: f.usd, ms: Date.now() - t0 });
        } catch (e) {
          if (e instanceof BudgetRefused) throw e;
          out.push({ case: c.id, rep, label: c.label, confirmed: null, error: e instanceof Error ? `${e.name}: ${e.message}`.slice(0, 300) : String(e), usd: budget.spent - before, ms: Date.now() - t0 });
        }
        const o = out.at(-1)!;
        console.log(`${model} #${rep} ${c.id} label=${c.label ? "violates" : "not"} -> ${o.error ? `ERROR ${o.error}` : `${o.confirmed ? "CONFIRMED" : "rejected"} (${o.call})`} $${o.usd.toFixed(6)}`);
      }
    }
    await writeFile(path.join(RESULTS, `${model}.json`), `${JSON.stringify(out, null, 2)}\n`);
    const s = summarize(model, out);
    console.log(`${model}: ${s.right}/${s.n} right, ${s.falseConfirms} false confirms, ${s.falseRejects} false rejects, ${s.errors} without an answer, $${s.usd.toFixed(5)}`);
  }
  console.log(`spent $${budget.spent.toFixed(5)} of $${capUsd}`);
}

async function table(): Promise<void> {
  const files = (await readdir(RESULTS)).filter((f) => f.endsWith(".json")).sort();
  console.log("| model | right | false confirms | false rejects | no answer | $/call |");
  console.log("| --- | --- | --- | --- | --- | --- |");
  for (const f of files) {
    const s = summarize(f.replace(/\.json$/, ""), JSON.parse(await readFile(path.join(RESULTS, f), "utf8")) as Outcome[]);
    console.log(`| ${s.model} | ${s.right}/${s.n} | ${s.falseConfirms} | ${s.falseRejects} | ${s.errors} | ${(s.usd / s.n).toFixed(6)} |`);
  }
}

const USAGE = "usage: run.ts run --models a,b [--repeat n] [--cases id,id] [--cap usd] | run.ts table";

async function main(): Promise<void> {
  const { values, positionals } = parseArgs({
    allowPositionals: true,
    options: { models: { type: "string" }, cases: { type: "string" }, repeat: { type: "string", default: "1" }, cap: { type: "string", default: "0.30" } },
  });
  const cmd = positionals[0];
  if (cmd === "table") return table();
  if (cmd !== "run" || !values.models) throw new Error(USAGE);
  const cap = Number(values.cap);
  if (!Number.isFinite(cap) || cap <= 0) throw new Error("--cap must be a positive number of USD");
  const repeat = Number(values.repeat);
  if (!Number.isInteger(repeat) || repeat < 1) throw new Error("--repeat must be a whole number of at least 1");
  await run(values.models.split(","), values.cases?.split(","), cap, repeat);
}

main().catch((e) => {
  console.error(e instanceof Error ? e.message : String(e));
  process.exit(1);
});
