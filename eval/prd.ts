import { createHash } from "node:crypto";
import { copyFile, mkdir, readFile, readdir, writeFile } from "node:fs/promises";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { examPrdLines } from "./reference.ts";

export const EVAL_DIR = path.dirname(fileURLToPath(import.meta.url));
export const DEFAULT_RESULTS_DIR = path.join(EVAL_DIR, "results");

export const PRD_FINAL_JSON = "prd-final.json";
export const PRD_FINAL_MD = "prd-final.md";

/** The fairness inputs every arm is bound to: one PRD, one STACK, one agent model. */
export type PrdFinal = {
  prdSha256: string;
  dependentLinesSha256: string;
  stackSha256: string;
  model: string;
  registeredAt: string;
};

export class PrdChanged extends Error {
  constructor(message: string) {
    super(message);
    this.name = "PrdChanged";
  }
}

export const sha256 = (data: string | Buffer): string => createHash("sha256").update(data).digest("hex");
/** sha256 of the text with LF line endings (how PREREGISTERED.md lists the exam files). */
export const sha256Lf = (data: Buffer): string => sha256(data.toString("utf8").replace(/\r\n/g, "\n"));

const PREREG = path.join(EVAL_DIR, "PREREGISTERED.md");

/** The dependent-lines hash recorded in PREREGISTERED.md (the `examPrdLines()` row). */
export async function registeredDependentLinesHash(file = PREREG): Promise<string> {
  const text = await readFile(file, "utf8");
  const m = /\(`examPrdLines\(\)`\)\s*\|\s*`([0-9a-f]{64})`/.exec(text);
  if (!m) throw new Error(`${file}: no registered hash for the exam-dependent PRD lines`);
  return m[1]!;
}

/** The STACK.md hash recorded in PREREGISTERED.md. */
export async function registeredStackHash(file = PREREG): Promise<string> {
  const text = await readFile(file, "utf8");
  const m = /`examples\/pantry-spec\/STACK\.md`\s*\|\s*`([0-9a-f]{64})`/.exec(text);
  if (!m) throw new Error(`${file}: no registered hash for STACK.md`);
  return m[1]!;
}

