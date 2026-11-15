import { spawn } from "node:child_process";
import { trackChild } from "../children.js";
import { assertPlainArgs, killTree, resolveProgram, type Program } from "../programs.js";
import { parseLine, type KaneEvent } from "./ndjson.js";

export interface RunKaneOptions {
  cwd: string;
  timeoutMs: number;
  env?: NodeJS.ProcessEnv;
  onEvent?: (e: KaneEvent) => void;
  /** After a timeout kill, resolve anyway once this many ms pass without `close`. Default 2000. */
  killGraceMs?: number;
}

export interface RunKaneResult {
  exitCode: number;
  events: KaneEvent[];
  /** Full raw stdout text, including non-JSON lines (e.g. `Available credits: ...`). */
  stdout: string;
  stderr: string;
  durationMs: number;
  timedOut: boolean;
}

/** Where kane-cli is: `HOLDBACK_KANE_BIN`, else `kane-cli` on PATH (on Windows, the JS entry behind npm's shim). */
export function kaneProgram(): Program {
  return resolveProgram("kane-cli", { override: process.env.HOLDBACK_KANE_BIN, overrideVar: "HOLDBACK_KANE_BIN", pkg: { name: "@testmuai/kane-cli", bin: "kane-cli" } });
}

/**
 * Run kane-cli (or the program named by HOLDBACK_KANE_BIN) and collect its NDJSON event stream.
 * Never through a shell (C-1): on Windows kane-cli is an npm `.cmd` shim whose `%*` cmd.exe would
 * parse again, so `&`, `|`, `>` or `%VAR%` in a `--because` would run as commands. Its JS entry runs
 * under this Node instead (`kaneProgram`); a `.js`/`.cjs`/`.mjs` override does too (the test fake).
 * An argument with a NUL or a line break is refused before anything runs.
 */
export async function runKane(args: string[], opts: RunKaneOptions): Promise<RunKaneResult> {
  assertPlainArgs("kane-cli", args);
  const program = kaneProgram();
  const cmd = program.cmd;
  const cmdArgs = [...program.prefix, ...args];

  return new Promise((resolve, reject) => {
    const started = Date.now();
    const events: KaneEvent[] = [];
    let stderr = "";
    let buf = "";
    let stdout = "";
    let timedOut = false;
    let settled = false;

    const child = spawn(cmd, cmdArgs, {
      cwd: opts.cwd,
      env: { ...process.env, ...opts.env },
      stdio: ["ignore", "pipe", "pipe"],
      windowsHide: true,
      shell: false,
    });

    const untrack = trackChild(child.pid);
    child.on("exit", untrack);

    const handleLine = (line: string) => {
      const ev = parseLine(line);
      if (!ev) return;
      events.push(ev);
      opts.onEvent?.(ev);
    };

    child.stdout?.setEncoding("utf8");
    child.stdout?.on("data", (chunk: string) => {
      stdout += chunk;
      buf += chunk;
      let i: number;
      while ((i = buf.indexOf("\n")) >= 0) {
        handleLine(buf.slice(0, i));
        buf = buf.slice(i + 1);
      }
    });
    child.stderr?.setEncoding("utf8");
    child.stderr?.on("data", (chunk: string) => {
      stderr += chunk;
    });

    const timer = setTimeout(() => {
      timedOut = true;
      if (child.pid !== undefined) killTree(child.pid);
      else child.kill("SIGKILL");
      // If the kill did not land or a grandchild keeps stdio open, "close" may
      // never fire: give up waiting and resolve with what we have.
      graceTimer = setTimeout(() => {
        child.stdout?.destroy();
        child.stderr?.destroy();
        finish(124);
      }, opts.killGraceMs ?? 2000);
    }, opts.timeoutMs);
    let graceTimer: NodeJS.Timeout | undefined;

    const finish = (exitCode: number) => {
      untrack();
      if (settled) return;
      settled = true;
      clearTimeout(timer);
      clearTimeout(graceTimer);
      if (buf.length > 0) handleLine(buf);
      buf = "";
      resolve({ exitCode, events, stdout, stderr, durationMs: Date.now() - started, timedOut });
    };

    child.on("error", (err) => {
      untrack();
      if (settled) return;
      settled = true;
      clearTimeout(timer);
      clearTimeout(graceTimer);
      reject(err);
    });
    // "close" fires after stdio streams end, so no trailing output is lost.
    child.on("close", (code) => finish(code ?? (timedOut ? 124 : 1)));
  });
}
