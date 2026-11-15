import { spawn } from "node:child_process";
import { createConnection, createServer } from "node:net";
import treeKill from "tree-kill";

export interface StartAppOptions {
  cwd: string;
  cmd: string;
  port: number;
  readyPath: string;
  env?: Record<string, string>;
  /** Max wait for the app to answer HTTP. Default 60000. */
  timeoutMs?: number;
}

export interface RunningApp {
  url: string;
  stop: () => Promise<void>;
  logs: () => string;
}

export class AppStartError extends Error {
  constructor(message: string, public readonly logs: string) {
    super(message);
    this.name = "AppStartError";
  }
}

/**
 * Another program already listens on the port: nothing was started. Not an AppStartError, since
 * the app's code is not at fault, so it is never briefed to the coding agent as one to fix.
 */
export class PortInUse extends Error {
  constructor(public readonly port: number) {
    super(`port ${port} is already in use by another program: stop it, or set start.port in holdback.config.json to a free port`);
    this.name = "PortInUse";
  }
}

const MAX_LOG_LINES = 400;
const sleep = (ms: number) => new Promise<void>((r) => setTimeout(r, ms));

/** Ask the OS for a currently free TCP port on 127.0.0.1. */
export function freePort(): Promise<number> {
  return new Promise((resolve, reject) => {
    const srv = createServer();
    srv.once("error", reject);
    srv.listen(0, "127.0.0.1", () => {
      const addr = srv.address();
      const port = typeof addr === "object" && addr ? addr.port : 0;
      srv.close((err) => (err ? reject(err) : resolve(port)));
    });
  });
}

function portAccepts(port: number): Promise<boolean> {
  return new Promise((resolve) => {
    const s = createConnection({ port, host: "127.0.0.1" });
    const done = (ok: boolean) => {
      s.destroy();
      resolve(ok);
    };
    s.setTimeout(500, () => done(false));
    s.once("connect", () => done(true));
    s.once("error", () => done(false));
  });
}

async function probe(url: string): Promise<boolean> {
  try {
    const res = await fetch(url, { redirect: "manual", signal: AbortSignal.timeout(1000) });
    await res.body?.cancel().catch(() => {});
    // redirect: "manual" yields 3xx as-is (or status 0 for opaque redirects in some runtimes)
    return res.status >= 200 && res.status < 400;
  } catch {
    return false;
  }
}

/**
 * Start `cmd` through a shell with PORT set, wait until it answers HTTP on
 * `readyPath`, and return handles to stop it (whole process tree) and read logs.
 * Throws `PortInUse`, before starting anything, when the port already accepts connections.
 */
export async function startApp(opts: StartAppOptions): Promise<RunningApp> {
  const timeoutMs = opts.timeoutMs ?? 60000;
  // a server already on the port would answer the readiness probe (and Kane) in the app's place
  if (await portAccepts(opts.port)) throw new PortInUse(opts.port);
  const lines: string[] = [];
  let partial = "";
  const push = (chunk: string) => {
    partial += chunk;
    const parts = partial.split(/\r?\n/);
    partial = parts.pop() ?? "";
    lines.push(...parts);
    if (lines.length > MAX_LOG_LINES) lines.splice(0, lines.length - MAX_LOG_LINES);
  };
  const logs = () => (partial ? [...lines, partial] : lines).join("\n");

  // node's own spawn: the shell resolves the command. cross-spawn would report any shell command
  // that exits with 1 on Windows as "spawn <cmd> ENOENT", hiding the app's own crash
  const child = spawn(opts.cmd, [], {
    cwd: opts.cwd,
    shell: true,
    env: { ...process.env, ...opts.env, PORT: String(opts.port) },
    stdio: ["ignore", "pipe", "pipe"],
    windowsHide: true,
  });
  child.stdout?.setEncoding("utf8");
  child.stderr?.setEncoding("utf8");
  child.stdout?.on("data", push);
  child.stderr?.on("data", push);

  let exited = false;
  let exitCode: number | null = null;
  let spawnError: Error | undefined;
  child.on("exit", (code) => {
    exitCode = code;
    exited = true;
  });
  child.on("error", (e) => {
    spawnError = e;
    exited = true;
  });

  const killTree = (): Promise<void> =>
    new Promise((resolve) => {
      if (child.pid === undefined) return resolve();
      treeKill(child.pid, "SIGKILL", () => resolve());
    });

  let stopped: Promise<void> | undefined;
  const stop = (): Promise<void> => {
    stopped ??= (async () => {
      await killTree();
      const deadline = Date.now() + 5000;
      while (Date.now() < deadline && (await portAccepts(opts.port))) await sleep(100);
      child.stdout?.destroy();
      child.stderr?.destroy();
    })();
    return stopped;
  };

  const url = `http://127.0.0.1:${opts.port}`;
  const readyUrl = `${url}${opts.readyPath}`;
  const deadline = Date.now() + timeoutMs;
  for (;;) {
    if (exited) {
      await sleep(50); // let trailing output drain
      await stop();
      throw new AppStartError(
        spawnError
          ? `app did not start: ${spawnError.message}`
          : `app exited${exitCode === null ? "" : ` with code ${exitCode}`} before becoming ready`,
        logs(),
      );
    }
    if (await probe(readyUrl)) break;
    if (Date.now() >= deadline) {
      await stop();
      throw new AppStartError(`app did not answer ${readyUrl} within ${timeoutMs}ms`, logs());
    }
    await sleep(100);
  }
  return { url, stop, logs };
}
