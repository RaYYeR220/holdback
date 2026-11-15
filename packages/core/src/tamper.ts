import { createHash } from "node:crypto";
import { appendFile, lstat, mkdir, readFile, rm, unlink } from "node:fs/promises";
import path from "node:path";
import { git as runGit, gitPath, type GitOptions } from "./git.js";
import type { LedgerEvent } from "./ledger/types.js";
import type { Project } from "./project.js";
import { sealRecordings } from "./seal.js";

/**
 * `<home>/TAMPERED`: written on every tamper detection before the ledger is touched, so a tamper
 * that cannot be logged (read-only or forged ledger) still blocks the next run. Only a fresh seal
 * (`reseal`: spec stage or a human re-seal) clears it.
 */
export const TAMPER_MARKER = "TAMPERED";

const markerFile = (p: Pick<Project, "home">) => path.join(p.home, TAMPER_MARKER);
const errText = (e: unknown) => (e instanceof Error ? e.message : String(e));

export async function markTampered(p: Pick<Project, "home">, reason: string): Promise<void> {
  await mkdir(p.home, { recursive: true });
  await appendFile(markerFile(p), `${new Date().toISOString()} ${reason.replace(/\s+/g, " ")}\n`, "utf8");
}

/**
 * The marker's text (trimmed), or null when no tamper is on record outside the ledger. Only a clean
 * "not there" is null: a link, a directory or anything unreadable in its place counts as a tamper.
 */
export async function tamperMarker(p: Pick<Project, "home">): Promise<string | null> {
  const file = markerFile(p);
  try {
    const st = await lstat(file);
    if (st.isSymbolicLink()) return "tamper marker is a link";
    if (!st.isFile()) return st.isDirectory() ? "tamper marker is a directory" : "tamper marker is not a regular file";
    return (await readFile(file, "utf8")).trim() || "tamper marker present (empty)";
  } catch (e) {
    if ((e as NodeJS.ErrnoException).code === "ENOENT") return null;
    return `tamper marker unreadable: ${errText(e)}`;
  }
}

/** Call right after logging a fresh `seal` (`reseal` does). A link in the marker's place goes, never its target. */
export async function clearTamper(p: Pick<Project, "home">): Promise<void> {
  const file = markerFile(p);
  let dir: boolean;
  try {
    dir = (await lstat(file)).isDirectory(); // false for a link or junction
  } catch (e) {
    if ((e as NodeJS.ErrnoException).code === "ENOENT") return;
    throw e;
  }
  if (dir) await rm(file, { recursive: true, force: true });
  else await unlink(file);
}

const sha256 = (b: string | Buffer) => createHash("sha256").update(b).digest("hex");

/**
 * Sections that only steer fetch, pull, push, identity and `git init`. Holdback runs none of those,
 * and a human changing them between runs (`git remote add`, `git push -u`) is not a tamper.
 */
const INERT_GIT_SECTIONS = new Set(["remote", "branch", "user", "init", "pull", "push"]);

/** Raw sha256 -> parsed hash: the parse is a pure function of the bytes (`--file` never follows includes). */
const parsedConfigs = new Map<string, string>();

/**
 * sha256 of the repo's git config as git itself parses it, leaving out the inert sections above, so
 * it covers what can run code or redirect git (core, filter, diff, merge, alias, gpg, include*, ...).
 * git prints every key normalised (section and name lowercased, a subsection as written); entries
 * are sorted by key, and a repeated key keeps its values' order (the last one wins).
 * "absent" when there is no config file; a config git cannot parse hashes its raw bytes.
 */
