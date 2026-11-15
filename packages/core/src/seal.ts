import { createHash } from "node:crypto";
import { readdir, readFile, readlink } from "node:fs/promises";
import path from "node:path";

const SEALED_DIRS = [".testmuai/tests", ".testmuai/variables"];

type Entry = { rel: string; kind: "file" | "symlink" | "special" };

async function walk(dir: string, rel: string, out: Entry[]): Promise<void> {
  let entries;
  try {
    entries = await readdir(dir, { withFileTypes: true });
  } catch (e) {
    if ((e as NodeJS.ErrnoException).code === "ENOENT") return;
    throw e;
  }
  for (const ent of entries) {
    const r = `${rel}/${ent.name}`;
    // Dirent is lstat-based: symlinks/junctions are never followed.
    if (ent.isSymbolicLink()) out.push({ rel: r, kind: "symlink" });
    else if (ent.isDirectory()) await walk(path.join(dir, ent.name), r, out);
    else if (ent.isFile()) out.push({ rel: r, kind: "file" });
    else out.push({ rel: r, kind: "special" });
  }
}

/** sha256 of every file under .testmuai/tests and .testmuai/variables, keyed by `/` relative path. */
export async function seal(verifierDir: string): Promise<Record<string, string>> {
  const files: Entry[] = [];
  for (const d of SEALED_DIRS) await walk(path.join(verifierDir, ...d.split("/")), d, files);
  files.sort((a, b) => (a.rel < b.rel ? -1 : a.rel > b.rel ? 1 : 0));
  const manifest: Record<string, string> = {};
  for (const { rel, kind } of files) {
    const abs = path.join(verifierDir, ...rel.split("/"));
    if (kind === "symlink") manifest[rel] = "symlink:" + (await readlink(abs).catch(() => "?"));
    else if (kind === "special") manifest[rel] = "special";
    else manifest[rel] = createHash("sha256").update(await readFile(abs)).digest("hex");
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
