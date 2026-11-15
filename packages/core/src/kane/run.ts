import spawn from "cross-spawn";
import treeKill from "tree-kill";
import { parseLine, type KaneEvent } from "./ndjson.js";

export interface RunKaneOptions {
  cwd: string;
  timeoutMs: number;
  env?: NodeJS.ProcessEnv;
  onEvent?: (e: KaneEvent) => void;
}

export interface RunKaneResult {
  exitCode: number;
  events: KaneEvent[];
  stderr: string;
  durationMs: number;
  timedOut: boolean;
}

/**
 * Run kane-cli (or the binary named by HOLDBACK_KANE_BIN) and collect its
 * NDJSON event stream. cross-spawn is used because on Windows kane-cli is an
 * npm `.cmd` shim that plain spawn cannot execute without a shell.
 *
 * If the binary ends in `.mjs` / `.js` it is treated as a Node script and run
 * as `process.execPath <script> ...args` (used by the test fake).
 */
export function runKane(args: string[], opts: RunKaneOptions): Promise<RunKaneResult> {
  const bin = process.env.HOLDBACK_KANE_BIN ?? "kane-cli";
  const isScript = /\.(mjs|js)$/i.test(bin);
  const cmd = isScript ? process.execPath : bin;
  const cmdArgs = isScript ? [bin, ...args] : args;

  return new Promise((resolve, reject) => {
    const started = Date.now();
    const events: KaneEvent[] = [];
    let stderr = "";
    let buf = "";
    let timedOut = false;
    let settled = false;

    const child = spawn(cmd, cmdArgs, {
      cwd: opts.cwd,
      env: { ...process.env, ...opts.env },
      stdio: ["ignore", "pipe", "pipe"],
    });

    const handleLine = (line: string) => {
      const ev = parseLine(line);
      if (!ev) return;
      events.push(ev);
      opts.onEvent?.(ev);
    };

    child.stdout?.setEncoding("utf8");
    child.stdout?.on("data", (chunk: string) => {
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
      if (child.pid !== undefined) treeKill(child.pid, "SIGKILL");
      else child.kill("SIGKILL");
    }, opts.timeoutMs);

    const finish = (exitCode: number) => {
      if (settled) return;
      settled = true;
      clearTimeout(timer);
      if (buf.length > 0) handleLine(buf);
      buf = "";
      resolve({ exitCode, events, stderr, durationMs: Date.now() - started, timedOut });
    };

    child.on("error", (err) => {
      if (settled) return;
      settled = true;
      clearTimeout(timer);
      reject(err);
    });
    // "close" fires after stdio streams end, so no trailing output is lost.
    child.on("close", (code) => finish(code ?? (timedOut ? 124 : 1)));
  });
}
