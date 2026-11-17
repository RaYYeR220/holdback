import { readdir, readFile, writeFile } from "node:fs/promises";
import path from "node:path";
import type { EventBody } from "../ledger/vouched.js";
import type { HumanIO, VariableAsk } from "./human.js";
import { importTargets } from "./imports.js";

/**
 * The variables gate (live run, 2026-11-17): `design tests` declares the test data it needs in
 * `.testmuai/variables/*.json`, often with an empty value for the owner to fill. Kane 0.10.4 seals
 * and runs such a test as it is: it types nothing, and its verdict is `automation_bug`, a run that
 * never proves anything. Before the seal, Holdback asks the human for every empty variable an
 * approved test types, and seals none of them empty.
 */

const VARIABLES_DIR = [".testmuai", "variables"];
const REF = /\{\{\s*([A-Za-z_][\w.-]*)\s*\}\}/g;

/** A variable as Kane declared it, in one variables file. Never carries a secret's value. */
type Declared = { file: string; name: string; description: string; secret: boolean; empty: boolean; value?: string };

const isObj = (v: unknown): v is Record<string, unknown> => v !== null && typeof v === "object" && !Array.isArray(v);
const isEmpty = (v: unknown) => v === undefined || v === null || (typeof v === "string" && v.trim() === "");

/** Every variable in the verifier's variables files (sorted by file name), in the order Kane declared them. */
async function readDeclared(verifierDir: string): Promise<Declared[]> {
  const dir = path.join(verifierDir, ...VARIABLES_DIR);
  let names: string[];
  try {
    names = (await readdir(dir)).filter((n) => n.endsWith(".json")).sort();
  } catch (e) {
    if ((e as NodeJS.ErrnoException).code === "ENOENT") return [];
    throw e;
  }
  const out: Declared[] = [];
  for (const n of names) {
    const file = path.join(dir, n);
    let doc: unknown;
    try {
      doc = JSON.parse(await readFile(file, "utf8"));
    } catch (e) {
      throw new Error(`cannot read Kane's test variables in ${[...VARIABLES_DIR, n].join("/")}: ${e instanceof Error ? e.message : String(e)}`);
    }
    if (!isObj(doc)) continue;
    for (const [name, v] of Object.entries(doc)) {
      if (!isObj(v)) continue;
      const secret = v.secret === true;
      const empty = isEmpty(v.value);
      out.push({ file, name, description: typeof v.description === "string" ? v.description : "", secret, empty, ...(!secret && !empty ? { value: String(v.value) } : {}) });
    }
  }
  return out;
}

/** The `{{name}}` references in `file` and in every file it imports, transitively. */
async function referencesOf(file: string, seen = new Set<string>()): Promise<Set<string>> {
  const out = new Set<string>();
  const abs = path.resolve(file);
  if (seen.has(abs)) return out;
  seen.add(abs);
  let text: string;
  try {
    text = await readFile(abs, "utf8");
  } catch {
    return out; // no such file (an import that resolves to nothing is flagged at the approval): it types nothing
  }
  for (const m of text.matchAll(REF)) out.add(m[1]!);
  for (const t of importTargets(text)) for (const r of await referencesOf(path.resolve(path.dirname(abs), t), seen)) out.add(r);
  return out;
}

const PHONE_PREFIX = "215555";
const NAMES = ["Maria Lopez", "James Carter", "Priya Shah", "Daniel Kim", "Ana Costa", "Samuel Okafor"];
const digits = (s: string) => s.replace(/\D/g, "");
const formatted = (d: string) => (d.length === 10 ? `(${d.slice(0, 3)}) ${d.slice(3, 6)}-${d.slice(6)}` : d);

const isNineDigits = (name: string, description: string) => /\b(nine|9)[\s-]digits?\b/i.test(description) || /nine[_-]?digit/i.test(name);
const isFormatted = (name: string, description: string) => /formatted|punctuat/i.test(name) || /\b(formatted|punctuation|punctuated)\b/i.test(description);
const isPhone = (name: string, description: string) => /phone|mobile/i.test(name) || /\b(phone|mobile|telephone)\b/i.test(description) || /\b(ten|10)[\s-]digits?\b/i.test(description);
const isPersonName = (name: string, description: string) => /(^|_)name$/i.test(name) || /\bname\b/i.test(description);

/**
 * A test value for each variable, derived from its name and description alone, so the same
 * declarations always get the same values (the human accepts or edits each):
 * - a phone: `215555` and four digits, distinct across every phone here and every filled value;
 * - one "formatted" or "punctuated": its sibling's digits as `(215) 555-0101` (`sameAs`), the
 *   sibling being a variable its description names, or its own name without "formatted";
 * - one of "nine digits": nine digits;
 * - a name: a plain test name;
 * - anything else: only a placeholder the human must replace; a secret: nothing.
 * `filled`: the values already given (non-secret), by name.
 */
