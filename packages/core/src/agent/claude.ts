import { fileURLToPath } from "node:url";
import spawn from "cross-spawn";
import treeKill from "tree-kill";

export interface ClaudeTurnOptions {
  cwd: string;
  prompt: string;
  settingsFile: string;
  contractFile: string;
  maxTurns: number;
  model?: string;
  timeoutMs: number;
  env?: NodeJS.ProcessEnv;
  /** After a timeout kill, resolve anyway once this many ms pass without `close`. Default 2000. */
  killGraceMs?: number;
}

export interface ClaudeTurnResult {
  exitCode: number;
  /** `result` text, or the `errors` joined by newlines; "" when no result line arrived. */
  resultText: string;
  costUsd?: number;
  numTurns?: number;
  isError?: boolean;
  subtype?: string;
  permissionDenials?: unknown[];
  durationMs: number;
  timedOut: boolean;
}

/** Absolute path of the agent contract shipped next to this module (src/ in dev, dist/ when built). */
export function contractPath(): string {
  return fileURLToPath(new URL("./contract.md", import.meta.url));
}

/**
 * Run one headless Claude Code turn and parse its final `result` line.
 * The binary is HOLDBACK_CLAUDE_BIN or `claude`; a `.mjs`/`.js` binary is run
 * through node (test fake).
 */
export function runClaudeTurn(opts: ClaudeTurnOptions): Promise<ClaudeTurnResult> {
  const bin = process.env.HOLDBACK_CLAUDE_BIN ?? "claude";
  const isScript = /\.(mjs|js)$/i.test(bin);
  const args = [
    "-p",
    opts.prompt,
    "--output-format",
    "stream-json",
    "--verbose",
    "--permission-mode",
    "bypassPermissions",
    "--settings",
    opts.settingsFile,
    "--append-system-prompt-file",
    opts.contractFile,
    "--max-turns",
    String(opts.maxTurns),
    ...(opts.model ? ["--model", opts.model] : []),
  ];
  const cmd = isScript ? process.execPath : bin;
  const cmdArgs = isScript ? [bin, ...args] : args;

  return new Promise((resolve, reject) => {
    const started = Date.now();
    let buf = "";
    let result: Record<string, unknown> | undefined;
    let timedOut = false;
    let settled = false;
    let graceTimer: NodeJS.Timeout | undefined;

    const child = spawn(cmd, cmdArgs, {
      cwd: opts.cwd,
      env: { ...process.env, ...opts.env },
      stdio: ["ignore", "pipe", "pipe"],
    });

    const handleLine = (line: string) => {
      const t = line.trim();
      if (!t.startsWith("{")) return;
      try {
        const o = JSON.parse(t) as Record<string, unknown>;
        if (o.type === "result") result = o;
      } catch {
        /* partial or non-JSON line */
      }
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
    child.stderr?.resume();

    const timer = setTimeout(() => {
      timedOut = true;
      if (child.pid !== undefined) treeKill(child.pid, "SIGKILL");
      else child.kill("SIGKILL");
      graceTimer = setTimeout(() => {
        child.stdout?.destroy();
        child.stderr?.destroy();
        finish(124);
      }, opts.killGraceMs ?? 2000);
    }, opts.timeoutMs);

    const finish = (code: number) => {
      if (settled) return;
      settled = true;
      clearTimeout(timer);
      clearTimeout(graceTimer);
      if (buf.length > 0) handleLine(buf);
      buf = "";
      const r = result;
      const errors = Array.isArray(r?.errors) ? (r.errors as unknown[]).map(String) : undefined;
      const resultText = typeof r?.result === "string" ? r.result : (errors?.join("\n") ?? "");
      resolve({
        exitCode: r || code !== 0 ? code : 1,
        resultText,
        costUsd: typeof r?.total_cost_usd === "number" ? r.total_cost_usd : undefined,
        numTurns: typeof r?.num_turns === "number" ? r.num_turns : undefined,
        isError: typeof r?.is_error === "boolean" ? r.is_error : undefined,
        subtype: typeof r?.subtype === "string" ? r.subtype : undefined,
        permissionDenials: Array.isArray(r?.permission_denials) ? (r.permission_denials as unknown[]) : undefined,
        durationMs: Date.now() - started,
        timedOut,
      });
    };

    child.on("error", (err) => {
      if (settled) return;
      settled = true;
      clearTimeout(timer);
      clearTimeout(graceTimer);
      reject(err);
    });
    child.on("close", (code) => finish(code ?? (timedOut ? 124 : 1)));
  });
}
