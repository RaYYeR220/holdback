import { createHash } from "node:crypto";
import { readdir, readFile, readlink } from "node:fs/promises";
import path from "node:path";

const TESTS_DIR = ".testmuai/tests";
const VARIABLES_DIR = ".testmuai/variables";
/** Kane writes each run's recording into an `output-<name>/` folder next to the test. */
const isRecordingDir = (name: string) => name.startsWith("output-");

type Entry = { rel: string; kind: "file" | "symlink" | "special" };

/**
 * Every entry under `dir` (lstat-based: symlinks/junctions are recorded, never followed).
 * `recordings`: "skip" leaves `output-*` folders out, "only" keeps nothing but their contents.
 */
async function walk(dir: string, rel: string, recordings: "skip" | "only" | "all", out: Entry[]): Promise<void> {
  let entries;
  try {
    entries = await readdir(dir, { withFileTypes: true });
  } catch (e) {
    if ((e as NodeJS.ErrnoException).code === "ENOENT") return;
    throw e;
  }
  for (const ent of entries) {
    const r = `${rel}/${ent.name}`;
    if (ent.isDirectory()) {
      if (isRecordingDir(ent.name) && recordings !== "all") {
        if (recordings === "only") await walk(path.join(dir, ent.name), r, "all", out);
        continue;
      }
      await walk(path.join(dir, ent.name), r, recordings, out);
      continue;
    }
    if (recordings === "only") continue;
    if (ent.isSymbolicLink()) out.push({ rel: r, kind: "symlink" });
    else if (ent.isFile()) out.push({ rel: r, kind: "file" });
    else out.push({ rel: r, kind: "special" });
  }
}

async function hashEntries(verifierDir: string, entries: Entry[]): Promise<Record<string, string>> {
  entries.sort((a, b) => (a.rel < b.rel ? -1 : a.rel > b.rel ? 1 : 0));
  const manifest: Record<string, string> = {};
  for (const { rel, kind } of entries) {
    const abs = path.join(verifierDir, ...rel.split("/"));
    if (kind === "symlink") manifest[rel] = "symlink:" + (await readlink(abs).catch(() => "?"));
    else if (kind === "special") manifest[rel] = "special";
    else manifest[rel] = createHash("sha256").update(await readFile(abs)).digest("hex");
  }
  return manifest;
}

const abs = (verifierDir: string, rel: string) => path.join(verifierDir, ...rel.split("/"));

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
 * Tier 1, checked at every gate: sha256 of every entry under .testmuai/tests except inside Kane's
 * `output-*` recording folders, and of every entry under .testmuai/variables, keyed by `/` relative
 * path; plus `app:<rel>` entries when `app` is given.
 */
export async function seal(verifierDir: string, app?: AppSeal): Promise<Record<string, string>> {
  const entries: Entry[] = [];
  await walk(abs(verifierDir, TESTS_DIR), TESTS_DIR, "skip", entries);
  await walk(abs(verifierDir, VARIABLES_DIR), VARIABLES_DIR, "all", entries);
  const manifest = await hashEntries(verifierDir, entries);
  if (app) {
    for (const f of app.files) {
      const rel = f.split(path.sep).join("/");
      manifest[APP_PREFIX + rel] = await hashAppFile(app.appDir, rel);
    }
  }
  return manifest;
}

function diff(manifest: Record<string, string>, now: Record<string, string>, skip: (k: string) => boolean): Set<string> {
  const bad = new Set<string>();
  for (const [k, h] of Object.entries(manifest)) if (!skip(k) && now[k] !== h) bad.add(k);
  for (const k of Object.keys(now)) if (!(k in manifest)) bad.add(k);
  return bad;
}

/** Sorted relative paths that were changed, deleted or added since the manifest was sealed. */
export async function checkSeal(
  verifierDir: string,
  manifest: Record<string, string>,
  appDir?: string,
): Promise<string[]> {
  const bad = diff(manifest, await seal(verifierDir), (k) => k.startsWith(APP_PREFIX));
  if (appDir !== undefined) {
    for (const [k, h] of Object.entries(manifest)) {
      if (k.startsWith(APP_PREFIX) && (await hashAppFile(appDir, k.slice(APP_PREFIX.length))) !== h) bad.add(k);
    }
  }
  return [...bad].sort();
}

/** Tier 2: hashes of Kane's own `output-*` run recordings under .testmuai/tests (taken after a Kane batch). */
export async function sealRecordings(verifierDir: string): Promise<Record<string, string>> {
  const entries: Entry[] = [];
  await walk(abs(verifierDir, TESTS_DIR), TESTS_DIR, "only", entries);
  return hashEntries(verifierDir, entries);
}

/** Sorted recording paths changed, deleted or added since `snapshot`. */
export async function checkRecordings(verifierDir: string, snapshot: Record<string, string>): Promise<string[]> {
  return [...diff(snapshot, await sealRecordings(verifierDir), () => false)].sort();
}
