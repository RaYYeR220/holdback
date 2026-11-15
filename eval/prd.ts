import { createHash } from "node:crypto";
import { copyFile, mkdir, readFile, writeFile } from "node:fs/promises";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { examPrdLines } from "./reference.ts";

export const EVAL_DIR = path.dirname(fileURLToPath(import.meta.url));
export const DEFAULT_RESULTS_DIR = path.join(EVAL_DIR, "results");

export const PRD_FINAL_JSON = "prd-final.json";
export const PRD_FINAL_MD = "prd-final.md";

export type PrdFinal = {
  prdSha256: string;
  dependentLinesSha256: string;
  stackSha256?: string;
  registeredAt: string;
};

export class PrdChanged extends Error {
  constructor(message: string) {
    super(message);
    this.name = "PrdChanged";
  }
}

export const sha256 = (data: string | Buffer): string => createHash("sha256").update(data).digest("hex");

/** The dependent-lines hash recorded in PREREGISTERED.md (the `examPrdLines()` row). */
export async function registeredDependentLinesHash(file = path.join(EVAL_DIR, "PREREGISTERED.md")): Promise<string> {
  const text = await readFile(file, "utf8");
  const m = /\(`examPrdLines\(\)`\)\s*\|\s*`([0-9a-f]{64})`/.exec(text);
  if (!m) throw new Error(`${file}: no registered hash for the exam-dependent PRD lines`);
  return m[1]!;
}

function checkLines(prd: string, expected: string, what: string): string {
  const got = sha256(examPrdLines(prd));
  if (got !== expected) {
    throw new PrdChanged(`${what}: the PRD lines the exam depends on changed (sha256 ${got}, registered ${expected}); refusing to go on`);
  }
  return got;
}

/**
 * Before the first arm runs: hash the final PRD (with its Clarifications) into `<resultsDir>/prd-final.json`
 * and keep a copy. Refuses a PRD whose exam-dependent lines no longer match the registered hash, and a PRD
 * that differs from the one an earlier arm already registered (every arm builds from the same one).
 */
export async function registerPrd(
  prdPath: string,
  resultsDir: string,
  opts: { stackPath?: string; expected?: string; now?: () => Date } = {},
): Promise<PrdFinal> {
  const expected = opts.expected ?? (await registeredDependentLinesHash());
  const prd = await readFile(prdPath);
  const dependentLinesSha256 = checkLines(prd.toString("utf8"), expected, prdPath);
  const prdSha256 = sha256(prd);
  const jsonFile = path.join(resultsDir, PRD_FINAL_JSON);
  let existing: PrdFinal | undefined;
  try {
    existing = JSON.parse(await readFile(jsonFile, "utf8")) as PrdFinal;
  } catch (e) {
    if ((e as NodeJS.ErrnoException).code !== "ENOENT") throw e;
  }
  if (existing) {
    if (existing.prdSha256 !== prdSha256) {
      throw new PrdChanged(`${prdPath} differs from the final PRD already registered in ${jsonFile}: every arm builds from the same PRD`);
    }
    return existing;
  }
  const rec: PrdFinal = {
    prdSha256,
    dependentLinesSha256,
    ...(opts.stackPath ? { stackSha256: sha256(await readFile(opts.stackPath)) } : {}),
    registeredAt: (opts.now?.() ?? new Date()).toISOString(),
  };
  await mkdir(resultsDir, { recursive: true });
  await copyFile(prdPath, path.join(resultsDir, PRD_FINAL_MD));
  await writeFile(jsonFile, JSON.stringify(rec, null, 2) + "\n", "utf8");
  return rec;
}

/** Scoring gate: the registered final PRD must exist, be intact, and still match the registered exam-dependent lines. */
export async function assertPrdRegistered(resultsDir: string, expected?: string): Promise<PrdFinal> {
  const want = expected ?? (await registeredDependentLinesHash());
  let rec: PrdFinal;
  let prd: Buffer;
  try {
    rec = JSON.parse(await readFile(path.join(resultsDir, PRD_FINAL_JSON), "utf8")) as PrdFinal;
    prd = await readFile(path.join(resultsDir, PRD_FINAL_MD));
  } catch (e) {
    if ((e as NodeJS.ErrnoException).code === "ENOENT") throw new PrdChanged(`no final PRD registered in ${resultsDir}: run an arm first`);
    throw e;
  }
  if (sha256(prd) !== rec.prdSha256) throw new PrdChanged(`${PRD_FINAL_MD} no longer matches ${PRD_FINAL_JSON}`);
  checkLines(prd.toString("utf8"), want, PRD_FINAL_MD);
  return rec;
}
