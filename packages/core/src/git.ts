import { appendFile, mkdir, readFile } from "node:fs/promises";
import path from "node:path";
import spawn from "cross-spawn";

export type GitResult = { code: number; stdout: string; stderr: string };

export type GitOptions = {
  /**
   * Run with `-c core.hooksPath=<hooksDir>` (and commit with `--no-verify`): none of the
   * repository's own hooks run, on any command. Pass an empty directory Holdback owns; the app
   * repo's hooks are writable by the agent.
   */
  hooksDir?: string;
};

/**
 * Config overrides on every git call Holdback makes: no fsmonitor hook and no signing program,
 * so nothing configured inside the (agent-writable) repo runs as part of Holdback's own commands.
 */
const SAFE_CONFIG = ["-c", "core.fsmonitor=false", "-c", "commit.gpgsign=false"];

/** Run `git <args>` in `cwd` (with the safety overrides above). */
export function git(cwd: string, args: string[], opts: GitOptions = {}): Promise<GitResult> {
  const hooks = opts.hooksDir ? ["-c", `core.hooksPath=${opts.hooksDir}`] : [];
  return new Promise((resolve, reject) => {
    const child = spawn("git", [...SAFE_CONFIG, ...hooks, ...args], {
      cwd,
      env: { ...process.env, GIT_TERMINAL_PROMPT: "0" },
      stdio: ["ignore", "pipe", "pipe"],
      windowsHide: true,
    });
    let stdout = "";
    let stderr = "";
    child.stdout?.setEncoding("utf8");
    child.stderr?.setEncoding("utf8");
    child.stdout?.on("data", (c: string) => (stdout += c));
    child.stderr?.on("data", (c: string) => (stderr += c));
    child.on("error", reject);
    child.on("close", (code) => resolve({ code: code ?? 1, stdout, stderr }));
  });
}

async function gitOk(cwd: string, args: string[], opts: GitOptions): Promise<string> {
  const r = await git(cwd, args, opts);
  if (r.code !== 0) throw new Error(`git ${args.join(" ")} failed (exit ${r.code}): ${(r.stderr || r.stdout).trim()}`);
  return r.stdout;
}

/** True when `cwd` is the top level of a git work tree (not merely somewhere inside a parent repo). */
export async function isRepoRoot(cwd: string, opts: GitOptions = {}): Promise<boolean> {
  const r = await git(cwd, ["rev-parse", "--is-inside-work-tree", "--show-prefix"], opts);
  const [inside, prefix] = r.stdout.split(/\r?\n/);
  return r.code === 0 && inside === "true" && prefix === "";
}

/** Short SHA of HEAD, or null while HEAD is unborn. */
export async function headSha(cwd: string, opts: GitOptions = {}): Promise<string | null> {
  const r = await git(cwd, ["rev-parse", "--verify", "-q", "--short", "HEAD"], opts);
  return r.code === 0 ? r.stdout.trim() : null;
}

function commitArgs(message: string, opts: GitOptions, extra: string[] = []): string[] {
  return [opts.hooksDir ? ["commit", "--no-verify"] : ["commit"], ["-q", ...extra, "-m", message]].flat();
}

/** Stage everything not ignored and commit. Returns the new short SHA, or null when nothing changed. */
export async function commitAll(cwd: string, message: string, opts: GitOptions = {}): Promise<string | null> {
  await gitOk(cwd, ["add", "-A", "--", "."], opts);
  const staged = await git(cwd, ["diff", "--cached", "--quiet"], opts);
  if (staged.code === 0) return null;
  if (staged.code !== 1) throw new Error(`git diff --cached failed (exit ${staged.code}): ${staged.stderr.trim()}`);
  await gitOk(cwd, commitArgs(message, opts), opts);
  return (await gitOk(cwd, ["rev-parse", "--short", "HEAD"], opts)).trim();
}

/** Give an unborn HEAD a first commit of whatever is there. Returns HEAD's short SHA. */
export async function ensureHead(cwd: string, message: string, opts: GitOptions = {}): Promise<string> {
  const head = await headSha(cwd, opts);
  if (head) return head;
  await gitOk(cwd, ["add", "-A", "--", "."], opts);
  await gitOk(cwd, commitArgs(message, opts, ["--allow-empty"]), opts);
  return (await gitOk(cwd, ["rev-parse", "--short", "HEAD"], opts)).trim();
}

/** Absolute path of a file inside the repo's git dir, e.g. `config` or `info/exclude`. */
export async function gitPath(cwd: string, name: string, opts: GitOptions = {}): Promise<string> {
  return path.resolve(cwd, (await gitOk(cwd, ["rev-parse", "--git-path", name], opts)).trim());
}

/** Add `pattern` to the repo's local `info/exclude` (never committed) unless it is already listed. */
export async function excludeFromGit(cwd: string, pattern: string, opts: GitOptions = {}): Promise<void> {
  const file = await gitPath(cwd, "info/exclude", opts);
  let text = "";
  try {
    text = await readFile(file, "utf8");
  } catch (e) {
    if ((e as NodeJS.ErrnoException).code !== "ENOENT") throw e;
  }
  if (text.split(/\r?\n/).some((l) => l.trim() === pattern)) return;
  await mkdir(path.dirname(file), { recursive: true });
  await appendFile(file, (text === "" || text.endsWith("\n") ? "" : "\n") + pattern + "\n", "utf8");
}

/** Paths changed between two commits, relative to the repo root. */
export async function changedFiles(cwd: string, from: string, to: string, opts: GitOptions = {}): Promise<string[]> {
  const out = await gitOk(cwd, ["diff", "--name-only", "-z", from, to, "--"], opts);
  return out.split("\0").filter((f) => f.length > 0);
}

export async function checkout(cwd: string, ref: string, opts: GitOptions = {}): Promise<void> {
  await gitOk(cwd, ["checkout", "-q", ref, "--"], opts);
}

/** Detached worktree of `ref` at `dir`. */
export async function worktreeAdd(cwd: string, dir: string, ref: string, opts: GitOptions = {}): Promise<void> {
  await gitOk(cwd, ["worktree", "add", "--detach", dir, ref], opts);
}

export async function worktreeRemove(cwd: string, dir: string, opts: GitOptions = {}): Promise<void> {
  await gitOk(cwd, ["worktree", "remove", "--force", dir], opts);
}
