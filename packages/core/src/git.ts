import spawn from "cross-spawn";

export type GitResult = { code: number; stdout: string; stderr: string };

/** Run `git <args>` in `cwd`. Never adds `--no-verify`: the repo's own hooks run. */
export function git(cwd: string, args: string[]): Promise<GitResult> {
  return new Promise((resolve, reject) => {
    const child = spawn("git", args, {
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

async function gitOk(cwd: string, args: string[]): Promise<string> {
  const r = await git(cwd, args);
  if (r.code !== 0) throw new Error(`git ${args.join(" ")} failed (exit ${r.code}): ${(r.stderr || r.stdout).trim()}`);
  return r.stdout;
}

/** True when `cwd` is the top level of a git work tree (not merely somewhere inside a parent repo). */
export async function isRepoRoot(cwd: string): Promise<boolean> {
  const r = await git(cwd, ["rev-parse", "--is-inside-work-tree", "--show-prefix"]);
  const [inside, prefix] = r.stdout.split(/\r?\n/);
  return r.code === 0 && inside === "true" && prefix === "";
}

/** Short SHA of HEAD, or null while HEAD is unborn. */
export async function headSha(cwd: string): Promise<string | null> {
  const r = await git(cwd, ["rev-parse", "--verify", "-q", "--short", "HEAD"]);
  return r.code === 0 ? r.stdout.trim() : null;
}

/** Stage everything not ignored and commit. Returns the new short SHA, or null when nothing changed. */
export async function commitAll(cwd: string, message: string): Promise<string | null> {
  await gitOk(cwd, ["add", "-A", "--", "."]);
  const staged = await git(cwd, ["diff", "--cached", "--quiet"]);
  if (staged.code === 0) return null;
  if (staged.code !== 1) throw new Error(`git diff --cached failed (exit ${staged.code}): ${staged.stderr.trim()}`);
  await gitOk(cwd, ["commit", "-q", "-m", message]);
  return (await gitOk(cwd, ["rev-parse", "--short", "HEAD"])).trim();
}

/** Give an unborn HEAD a first commit of whatever is there. Returns HEAD's short SHA. */
export async function ensureHead(cwd: string, message: string): Promise<string> {
  const head = await headSha(cwd);
  if (head) return head;
  await gitOk(cwd, ["add", "-A", "--", "."]);
  await gitOk(cwd, ["commit", "-q", "--allow-empty", "-m", message]);
  return (await gitOk(cwd, ["rev-parse", "--short", "HEAD"])).trim();
}

/** Paths changed between two commits, relative to the repo root. */
export async function changedFiles(cwd: string, from: string, to: string): Promise<string[]> {
  const out = await gitOk(cwd, ["diff", "--name-only", "-z", from, to, "--"]);
  return out.split("\0").filter((f) => f.length > 0);
}

export async function checkout(cwd: string, ref: string): Promise<void> {
  await gitOk(cwd, ["checkout", "-q", ref, "--"]);
}

/** Detached worktree of `ref` at `dir`. */
export async function worktreeAdd(cwd: string, dir: string, ref: string): Promise<void> {
  await gitOk(cwd, ["worktree", "add", "--detach", dir, ref]);
}

export async function worktreeRemove(cwd: string, dir: string): Promise<void> {
  await gitOk(cwd, ["worktree", "remove", "--force", dir]);
}
