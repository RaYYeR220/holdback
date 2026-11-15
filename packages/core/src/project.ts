import { createHash } from "node:crypto";
import { mkdir, readFile } from "node:fs/promises";
import os from "node:os";
import path from "node:path";

export type HoldbackConfig = {
  spec: string[];
  specUrls: string[];
  agentNotes?: string;
  start: { cmd: string; port: number; readyPath: string; env?: Record<string, string> };
  agent: { kind: "claude"; model?: string; maxTurnsPerCall: number };
  /** `capCredits`: the most Kane credits the project may spend, as measured on the ledger; null for no cap. */
  kane: { parallel: number; timeoutS: number; designMax: number; capCredits?: number | null };
  breaker: { model: string; capUsd: number };
  /**
   * denyWeb: remove WebFetch/WebSearch from the agent (eval arms run without web access).
   * appendClarifications: "spec-only" appends answers to PRD.md only in the spec stage; the answers of drift and
   * falsify re-designs stay on the ledger (the eval keeps the PRD it registered).
   */
  loop: { maxTurns: number; denyWeb?: boolean; appendClarifications?: "always" | "spec-only" };
};

const DEFAULTS: HoldbackConfig = {
  spec: ["PRD.md"],
  specUrls: [],
  start: { cmd: "npm start", port: 3100, readyPath: "/" },
  agent: { kind: "claude", maxTurnsPerCall: 60 },
  kane: { parallel: 3, timeoutS: 420, designMax: 5, capCredits: null },
  breaker: { model: "deepseek-v4-flash", capUsd: 2 },
  loop: { maxTurns: 15, appendClarifications: "always" },
};

function isObj(v: unknown): v is Record<string, unknown> {
  return typeof v === "object" && v !== null && !Array.isArray(v);
}

function merge(base: unknown, over: unknown): unknown {
  if (!isObj(base) || !isObj(over)) return over === undefined ? base : over;
  const out: Record<string, unknown> = { ...base };
  for (const [k, v] of Object.entries(over)) out[k] = k in base ? merge(base[k], v) : v;
  return out;
}

function computeProjectId(absDir: string): string {
  const norm = absDir.replace(/\\/g, "/").replace(/\/+$/, "").toLowerCase();
  return createHash("sha256").update(norm).digest("hex").slice(0, 12);
}

async function loadConfig(appDir: string): Promise<HoldbackConfig> {
  const file = path.join(appDir, "holdback.config.json");
  let raw: string;
  try {
    raw = await readFile(file, "utf8");
  } catch (e) {
    if ((e as NodeJS.ErrnoException).code === "ENOENT") return structuredClone(DEFAULTS);
    throw e;
  }
  let user: unknown;
  try {
    user = JSON.parse(raw);
  } catch (e) {
    throw new Error(`Invalid JSON in ${file}: ${(e as Error).message}`);
  }
  if (!isObj(user)) throw new Error(`Invalid config in ${file}: expected a JSON object`);
  return merge(DEFAULTS, user) as HoldbackConfig;
}

export async function loadProject(appDir: string) {
  const abs = path.resolve(appDir);
  const projectId = computeProjectId(abs);
  const parent = process.env.HOLDBACK_HOME || path.join(os.homedir(), ".holdback");
  const home = path.join(parent, projectId);
  const verifierDir = path.join(home, "verifier");
  await mkdir(verifierDir, { recursive: true });
  return {
    appDir: abs,
    projectId,
    home,
    verifierDir,
    ledgerFile: path.join(home, "ledger.jsonl"),
    config: await loadConfig(abs),
  };
}

export type Project = Awaited<ReturnType<typeof loadProject>>;

/**
 * The Kane credit cap in force: `override` (a human's `--kane-cap` for one command), else
 * `kane.capCredits`; undefined for none. Throws on anything but a number of credits, 0 or more.
 */
export function kaneCapCredits(config: Pick<HoldbackConfig, "kane">, override?: number): number | undefined {
  const v: unknown = override ?? config.kane.capCredits;
  if (v === undefined || v === null) return undefined;
  if (typeof v !== "number" || !Number.isFinite(v) || v < 0) throw new Error(`kane.capCredits must be a number of credits (0 or more) or null, got ${JSON.stringify(v)}`);
  return v;
}
