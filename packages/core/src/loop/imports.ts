import { readdir, readFile, stat, writeFile } from "node:fs/promises";
import path from "node:path";
import { parseTestMd } from "../kane/testmd-parse.js";

/**
 * Kane 0.10.4 on Windows (live run, 2026-11-17) wrote a test that imports another one as
 * `@import ./C:\Users\…\verifier\.testmuai\tests\<name>_test.md`: an absolute path joined after
 * `./`, which `testmd run` cannot resolve ("@import path not found"), so the test can never run.
 * Before the human approves the tests, Holdback points such an import at the file of that name in
 * the same folder, and shows the human what it changed; an import that resolves to nothing is shown
 * on its test instead.
 */

const IMPORT = /^(\s*@import\s+)(\S(?:.*\S)?)\s*$/;
/** `./` (or `.\`) followed by a Windows drive path or a rooted path. */
const ABSOLUTE_AFTER_DOT = /^\.[\\/](?=[A-Za-z]:[\\/]|[\\/])/;

/** The targets of a test file's `@import` lines, as written. */
export function importTargets(text: string): string[] {
  const out: string[] = [];
  for (const line of text.split("\n")) {
    const m = IMPORT.exec(line.replace(/\r$/, ""));
    if (m) out.push(m[2]!);
  }
  return out;
}

/** One import Holdback rewrote: `file` relative to the verifier (`/`), `line` 1-based, both lines as they read. */
export type ImportRepair = { file: string; test?: string; line: number; from: string; to: string };
/** One import that names no file: `target` as Kane wrote it. */
export type BrokenImport = { file: string; test?: string; line: number; target: string };
export type ImportLint = { repaired: ImportRepair[]; broken: BrokenImport[] };

const isFile = (f: string) => stat(f).then((s) => s.isFile(), () => false);

/**
 * Checks the `@import` line of every `*_test.md` in the verifier's tests folder. One whose target is
 * an absolute path after `./` is rewritten to `./<file name>` when that file is in the same folder
 * (the rest of the file byte for byte as it was, line endings too); `onRepair` hears of each repair
 * before its file is written, so its record comes first (a record that fails leaves the file as it
 * was). One it cannot repair is broken, whatever that absolute path names (`testmd run` never
 * resolves it), as is any other import that resolves to no file; its test is left as Kane wrote it.
 */
export async function lintImports(verifierDir: string, onRepair: (r: ImportRepair) => Promise<void> = async () => {}): Promise<ImportLint> {
  const dir = path.join(verifierDir, ".testmuai", "tests");
  let names: string[];
  try {
    names = (await readdir(dir)).filter((n) => n.endsWith("_test.md")).sort();
  } catch (e) {
    if ((e as NodeJS.ErrnoException).code === "ENOENT") return { repaired: [], broken: [] };
    throw e;
  }
  const out: ImportLint = { repaired: [], broken: [] };
  for (const name of names) {
    const file = path.join(dir, name);
    const text = await readFile(file, "utf8");
    if (!text.includes("@import")) continue;
    const rel = path.relative(verifierDir, file).split(path.sep).join("/");
    const id = parseTestMd(text).id ?? undefined;
    const tag = id ? { test: id } : {};
    const lines = text.split("\n");
    const repairs: ImportRepair[] = [];
    for (let i = 0; i < lines.length; i++) {
      const cr = lines[i]!.endsWith("\r") ? "\r" : "";
      const line = cr ? lines[i]!.slice(0, -1) : lines[i]!;
      const m = IMPORT.exec(line);
      if (!m) continue;
      const target = m[2]!;
      if (ABSOLUTE_AFTER_DOT.test(target)) {
        const base = target.split(/[\\/]/).pop() ?? "";
        if (base !== "" && (await isFile(path.join(dir, base)))) {
          const fixed = `${m[1]}./${base}`;
          lines[i] = fixed + cr;
          repairs.push({ file: rel, ...tag, line: i + 1, from: line.trim(), to: fixed.trim() });
        } else out.broken.push({ file: rel, ...tag, line: i + 1, target });
        continue;
      }
      if (!(await isFile(path.resolve(dir, target)))) out.broken.push({ file: rel, ...tag, line: i + 1, target });
    }
    if (repairs.length === 0) continue;
    for (const r of repairs) await onRepair(r);
    await writeFile(file, lines.join("\n"), "utf8");
    out.repaired.push(...repairs);
  }
  return out;
}
