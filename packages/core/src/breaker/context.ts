import type { SourceFile } from "./mutate.js";

/** A file a planted bug changes: as it was, and as the patch leaves it (LF line endings). */
export type PatchedCode = { path: string; before: string; after: string };

/**
 * The referee is shown each changed file whole, before and after the change, while both fit in about
 * this many prompt tokens (~4 characters each); past it, excerpts (`codeForReferee`).
 */
export const REFEREE_CODE_TOKENS = 12_000;
/** A quote shorter than this, whitespace aside, shows nothing about a page (`}`, `return`). */
const MIN_QUOTE = 8;
/** An enclosing statement longer than this is cut to the lines around the change. */
const MAX_BLOCK_LINES = 120;
const AROUND = 30;
/** Files read with a bracket-and-string scanner to find top-level statements; others by indentation. */
const BRACKETED = /\.(m?[jt]sx?|c[jt]s|css|json|java|kt|cs|go|rs|c|cc|cpp|h|hpp|php|swift|scala|dart)$/i;
/** Words never searched for as definitions: keywords and literals. */
const KEYWORDS = new Set(
  "if else for while do switch case default break continue return function const let var new this typeof instanceof in of void delete throw try catch finally class extends super import export from as async await yield true false null undefined NaN Infinity def elif lambda pass None True False self and or not is with".split(" "),
);
const SQL_TYPES = "TEXT|INTEGER|INT|REAL|NUMERIC|BLOB|BOOLEAN|BOOL|VARCHAR|CHAR|DATE|DATETIME|TIMESTAMP|SERIAL|BIGINT|FLOAT|DOUBLE|DECIMAL|JSONB?|UUID";

const escapeRe = (s: string) => s.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
const norm = (s: string) => s.replace(/\s+/g, " ").trim();

type Hunk = { start: number; lines: string[] };

