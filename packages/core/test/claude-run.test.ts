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
});
