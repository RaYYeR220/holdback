import { createHash } from "node:crypto";
import { readdir, readFile, readlink } from "node:fs/promises";
import path from "node:path";

type Scope = {
  /** Directory names not descended into. */
  skipDir: (name: string) => boolean;
  /** Entry names (file, symlink or special) that are sealed. */
  keep: (name: string) => boolean;
};

// Tests: only the `*_test.md` files Kane designed. Kane writes its run recordings into
// `output-<name>/` folders next to them; those are Kane's, not part of the seal.
const TESTS: Scope = { skipDir: (n) => n.startsWith("output-"), keep: (n) => n.endsWith("_test.md") };
const EVERYTHING: Scope = { skipDir: () => false, keep: () => true };
const SEALED_DIRS: [string, Scope][] = [
  [".testmuai/tests", TESTS],
  [".testmuai/variables", EVERYTHING],
];

type Entry = { rel: string; kind: "file" | "symlink" | "special" };

async function walk(dir: string, rel: string, scope: Scope, out: Entry[]): Promise<void> {
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
    if (ent.isDirectory()) {
      if (!scope.skipDir(ent.name)) await walk(path.join(dir, ent.name), r, scope, out);
    } else if (!scope.keep(ent.name)) continue;
    else if (ent.isSymbolicLink()) out.push({ rel: r, kind: "symlink" });
    else if (ent.isFile()) out.push({ rel: r, kind: "file" });
    else out.push({ rel: r, kind: "special" });
  }
}

/** App-dir files that are sealed too (the app repo is agent-writable). Keyed `app:<rel>`. */
export type AppSeal = { appDir: string; files: string[] };

const APP_PREFIX = "app:";

async function hashAppFile(appDir: string, rel: string): Promise<string> {
  try {
    return createHash("sha256").update(await readFile(path.join(appDir, ...rel.split("/")))).digest("hex");
  } catch (e) {
    if ((e as NodeJS.ErrnoException).code === "ENOENT") return "absent";
    throw e;
  }
}

/**
 * sha256 of every `*_test.md` under .testmuai/tests (Kane's `output-*` recording folders excluded)
 * and every file under .testmuai/variables, keyed by `/` relative path; plus `app:<rel>` entries
 * when `app` is given.
 */
export async function seal(verifierDir: string, app?: AppSeal): Promise<Record<string, string>> {
  const files: Entry[] = [];
  for (const [d, scope] of SEALED_DIRS) await walk(path.join(verifierDir, ...d.split("/")), d, scope, files);
  files.sort((a, b) => (a.rel < b.rel ? -1 : a.rel > b.rel ? 1 : 0));
  const manifest: Record<string, string> = {};
  for (const { rel, kind } of files) {
    const abs = path.join(verifierDir, ...rel.split("/"));
    if (kind === "symlink") manifest[rel] = "symlink:" + (await readlink(abs).catch(() => "?"));
    else if (kind === "special") manifest[rel] = "special";
    else manifest[rel] = createHash("sha256").update(await readFile(abs)).digest("hex");
  }
  if (app) {
    for (const f of app.files) {
      const rel = f.split(path.sep).join("/");
      manifest[APP_PREFIX + rel] = await hashAppFile(app.appDir, rel);
    }
  }
  return manifest;
}

/** Sorted relative paths that were changed, deleted or added since the manifest was sealed. */
export async function checkSeal(
  verifierDir: string,
  manifest: Record<string, string>,
  appDir?: string,
): Promise<string[]> {
  const now = await seal(verifierDir);
  const bad = new Set<string>();
  for (const [k, h] of Object.entries(manifest)) {
    if (k.startsWith(APP_PREFIX)) {
      if (appDir !== undefined && (await hashAppFile(appDir, k.slice(APP_PREFIX.length))) !== h) bad.add(k);
    } else if (now[k] !== h) bad.add(k);
  }
  for (const k of Object.keys(now)) if (!(k in manifest)) bad.add(k);
  return [...bad].sort();
}