export async function gitConfigHash(file: string, opts: GitOptions = {}): Promise<string> {
  let raw: Buffer;
  try {
    raw = await readFile(file);
  } catch (e) {
    if ((e as NodeJS.ErrnoException).code === "ENOENT") return "absent";
    throw e;
  }
  const rawHash = sha256(raw);
  const known = parsedConfigs.get(rawHash);
  if (known !== undefined) return known;
  const r = await runGit(path.dirname(file), ["config", "--file", file, "--null", "--list"], opts);
  let out: string;
  if (r.code !== 0) out = `unparsed:${rawHash}`;
  else {
    const entries: [string, string | null][] = [];
    for (const item of r.stdout.split("\0")) {
      if (item === "") continue;
      const nl = item.indexOf("\n"); // `key\nvalue`; a value-less key has no newline
      const key = nl < 0 ? item : item.slice(0, nl);
      if (INERT_GIT_SECTIONS.has(key.split(".", 1)[0]!)) continue;
      entries.push([key, nl < 0 ? null : item.slice(nl + 1)]);
    }
    entries.sort((a, b) => (a[0] < b[0] ? -1 : a[0] > b[0] ? 1 : 0)); // stable
    out = sha256(JSON.stringify(entries));
  }
  if (parsedConfigs.size >= 256) parsedConfigs.clear();
  parsedConfigs.set(rawHash, out);
  return out;
}

/** sha256 over the sorted `[path, hash]` pairs of a manifest. */
export function manifestDigest(m: Record<string, string>): string {
  return sha256(JSON.stringify(Object.keys(m).sort().map((k) => [k, m[k]])));
}

export type RecordingsSnapshot = {
  /** Kane's `output-*` recordings (tier 2), path -> hash; kept in memory, only the digest is logged. */
  manifest: Record<string, string>;
  digest: string;
  /** `gitConfigHash` of the app repo's git config ("absent" when there is none). */
  gitConfig: string;
  gitConfigFile: string;
};

export async function snapshotRecordings(p: Project, git: GitOptions = {}): Promise<RecordingsSnapshot> {
  const manifest = await sealRecordings(p.verifierDir);
  const gitConfigFile = await gitPath(p.appDir, "config", git);
  return { manifest, digest: manifestDigest(manifest), gitConfig: await gitConfigHash(gitConfigFile, git), gitConfigFile };
}

/**
 * Snapshot Kane's recordings and the repo's git config, and log them as a `recordings` event.
 * Every Kane batch run outside the build loop (falsification) must call this afterwards: the next
 * build loop compares the disk against the latest `recordings` event at start.
 */
export async function logRecordings(p: Project, log: (e: LedgerEvent) => Promise<void>, git: GitOptions = {}): Promise<RecordingsSnapshot> {
  const snap = await snapshotRecordings(p, git);
  await log({ at: new Date().toISOString(), t: "recordings", digest: snap.digest, gitConfig: snap.gitConfig });
  return snap;
}

export type RecordingsAnchorCheck = {
  /** The disk as it is now. */
  snapshot: RecordingsSnapshot;
  /** A `recordings` event follows the latest `seal`. When false there is nothing to hold the disk to: seed one from `snapshot`. */
  anchored: boolean;
  /** What differs from that anchor ("Kane's recordings", ".git/config"); anything here is a tamper. */
  moved: string[];
};

/**
 * Holds Kane's recordings and the repo's git config to the latest `recordings` event, unless a seal
 * came after it (spec stage, drift, re-seal). Run it before any Kane batch (build loop start,
 * falsification), and `logRecordings` after the batch.
 */
export async function checkRecordingsAnchor(p: Project, events: LedgerEvent[], git: GitOptions = {}): Promise<RecordingsAnchorCheck> {
  const snapshot = await snapshotRecordings(p, git);
  for (let i = events.length - 1; i >= 0; i--) {
    const e = events[i]!;
    if (e.t === "seal") break;
    if (e.t !== "recordings") continue;
    const moved = [...(e.digest !== snapshot.digest ? ["Kane's recordings"] : []), ...(e.gitConfig !== snapshot.gitConfig ? [".git/config"] : [])];
    return { snapshot, anchored: true, moved };
  }
  return { snapshot, anchored: false, moved: [] };
}
