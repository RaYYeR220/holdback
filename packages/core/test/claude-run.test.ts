import { mkdtempSync, readFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { afterEach, describe, expect, it } from "vitest";
import { runClaudeTurn } from "../src/agent/claude.js";

const fake = join(dirname(fileURLToPath(import.meta.url)), "fake-claude.mjs");
const saved = process.env.HOLDBACK_CLAUDE_BIN;
afterEach(() => {
  if (saved === undefined) delete process.env.HOLDBACK_CLAUDE_BIN;
  else process.env.HOLDBACK_CLAUDE_BIN = saved;
  delete process.env.FAKE_CLAUDE_MODE;
  delete process.env.FAKE_CLAUDE_ARGS_FILE;
  delete process.env.FAKE_CLAUDE_STDIN_FILE;
  delete process.env.FAKE_CLAUDE_STDERR;
  delete process.env.FAKE_CLAUDE_ENV_FILE;
});
const base = () => ({
  cwd: tmpdir(),
  prompt: "do it",
  settingsFile: "s.json",
  contractFile: "c.md",
  maxTurns: 3,
  timeoutMs: 10_000,
});

describe("runClaudeTurn", () => {
  it("parses the result line and passes the documented flags", async () => {
    process.env.HOLDBACK_CLAUDE_BIN = fake;
    const argsFile = join(mkdtempSync(join(tmpdir(), "hb-")), "args.json");
    process.env.FAKE_CLAUDE_ARGS_FILE = argsFile;
    const stdinFile = join(mkdtempSync(join(tmpdir(), "hb-")), "stdin.txt");
    process.env.FAKE_CLAUDE_STDIN_FILE = stdinFile;
    process.env.FAKE_CLAUDE_STDERR = "x".repeat(6000) + "TAIL";
    const r = await runClaudeTurn({ ...base(), prompt: "line1\nline2 \"q\"\nline3", model: "sonnet" });
    expect(readFileSync(stdinFile, "utf8")).toBe("line1\nline2 \"q\"\nline3");
    expect(r.stderrTail.length).toBeLessThanOrEqual(4096);
    expect(r.stderrTail.endsWith("TAIL")).toBe(true);
    expect(r).toMatchObject({ exitCode: 0, resultText: "done", costUsd: 0.12, numTurns: 7, isError: false, subtype: "success" });
    const args: string[] = JSON.parse(readFileSync(argsFile, "utf8"));
    expect(args[0]).toBe("-p");
    expect(args.some((a) => a.includes("line1"))).toBe(false); // prompt goes on stdin, not argv
    for (const a of ["--output-format", "stream-json", "--verbose", "--permission-mode", "bypassPermissions",
      "--settings", "s.json", "--append-system-prompt-file", "c.md", "--max-turns", "3", "--model", "sonnet"])
      expect(args).toContain(a);
  });
  it("runs the agent without the user's own Claude Code setup: project and local settings only, no MCP servers, never --bare (R34)", async () => {
    process.env.HOLDBACK_CLAUDE_BIN = fake;
    const argsFile = join(mkdtempSync(join(tmpdir(), "hb-")), "args.json");
    process.env.FAKE_CLAUDE_ARGS_FILE = argsFile;
    await runClaudeTurn(base());
    const args: string[] = JSON.parse(readFileSync(argsFile, "utf8"));
    // no user-level plugins, hooks or CLAUDE.md; Holdback's guard comes in through --settings, which still applies
    expect(args[args.indexOf("--setting-sources") + 1]).toBe("project,local");
    expect(args).toContain("--strict-mcp-config");
    expect(args).not.toContain("--mcp-config");
    expect(args).not.toContain("--bare"); // it would drop the guard hook too
    expect(args[args.indexOf("--settings") + 1]).toBe("s.json");
  });
  it("marks the agent's process (and so every hook Claude Code runs from it) as a headless turn", async () => {
    process.env.HOLDBACK_CLAUDE_BIN = fake;
    const envFile = join(mkdtempSync(join(tmpdir(), "hb-")), "env.json");
    process.env.FAKE_CLAUDE_ENV_FILE = envFile;
    // the caller's env cannot take the mark off
    await runClaudeTurn({ ...base(), env: { HOLDBACK_HEADLESS: "" } });
    expect(JSON.parse(readFileSync(envFile, "utf8"))).toEqual({ HOLDBACK_HEADLESS: "1" });
  });
  it("joins errors for error results", async () => {
    process.env.HOLDBACK_CLAUDE_BIN = fake;
    process.env.FAKE_CLAUDE_MODE = "error";
    const r = await runClaudeTurn(base());
    expect(r).toMatchObject({ exitCode: 1, resultText: "too many\nturns", isError: true, subtype: "error_max_turns", numTurns: 3 });
  });
  it("missing result line gives non-zero exit and empty text", async () => {
    process.env.HOLDBACK_CLAUDE_BIN = fake;
    process.env.FAKE_CLAUDE_MODE = "killed";
    const r = await runClaudeTurn(base());
    expect(r.exitCode).not.toBe(0);
    expect(r.resultText).toBe("");
  });
  it("times out and kills the process", async () => {
    process.env.HOLDBACK_CLAUDE_BIN = fake;
    process.env.FAKE_CLAUDE_MODE = "hang";
    const r = await runClaudeTurn({ ...base(), timeoutMs: 400 });
    expect(r.exitCode).not.toBe(0);
    expect(r.resultText).toBe("");
    expect(r.durationMs).toBeLessThan(8000);
  });

  it("kills the agent when the signal aborts, promptly and without timing out", async () => {
    process.env.HOLDBACK_CLAUDE_BIN = fake;
    process.env.FAKE_CLAUDE_MODE = "hang";
    const ctl = new AbortController();
    setTimeout(() => ctl.abort(), 200);
    const started = Date.now();
    const r = await runClaudeTurn({ ...base(), timeoutMs: 60_000, killGraceMs: 500, signal: ctl.signal });
    expect(Date.now() - started).toBeLessThan(10_000);
    expect(r.timedOut).toBe(false);
    expect(r.exitCode).not.toBe(0);
    // already aborted: killed at once
    const r2 = await runClaudeTurn({ ...base(), timeoutMs: 60_000, killGraceMs: 500, signal: ctl.signal });
    expect(r2.exitCode).not.toBe(0);
  });
});
