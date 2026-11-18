import { open, readdir, stat } from "node:fs/promises";
import path from "node:path";
import type { AcState } from "../ledger/types.js";
import { Budget, estimateUsd, MAX_TOKENS, veniceChat, VeniceHttpError, VeniceOutputError, VeniceUnreachable, type ChatMessage } from "./venice.js";

export type SourceFile = { path: string; content: string };
/**
 * The breaker's own account of its planted bug, in a user's terms: what goes wrong, the inputs that
 * show it, what the spec expects and what the app shows instead. If the bug gets past every test,
 * Kane, the verifier, is told this to design a test that catches it (R40); the builder never is.
 */
export type Slip = { behaviour: string; inputs: string; expected: string; observed: string };
/** `slip` is left out when the breaker did not describe its bug in full. */
export type Mutant = { patch: string; usd: number; rationale: string; slip?: Slip };

/** The most lines (added + removed) a mutant may change. */
export const MAX_PATCH_LINES = 30;
const MAX_FILES = 3;
const MAX_FILE_BYTES = 40 * 1024;
/** Stop walking a huge tree after this many entries. */
const MAX_ENTRIES = 5000;
const SKIP_DIRS = new Set(["node_modules", "kane-evidence"]);
const LOCKFILE = /^(package-lock\.json|npm-shrinkwrap\.json|pnpm-lock\.yaml|yarn\.lock|bun\.lockb?|.*\.lock)$/i;
const DOC = /\.(md|markdown|txt|rst|log)$/i;

export const PATCH_SCHEMA = {
  type: "object",
  properties: {
    patch: { type: "string" },
    rationale: { type: "string" },
    behaviour: { type: "string" },
    inputs: { type: "string" },
    expected: { type: "string" },
    observed: { type: "string" },
  },
  required: ["patch", "rationale", "behaviour", "inputs", "expected", "observed"],
  additionalProperties: false,
};

/** No call was made: the estimate would take the spend past the cap. */
export class BudgetRefused extends Error {
  constructor(
    readonly estimateUsd: number,
    readonly spentUsd: number,
    readonly capUsd: number,
  ) {
    super(`breaker budget: $${spentUsd.toFixed(4)} spent, this call could cost $${estimateUsd.toFixed(4)}, cap $${capUsd.toFixed(2)}`);
    this.name = "BudgetRefused";
  }
}

/**
 * The breaker was paid (`usd`) but sent nothing usable. `cutOff`: the token limit ended its reply
 * (or it came back empty), so asking again the same way would fail the same way.
 */
export class BreakerError extends Error {
  constructor(
    message: string,
    readonly usd: number,
    readonly cutOff = false,
  ) {
    super(message);
    this.name = "BreakerError";
  }
}

/**
 * The breaker could not be reached or answered with an error. `usd` is what it may have cost:
 * the worst-case estimate when the request may have been billed, else 0.
 */
export class BreakerUnavailable extends Error {
  constructor(
    message: string,
    readonly usd: number,
  ) {
    super(message);
    this.name = "BreakerUnavailable";
  }
}

const groupThousands = (n: string) => n.replace(/\B(?=(\d{3})+(?!\d))/g, ",");
const escapeRe = (s: string) => s.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");

/** Numbers (two or more digits, thousands separators dropped) and quoted labels in the AC text. */
export function acKeywords(text: string): string[] {
  const out = new Set<string>();
  for (const m of text.matchAll(/“([^”]+)”|"([^"]+)"|‘([^’]+)’/g)) {
    const label = (m[1] ?? m[2] ?? m[3] ?? "").trim().replace(/[\s.,;:!?]+$/, "");
    if (label.length >= 2) out.add(label);
  }
  for (const m of text.matchAll(/\d[\d,]*(?:\.\d+)?/g)) {
    const n = m[0].replace(/,/g, "");
    if (n.replace(/\D/g, "").length >= 2) out.add(n);
  }
  return [...out];
}