/** The hunks of a unified diff, by the file they edit (`a/`/`b/` prefixes dropped). */
function parseDiff(patch: string): { path: string; hunks: Hunk[] }[] {
  const lines = patch.replace(/\r\n/g, "\n").split("\n");
  const files: { path: string; hunks: Hunk[] }[] = [];
  let hunk: Hunk | undefined;
  for (let i = 0; i < lines.length; i++) {
    const l = lines[i]!;
    if (l.startsWith("--- ") && lines[i + 1]?.startsWith("+++ ")) {
      const raw = lines[i + 1]!.slice(4).split("\t")[0]!.trim();
      const old = l.slice(4).split("\t")[0]!.trim();
      const p = raw === "/dev/null" ? old : raw;
      files.push({ path: /^[ab]\//.test(p) ? p.slice(2) : p, hunks: [] });
      hunk = undefined;
      i++;
      continue;
    }
    const h = /^@@ -(\d+)(?:,\d+)? \+\d+(?:,\d+)? @@/.exec(l);
    if (h && files.length > 0) {
      hunk = { start: Number(h[1]), lines: [] };
      files.at(-1)!.hunks.push(hunk);
      continue;
    }
    if (!hunk) continue;
    if (l.startsWith("\\")) continue; // "\ No newline at end of file"
    if (l.startsWith(" ") || l.startsWith("-") || l.startsWith("+")) hunk.lines.push(l);
    // a blank context line that lost its leading space
    else if (l === "" && i < lines.length - 1) hunk.lines.push(" ");
    else hunk = undefined;
  }
  return files.filter((f) => f.hunks.length > 0);
}

/**
 * The files a patch changes, before and after it, applied in memory as `git apply --recount
 * --ignore-whitespace` would: each hunk found by its context and removed lines (whitespace runs
 * aside), nearest the line it names, after the hunk before it; the file's own context lines kept.
 * Undefined when a file is not among `files` or a hunk's lines are not in it.
 */
export function patchInMemory(files: SourceFile[], patch: string): PatchedCode[] | undefined {
  const diff = parseDiff(patch);
  if (diff.length === 0) return undefined;
  const out: PatchedCode[] = [];
  for (const d of diff) {
    const f = files.find((x) => x.path === d.path);
    if (!f) return undefined;
    const before = f.content.replace(/\r\n/g, "\n");
    const lines = before.split("\n");
    let from = 0;
    for (const h of d.hunks) {
      const old = h.lines.filter((l) => !l.startsWith("+")).map((l) => norm(l.slice(1)));
      const want = Math.max(from, h.start - 1 + (lines.length - before.split("\n").length));
      let at = -1;
      if (old.length === 0) at = Math.min(Math.max(from, h.start), lines.length);
      else {
        let best = Number.POSITIVE_INFINITY;
        for (let i = from; i + old.length <= lines.length; i++) {
          if (!old.every((o, k) => norm(lines[i + k]!) === o)) continue;
          if (Math.abs(i - want) < best) {
            best = Math.abs(i - want);
            at = i;
          }
        }
      }
      if (at < 0) return undefined;
      const next: string[] = [];
      let k = at;
      for (const l of h.lines) {
        if (l.startsWith("+")) next.push(l.slice(1));
        else if (l.startsWith(" ")) next.push(lines[k++]!);
        else k++;
      }
      lines.splice(at, k - at, ...next);
      from = at + next.length;
    }
    out.push({ path: d.path, before, after: lines.join("\n") });
  }
  return out;
}

/**
 * The lines (0-based) a change removes from `before` and adds to `after`, by a line diff. A change
 * that only adds lines names the line before them on the `before` side (and one that only removes,
 * on the `after` side), so the code around it is still found.
 */
export function changedLines(before: string, after: string): { before: number[]; after: number[] } {
  const a = before.split("\n");
  const b = after.split("\n");
  let p = 0;
  while (p < a.length && p < b.length && a[p] === b[p]) p++;
  let s = 0;
  while (s < a.length - p && s < b.length - p && a[a.length - 1 - s] === b[b.length - 1 - s]) s++;
  const A = a.slice(p, a.length - s);
  const B = b.slice(p, b.length - s);
  const out = { before: new Set<number>(), after: new Set<number>() };
  const mark = (rmFrom: number, rmTo: number, addFrom: number, addTo: number) => {
    if (rmFrom === rmTo && addFrom === addTo) return;
    if (rmFrom < rmTo) for (let i = rmFrom; i < rmTo; i++) out.before.add(p + i);
    else out.before.add(Math.max(0, p + rmFrom - 1));
    if (addFrom < addTo) for (let j = addFrom; j < addTo; j++) out.after.add(p + j);
    else out.after.add(Math.max(0, p + addFrom - 1));
  };
  const n = A.length;
  const m = B.length;
  if (n * m > 4_000_000) mark(0, n, 0, m);
  else {
    // longest common subsequence of the middle, from the end
    const w = m + 1;
    const lcs = new Uint32Array((n + 1) * w);
    for (let i = n - 1; i >= 0; i--) for (let j = m - 1; j >= 0; j--) lcs[i * w + j] = A[i] === B[j] ? lcs[(i + 1) * w + j + 1]! + 1 : Math.max(lcs[(i + 1) * w + j]!, lcs[i * w + j + 1]!);
    let i = 0;
    let j = 0;
    let ri = 0;
    let rj = 0;
    while (i < n || j < m) {
      if (i < n && j < m && A[i] === B[j]) {
        mark(ri, i, rj, j);
        i++;
        j++;
        ri = i;
        rj = j;
      } else if (j >= m || (i < n && lcs[(i + 1) * w + j]! >= lcs[i * w + j + 1]!)) i++;
      else j++;
    }
    mark(ri, i, rj, j);
  }
  const sorted = (x: Set<number>) => [...x].sort((u, v) => u - v);
  return { before: sorted(out.before), after: sorted(out.after) };
}

/**
 * Per line: does a top-level statement start there? An unindented line that does not start by
 * closing a bracket; in a bracketed language, one that also starts outside every bracket, string,
 * template literal, regular expression and comment.
 */
function statementStarts(file: string, lines: string[]): boolean[] {
  const blank = (l: string) => l.trim() === "";
  const closer = (l: string) => /^\s*[\]})]/.test(l);
  if (!BRACKETED.test(file)) return lines.map((l) => !blank(l) && !/^\s/.test(l) && !closer(l));
  type Ctx = { tpl: false; depth: number } | { tpl: true };
  const stack: Ctx[] = [{ tpl: false, depth: 0 }];
  let comment = false;
  const starts: boolean[] = [];
  for (const line of lines) {
    const top = stack.at(-1)!;
    starts.push(!comment && stack.length === 1 && !top.tpl && top.depth === 0 && !blank(line) && !/^\s/.test(line) && !closer(line));
    for (let i = 0; i < line.length; i++) {
      const c = line[i]!;
      const ctx = stack.at(-1)!;
      if (comment) {
        if (c === "*" && line[i + 1] === "/") {
          comment = false;
          i++;
        }
        continue;
      }
      if (ctx.tpl) {
        if (c === "\\") i++;
        else if (c === "`") stack.pop();
        else if (c === "$" && line[i + 1] === "{") {
          stack.push({ tpl: false, depth: 0 });
          i++;
        }
        continue;
      }
      if (c === "/" && line[i + 1] === "/") break;
      if (c === "/" && line[i + 1] === "*") {
        comment = true;
        i++;
      } else if (c === "/" && /(^|[(,=:[!&|?{};+\-*%<>~^]|\breturn|\btypeof)\s*$/.test(line.slice(0, i))) {
        // a regular expression literal: its quotes and brackets are not code
        let j = i + 1;
        let cls = false;
        while (j < line.length && (cls || line[j] !== "/")) {
          if (line[j] === "\\") j++;
          else if (line[j] === "[") cls = true;
          else if (line[j] === "]") cls = false;
          j++;
        }
        i = j;
      } else if (c === "'" || c === '"') {
        let j = i + 1;
        while (j < line.length && line[j] !== c) j += line[j] === "\\" ? 2 : 1;
        i = j;
      } else if (c === "`") stack.push({ tpl: true });
      else if ("{[(".includes(c)) ctx.depth++;
      else if ("}])".includes(c)) {
        if (ctx.depth === 0 && stack.length > 1) stack.pop(); // the end of a template's ${…}
        else ctx.depth = Math.max(0, ctx.depth - 1);
      }
    }
  }
  return starts;
}

type Range = [number, number];

/** The top-level statement around line `i` (a function, a declaration), cut to the lines around `i` when it is long. */
function blockAround(starts: boolean[], lines: string[], i: number): Range {
  let s = i;
  while (s > 0 && !starts[s]) s--;
  let e = i;
  while (e + 1 < lines.length && !starts[e + 1]) e++;
  while (e > i && lines[e]!.trim() === "") e--;
  if (e - s + 1 > MAX_BLOCK_LINES) return [Math.max(s, i - AROUND), Math.min(e, i + AROUND)];
  return [s, e];
}

/** Does line `l` define `name`: a declaration, a parameter default or assignment, an object key, a schema column? */
function defines(l: string, name: string): boolean {
  const n = escapeRe(name);
  return [
    new RegExp(`\\b(?:const|let|var|function\\*?|class|def|type|interface|enum)\\s+${n}\\b`),
    new RegExp(`\\b(?:const|let|var)\\s*[{[][^=]*\\b${n}\\b[^=]*[}\\]]\\s*=`),
    new RegExp(`(?:^|[^.\\w$])${n}\\s*=(?![=>])`),
    new RegExp(`(?:^|[{,]\\s*)${n}\\s*:(?!:)`),
    new RegExp(`^\\s*${n}\\s+(?:${SQL_TYPES})\\b`, "i"),
  ].some((re) => re.test(l));
}

/** The names a line uses: identifiers and property names, keywords left out. */
function namesIn(line: string): string[] {
  return [...new Set(line.match(/[A-Za-z_$][\w$]*/g) ?? [])].filter((w) => w.length > 1 && !KEYWORDS.has(w));
}

const inRanges = (ranges: Range[], i: number) => ranges.some(([s, e]) => i >= s && i <= e);
const sizeOf = (lines: string[], [s, e]: Range) => lines.slice(s, e + 1).reduce((n, l) => n + l.length + 1, 0);

/**
 * The parts of `src` the referee is shown when the whole file is too long: the top-level statement
 * around each changed line, then the statements that define a name the changed lines use (one not
 * defined in those already), until `maxChars`. Sorted, overlapping ranges merged.
 */
function excerpt(file: string, src: string, changed: number[], maxChars: number): Range[] {
  const lines = src.split("\n");
  const starts = statementStarts(file, lines);
  const ranges: Range[] = [];
  let used = 0;
  const add = (r: Range, force = false): boolean => {
    const extra: Range[] = [];
    // only the part not shown yet counts
    for (let i = r[0]; i <= r[1]; i++) {
      if (inRanges(ranges, i)) continue;
      const last = extra.at(-1);
      if (last && last[1] === i - 1) last[1] = i;
      else extra.push([i, i]);
    }
    const size = extra.reduce((n, x) => n + sizeOf(lines, x), 0);
    if (!force && used + size > maxChars) return false;
    ranges.push(...extra);
    used += size;
    return true;
  };
  for (const i of changed) if (i < lines.length) add(blockAround(starts, lines, i), true);
  const names = [...new Set(changed.flatMap((i) => namesIn(lines[i] ?? "")))];
  for (const name of names) {
    const defs = lines.flatMap((l, i) => (defines(l, name) ? [i] : []));
    // a name defined where the change is (a local, a parameter) uses that definition; a property
    // (`booked.proxy`) is set wherever its object is built, so every definition counts
    const property = changed.some((i) => new RegExp(`\\.\\s*${escapeRe(name)}\\b`).test(lines[i] ?? ""));
    if (property || !defs.some((i) => inRanges(ranges, i))) {
      for (const i of defs) if (!inRanges(ranges, i)) add(blockAround(starts, lines, i));
    }
  }
  const sorted = ranges.sort((x, y) => x[0] - y[0]);
  const merged: Range[] = [];
  for (const r of sorted) {
    const last = merged.at(-1);
    if (last && r[0] <= last[1] + 1) last[1] = Math.max(last[1], r[1]);
    else merged.push([...r]);
  }
  return merged;
}

/** What the referee is shown of the code (`text`), and the code after the change it was shown (`after`), which its quote must come from. */
export type RefereeCode = { text: string; after: string; whole: boolean };

const fence = (path: string, side: string, body: string) => `<<<<< ${path} (${side})\n${body}\n>>>>> end of ${path} (${side})`;
/** Joins pieces of code shown apart, so a quote never spans two of them. */
const APART = "\n\u0000\n";

/**
 * The changed files for the referee's prompt: each whole, before and after the change, while all of
 * them fit in `maxTokens` (~4 characters a token); else, per side and file, the top-level statements
 * around the change and those defining the names the changed lines use, each headed by its line
 * numbers. With no file (the code moved since the bug was planted), it says so, and the patch's own
 * lines after the change stand for the code.
 */
export function codeForReferee(code: PatchedCode[], patch: string, maxTokens = REFEREE_CODE_TOKENS): RefereeCode {
  if (code.length === 0) {
    const after = parseDiff(patch)
      .flatMap((f) => f.hunks.map((h) => h.lines.filter((l) => !l.startsWith("-")).map((l) => l.slice(1)).join("\n")))
      .join(APART);
    return { text: "The changed file is not available (the code moved since this bug was planted): judge from the patch alone.", after, whole: false };
  }
  const maxChars = maxTokens * 4;
  const total = code.reduce((n, f) => n + f.before.length + f.after.length, 0);
  if (total <= maxChars) {
    const parts = code.flatMap((f) => [
      `The changed file ${f.path} before the change:\n${fence(f.path, "before", f.before)}`,
      `The same file after the change (the app under test runs this code):\n${fence(f.path, "after", f.after)}`,
    ]);
    return { text: parts.join("\n\n"), after: code.map((f) => f.after).join(APART), whole: true };
  }
  const perSide = Math.floor(maxChars / 2 / code.length);
  const parts: string[] = [];
  const shownAfter: string[] = [];
  for (const f of code) {
    const changed = changedLines(f.before, f.after);
    for (const side of ["before", "after"] as const) {
      const src = f[side];
      const lines = src.split("\n");
      const ranges = excerpt(f.path, src, changed[side], perSide);
      const body = ranges.map(([s, e]) => `[lines ${s + 1}-${e + 1}]\n${lines.slice(s, e + 1).join("\n")}`).join("\n");
      const head =
        side === "before"
          ? `The changed file ${f.path} (${lines.length - (src.endsWith("\n") ? 1 : 0)} lines) is too long to show whole. Below, before the change and after it, the code around the change and the code that defines the names the changed lines use, each part headed by its line numbers.`
          : "The same parts after the change (the app under test runs this code):";
      parts.push(`${head}\n${fence(f.path, `${side}, excerpts`, body)}`);
      if (side === "after") shownAfter.push(...ranges.map(([s, e]) => lines.slice(s, e + 1).join("\n")));
    }
  }
  return { text: parts.join("\n\n"), after: shownAfter.join(APART), whole: false };
}

/**
 * Is `quote` a piece of `code` as given: whitespace runs aside, and one pair of backticks or quotes
 * around it, or a diff's `+` in front, taken off? At least 8 characters besides whitespace.
 */
export function quotedIn(quote: string, code: string): boolean {
  const q = norm(quote);
  const forms = new Set([q]);
  const bare = /^([`"'])(.*)\1$/.exec(q);
  if (bare) forms.add(norm(bare[2]!));
  for (const f of [...forms]) if (f.startsWith("+")) forms.add(norm(f.slice(1)));
  const hay = norm(code);
  return [...forms].some((f) => f.replace(/\s/g, "").length >= MIN_QUOTE && hay.includes(f));
}
