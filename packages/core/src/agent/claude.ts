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
  /** Aborting kills the agent's process tree; the turn then resolves with whatever it had printed. */
  signal?: AbortSignal;
  /** Every stream-json line the agent prints, as it arrives (a transcript for the caller). */
  onLine?: (line: string) => void;
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
  /** Last ~4 KB of the process's stderr. */
  stderrTail: string;
  durationMs: number;
  timedOut: boolean;
}

const STDERR_TAIL_BYTES = 4096;

/** Absolute path of the agent contract shipped next to this module (src/ in dev, dist/ when built). */
export function contractPath(): string {
  return fileURLToPath(new URL("./contract.md", import.meta.url));
}

/** Absolute path of the compiled PreToolUse guard entry (exists once the package is built). */
export function guardMainPath(): string {
  return fileURLToPath(new URL("./guard-main.js", import.meta.url));
}

/**
 * Set on every headless agent process: Claude Code passes it to the hooks it runs, so the
 * interactive hooks an app may also have installed (`init --agent claude`) stand aside inside a
 * headless turn, whose run already holds the check lock. The agent cannot take it off its parent.
 */
export const HEADLESS_ENV = "HOLDBACK_HEADLESS";

/**
 * Run one headless Claude Code turn and parse its final `result` line.
 * The binary is HOLDBACK_CLAUDE_BIN or `claude`; a `.mjs`/`.js` binary is run
 * through node (test fake).
 */
export function runClaudeTurn(opts: ClaudeTurnOptions): Promise<ClaudeTurnResult> {
  const bin = process.env.HOLDBACK_CLAUDE_BIN ?? "claude";
  const isScript = /\.(mjs|js)$/i.test(bin);
  const args = [
    // No prompt argument: `claude -p` reads the prompt from stdin. Multi-line argv is
    // mangled when `claude` resolves to an npm .cmd shim on Windows.
    "-p",
    "--output-format",
    "stream-json",
    "--verbose",
    "--permission-mode",
    "bypassPermissions",
    "--settings",
    opts.settingsFile,
    // A clean, reproducible agent: the app's own project/local settings (and Holdback's --settings,
    // which carries the guard hook) but none of the user's plugins, hooks, global CLAUDE.md or MCP
    // servers. Not --bare: it would drop the guard hook as well.
    "--setting-sources",
    "project,local",
    "--strict-mcp-config",
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
    let stderrTail = "";
    let result: Record<string, unknown> | undefined;
    let timedOut = false;
    let settled = false;
    let graceTimer: NodeJS.Timeout | undefined;

    const child = spawn(cmd, cmdArgs, {
      cwd: opts.cwd,
      env: { ...process.env, ...opts.env, [HEADLESS_ENV]: "1" },
      stdio: ["pipe", "pipe", "pipe"],
      windowsHide: true,
    });
    child.stdin?.on("error", () => {
      /* child exited before reading the prompt */
    });
    child.stdin?.end(opts.prompt);

    const handleLine = (line: string) => {
      const t = line.trim();
      if (!t.startsWith("{")) return;
      opts.onLine?.(t);
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
    child.stderr?.setEncoding("utf8");
    child.stderr?.on("data", (chunk: string) => {
      stderrTail = (stderrTail + chunk).slice(-STDERR_TAIL_BYTES);
    });

    const killTree = () => {
      if (settled || graceTimer) return;
      if (child.pid !== undefined) treeKill(child.pid, "SIGKILL");
      else child.kill("SIGKILL");
      graceTimer = setTimeout(() => {
        child.stdout?.destroy();
        child.stderr?.destroy();
        finish(124);
      }, opts.killGraceMs ?? 2000);
    };
    const timer = setTimeout(() => {
      timedOut = true;
      killTree();
    }, opts.timeoutMs);
    const onAbort = () => killTree();
    opts.signal?.addEventListener("abort", onAbort, { once: true });
    if (opts.signal?.aborted) onAbort();

    const finish = (code: number) => {
      if (settled) return;
      settled = true;
      clearTimeout(timer);
      clearTimeout(graceTimer);
      opts.signal?.removeEventListener("abort", onAbort);
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
        stderrTail,
        durationMs: Date.now() - started,
        timedOut,
      });
    };

    child.on("error", (err) => {
      if (settled) return;
      settled = true;
      clearTimeout(timer);
      clearTimeout(graceTimer);
      opts.signal?.removeEventListener("abort", onAbort);
      reject(err);
    });
    child.on("close", (code) => finish(code ?? (timedOut ? 124 : 1)));
  });
}