function matcher(keyword: string): (content: string) => boolean {
  if (/^\d+(\.\d+)?$/.test(keyword)) {
    const [int, frac] = keyword.split(".");
    const forms = [keyword, `${groupThousands(int!)}${frac === undefined ? "" : `.${frac}`}`];
    const re = new RegExp(`(?<!\\d)(?:${forms.map(escapeRe).join("|")})(?!\\d|,\\d{3}(?!\\d))`);
    return (c) => re.test(c);
  }
  const k = keyword.toLowerCase();
  return (c) => c.toLowerCase().includes(k);
}

/** Text files under `dir`, relative and `/`-separated; dot entries, dependencies and lockfiles left out. */
async function listFiles(root: string, exclude: Set<string>): Promise<string[]> {
  const out: string[] = [];
  let seen = 0;
  const walk = async (dir: string, rel: string): Promise<void> => {
    let entries;
    try {
      entries = await readdir(dir, { withFileTypes: true });
    } catch {
      return;
    }
    entries.sort((a, b) => (a.name < b.name ? -1 : a.name > b.name ? 1 : 0));
    for (const ent of entries) {
      if (++seen > MAX_ENTRIES) return;
      if (ent.name.startsWith(".")) continue; // .git, .env, caches
      const r = rel ? `${rel}/${ent.name}` : ent.name;
      if (ent.isDirectory()) {
        if (!SKIP_DIRS.has(ent.name)) await walk(path.join(dir, ent.name), r);
      } else if (ent.isFile() && !LOCKFILE.test(ent.name) && !DOC.test(ent.name) && !exclude.has(r)) {
        out.push(r);
      }
    }
  };
  await walk(root, "");
  return out;
}

async function readText(file: string): Promise<string | null> {
  const st = await stat(file);
  if (st.size > MAX_FILE_BYTES) return null;
  const h = await open(file, "r");
  try {
    const buf = await h.readFile();
    if (buf.includes(0)) return null; // binary
    return buf.toString("utf8").replace(/\r\n/g, "\n");
  } finally {
    await h.close();
  }
}

/**
 * Up to three source files the breaker is shown for `ac`: ranked by how many of the AC's
 * keywords (numbers and quoted labels) each contains, then by how recently it changed
 * (`lastChanged`, most recent first). A file with no keyword is only taken when it changed
 * recently. Skips dot entries, `node_modules`, lockfiles, docs, binaries, files over 40 KB and
 * `opts.exclude` (relative paths).
 */
export async function pickFiles(appDir: string, ac: AcState, lastChanged: string[], opts: { exclude?: string[] } = {}): Promise<SourceFile[]> {
  const exclude = new Set((opts.exclude ?? []).map((f) => f.split(path.sep).join("/")));
  const tests = acKeywords(ac.text).map(matcher);
  const recency = (f: string) => {
    const i = lastChanged.map((c) => c.split(path.sep).join("/")).indexOf(f);
    return i < 0 ? Number.POSITIVE_INFINITY : i;
  };
  const ranked: { path: string; content: string; score: number; recent: number }[] = [];
  for (const rel of await listFiles(appDir, exclude)) {
    let content: string | null;
    try {
      content = await readText(path.join(appDir, ...rel.split("/")));
    } catch {
      continue;
    }
    if (content === null) continue;
    const c = content;
    ranked.push({ path: rel, content: c, score: tests.filter((t) => t(c)).length, recent: recency(rel) });
  }
  ranked.sort((a, b) => b.score - a.score || a.recent - b.recent || (a.path < b.path ? -1 : a.path > b.path ? 1 : 0));
  const relevant = ranked.filter((f) => f.score > 0 || Number.isFinite(f.recent));
  return (relevant.length > 0 ? relevant : ranked).slice(0, MAX_FILES).map((f) => ({ path: f.path, content: f.content }));
}

/** The files a unified diff edits, app-relative (`a/`/`b/` prefixes dropped, `/dev/null` left out), in order. */
export function patchedFiles(patch: string): string[] {
  const lines = patch.split("\n");
  const paths: string[] = [];
  for (let i = 0; i < lines.length; i++) {
    if (!lines[i]!.startsWith("--- ") || !lines[i + 1]?.startsWith("+++ ")) continue;
    for (const h of [lines[i]!, lines[i + 1]!]) paths.push(h.slice(4).split("\t")[0]!.trim());
    i++;
  }
  const prefixed = paths.length > 0 && paths.every((p, i) => p.startsWith(i % 2 === 0 ? "a/" : "b/"));
  return [...new Set(paths.filter((p) => p !== "/dev/null").map((p) => (prefixed ? p.slice(2) : p)))];
}

