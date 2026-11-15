import { mkdir, readdir, rm } from "node:fs/promises";
import path from "node:path";
import type { Project } from "./project.js";

/**
 * The environment variable an app under test reads for where to keep its data (the convention
 * Holdback's apps follow). Holdback sets it on every app it starts for Kane, over anything
 * `start.env` says, so every start begins from an empty data folder.
 */
export const DATA_DIR_ENV = "DATA_DIR";
/** `<home>/data`: one empty folder per app start. */
export const DATA_ROOT = "data";
/** The most recent data folders kept for debugging; older ones are removed. */
export const KEEP_DATA_DIRS = 6;

let seq = 0;

/** `20261115T120102123-<n>`: sorts in creation order. */
function stamp(): string {
  const d = new Date();
  const p = (n: number, w = 2) => String(n).padStart(w, "0");
  seq = (seq + 1) % 10_000;
  return `${d.getUTCFullYear()}${p(d.getUTCMonth() + 1)}${p(d.getUTCDate())}T${p(d.getUTCHours())}${p(d.getUTCMinutes())}${p(d.getUTCSeconds())}${p(d.getUTCMilliseconds(), 3)}-${p(seq, 4)}`;
}

/**
 * A new, empty data folder for one app start: `<home>/data/<stamp>-<label>`. Rows a Kane run
 * writes (a booking, a sign-up) never reach the next start, so a replay of the same steps meets
 * the same empty app. The newest `KEEP_DATA_DIRS` folders stay for debugging; older ones are
 * removed, best effort (a file a just-stopped app still holds stays for the next prune).
 */
export async function freshDataDir(p: Pick<Project, "home">, label: string): Promise<string> {
  const root = path.join(p.home, DATA_ROOT);
  const dir = path.join(root, `${stamp()}-${label.replace(/[^\w.-]/g, "_")}`);
  await rm(dir, { recursive: true, force: true });
  await mkdir(dir, { recursive: true });
  const names = (await readdir(root, { withFileTypes: true }).catch(() => []))
    .filter((e) => e.isDirectory())
    .map((e) => e.name)
    .sort();
  for (const old of names.slice(0, Math.max(0, names.length - KEEP_DATA_DIRS))) {
    await rm(path.join(root, old), { recursive: true, force: true, maxRetries: 2 }).catch(() => {});
  }
  return dir;
}

/**
 * The environment of an app Holdback starts for Kane: `start.env`, then its own data folder (which
 * wins over a `DATA_DIR` in `start.env`), and the breaker's key blanked: it never reaches an app.
 */
export function appEnv(p: Pick<Project, "config">, dataDir: string): Record<string, string> {
  return { ...p.config.start.env, [DATA_DIR_ENV]: dataDir, VENICE_API_KEY: "" };
}
