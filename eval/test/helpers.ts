import { mkdirSync, writeFileSync } from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { commitAll, git } from "@holdback/core";
import { sha256 } from "../prd.ts";
import type { ArmId, ArmRun } from "../run-arm.ts";
import { readFileSync } from "node:fs";

const here = path.dirname(fileURLToPath(import.meta.url));
export const ROOT = path.join(here, "..", "..");
export const PRD = path.join(ROOT, "examples", "pantry-spec", "PRD.md");
export const STACK = path.join(ROOT, "examples", "pantry-spec", "STACK.md");
export const FAKE_KANE = path.join(here, "fake-kane-exam.mjs");
export const APP_MJS = path.join(here, "app.mjs").replace(/\\/g, "/");
export const MODEL = "claude-test-model";

export const GIT = {
  env: { GIT_AUTHOR_NAME: "t", GIT_AUTHOR_EMAIL: "t@example.invalid", GIT_COMMITTER_NAME: "t", GIT_COMMITTER_EMAIL: "t@example.invalid" },
};

/** A committed app repo whose `npm start` runs the stand-in app. Returns HEAD. */
export async function makeAppRepo(dir: string): Promise<string> {
  mkdirSync(dir, { recursive: true });
  writeFileSync(path.join(dir, "package.json"), JSON.stringify({ scripts: { start: `node ${APP_MJS}` } }));
  await git(dir, ["init", "-q"], GIT);
  await commitAll(dir, "app", GIT);
  return (await git(dir, ["rev-parse", "--short", "HEAD"], GIT)).stdout.trim();
}

/** A recorded build for `arm`, bound to the registered PRD, STACK and model. */
export function writeRun(resultsDir: string, arm: ArmId, appDir: string, head: string, extra: Partial<ArmRun> = {}): void {
  mkdirSync(resultsDir, { recursive: true });
  const run: ArmRun = {
    arm,
    appDir: path.resolve(appDir),
    model: MODEL,
    calls: 1,
    retries: 0,
    turns: 10,
    agentUsd: 1.5,
    breakerUsd: 0,
    wallMin: 5,
    claimedDone: true,
    stopReason: "done",
    kaneCredits: 0,
    head,
    dirty: false,
    prdSha256: sha256(readFileSync(PRD)),
    stackSha256: sha256(readFileSync(STACK)),
    recordedAt: "2026-11-15T00:00:00.000Z",
    ...extra,
  };
  writeFileSync(path.join(resultsDir, `${arm.toLowerCase()}-run.json`), JSON.stringify(run, null, 2));
}