/**
 * Checks a breaker patch before `git apply` sees it: a unified diff that only edits the files the
 * breaker was shown, changing 1..30 lines. Returns the `-p` strip level, or why it is refused.
 */
export function checkPatch(patch: string, allowed: string[], maxLines = MAX_PATCH_LINES): { strip: 0 | 1; changed: number } | { error: string } {
  const lines = patch.split("\n");
  const paths: string[] = [];
  let changed = 0;
  let hunks = 0;
  for (let i = 0; i < lines.length; i++) {
    const l = lines[i]!;
    if (l.startsWith("--- ") && lines[i + 1]?.startsWith("+++ ")) {
      for (const h of [l, lines[i + 1]!]) {
        const p = h.slice(4).split("\t")[0]!.trim();
        if (p === "/dev/null") return { error: "the patch creates or deletes a file" };
        paths.push(p);
      }
      i++;
      continue;
    }
    if (/^(rename|copy) (from|to) |^(new|deleted) file mode |^GIT binary patch|^Binary files /.test(l)) return { error: "the patch may only edit the files shown" };
    if (l.startsWith("@@")) hunks++;
    else if (l.startsWith("+") || l.startsWith("-")) changed++;
  }
  if (paths.length === 0 || hunks === 0) return { error: "not a unified diff: no ---/+++ headers with @@ hunks" };
  const prefixed = paths.every((p, i) => p.startsWith(i % 2 === 0 ? "a/" : "b/"));
  const strip: 0 | 1 = prefixed ? 1 : 0;
  const files = [...new Set(paths.map((p) => (prefixed ? p.slice(2) : p)))];
  const unknown = files.filter((f) => !allowed.includes(f));
  if (unknown.length > 0) return { error: `the patch touches files that were not shown: ${unknown.join(", ")}` };
  if (changed === 0) return { error: "the patch changes nothing" };
  if (changed > maxLines) return { error: `the patch changes ${changed} lines; the limit is ${maxLines}` };
  return { strip, changed };
}

/** Files whose leading whitespace is code (indentation): only trailing whitespace is ignored there. */
const INDENTED = /(\.(py|pyw|ya?ml|coffee|pug|jade|haml|sass|slim)|(^|\/)Makefile)$/i;
/** Files whose token stream Holdback reads (whitespace and comments outside strings are not code there). */
const TOKENIZED = /\.(m?[jt]sx?|c[jt]s|css|json)$/i;

/**
 * A changed line as code: runs of whitespace outside quotes become one space, and the line is
 * trimmed (its leading whitespace kept in an indentation-significant file). Inside quotes nothing
 * changes: that is text the page may show.
 */
function codeLine(line: string, indented: boolean): string {
  const lead = indented ? (/^\s*/.exec(line)?.[0] ?? "") : "";
  let out = "";
  let quote: string | undefined;
  let space = false;
  for (let i = lead.length; i < line.length; i++) {
    const c = line[i]!;
    if (quote) {
      out += c;
      if (c === "\\" && i + 1 < line.length) out += line[++i];
      else if (c === quote) quote = undefined;
      continue;
    }
    if (/\s/.test(c)) {
      space = true;
      continue;
    }
    if (space && out !== "") out += " ";
    space = false;
    if (c === '"' || c === "'" || c === "`") quote = c;
    out += c;
  }
  return lead + out;
}

/**
 * True when every block of lines the patch changes adds back exactly the lines it removes, as code
 * (`codeLine`), blank lines left out: m-ac-53-1 in the live demo replaced a line with itself.
 */
