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
  /** Extra environment for the git process (e.g. a private GIT_INDEX_FILE). */
  env?: Record<string, string>;
};

/** Holdback's own empty hooks dir, under its home (never inside the agent-writable app repo). */
export const EMPTY_HOOKS_DIR = "empty-hooks";

/** The GitOptions for every git call Holdback makes on the app repo; creates `<home>/empty-hooks`. */
export async function holdbackGitOptions(home: string): Promise<GitOptions> {
  const hooksDir = path.join(home, EMPTY_HOOKS_DIR);
  await mkdir(hooksDir, { recursive: true });
  return { hooksDir };
}

/**
 * Config overrides on every git call Holdback makes: no fsmonitor hook, no signing program and no
 * transport at all (Holdback never fetches or pushes), so nothing configured inside the
 * (agent-writable) repo runs as part of Holdback's own commands, not even a promisor remote's
 * lazy fetch of a missing object.
 */
const SAFE_CONFIG = ["-c", "core.fsmonitor=false", "-c", "commit.gpgsign=false", "-c", "protocol.allow=never"];

/** Run `git <args>` in `cwd` (with the safety overrides above, and lazy fetching off). */
export function git(cwd: string, args: string[], opts: GitOptions = {}): Promise<GitResult> {
  const hooks = opts.hooksDir ? ["-c", `core.hooksPath=${opts.hooksDir}`] : [];
  return new Promise((resolve, reject) => {
    const child = spawn("git", [...SAFE_CONFIG, ...hooks, ...args], {
      cwd,
      env: { ...process.env, GIT_TERMINAL_PROMPT: "0", GIT_NO_LAZY_FETCH: "1", ...opts.env },
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

/** Commit what is staged (under `paths` only, when given). Returns the new short SHA, or null when nothing there is staged. */
async function commitStaged(cwd: string, message: string, opts: GitOptions, paths: string[] = []): Promise<string | null> {
  const only = paths.length > 0 ? ["--", ...paths] : [];
  const staged = await git(cwd, ["diff", "--cached", "--quiet", ...only], opts);
  if (staged.code === 0) return null;
  if (staged.code !== 1) throw new Error(`git diff --cached failed (exit ${staged.code}): ${staged.stderr.trim()}`);
  await gitOk(cwd, [...commitArgs(message, opts), ...only], opts);
  return (await gitOk(cwd, ["rev-parse", "--short", "HEAD"], opts)).trim();
}

/**
 * Stage everything not ignored and commit, except the `exclude` paths (relative to `cwd`), which
 * stay as they are in the work tree. Returns the new short SHA, or null when nothing changed.
 */
export async function commitAll(cwd: string, message: string, opts: GitOptions = {}, exclude: string[] = []): Promise<string | null> {
  const but = exclude.map((f) => `:(exclude)${f.split("\\").join("/")}`);
  await gitOk(cwd, ["add", "-A", "--", ".", ...but], opts);
  return commitStaged(cwd, message, opts, but.length > 0 ? [".", ...but] : []);
}

/**
 * Stage and commit `paths` alone: anything else staged stays staged, and out of the commit.
 * Returns the new short SHA, or null when they did not change.
 */
export async function commitPaths(cwd: string, message: string, paths: string[], opts: GitOptions = {}): Promise<string | null> {
  await gitOk(cwd, ["add", "--", ...paths], opts);
  return commitStaged(cwd, message, opts, paths);
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

/**
 * Paths the work tree has that HEAD does not (changed, staged, deleted or untracked, ignored files
 * left out), `/`-separated and relative to the repo root, except those under one of `skip` (folder
 * names, relative to the root).
 */
export async function uncommitted(cwd: string, opts: GitOptions = {}, skip: string[] = []): Promise<string[]> {
  const out = await gitOk(cwd, ["status", "--porcelain=v1", "-z", "--untracked-files=all"], opts);
  const parts = out.split("\0");
  const paths: string[] = [];
  for (let i = 0; i < parts.length; i++) {
    const e = parts[i]!;
    if (e.length < 4) continue;
    paths.push(e.slice(3));
    if (e[0] === "R" || e[0] === "C") i++; // a rename or copy also names where it came from
  }
  return paths.filter((f) => !skip.some((d) => f === d || f.startsWith(`${d}/`)));
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

/**
 * Tree id of the work tree as `git add -A` would stage it (ignored files left out, and the
 * repo-relative `exclude` paths too), built in the private index file `indexFile`: the repo's own
 * index, HEAD and refs are never touched; only blobs and trees go into its object store.
 * Two calls give the same id exactly when no tracked or untracked, non-ignored file changed.
 */
export async function worktreeTree(cwd: string, indexFile: string, opts: GitOptions = {}, exclude: string[] = []): Promise<string> {
  const o: GitOptions = { ...opts, env: { ...opts.env, GIT_INDEX_FILE: indexFile } };
  await gitOk(cwd, ["add", "-A", "--", "."], o);
  // dropped from the private index afterwards: a pathspec naming an ignored path makes `git add` fail
  if (exclude.length > 0) await gitOk(cwd, ["rm", "-r", "-q", "--cached", "--ignore-unmatch", "--", ...exclude], o);
  return (await gitOk(cwd, ["write-tree"], o)).trim();
}
