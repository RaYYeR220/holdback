import { existsSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { git, type ClaudeTurnOptions, type ClaudeTurnResult } from "@holdback/core";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { runArm, recordArmC } from "./run-arm.ts";

const here = path.dirname(fileURLToPath(import.meta.url));
const PRD = path.join(here, "..", "examples", "pantry-spec", "PRD.md");
const STACK = path.join(here, "..", "examples", "pantry-spec", "STACK.md");
const fakeClaude = path.join(here, "..", "packages", "core", "test", "fake-claude.mjs");

const saved = { ...process.env };
let tmp: string;
let results: string;
let out: string;

beforeEach(() => {
  tmp = mkdtempSync(path.join(tmpdir(), "holdback-arm-test-"));
  results = path.join(tmp, "results");
  out = path.join(tmp, "arm");
});
afterEach(() => {
  process.env = { ...saved };
  rmSync(tmp, { recursive: true, force: true });
});

const base = () => ({ outDir: out, prdPath: PRD, stackPath: STACK, model: "claude-test-model", resultsDir: results });
const readRun = (arm: string) => JSON.parse(readFileSync(path.join(results, `${arm}-run.json`), "utf8"));
const result = (o: Partial<ClaudeTurnResult>): ClaudeTurnResult => ({
  exitCode: 0,
  resultText: "done",
  isError: false,
  stderrTail: "",
  durationMs: 60_000,
  timedOut: false,
  ...o,
});

describe("runArm", () => {
  it("builds in an isolated repo, with the same model, no web access, and records the metrics", async () => {
    process.env.HOLDBACK_CLAUDE_BIN = fakeClaude;
    process.env.FAKE_CLAUDE_ARGS_FILE = path.join(tmp, "args.json");
    process.env.FAKE_CLAUDE_STDIN_FILE = path.join(tmp, "stdin.txt");
    const run = await runArm("A", base());
    expect(run).toMatchObject({ arm: "A", calls: 1, turns: 7, agentUsd: 0.12, claimedDone: true, stopReason: "done", kaneCredits: 0, model: "claude-test-model" });
    expect(readRun("a")).toMatchObject({ arm: "A", appDir: out, turns: 7 });

    // the arm's own repo, with the final PRD and STACK, outside the holdback repo
    expect((await git(out, ["rev-parse", "--show-toplevel"])).stdout.trim().toLowerCase()).toBe(out.replace(/\\/g, "/").toLowerCase());
    expect(readFileSync(path.join(out, "PRD.md"), "utf8")).toBe(readFileSync(PRD, "utf8"));
    expect(readFileSync(path.join(out, "STACK.md"), "utf8")).toBe(readFileSync(STACK, "utf8"));
    expect((await git(out, ["log", "--oneline"])).stdout.trim().split("\n").length).toBeGreaterThanOrEqual(1);

    const args: string[] = JSON.parse(readFileSync(process.env.FAKE_CLAUDE_ARGS_FILE, "utf8"));
    expect(args[args.indexOf("--model") + 1]).toBe("claude-test-model");
    const settings = JSON.parse(readFileSync(args[args.indexOf("--settings") + 1]!, "utf8"));
    expect(settings.permissions.deny).toEqual(expect.arrayContaining(["WebFetch", "WebSearch"]));
    expect(readFileSync(process.env.FAKE_CLAUDE_STDIN_FILE, "utf8")).toMatch(/Write your own tests/);
  });

  it("registers the final PRD in the results once", async () => {
    process.env.HOLDBACK_CLAUDE_BIN = fakeClaude;
    await runArm("A", base());
    const rec = JSON.parse(readFileSync(path.join(results, "prd-final.json"), "utf8"));
    expect(rec.prdSha256).toMatch(/^[0-9a-f]{64}$/);
    expect(rec.dependentLinesSha256).toBe("cf71451e27c5cebebdead56688f96a467f6dcc412404f01666a57c97aa3c85d0");
    expect(existsSync(path.join(results, "prd-final.md"))).toBe(true);
  });

  it("B gets the Kane verify-and-fix prompt and its credits are the balance drop", async () => {
    const seen: ClaudeTurnOptions[] = [];
    let n = 0;
    const run = await runArm("B", {
      ...base(),
      claude: async (o) => (seen.push(o), result({ numTurns: 30, costUsd: 2.5 })),
      balance: async () => (n++ === 0 ? 500 : 420.25),
    });
    expect(seen[0]!.prompt).toMatch(/kane-cli run/);
    expect(seen[0]!.prompt).toMatch(/--agent/);
    expect(JSON.parse(readFileSync(seen[0]!.settingsFile, "utf8")).permissions.deny).not.toContain("Bash(kane-cli:*)");
    expect(run).toMatchObject({ arm: "B", kaneCredits: 79.75, turns: 30, agentUsd: 2.5, wallMin: 1 });
  });

  it("continues a call that ran out of turns, within the cap, and sums the cost", async () => {
    let calls = 0;
    const run = await runArm("A", {
      ...base(),
      maxCalls: 3,
      claude: async () =>
        ++calls < 3
          ? result({ exitCode: 1, isError: true, subtype: "error_max_turns", numTurns: 60, costUsd: 1 })
          : result({ numTurns: 10, costUsd: 0.5 }),
    });
    expect(run).toMatchObject({ calls: 3, turns: 130, agentUsd: 2.5, claimedDone: true, wallMin: 3 });
  });

  it("does not claim done when the cap is hit or the agent timed out", async () => {
    const capped = await runArm("A", { ...base(), maxCalls: 2, claude: async () => result({ exitCode: 1, isError: true, subtype: "error_max_turns" }) });
    expect(capped).toMatchObject({ calls: 2, claimedDone: false, stopReason: "error_max_turns" });
    const out2 = path.join(tmp, "arm2");
    const timed = await runArm("A", { ...base(), outDir: out2, claude: async () => result({ exitCode: 124, timedOut: true }) });
    expect(timed).toMatchObject({ calls: 1, claimedDone: false, stopReason: "timeout" });
  });

  it("refuses a directory inside the holdback repo or one that is not empty", async () => {
    await expect(runArm("A", { ...base(), outDir: path.join(here, "arm-scratch") })).rejects.toThrow(/inside the holdback repository/);
    writeFileSync(path.join(tmp, "x"), "x");
    await expect(runArm("A", { ...base(), outDir: tmp })).rejects.toThrow(/not empty/);
  });

  it("refuses a PRD whose exam-dependent lines changed, before anything runs", async () => {
    const bad = path.join(tmp, "PRD.md");
    writeFileSync(bad, readFileSync(PRD, "utf8").replace("Not eligible.", "Not eligible!"));
    let ran = false;
    await expect(runArm("A", { ...base(), prdPath: bad, claude: async () => ((ran = true), result({})) })).rejects.toThrow(/exam depends on changed/);
    expect(ran).toBe(false);
    expect(existsSync(out)).toBe(false);
  });

  it("refuses a PRD that differs from the one already registered", async () => {
    await runArm("A", { ...base(), claude: async () => result({}) });
    const other = path.join(tmp, "PRD2.md");
    writeFileSync(other, readFileSync(PRD, "utf8") + "\n## Clarifications\n\nQ: x? A: y.\n");
    await expect(runArm("B", { ...base(), outDir: path.join(tmp, "arm-b"), prdPath: other, claude: async () => result({}) })).rejects.toThrow(/differs from the final PRD/);
  });
});

describe("recordArmC", () => {
  it("records the app dir and the run's metrics", async () => {
    const run = await recordArmC(path.join(tmp, "demo"), { turns: 12, agentUsd: 4.1, breakerUsd: 0.3, wallMin: 55, claimedDone: true, kaneCredits: 900 }, { resultsDir: results });
    expect(run).toMatchObject({ arm: "C", turns: 12, breakerUsd: 0.3, claimedDone: true });
    expect(readRun("c")).toMatchObject({ appDir: path.join(tmp, "demo"), kaneCredits: 900 });
  });
});

