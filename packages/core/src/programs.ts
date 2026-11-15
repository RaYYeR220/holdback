import { spawn } from "node:child_process";
import { accessSync, constants, readFileSync, statSync } from "node:fs";
import path from "node:path";
import treeKill from "tree-kill";

/**
 * How Holdback starts a program it runs for itself (kane-cli, claude, git, taskkill): an absolute
 * `cmd` and the arguments that go before the program's own (`prefix`), spawned with no shell. On
 * Windows an npm `.cmd` shim is never run: cmd.exe would parse its `%*` again and turn `&`, `|`, `>`
 * or `%VAR%` in an argument into commands (C-1). Its JS entry runs under this Node instead.
 */
export type Program = { cmd: string; prefix: string[] };

/** The program cannot be found, or found only in a form Holdback will not run (C-1). */
export class ProgramNotFound extends Error {}

const SCRIPT = /\.(c|m)?js$/i;
const SHIM = /\.(cmd|bat)$/i;
const NATIVE = /\.(exe|com)$/i;

export type ResolveOptions = {
  /** The override's value (`HOLDBACK_KANE_BIN`): a `.js`/`.cjs`/`.mjs` script, an executable, a Windows `.cmd` shim, or a name looked up on PATH. */
  override?: string;
  /** The override's name, for the error message (none for git). */
  overrideVar?: string;
  /** Where to look for the PATH (and PATHEXT, SystemRoot). Default: `process.env`. */
  env?: NodeJS.ProcessEnv;
  platform?: NodeJS.Platform;
  /** The Node that runs a script. Default: `process.execPath`. */
  execPath?: string;
  /** The npm package behind the shim and its `bin` name: read when the shim's own text names no entry. */
  pkg?: { name: string; bin: string };
};

/** A variable of `env`, its name matched without case on Windows (where `Path` is `PATH`). */
function envGet(env: NodeJS.ProcessEnv, name: string, platform: NodeJS.Platform): string | undefined {
  if (platform !== "win32") return env[name];
  const k = Object.keys(env).find((x) => x.toUpperCase() === name.toUpperCase());
  return k === undefined ? undefined : env[k];
}

const isFile = (f: string): boolean => {
  try {
    return statSync(f).isFile();
  } catch {
    return false;
  }
};

const isExecutable = (f: string): boolean => {
  try {
    accessSync(f, constants.X_OK);
    return isFile(f);
  } catch {
    return false;
  }
};

/**
 * The JS entry an npm (or pnpm) `.cmd` shim runs, from its text: the first `"%dp0%\…\x.js"` (or
 * `%~dp0`) path that exists, resolved against the shim's folder. Undefined for any other batch
 * file: Holdback cannot know what it runs without running cmd.exe on it.
 */
export function shimEntry(text: string, shimDir: string, exists: (f: string) => boolean = isFile): string | undefined {
  const re = /"%~?dp0%?\\?([^"%]+\.(?:c|m)?js)"/gi;
  let m: RegExpExecArray | null;
  while ((m = re.exec(text)) !== null) {
    const entry = path.resolve(shimDir, ...m[1]!.split(/[\\/]+/).filter((s) => s !== ""));
    if (exists(entry)) return entry;
  }
  return undefined;
}

/** The JS file `pkg`'s `bin` names, in `<root>/<pkg>/package.json`, when it exists. */
function packageBin(root: string, pkg: { name: string; bin: string }): string | undefined {
  try {
    const dir = path.join(root, ...pkg.name.split("/"));
    const json = JSON.parse(readFileSync(path.join(dir, "package.json"), "utf8")) as { bin?: string | Record<string, string> };
    const rel = typeof json.bin === "string" ? json.bin : json.bin?.[pkg.bin];
    if (typeof rel !== "string" || !SCRIPT.test(rel)) return undefined;
    const entry = path.resolve(dir, rel);
    return isFile(entry) ? entry : undefined;
  } catch {
    return undefined;
  }
}

/** `name` looked up on PATH: absolute folders only, never the current one (a planted `git.bat` in the app repo is never run). */
function onPath(name: string, env: NodeJS.ProcessEnv, platform: NodeJS.Platform): string | undefined {
  const dirs = (envGet(env, "PATH", platform) ?? "")
    .split(platform === "win32" ? ";" : ":")
    .map((d) => d.trim().replace(/^"(.*)"$/, "$1"))
    .filter((d) => d !== "" && path.isAbsolute(d));
  if (platform !== "win32") {
    for (const d of dirs) if (isExecutable(path.join(d, name))) return path.join(d, name);
    return undefined;
  }
  const exts = (envGet(env, "PATHEXT", platform) ?? ".COM;.EXE;.BAT;.CMD")
    .split(";")
    .map((e) => e.trim())
    .filter((e) => /^\.[a-z0-9]+$/i.test(e));
  const named = path.extname(name) !== "" && [...exts, ".js", ".cjs", ".mjs"].some((e) => e.toLowerCase() === path.extname(name).toLowerCase());
  for (const d of dirs) {
    if (named && isFile(path.join(d, name))) return path.join(d, name);
    for (const e of exts) if (isFile(path.join(d, name + e))) return path.join(d, name + e);
  }
  return undefined;
}

