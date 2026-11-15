import { existsSync, mkdirSync, mkdtempSync, readdirSync, readFileSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import path, { join } from "node:path";
import { fileURLToPath } from "node:url";
import { afterEach, describe, expect, it } from "vitest";
import { runClaudeTurn } from "../src/agent/claude.js";
import { git } from "../src/git.js";
import { runKane } from "../src/kane/run.js";
import { assertPlainArgs, ProgramNotFound, resolveProgram, shimEntry, systemTool } from "../src/programs.js";

const win = process.platform === "win32";

/** The shim npm writes for a global `kane-cli` (as on the demo machine), with a canary line first: any run of it by cmd.exe leaves `ran.txt`. */
const npmShim = (canary = true) =>
  [
    ...(canary ? ['@echo ran> "%~dp0ran.txt"'] : []),
    "@ECHO off",
    "GOTO start",
    ":find_dp0",
    "SET dp0=%~dp0",
    "EXIT /b",
    ":start",
    "SETLOCAL",
    "CALL :find_dp0",
    "",
    'IF EXIST "%dp0%\\node.exe" (',
    '  SET "_prog=%dp0%\\node.exe"',
    ") ELSE (",
    '  SET "_prog=node"',
    "  SET PATHEXT=%PATHEXT:;.JS;=;%",
    ")",
    "",
    'endLocal & goto #_undefined_# 2>NUL || title %COMSPEC% & "%_prog%"  "%dp0%\\node_modules\\@testmuai\\kane-cli\\bin\\kane-cli.cjs" %*',
    "",
  ].join("\r\n");

/** A fake kane-cli entry: logs its argv as JSON and prints a `done` line. */
const FAKE_ENTRY = `const fs = require("node:fs");
fs.appendFileSync(process.env.FAKE_KANE_ARGV_LOG, JSON.stringify(process.argv.slice(2)) + "\\n");
process.stdout.write('{"type":"done","exit_code":0}\\n');
`;

/** A folder with `kane-cli.cmd` and the package it points at, as `npm i -g` lays them out. */
function npmPrefix(): { dir: string; entry: string } {
  const dir = mkdtempSync(join(tmpdir(), "hb-prefix-"));
  const bin = join(dir, "node_modules", "@testmuai", "kane-cli", "bin");
  mkdirSync(bin, { recursive: true });
  writeFileSync(join(bin, "kane-cli.cjs"), FAKE_ENTRY);
  writeFileSync(join(dir, "node_modules", "@testmuai", "kane-cli", "package.json"), JSON.stringify({ name: "@testmuai/kane-cli", bin: { "kane-cli": "./bin/kane-cli.cjs" } }));
  writeFileSync(join(dir, "kane-cli.cmd"), npmShim());
  return { dir, entry: join(bin, "kane-cli.cjs") };
}

const savedBin = process.env.HOLDBACK_KANE_BIN;
const savedClaude = process.env.HOLDBACK_CLAUDE_BIN;
const savedPath = process.env.PATH;
// set in some shells (it stops cmd.exe looking in the current folder); a user's terminal usually lacks it
const savedNoCwd = process.env.NoDefaultCurrentDirectoryInExePath;
const savedCwd = process.cwd();
afterEach(() => {
  if (savedBin === undefined) delete process.env.HOLDBACK_KANE_BIN;
  else process.env.HOLDBACK_KANE_BIN = savedBin;
  if (savedClaude === undefined) delete process.env.HOLDBACK_CLAUDE_BIN;
  else process.env.HOLDBACK_CLAUDE_BIN = savedClaude;
  if (savedNoCwd === undefined) delete process.env.NoDefaultCurrentDirectoryInExePath;
  else process.env.NoDefaultCurrentDirectoryInExePath = savedNoCwd;
  process.env.PATH = savedPath;
  process.chdir(savedCwd);
  delete process.env.HB_CANARY;
});

/** A batch file that leaves `ran.txt` next to itself when anything runs it. */
const canary = '@echo ran> "%~dp0ran.txt"\r\n';

describe("shimEntry", () => {
  const all = () => true;
  it("reads the JS entry out of npm's shim", () => {
    expect(shimEntry(npmShim(false), "C:\\npm", all)).toBe(path.resolve("C:\\npm", "node_modules", "@testmuai", "kane-cli", "bin", "kane-cli.cjs"));
  });
  it("reads older npm and pnpm shims", () => {
    expect(shimEntry('"%~dp0\\node.exe"  "%~dp0\\node_modules\\x\\cli.js" %*', "C:\\g", all)).toBe(path.resolve("C:\\g", "node_modules", "x", "cli.js"));
    expect(shimEntry('"%~dp0\\..\\@scope\\x\\bin\\x.mjs" %*', "C:\\g\\bin", all)).toBe(path.resolve("C:\\g", "@scope", "x", "bin", "x.mjs"));
  });
  it("names nothing for a batch file that is not a shim", () => {
    expect(shimEntry("@echo off\r\nnode C:\\x\\cli.js %*\r\n", "C:\\g", all)).toBeUndefined();
    expect(shimEntry(npmShim(false), "C:\\npm", () => false)).toBeUndefined();
  });
});

describe("assertPlainArgs", () => {
  it("refuses a NUL, a carriage return or a newline in any argument", () => {
    for (const bad of ["a\nb", "a\rb", "a\0b"]) expect(() => assertPlainArgs("kane-cli", ["maintain", "--because", bad])).toThrow(/argument 3/);
    expect(() => assertPlainArgs("kane-cli", ["--because", `a & b | c > d ^ %X% "q"`])).not.toThrow();
  });
});

describe("resolveProgram", () => {
  it("runs a script override under this Node, a .cjs one too", () => {
    const f = join(mkdtempSync(join(tmpdir(), "hb-")), "fake.cjs");
    writeFileSync(f, "");
    expect(resolveProgram("kane-cli", { override: f, overrideVar: "HOLDBACK_KANE_BIN" })).toEqual({ cmd: process.execPath, prefix: [f] });
  });

  it("says what to set when the program is nowhere on PATH", () => {
    const empty = mkdtempSync(join(tmpdir(), "hb-"));
    expect(() => resolveProgram("kane-cli", { overrideVar: "HOLDBACK_KANE_BIN", env: { PATH: empty } })).toThrow(ProgramNotFound);
    expect(() => resolveProgram("kane-cli", { overrideVar: "HOLDBACK_KANE_BIN", env: { PATH: empty } })).toThrow(/kane-cli was not found on PATH.*HOLDBACK_KANE_BIN/);
  });

  it.runIf(win)("on Windows, resolves npm's kane-cli.cmd to node and its .cjs entry", () => {
    const { dir, entry } = npmPrefix();
    expect(resolveProgram("kane-cli", { overrideVar: "HOLDBACK_KANE_BIN", env: { PATH: `${dir};C:\\nowhere` } })).toEqual({ cmd: process.execPath, prefix: [entry] });
    // the override may name the shim itself
    expect(resolveProgram("kane-cli", { override: join(dir, "kane-cli.cmd"), overrideVar: "HOLDBACK_KANE_BIN" })).toEqual({ cmd: process.execPath, prefix: [entry] });
  });

  it.runIf(win)("on Windows, falls back to the package's bin when the shim's text names no entry", () => {
    const { dir, entry } = npmPrefix();
    writeFileSync(join(dir, "kane-cli.cmd"), "@echo off\r\nnode %KANE% %*\r\n");
    const pkg = { name: "@testmuai/kane-cli", bin: "kane-cli" };
    expect(resolveProgram("kane-cli", { overrideVar: "HOLDBACK_KANE_BIN", env: { PATH: dir }, pkg })).toEqual({ cmd: process.execPath, prefix: [entry] });
  });

  it.runIf(win)("on Windows, refuses a batch file it cannot read an entry out of, never handing it to cmd.exe", () => {
    const dir = mkdtempSync(join(tmpdir(), "hb-"));
    writeFileSync(join(dir, "kane-cli.cmd"), "@echo off\r\nnode %KANE% %*\r\n");
    expect(() => resolveProgram("kane-cli", { overrideVar: "HOLDBACK_KANE_BIN", env: { PATH: dir } })).toThrow(
      /can't locate kane-cli's entry script.*set HOLDBACK_KANE_BIN to its \.js\/\.exe/,
    );
  });

  it.runIf(win)("on Windows, never looks in the current folder, and finds taskkill under System32", () => {
    const here = mkdtempSync(join(tmpdir(), "hb-"));
    writeFileSync(join(here, "kane-cli.cmd"), npmShim());
    const empty = mkdtempSync(join(tmpdir(), "hb-"));
    expect(() => resolveProgram("kane-cli", { overrideVar: "X", env: { PATH: `.;${empty}` } })).toThrow(ProgramNotFound);
    expect(systemTool("taskkill.exe", { SystemRoot: "C:\\Windows" })).toBe("C:\\Windows\\System32\\taskkill.exe");
  });
});

describe.runIf(win)("C-1: kane-cli through a real npm .cmd shim on Windows", () => {
  it("passes &, |, <, >, ^, %VAR%, ! and quotes in --because through verbatim and runs nothing else", async () => {
    const { dir } = npmPrefix();
    delete process.env.HOLDBACK_KANE_BIN;
    process.env.PATH = `${dir};${savedPath}`;
    process.env.HB_CANARY = "EXPANDED";
    const cwd = mkdtempSync(join(tmpdir(), "hb-cwd-"));
    const log = join(mkdtempSync(join(tmpdir(), "hb-log-")), "argv.log");
    const because =
      'A planted bug got past every test. ac-2 ("income above the limit & no SNAP is Not eligible > see table"): With 9 & 9000 | x, ' +
      'the page should show "Eligible" ^& limit, but it showed "Not eligible" < 3 %HB_CANARY% !HB_CANARY! & echo pwned> pwned.txt " & echo pwned2> pwned2.txt';
    const args = ["maintain", "evolve", "uc-1", "--because", because, "--mode", "agent"];
    const r = await runKane(args, { cwd, timeoutMs: 20_000, env: { FAKE_KANE_ARGV_LOG: log } });
    expect(r.exitCode).toBe(0);
    expect(r.events).toEqual([{ type: "done", exit_code: 0 }]);
    expect(readFileSync(log, "utf8").trim().split("\n").map((l) => JSON.parse(l))).toEqual([args]);
    // nothing ran in cmd.exe: not the shim, not a redirect, not an injected command
    expect(existsSync(join(dir, "ran.txt"))).toBe(false);
    expect(readdirSync(cwd)).toEqual([]);
  });

  it("refuses a line break in an argument before anything runs", async () => {
    const { dir } = npmPrefix();
    delete process.env.HOLDBACK_KANE_BIN;
    process.env.PATH = `${dir};${savedPath}`;
    const log = join(mkdtempSync(join(tmpdir(), "hb-log-")), "argv.log");
    await expect(runKane(["maintain", "evolve", "uc-1", "--because", "one\r\ntwo"], { cwd: tmpdir(), timeoutMs: 20_000, env: { FAKE_KANE_ARGV_LOG: log } })).rejects.toThrow(
      /line break/,
    );
    expect(existsSync(log)).toBe(false);
  });

  it("refuses a kane-cli.cmd it cannot read an entry out of, and never runs it", async () => {
    const dir = mkdtempSync(join(tmpdir(), "hb-prefix-"));
    writeFileSync(join(dir, "kane-cli.cmd"), '@echo ran> "%~dp0ran.txt"\r\n@echo off\r\nnode %KANE% %*\r\n');
    delete process.env.HOLDBACK_KANE_BIN;
    process.env.PATH = `${dir};${savedPath}`;
    await expect(runKane(["balance"], { cwd: tmpdir(), timeoutMs: 20_000 })).rejects.toThrow(/can't locate kane-cli's entry script.*HOLDBACK_KANE_BIN/);
    expect(existsSync(join(dir, "ran.txt"))).toBe(false);
  });
});

describe.runIf(win)("C-1: no program is taken from the folder it runs in", () => {
  it("a git.bat or git.cmd planted in the repo does not run", async () => {
    delete process.env.NoDefaultCurrentDirectoryInExePath;
    const repo = mkdtempSync(join(tmpdir(), "hb-repo-"));
    writeFileSync(join(repo, "git.bat"), canary);
    writeFileSync(join(repo, "git.cmd"), canary);
    const r = await git(repo, ["--version"]);
    expect(r.code).toBe(0);
    expect(r.stdout).toMatch(/^git version/);
    expect(existsSync(join(repo, "ran.txt"))).toBe(false);
  });

  it("a claude.cmd planted in the app does not run; npm's claude shim runs its JS entry under node", async () => {
    delete process.env.NoDefaultCurrentDirectoryInExePath;
    delete process.env.HOLDBACK_CLAUDE_BIN;
    const prefix = mkdtempSync(join(tmpdir(), "hb-prefix-"));
    const pkg = join(prefix, "node_modules", "@anthropic-ai", "claude-code");
    mkdirSync(pkg, { recursive: true });
    const argsFile = join(prefix, "args.json");
    writeFileSync(
      join(pkg, "cli.js"),
      `require("node:fs").writeFileSync(${JSON.stringify(argsFile)}, JSON.stringify(process.argv.slice(2)));
process.stdin.resume(); process.stdin.on("end", () => { console.log(JSON.stringify({ type: "result", subtype: "success", is_error: false, result: "done" })); });`,
    );
    writeFileSync(join(prefix, "claude.cmd"), canary + '@"%~dp0\\node.exe" "%~dp0\\node_modules\\@anthropic-ai\\claude-code\\cli.js" %*\r\n');
    process.env.PATH = `${prefix};${savedPath}`;
    const app = mkdtempSync(join(tmpdir(), "hb-app-"));
    writeFileSync(join(app, "claude.cmd"), canary);
    writeFileSync(join(app, "claude.bat"), canary);
    const r = await runClaudeTurn({ cwd: app, prompt: "go", settingsFile: "a & b.json", contractFile: "c%PATH%.md", maxTurns: 1, timeoutMs: 20_000 });
    expect(r.resultText).toBe("done");
    expect(JSON.parse(readFileSync(argsFile, "utf8"))).toContain("a & b.json");
    expect(JSON.parse(readFileSync(argsFile, "utf8"))).toContain("c%PATH%.md");
    expect(existsSync(join(app, "ran.txt"))).toBe(false);
    expect(existsSync(join(prefix, "ran.txt"))).toBe(false);
  });

  it("a taskkill.bat in the current folder does not run when a hung Kane is killed", async () => {
    delete process.env.NoDefaultCurrentDirectoryInExePath;
    const here = mkdtempSync(join(tmpdir(), "hb-here-"));
    writeFileSync(join(here, "taskkill.bat"), canary);
    writeFileSync(join(here, "taskkill.cmd"), canary);
    process.chdir(here);
    process.env.HOLDBACK_KANE_BIN = join(path.dirname(fileURLToPath(import.meta.url)), "fake-kane.mjs");
    const pidFile = join(mkdtempSync(join(tmpdir(), "hb-")), "pid");
    const r = await runKane([], { cwd: tmpdir(), timeoutMs: 500, env: { FAKE_KANE_HANG: "1", FAKE_KANE_PID_FILE: pidFile } });
    expect(r.timedOut).toBe(true);
    const pid = Number(readFileSync(pidFile, "utf8"));
    const alive = () => {
      try {
        process.kill(pid, 0);
        return true;
      } catch {
        return false;
      }
    };
    for (let i = 0; i < 50 && alive(); i++) await new Promise((res) => setTimeout(res, 100));
    expect(alive()).toBe(false);
    expect(existsSync(join(here, "ran.txt"))).toBe(false);
  }, 20_000);
});
