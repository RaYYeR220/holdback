import { existsSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { appendEvent, git, loadProject, type ClaudeTurnOptions, type ClaudeTurnResult } from "@holdback/core";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { registerPrd } from "./prd.ts";
import { recordArmC, runArm } from "./run-arm.ts";
import { GIT, MODEL, PRD, STACK, makeAppRepo } from "./test/helpers.ts";

const here = path.dirname(fileURLToPath(import.meta.url));
const fakeClaude = path.join(here, "..", "packages", "core", "test", "fake-claude.mjs");

const saved = { ...process.env };
let tmp: string;
let results: string;
let out: string;

beforeEach(async () => {
  tmp = mkdtempSync(path.join(tmpdir(), "holdback-arm-test-"));
  results = path.join(tmp, "results");
  out = path.join(tmp, "arm");
  await registerPrd(PRD, STACK, MODEL, results);
});
afterEach(() => {
  process.env = { ...saved };
  rmSync(tmp, { recursive: true, force: true, maxRetries: 10, retryDelay: 200 });
});

const base = () => ({ outDir: out, prdPath: PRD, stackPath: STACK, model: MODEL, resultsDir: results, retryDelayMs: 0 });
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
const settingsOf = (o: ClaudeTurnOptions) => JSON.parse(readFileSync(o.settingsFile, "utf8"));

describe("arm prompts", () => {
  const A = readFileSync(path.join(here, "arms", "a-self.md"), "utf8");
  const B = readFileSync(path.join(here, "arms", "b-self-kane.md"), "utf8");
  it("B is A verbatim plus Kane's own verify-and-fix instructions, and no assurance commands", () => {
    expect(B.startsWith(A)).toBe(true);
    for (const needle of [
      "**Verify and fix loop for every code change**",
      "never drop the expected outcome to get a pass",
      "3. Always pass `--agent` to `kane-cli run` and `kane-cli testmd run`.",
      "6. Every run needs a start URL.",
      "8. Tag every command with your runtime",
      "9. Browser runs take from 30 seconds to a few minutes.",
      "## Write an objective for kane-cli run",
      "write a dollar sign as `\\$`",
      "| `3` | Timeout or cancelled |",
    ]) {
      expect(B).toContain(needle);
    }
    expect(B).not.toMatch(/kane-cli (context|design|maintain|cover)/);
    expect(B).not.toMatch(/Never write test cases by hand/);
    expect(B).not.toMatch(/Test cases from requirements/);
  });
  it("A says nothing about Kane", () => {
    expect(A).not.toMatch(/kane/i);
  });
  it("documents where the Kane text came from", () => {
    const p = readFileSync(path.join(here, "arms", "PROVENANCE.md"), "utf8");
    expect(p).toMatch(/llms\.txt/);
    expect(p).toMatch(/kane-cli 0\.10\.4/);
    expect(p).toMatch(/2026-11-15/);
  });
});

describe("runArm", () => {
  it("builds in an isolated repo, with the same model, no web access, and records the metrics and caps", async () => {
    process.env.HOLDBACK_CLAUDE_BIN = fakeClaude;
    process.env.FAKE_CLAUDE_ARGS_FILE = path.join(tmp, "args.json");
    process.env.FAKE_CLAUDE_STDIN_FILE = path.join(tmp, "stdin.txt");
    const run = await runArm("A", base());
    expect(run).toMatchObject({ arm: "A", calls: 1, retries: 0, turns: 7, agentUsd: 0.12, claimedDone: true, stopReason: "done", kaneCredits: 0, model: MODEL });
    expect(run.caps).toEqual({ maxCalls: 3, maxTurnsPerCall: 60, timeoutMs: 90 * 60_000, maxRetries: 3 });
    expect(readRun("a")).toMatchObject({ arm: "A", appDir: out, turns: 7, head: run.head });
    expect(readRun("a").prdSha256).toMatch(/^[0-9a-f]{64}$/);

    expect((await git(out, ["rev-parse", "--show-toplevel"])).stdout.trim().toLowerCase()).toBe(out.replace(/\\/g, "/").toLowerCase());
    expect(readFileSync(path.join(out, "PRD.md"), "utf8")).toBe(readFileSync(PRD, "utf8"));
    expect(readFileSync(path.join(out, "STACK.md"), "utf8")).toBe(readFileSync(STACK, "utf8"));

    const args: string[] = JSON.parse(readFileSync(process.env.FAKE_CLAUDE_ARGS_FILE, "utf8"));
    expect(args[args.indexOf("--model") + 1]).toBe(MODEL);
    const settings = JSON.parse(readFileSync(args[args.indexOf("--settings") + 1]!, "utf8"));
    expect(settings.permissions.deny).toEqual(expect.arrayContaining(["WebFetch", "WebSearch", "Bash(kane-cli:*)"]));
    expect(readFileSync(process.env.FAKE_CLAUDE_STDIN_FILE, "utf8")).toMatch(/Write your own tests/);
  });

  it("B gets Kane without the assurance commands, and its credits are the balance drop", async () => {
    const seen: ClaudeTurnOptions[] = [];
    let n = 0;
    const run = await runArm("B", {
      ...base(),
      claude: async (o) => (seen.push(o), result({ numTurns: 30, costUsd: 2.5 })),
      balance: async () => (n++ === 0 ? 500 : 420.25),
    });
    expect(seen[0]!.prompt).toBe(readFileSync(path.join(here, "arms", "b-self-kane.md"), "utf8"));
    const deny: string[] = settingsOf(seen[0]!).permissions.deny;
    expect(deny).toEqual(expect.arrayContaining(["WebFetch", "WebSearch", "Bash(kane-cli context:*)", "Bash(kane-cli design:*)", "Bash(kane-cli maintain:*)"]));
    expect(deny).not.toContain("Bash(kane-cli:*)");
    expect(run).toMatchObject({ arm: "B", kaneCredits: 79.75, turns: 30, agentUsd: 2.5, wallMin: 1 });
  });

  it("continues a call that ran out of turns, within the cap, and sums the cost", async () => {
    let calls = 0;
    const run = await runArm("A", {
      ...base(),
      claude: async () =>
        ++calls < 3 ? result({ exitCode: 1, isError: true, subtype: "error_max_turns", numTurns: 60, costUsd: 1 }) : result({ numTurns: 10, costUsd: 0.5 }),
    });
    expect(run).toMatchObject({ calls: 3, turns: 130, agentUsd: 2.5, claimedDone: true, wallMin: 3 });
  });

  it("retries a transient API error inside the attempt, then goes on", async () => {
    const delays: number[] = [];
    let n = 0;
    const run = await runArm("A", {
      ...base(),
      retryDelayMs: 10,
      sleep: async (ms) => void delays.push(ms),
      claude: async () => (++n < 3 ? result({ exitCode: 1, isError: true, subtype: "error_during_execution", resultText: "API Error: 529 overloaded_error", costUsd: 0.1 }) : result({ numTurns: 5, costUsd: 0.5 })),
    });
    expect(run).toMatchObject({ calls: 1, retries: 2, claimedDone: true, agentUsd: 0.7, turns: 5 });
    expect(delays).toEqual([10, 20]);
  });

  it("gives up after the retry cap and does not claim done", async () => {
    const run = await runArm("A", { ...base(), maxRetries: 2, claude: async () => result({ exitCode: 1, isError: true, resultText: "rate limit exceeded (429)" }) });
    expect(run).toMatchObject({ calls: 1, retries: 2, claimedDone: false });
  });

  it("does not claim done when the cap is hit or the agent timed out", async () => {
    const capped = await runArm("A", { ...base(), maxCalls: 2, claude: async () => result({ exitCode: 1, isError: true, subtype: "error_max_turns" }) });
    expect(capped).toMatchObject({ calls: 2, claimedDone: false, stopReason: "error_max_turns" });
    const timed = await runArm("B", { ...base(), outDir: path.join(tmp, "arm2"), balance: async () => 1, claude: async () => result({ exitCode: 124, timedOut: true }) });
    expect(timed).toMatchObject({ calls: 1, claimedDone: false, stopReason: "timeout" });
  });

  it("builds an arm once: a second build is refused", async () => {
    await runArm("A", { ...base(), claude: async () => result({}) });
    let ran = false;
    await expect(runArm("A", { ...base(), outDir: path.join(tmp, "again"), claude: async () => ((ran = true), result({})) })).rejects.toThrow(/arm A was already built/);
    expect(ran).toBe(false);
  });

  it("refuses a directory inside the holdback repo or one that is not empty", async () => {
    await expect(runArm("A", { ...base(), outDir: path.join(here, "arm-scratch") })).rejects.toThrow(/inside the holdback repository/);
    writeFileSync(path.join(tmp, "x"), "x");
    await expect(runArm("A", { ...base(), outDir: tmp })).rejects.toThrow(/not empty/);
  });

  it("refuses without a registration, and implicitly registers nothing", async () => {
    let ran = false;
    await expect(runArm("A", { ...base(), resultsDir: path.join(tmp, "none"), claude: async () => ((ran = true), result({})) })).rejects.toThrow(/register-prd/);
    expect(ran).toBe(false);
    expect(existsSync(path.join(tmp, "none", "prd-final.json"))).toBe(false);
  });

  it("refuses a PRD, STACK or model that differs from the registration, before anything runs", async () => {
    let ran = false;
    const claude = async () => ((ran = true), result({}));
    const prd2 = path.join(tmp, "PRD2.md");
    writeFileSync(prd2, readFileSync(PRD, "utf8") + "\n## Clarifications\n\nQ: x? A: y.\n");
    await expect(runArm("A", { ...base(), prdPath: prd2, claude })).rejects.toThrow(/PRD\.md/);
    const stack2 = path.join(tmp, "STACK2.md");
    writeFileSync(stack2, "other stack\n");
    await expect(runArm("A", { ...base(), stackPath: stack2, claude })).rejects.toThrow(/STACK\.md/);
    await expect(runArm("A", { ...base(), model: "other-model", claude })).rejects.toThrow(/model/);
    expect(ran).toBe(false);
    expect(existsSync(out)).toBe(false);
  });
});

describe("recordArmC", () => {
  let app: string;
  let home: string;
  const ev = (at: string, e: object) => ({ at, ...e }) as never;

  beforeEach(async () => {
    home = path.join(tmp, "hb-home");
    process.env.HOLDBACK_HOME = home;
    app = path.join(tmp, "demo");
    await makeAppRepo(app);
    writeFileSync(path.join(app, "PRD.md"), readFileSync(PRD));
    writeFileSync(path.join(app, "STACK.md"), readFileSync(STACK));
    writeFileSync(path.join(app, "holdback.config.json"), JSON.stringify({ agent: { kind: "claude", model: MODEL, maxTurnsPerCall: 60 } }));
    const { commitAll } = await import("@holdback/core");
    await commitAll(app, "spec", GIT);
  });

  async function ledger(events: object[]) {
    const p = await loadProject(app);
    for (const e of events) await appendEvent(p.ledgerFile, e as never);
  }
  const turn = (n: number, at: string, usd: number, turns: number) =>
    ev(at, { t: "turn.end", n, commit: "abc", filesChanged: [], durationMs: 1000, appUp: true, agentExit: 0, agentUsd: usd, agentTurns: turns });

  it("derives every figure from the Holdback ledger and binds PRD, STACK and model", async () => {
    await ledger([
      ev("2026-11-15T10:00:00.000Z", { t: "credits", source: "spec", delta: 40, perRunSum: 38 }),
      turn(1, "2026-11-15T10:10:00.000Z", 1.25, 20),
      ev("2026-11-15T10:20:00.000Z", { t: "credits", source: "build", delta: 12.5, perRunSum: 10 }),
      turn(2, "2026-11-15T10:30:00.000Z", 0.75, 15),
      ev("2026-11-15T10:45:00.000Z", { t: "mutant", id: "m1", ac: "ac-1", patch: "", model: "x", usd: 0.4, verdict: "killed" }),
    ]);
    const run = await recordArmC(app, { resultsDir: results });
    expect(run).toMatchObject({
      arm: "C",
      model: MODEL,
      calls: 2,
      turns: 35,
      agentUsd: 2,
      breakerUsd: 0.4,
      kaneCredits: 52.5,
      wallMin: 45,
      claimedDone: true,
      dirty: false,
    });
    expect(run.head).toMatch(/^[0-9a-f]+$/);
    expect(readRun("c").appDir).toBe(path.resolve(app));
  });

  it("records null, not zero, for what the ledger does not hold", async () => {
    await ledger([ev("2026-11-15T10:00:00.000Z", { t: "turn.end", n: 1, commit: "a", filesChanged: [], durationMs: 5, appUp: true, agentExit: 0 })]);
    const run = await recordArmC(app, { resultsDir: results });
    expect(run).toMatchObject({ turns: null, agentUsd: null, wallMin: null });
  });

  it("does not claim done while a criterion is owed", async () => {
    await ledger([
      ev("2026-11-15T10:00:00.000Z", {
        t: "design",
        useCase: "uc-1",
        acs: [{ id: "ac-1", text: "x", useCase: "uc-1", cites: [], trust: "high" }],
        tests: [{ id: "t-1", title: "t", file: "t_test.md", verifies: ["ac-1"] }],
        gaps: [],
        credits: 1,
      }),
      turn(1, "2026-11-15T10:10:00.000Z", 1, 5),
    ]);
    expect((await recordArmC(app, { resultsDir: results })).claimedDone).toBe(false);
  });

  it("refuses an empty ledger, a wrong model, a changed PRD or STACK, and a second record", async () => {
    await expect(recordArmC(app, { resultsDir: results })).rejects.toThrow(/no Holdback ledger/);
    await ledger([turn(1, "2026-11-15T10:10:00.000Z", 1, 5)]);
    writeFileSync(path.join(app, "holdback.config.json"), JSON.stringify({ agent: { kind: "claude", model: "other", maxTurnsPerCall: 60 } }));
    await expect(recordArmC(app, { resultsDir: results })).rejects.toThrow(/model/);
    writeFileSync(path.join(app, "holdback.config.json"), JSON.stringify({ agent: { kind: "claude", model: MODEL, maxTurnsPerCall: 60 } }));
    writeFileSync(path.join(app, "STACK.md"), "changed\n");
    await expect(recordArmC(app, { resultsDir: results })).rejects.toThrow(/STACK\.md/);
    writeFileSync(path.join(app, "STACK.md"), readFileSync(STACK));
    writeFileSync(path.join(app, "PRD.md"), readFileSync(PRD, "utf8") + "\nmore\n");
    await expect(recordArmC(app, { resultsDir: results })).rejects.toThrow(/PRD\.md/);
    writeFileSync(path.join(app, "PRD.md"), readFileSync(PRD));
    await recordArmC(app, { resultsDir: results });
    await expect(recordArmC(app, { resultsDir: results })).rejects.toThrow(/already recorded/);
  });

  it("refuses a model that is not set in the config", async () => {
    writeFileSync(path.join(app, "holdback.config.json"), "{}");
    await ledger([turn(1, "2026-11-15T10:10:00.000Z", 1, 5)]);
    await expect(recordArmC(app, { resultsDir: results })).rejects.toThrow(/agent\.model is not set/);
  });

  it("marks uncommitted changes", async () => {
    await ledger([turn(1, "2026-11-15T10:10:00.000Z", 1, 5)]);
    writeFileSync(path.join(app, "stray.txt"), "x");
    expect((await recordArmC(app, { resultsDir: results })).dirty).toBe(true);
  });
});