/** The registered exam files: name -> sha256 (LF line endings). */
export async function registeredExamHashes(file = PREREG): Promise<Map<string, string>> {
  const text = await readFile(file, "utf8");
  const out = new Map<string, string>();
  for (const m of text.matchAll(/`exam\/(e-[^`/]+_test\.md)`\s*\|\s*`([0-9a-f]{64})`/g)) out.set(m[1]!, m[2]!);
  return out;
}

/** The exam files in `examDir`: exactly the 22 registered ones, each byte-identical (LF-normalised) to its registered hash. */
export async function verifiedExamFiles(examDir: string, registered?: Map<string, string>): Promise<string[]> {
  const want = registered ?? (await registeredExamHashes());
  if (want.size !== 22) throw new Error(`PREREGISTERED.md lists ${want.size} exam files, expected 22`);
  const files = (await readdir(examDir)).filter((f) => f.endsWith("_test.md")).sort();
  const extra = files.filter((f) => !want.has(f));
  const missing = [...want.keys()].filter((f) => !files.includes(f));
  if (files.length !== 22 || extra.length > 0 || missing.length > 0) {
    throw new PrdChanged(`${examDir}: expected the 22 registered exam files (extra: ${extra.join(", ") || "none"}; missing: ${missing.join(", ") || "none"})`);
  }
  for (const f of files) {
    if (sha256Lf(await readFile(path.join(examDir, f))) !== want.get(f)) throw new PrdChanged(`${f} no longer matches its registered hash`);
  }
  return files;
}

function checkLines(prd: string, expected: string, what: string): string {
  const got = sha256(examPrdLines(prd));
  if (got !== expected) {
    throw new PrdChanged(`${what}: the PRD lines the exam depends on changed (sha256 ${got}, registered ${expected}); refusing to go on`);
  }
  return got;
}

async function readRecord(resultsDir: string): Promise<PrdFinal | undefined> {
  try {
    return JSON.parse(await readFile(path.join(resultsDir, PRD_FINAL_JSON), "utf8")) as PrdFinal;
  } catch (e) {
    if ((e as NodeJS.ErrnoException).code === "ENOENT") return undefined;
    throw e;
  }
}

/**
 * The `register-prd` step, run right after the spec stage and before any arm builds: hash the final PRD (with
 * Kane's Clarifications), the STACK and the agent model into `<resultsDir>/prd-final.json` and keep a copy of the PRD.
 * Refuses a PRD whose exam-dependent lines no longer match the registered hash and a STACK that differs from the
 * registered one. Registering the same inputs again is a no-op; different inputs are refused.
 */
export async function registerPrd(
  prdPath: string,
  stackPath: string,
  model: string,
  resultsDir: string,
  opts: { expectedLines?: string; expectedStack?: string; now?: () => Date } = {},
): Promise<PrdFinal> {
  if (!model.trim()) throw new Error("an explicit agent model is required");
  const prd = await readFile(prdPath);
  const stack = await readFile(stackPath);
  const dependentLinesSha256 = checkLines(prd.toString("utf8"), opts.expectedLines ?? (await registeredDependentLinesHash()), prdPath);
  const stackSha256 = sha256(stack);
  const wantStack = opts.expectedStack ?? (await registeredStackHash());
  if (stackSha256 !== wantStack) throw new PrdChanged(`${stackPath} differs from the registered STACK.md (sha256 ${stackSha256}, registered ${wantStack})`);
  const rec: PrdFinal = {
    prdSha256: sha256(prd),
    dependentLinesSha256,
    stackSha256,
    model: model.trim(),
    registeredAt: (opts.now?.() ?? new Date()).toISOString(),
  };
  const existing = await readRecord(resultsDir);
  if (existing) {
    if (existing.prdSha256 !== rec.prdSha256 || existing.stackSha256 !== rec.stackSha256 || existing.model !== rec.model) {
      throw new PrdChanged(`${path.join(resultsDir, PRD_FINAL_JSON)} already registers a different PRD, STACK or model: every arm uses the same ones`);
    }
    return existing;
  }
  await mkdir(resultsDir, { recursive: true });
  await copyFile(prdPath, path.join(resultsDir, PRD_FINAL_MD));
  await writeFile(path.join(resultsDir, PRD_FINAL_JSON), JSON.stringify(rec, null, 2) + "\n", "utf8");
  return rec;
}

/** The registration must exist, be intact, and still match the registered exam-dependent lines. */
export async function assertPrdRegistered(resultsDir: string, expected?: string): Promise<PrdFinal> {
  const want = expected ?? (await registeredDependentLinesHash());
  const rec = await readRecord(resultsDir);
  if (!rec) throw new PrdChanged(`no final PRD registered in ${resultsDir}: run register-prd after the spec stage, before any arm builds`);
  let prd: Buffer;
  try {
    prd = await readFile(path.join(resultsDir, PRD_FINAL_MD));
  } catch (e) {
    if ((e as NodeJS.ErrnoException).code === "ENOENT") throw new PrdChanged(`${PRD_FINAL_MD} is missing from ${resultsDir}`);
    throw e;
  }
  if (sha256(prd) !== rec.prdSha256) throw new PrdChanged(`${PRD_FINAL_MD} no longer matches ${PRD_FINAL_JSON}`);
  checkLines(prd.toString("utf8"), want, PRD_FINAL_MD);
  return rec;
}

/** What an arm built from: its hashes and model must all equal the registration. */
export type ArmInputs = { prdSha256: string; stackSha256: string; model?: string };

/** Refuse an arm whose PRD, STACK or model differs from the registered ones. Returns the registration. */
export async function verifyInputs(resultsDir: string, inputs: ArmInputs, what: string): Promise<PrdFinal> {
  const rec = await assertPrdRegistered(resultsDir);
  const bad: string[] = [];
  if (inputs.prdSha256 !== rec.prdSha256) bad.push("PRD.md");
  if (inputs.stackSha256 !== rec.stackSha256) bad.push("STACK.md");
  if (inputs.model !== rec.model) bad.push(`model (${inputs.model ?? "none"} vs registered ${rec.model})`);
  if (bad.length > 0) throw new PrdChanged(`${what} differs from the registration in ${resultsDir}: ${bad.join(", ")}`);
  return rec;
}
