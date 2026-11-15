import { createHash } from "node:crypto";
import { readdir, readFile } from "node:fs/promises";
import path from "node:path";

const SEALED_DIRS = [".testmuai/tests", ".testmuai/variables"];

async function walk(dir: string, rel: string, out: string[]): Promise<void> {
  let entries;
  try {
    entries = await readdir(dir, { withFileTypes: true });
  } catch (e) {
    if ((e as NodeJS.ErrnoException).code === "ENOENT") return;
    throw e;
  }
  for (const ent of entries) {
    const r = `${rel}/${ent.name}`;
    if (ent.isDirectory()) await walk(path.join(dir, ent.name), r, out);
    else if (ent.isFile()) out.push(r);
  }
}

/** sha256 of every file under .testmuai/tests and .testmuai/variables, keyed by `/` relative path. */
export async function seal(verifierDir: string): Promise<Record<string, string>> {
  const files: string[] = [];
  for (const d of SEALED_DIRS) await walk(path.join(verifierDir, ...d.split("/")), d, files);
  const manifest: Record<string, string> = {};
  for (const rel of files.sort()) {
    const buf = await readFile(path.join(verifierDir, ...rel.split("/")));
    manifest[rel] = createHash("sha256").update(buf).digest("hex");
  }
  return manifest;
}

/** Sorted relative paths that were changed, deleted or added since the manifest was sealed. */
export async function checkSeal(
  verifierDir: string,
  manifest: Record<string, string>,
): Promise<string[]> {
  const now = await seal(verifierDir);
  const bad = new Set<string>();
  for (const [k, h] of Object.entries(manifest)) if (now[k] !== h) bad.add(k);
  for (const k of Object.keys(now)) if (!(k in manifest)) bad.add(k);
  return [...bad].sort();
}