export function suggestValues(
  vars: { name: string; description: string; secret: boolean }[],
  filled: Record<string, string> = {},
): Record<string, { suggested?: string; placeholder?: string; sameAs?: string }> {
  const out: Record<string, { suggested?: string; placeholder?: string; sameAs?: string }> = {};
  const used = new Set(Object.values(filled).map(digits).filter((d) => d.length > 0));
  let n = 101;
  const phone = () => {
    for (;;) {
      const d = `${PHONE_PREFIX}${String(n++).padStart(4, "0")}`;
      if (!used.has(d)) {
        used.add(d);
        return d;
      }
    }
  };
  let names = 0;
  const later: typeof vars = [];
  for (const v of vars) {
    if (v.secret) out[v.name] = {};
    else if (isNineDigits(v.name, v.description)) out[v.name] = { suggested: phone().slice(0, 9) };
    else if (isFormatted(v.name, v.description)) later.push(v);
    else if (isPhone(v.name, v.description)) out[v.name] = { suggested: phone() };
    else if (isPersonName(v.name, v.description)) {
      const i = names++;
      out[v.name] = { suggested: `${NAMES[i % NAMES.length]}${i >= NAMES.length ? ` ${Math.floor(i / NAMES.length) + 1}` : ""}` };
    } else out[v.name] = { placeholder: `<${v.name}>` };
  }
  // a formatted variable repeats a sibling's digits: the siblings have theirs by now
  const known = (name: string) => out[name]?.suggested ?? filled[name];
  for (const v of later) {
    const tokens = v.description.match(/[A-Za-z_][\w]*/g) ?? [];
    const own = v.name.replace(/_?(formatted|punctuated)_?/i, "");
    const sibling = tokens.find((t) => t !== v.name && known(t) !== undefined && digits(known(t)!).length === 10) ?? (own !== v.name && known(own) !== undefined ? own : undefined);
    const d = sibling !== undefined ? digits(known(sibling)!) : "";
    out[v.name] = d.length === 10 ? { suggested: formatted(d), sameAs: sibling! } : { suggested: formatted(phone()) };
  }
  return Object.fromEntries(vars.map((v) => [v.name, out[v.name]!]));
}

/**
 * The variables the approved `tests` (or a file one of them imports) type as `{{name}}` that Kane
 * declared with no value, in the order Kane declared them, each with Holdback's suggestion
 * (`suggestValues`) and the tests that use it. A name Kane never declared is not one of them.
 */
export async function emptyVariables(verifierDir: string, tests: { id: string; file: string }[]): Promise<VariableAsk[]> {
  const declared = await readDeclared(verifierDir);
  const usedBy = new Map<string, string[]>();
  for (const t of tests) {
    if (!t.file) continue;
    for (const name of await referencesOf(path.resolve(verifierDir, t.file))) {
      const ids = usedBy.get(name) ?? [];
      if (!ids.includes(t.id)) ids.push(t.id);
      usedBy.set(name, ids);
    }
  }
  const seen = new Set<string>();
  const empty: Declared[] = [];
  for (const d of declared) {
    if (!d.empty || seen.has(d.name) || !usedBy.has(d.name)) continue;
    seen.add(d.name);
    empty.push(d);
  }
  const filled: Record<string, string> = {};
  for (const d of declared) if (d.value !== undefined && !(d.name in filled)) filled[d.name] = d.value;
  const s = suggestValues(empty, filled);
  return empty.map((d) => ({ name: d.name, description: d.description, secret: d.secret, ...s[d.name], usedBy: usedBy.get(d.name)! }));
}

/** An approved test types a variable nobody gave a value: nothing is sealed. The CLI exits 3. */
export class VariablesMissing extends Error {
  constructor(readonly names: string[]) {
    super(
      `the tests type ${names.length === 1 ? "a variable" : "variables"} with no value (${names.join(", ")}), and Kane would run them as they are: nothing was sealed. ` +
        "Run `holdback spec` again and give each a value.",
    );
    this.name = "VariablesMissing";
  }
}

/**
 * The variables gate, after the design approval and before the seal: asks the human (`io.values`)
 * for every empty variable an approved test types, writes what they give into the variables file
 * that declares it (the rest of Kane's declaration kept), and logs `spec.variables` with the names
 * it filled, never a value. Throws `VariablesMissing` when one is still empty: what the human did
 * give stays written, so a resumed stage asks only for the rest.
 */
export async function fillVariables(verifierDir: string, tests: { id: string; file: string }[], io: HumanIO, emit: (e: EventBody) => Promise<void>): Promise<void> {
  const asks = await emptyVariables(verifierDir, tests);
  if (asks.length === 0) return;
  const given = await io.values(asks);
  const values = new Map<string, string>();
  for (const a of asks) {
    const v = given[a.name];
    if (typeof v === "string" && v.trim() !== "") values.set(a.name, v);
  }
  if (values.size > 0) {
    const byFile = new Map<string, Declared[]>();
    for (const d of await readDeclared(verifierDir)) if (d.empty && values.has(d.name)) byFile.set(d.file, [...(byFile.get(d.file) ?? []), d]);
    for (const [file, ds] of byFile) {
      const doc = JSON.parse(await readFile(file, "utf8")) as Record<string, Record<string, unknown>>;
      for (const d of ds) doc[d.name] = { ...doc[d.name], value: values.get(d.name)! };
      await writeFile(file, JSON.stringify(doc, null, 2) + "\n", "utf8");
    }
    await emit({ t: "spec.variables", names: asks.map((a) => a.name).filter((n) => values.has(n)), filledBy: "human" });
  }
  const missing = asks.map((a) => a.name).filter((n) => !values.has(n));
  if (missing.length > 0) throw new VariablesMissing(missing);
}
