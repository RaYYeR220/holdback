import { createHash } from "node:crypto";
import { appendFile, mkdir, readFile, rm } from "node:fs/promises";
import path from "node:path";
import { gitPath, type GitOptions } from "./git.js";
import type { LedgerEvent } from "./ledger/types.js";
import type { Project } from "./project.js";
import { sealRecordings } from "./seal.js";

/**
 * `<home>/TAMPERED`: written on every tamper detection before the ledger is touched, so a tamper
 * that cannot be logged (read-only or forged ledger) still blocks the next run. Only a fresh seal
 * (spec stage or a human re-seal) clears it.
 */
export const TAMPER_MARKER = "TAMPERED";

const markerFile = (p: Pick<Project, "home">) => path.join(p.home, TAMPER_MARKER);

export async function markTampered(p: Pick<Project, "home">, reason: string): Promise<void> {
  await mkdir(p.home, { recursive: true });
  await appendFile(markerFile(p), `${new Date().toISOString()} ${reason.replace(/\s+/g, " ")}\n`, "utf8");
}

/** The marker's text, or null when no tamper is on record outside the ledger. */
export async function tamperMarker(p: Pick<Project, "home">): Promise<string | null> {
  try {
    return await readFile(markerFile(p), "utf8");
  } catch (e) {
    if ((e as NodeJS.ErrnoException).code === "ENOENT") return null;
    throw e;
  }
}

/** Call right after logging a fresh `seal` (spec stage, human re-seal). */
export async function clearTamper(p: Pick<Project, "home">): Promise<void> {
  await rm(markerFile(p), { force: true });
}

const sha256 = (b: string | Buffer) => createHash("sha256").update(b).digest("hex");

export async function hashFileOrAbsent(file: string): Promise<string> {
  try {
    return sha256(await readFile(file));
  } catch (e) {
    if ((e as NodeJS.ErrnoException).code === "ENOENT") return "absent";
    throw e;
  }
}

/** sha256 over the sorted `[path, hash]` pairs of a manifest. */
export function manifestDigest(m: Record<string, string>): string {
  return sha256(JSON.stringify(Object.keys(m).sort().map((k) => [k, m[k]])));
}

export type RecordingsSnapshot = {
  /** Kane's `output-*` recordings (tier 2), path -> hash; kept in memory, only the digest is logged. */
  manifest: Record<string, string>;
  digest: string;
  /** sha256 of the app repo's git config ("absent" when there is none). */
  gitConfig: string;
  gitConfigFile: string;
};

export async function snapshotRecordings(p: Project, git: GitOptions = {}): Promise<RecordingsSnapshot> {
  const manifest = await sealRecordings(p.verifierDir);
  const gitConfigFile = await gitPath(p.appDir, "config", git);
  return { manifest, digest: manifestDigest(manifest), gitConfig: await hashFileOrAbsent(gitConfigFile), gitConfigFile };
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