/** A file found for `name`, as a program Holdback runs with no shell, or a refusal. */
function launchFile(file: string, name: string, o: ResolveOptions, platform: NodeJS.Platform): Program {
  const node = o.execPath ?? process.execPath;
  if (SCRIPT.test(file)) return { cmd: node, prefix: [file] };
  if (platform === "win32") {
    if (NATIVE.test(file)) return { cmd: file, prefix: [] };
    if (SHIM.test(file)) {
      let text = "";
      try {
        text = readFileSync(file, "utf8");
      } catch {
        /* unreadable: refused below */
      }
      const entry = shimEntry(text, path.dirname(file)) ?? (o.pkg ? packageBin(path.join(path.dirname(file), "node_modules"), o.pkg) : undefined);
      if (entry !== undefined) return { cmd: node, prefix: [entry] };
    }
    throw new ProgramNotFound(`can't locate ${name}'s entry script (${file}); ${o.overrideVar ? `set ${o.overrideVar} to its .js/.exe` : "put its .exe on PATH"}`);
  }
  return { cmd: file, prefix: [] };
}

/**
 * Where `name` is, as a program to spawn with no shell (C-1):
 * - the override, when set: a script runs under this Node; on Windows an `.exe` runs as is and a
 *   `.cmd` shim is read for its JS entry; a bare name is looked up on PATH;
 * - else `name` on PATH (absolute folders only). On Windows an `.exe`/`.com` runs as is, an npm
 *   `.cmd` shim's JS entry runs under this Node, and anything else is refused, never handed to cmd.exe.
 */
export function resolveProgram(name: string, o: ResolveOptions = {}): Program {
  const platform = o.platform ?? process.platform;
  const env = o.env ?? process.env;
  const want = o.override !== undefined && o.override !== "" ? o.override : name;
  const isPath = /[\\/]/.test(want) || (platform === "win32" && /^[a-z]:/i.test(want));
  const key = [want, platform, envGet(env, "PATH", platform), envGet(env, "PATHEXT", platform)].join("\0");
  const known = found.get(key);
  if (known !== undefined && isFile(known)) return launchFile(known, name, o, platform);
  const file = isPath ? path.resolve(want) : SCRIPT.test(want) && isFile(path.resolve(want)) ? path.resolve(want) : onPath(want, env, platform);
  if (file === undefined || !isFile(file)) {
    throw new ProgramNotFound(`${want} was not found${isPath ? "" : " on PATH"}: install it${o.overrideVar ? `, or set ${o.overrideVar} to its .js/.exe` : ""}`);
  }
  const program = launchFile(file, name, o, platform);
  found.set(key, file);
  return program;
}

/** The file found for a name and PATH (git runs often), checked again on every use. */
const found = new Map<string, string>();

/**
 * A Windows system tool by its full path under `%SystemRoot%\System32`: cmd.exe, and node's own
 * spawn, look in the current folder first, which may be the agent's app repo.
 */
export function systemTool(exe: string, env: NodeJS.ProcessEnv = process.env): string {
  const root = envGet(env, "SystemRoot", "win32") ?? envGet(env, "windir", "win32") ?? "C:\\Windows";
  return path.win32.join(root, "System32", exe);
}

/**
 * Kills `pid` and its children: on Windows `taskkill /T /F` by its full path with no shell (tree-kill
 * runs `taskkill` through cmd.exe in the current folder), elsewhere tree-kill.
 */
export function killTree(pid: number, done?: () => void): void {
  if (process.platform !== "win32") {
    treeKill(pid, "SIGKILL", () => done?.());
    return;
  }
  const child = spawn(systemTool("taskkill.exe"), ["/T", "/F", "/PID", String(pid)], { stdio: "ignore", windowsHide: true, shell: false });
  child.on("error", () => done?.());
  child.on("close", () => done?.());
}

/**
 * Refuses an argument no command line Holdback builds should carry: a NUL, a carriage return or a
 * newline (text a model or a human wrote, on its way to a command line). Throws before anything runs.
 */
export function assertPlainArgs(program: string, args: string[]): void {
  for (const [i, a] of args.entries()) {
    if (/[\0\r\n]/.test(a)) throw new Error(`refused to run ${program}: argument ${i + 1} holds a NUL or a line break`);
  }
}