function sameLines(patch: string): boolean {
  let file = "";
  let blocks = 0;
  let rm: string[] = [];
  let add: string[] = [];
  let same = true;
  const close = () => {
    if (rm.length === 0 && add.length === 0) return;
    blocks++;
    const ind = INDENTED.test(file);
    const norm = (l: string[]) => l.map((x) => codeLine(x, ind)).filter((x) => x.trim() !== "");
    const [a, b] = [norm(rm), norm(add)];
    if (a.length !== b.length || a.some((x, i) => x !== b[i])) same = false;
    rm = [];
    add = [];
  };
  const lines = patch.split("\n");
  for (let i = 0; i < lines.length; i++) {
    const l = lines[i]!;
    if (l.startsWith("--- ") && lines[i + 1]?.startsWith("+++ ")) {
      close();
      file = lines[i + 1]!.slice(4).split("\t")[0]!.trim();
      i++;
    } else if (l.startsWith("-")) rm.push(l.slice(1));
    else if (l.startsWith("+")) add.push(l.slice(1));
    else if (!l.startsWith("\\")) close();
  }
  close();
  return blocks > 0 && same;
}

/** A source file's tokens: whitespace and comments outside strings left out, every string literal whole. */
function tokens(file: string, src: string): string[] {
  const lineComments = !/\.css$/i.test(file);
  const out: string[] = [];
  const n = src.length;
  let i = 0;
  while (i < n) {
    const c = src[i]!;
    if (/\s/.test(c)) i++;
    else if (c === "/" && src[i + 1] === "/" && lineComments) {
      while (i < n && src[i] !== "\n") i++;
    } else if (c === "/" && src[i + 1] === "*") {
      const end = src.indexOf("*/", i + 2);
      i = end < 0 ? n : end + 2;
    } else if (c === '"' || c === "'" || c === "`") {
      let j = i + 1;
      while (j < n && src[j] !== c && (c === "`" || src[j] !== "\n")) j += src[j] === "\\" ? 2 : 1;
      out.push(src.slice(i, j + 1));
      i = j + 1;
    } else if (/[\w$]/.test(c)) {
      let j = i;
      while (j < n && /[\w$]/.test(src[j]!)) j++;
      out.push(src.slice(i, j));
      i = j;
    } else {
      out.push(c);
      i++;
    }
  }
  return out;
}

/**
 * Why a breaker patch changes no code, or undefined when it does (or Holdback cannot tell). A mutant
 * that changes no code proves nothing either way: it is never replayed. Two checks: every changed
 * line is the line it replaces once whitespace outside quotes is normalised (the patch alone), or,
 * for a JavaScript, TypeScript, CSS or JSON file, the file's tokens are the same before and after
 * (`before`/`after`: the patched files' contents): a comment, a line split in two.
 */
export function noOpReason(patch: string, before: SourceFile[], after: SourceFile[]): string | undefined {
  if (sameLines(patch)) return "every line it changes is the same line once whitespace is normalised";
  const files = patchedFiles(patch);
  if (files.length === 0) return undefined;
  for (const f of files) {
    const a = before.find((x) => x.path === f);
    const b = after.find((x) => x.path === f);
    if (!a || !b || !TOKENIZED.test(f)) return undefined;
    const [ta, tb] = [tokens(f, a.content.replace(/\r\n/g, "\n")), tokens(f, b.content.replace(/\r\n/g, "\n"))];
    if (ta.length !== tb.length || ta.some((t, i) => t !== tb[i])) return undefined;
  }
  return "it leaves the code's tokens as they were: only whitespace or comments change";
}

const SYSTEM = [
  "You are the breaker in a mutation test of a web app.",
  "Browser tests check that the app meets one acceptance criterion (AC). Write the smallest change to the app's source that makes the running app violate exactly this AC, so that a correct test of the AC fails, while the app still starts and everything else keeps working as before.",
  "Rules:",
  `- Change only the files shown, at most ${MAX_PATCH_LINES} changed lines in total. Do not create, delete or rename files.`,
  "- The violation must be visible in the browser (a wrong decision, text or number), not a crash or a page that fails to load.",
  '- Reply with JSON {"patch": string, "rationale": string, "behaviour": string, "inputs": string, "expected": string, "observed": string}. `patch` is a unified diff that `git apply` accepts: `--- a/<path>` and `+++ b/<path>` headers with each path exactly as shown, then `@@` hunks whose context lines are copied exactly from the file. `rationale` is one sentence on how the change violates the AC.',
  "- Then describe the bug as a user meets it in the browser, without code: `behaviour` is what a user would see go wrong, in one sentence; `inputs` the concrete values they enter or pick that show it; `expected` what the page should show for those inputs, per the AC; `observed` what the changed app shows instead.",
].join("\n");

function messagesFor(ac: AcState, files: SourceFile[], retry?: { patch: string; error: string }): ChatMessage[] {
  const cite = ac.cites[0];
  const parts = [`AC ${ac.id}: ${ac.text}`];
  if (cite) parts.push(`Spec: "${cite.quote}" (${cite.source} ${cite.anchor})`);
  for (const f of files) parts.push(`<file path="${f.path}">\n${f.content}${f.content.endsWith("\n") ? "" : "\n"}</file>`);
  if (retry) {
    parts.push(`Your previous patch failed: ${retry.error}\n\nPrevious patch:\n${retry.patch}\n\nSend a corrected patch against the files above.`);
  }
  return [
    { role: "system", content: SYSTEM },
    { role: "user", content: parts.join("\n\n") },
  ];
}

const isObj = (v: unknown): v is Record<string, unknown> => v !== null && typeof v === "object" && !Array.isArray(v);

export type ProposeOptions = {
  model: string;
  apiKey: string;
  budget: Budget;
  /** Default: `veniceChat`. */
  chat?: typeof veniceChat;
  /** A second attempt: the patch that failed and why. */
  retry?: { patch: string; error: string };
  /** Completion-token cap of the call (estimated in full against the budget). Default `MAX_TOKENS`. */
  maxTokens?: number;
};

/**
 * Ask the breaker for the smallest patch that makes the app violate exactly `ac`. Refuses
 * (BudgetRefused, no call) when the call's worst case would pass the cap; a paid reply without
 * a usable patch throws BreakerError carrying its cost; an outage throws BreakerUnavailable
 * (charged at the worst case when the request may have been billed).
 */
export async function proposeMutant(ac: AcState, files: SourceFile[], opts: ProposeOptions): Promise<Mutant> {
  const messages = messagesFor(ac, files, opts.retry);
  const maxTokens = opts.maxTokens ?? MAX_TOKENS;
  const est = estimateUsd(opts.model, messages, maxTokens);
  if (!opts.budget.canSpend(est)) throw new BudgetRefused(est, opts.budget.spent, opts.budget.capUsd);
  const chat = opts.chat ?? veniceChat;
  let reply;
  try {
    reply = await chat({ model: opts.model, messages, schema: PATCH_SCHEMA, apiKey: opts.apiKey, ...(opts.maxTokens === undefined ? {} : { maxTokens }) });
  } catch (e) {
    if (e instanceof VeniceOutputError) throw new BreakerError(e.message, opts.budget.charge(opts.model, e.usage), e.cutOff);
    if (e instanceof VeniceUnreachable) {
      const chars = messages.reduce((n, m) => n + m.content.length, 0);
      throw new BreakerUnavailable(e.message, opts.budget.charge(opts.model, { prompt_tokens: chars / 4, completion_tokens: maxTokens }));
    }
    if (e instanceof VeniceHttpError) throw new BreakerUnavailable(e.message, 0);
    throw e;
  }
  const usd = opts.budget.charge(opts.model, reply.usage);
  const j = reply.json;
  if (!isObj(j) || typeof j.patch !== "string" || j.patch.trim() === "") throw new BreakerError("the breaker's reply has no patch", usd);
  const patch = j.patch.replace(/\r\n/g, "\n").replace(/\n*$/, "\n");
  const text = (k: keyof Slip) => (typeof j[k] === "string" ? (j[k] as string).trim() : "");
  const slip: Slip = { behaviour: text("behaviour"), inputs: text("inputs"), expected: text("expected"), observed: text("observed") };
  const rationale = typeof j.rationale === "string" ? j.rationale.trim() : "";
  return Object.values(slip).every((v) => v !== "") ? { patch, usd, rationale, slip } : { patch, usd, rationale };
}
