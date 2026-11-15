import { execFileSync } from "node:child_process";
import { appendFileSync, existsSync, mkdirSync, mkdtempSync, readdirSync, rmSync, symlinkSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import type { LedgerEvent } from "../src/ledger/types.js";
import { loadProject, type Project } from "../src/project.js";
import { checkRecordingsAnchor, clearTamper, gitConfigHash, markTampered, tamperMarker } from "../src/tamper.js";

const at = "2026-11-15T00:00:00.000Z";
const saved = { ...process.env };
let root: string;

const git = (cwd: string, ...args: string[]) => execFileSync("git", args, { cwd, encoding: "utf8" }).trim();

function repo(name = "app"): string {
  const dir = join(root, name);
  mkdirSync(dir, { recursive: true });
  git(dir, "init", "-q");
  git(dir, "config", "user.name", "Test");
  git(dir, "config", "user.email", "test@example.com");
  return dir;
}

beforeEach(() => {
  root = mkdtempSync(join(tmpdir(), "hb-tamper-"));
  process.env.HOLDBACK_HOME = join(root, "home");
});
afterEach(() => {
  if (saved.HOLDBACK_HOME === undefined) delete process.env.HOLDBACK_HOME;
  else process.env.HOLDBACK_HOME = saved.HOLDBACK_HOME;
  rmSync(root, { recursive: true, force: true });
});

describe("tamper marker", () => {
  it("is null only when absent; a file, a directory or a link all count, and clearTamper removes each", async () => {
    const p = { home: join(root, "home", "proj") };
    mkdirSync(p.home, { recursive: true });
    const marker = join(p.home, "TAMPERED");
    expect(await tamperMarker(p)).toBeNull();

    await markTampered(p, "sealed files changed:\n  x");
    expect(await tamperMarker(p)).toMatch(/^\S+ sealed files changed: x$/);
    await clearTamper(p);
    expect(await tamperMarker(p)).toBeNull();

    // a directory in its place cannot be read as text, and still counts
    mkdirSync(join(marker, "sub"), { recursive: true });
    expect(await tamperMarker(p)).toMatch(/directory/);
    await clearTamper(p);
    expect(existsSync(marker)).toBe(false);

    // a link (junction) in its place counts too, and clearing removes the link, never its target
    const target = join(root, "elsewhere");
    mkdirSync(target);
    writeFileSync(join(target, "keep.txt"), "x");
    symlinkSync(target, marker, "junction");
    expect(await tamperMarker(p)).toMatch(/link/);
    await clearTamper(p);
    expect(existsSync(marker)).toBe(false);
    expect(readdirSync(target)).toEqual(["keep.txt"]);

    // an empty marker file still counts
    writeFileSync(marker, "");
    expect(await tamperMarker(p)).toMatch(/\S/);
  });

  it("counts a marker path it cannot even look at as a tamper (only a clean ENOENT is none)", async () => {
    // lstat rejects with ERR_INVALID_ARG_VALUE on every platform
    expect(await tamperMarker({ home: join(root, "bad\0home") })).toMatch(/unreadable/);
    // a file where the home directory should be: ENOTDIR on POSIX (Windows reports ENOENT)
    writeFileSync(join(root, "file-home"), "");
    if (process.platform !== "win32") expect(await tamperMarker({ home: join(root, "file-home") })).toMatch(/unreadable/);
  });

  it("markTampered throws when the marker cannot be written (a directory in its place)", async () => {
    const p = { home: join(root, "home", "proj") };
    mkdirSync(join(p.home, "TAMPERED"), { recursive: true });
    await expect(markTampered(p, "x")).rejects.toThrow();
  });
});

describe("gitConfigHash", { timeout: 60_000 }, () => {
  it("ignores a remote's address/refspec keys and branch, user, init, pull and push config, in any case, and comments", async () => {
    const dir = repo();
    const cfg = join(dir, ".git", "config");
    git(dir, "-c", "commit.gpgsign=false", "commit", "-q", "--allow-empty", "-m", "first");
    const before = await gitConfigHash(cfg);
    expect(before).toMatch(/^[0-9a-f]{64}$/);
    // what `git remote add` and `git branch --set-upstream-to` (as `git push -u` does) write
    git(dir, "remote", "add", "origin", "https://example.com/app.git");
    const branch = git(dir, "symbolic-ref", "--short", "HEAD");
    git(dir, "update-ref", `refs/remotes/origin/${branch}`, "HEAD");
    git(dir, "branch", "-q", `--set-upstream-to=origin/${branch}`);
    expect(git(dir, "config", `branch.${branch}.remote`)).toBe("origin");
    // everyday identity and pull/push settings
    git(dir, "config", "user.name", "Someone Else");
    git(dir, "config", "init.defaultBranch", "main");
    git(dir, "config", "pull.rebase", "true");
    git(dir, "config", "push.autoSetupRemote", "true");
    // every remote key that only names an address or refspecs, in any case
    appendFileSync(
      cfg,
      '# a comment\n[Remote "Upstream"]\n\tURL = https://example.com/up.git\n\tpushurl = https://example.com/push.git\n' +
        "\tfetch = +refs/heads/*:refs/remotes/upstream/*\n\tpush = refs/heads/main\n\tmirror = false\n\ttagOpt = --no-tags\n" +
        '\tprune = true\n\tpruneTags = true\n\tskipDefaultUpdate = true\n\tskipFetchAll = true\n[BRANCH "dev"]\n\tRemote = upstream\n',
    );
    expect(await gitConfigHash(cfg)).toBe(before);
  });

  it.each([
    ["filter", '[filter "x"]\n\tclean = node evil.js\n'],
    ["core", "[core]\n\thooksPath = elsewhere\n"],
    ["core, mixed case", "[Core]\n\tHooksPath = elsewhere\n"],
    ["alias", "[alias]\n\tst = status\n"],
    ["include", "[include]\n\tpath = other.cfg\n"],
    ["includeIf", '[includeIf "gitdir:/x/"]\n\tpath = other.cfg\n'],
    ["diff", '[diff "x"]\n\ttextconv = node evil.js\n'],
    ["merge", '[merge "x"]\n\tdriver = node evil.js %O %A %B\n'],
    ["gpg", "[gpg]\n\tprogram = evil\n"],
    ["a value-less key", "[core]\n\tsymlinks\n"],
    // a promisor remote lazily fetches a missing object during Holdback's own add/commit, running uploadpack
    ["remote promisor", '[remote "x"]\n\tpromisor = true\n'],
    ["remote uploadpack", '[remote "x"]\n\tuploadpack = node evil.js\n'],
    ["remote uploadpack, mixed case", '[Remote "x"]\n\tUploadPack = node evil.js\n'],
    ["remote partialclonefilter", '[remote "x"]\n\tpartialclonefilter = blob:none\n'],
    ["remote receivepack", '[remote "x"]\n\treceivepack = node evil.js\n'],
    ["remote vcs", '[remote "x"]\n\tvcs = evil\n'],
    ["remote proxy", '[remote "x"]\n\tproxy = http://127.0.0.1:1\n'],
  ])("changes on a %s change", async (_name, text) => {
    const dir = repo();
    const cfg = join(dir, ".git", "config");
    const before = await gitConfigHash(cfg);
    appendFileSync(cfg, text);
    expect(await gitConfigHash(cfg)).not.toBe(before);
  });

  it("keeps the order of repeated values (the last one wins), and hashes an unparseable or absent config too", async () => {
    const dir = repo();
    const cfg = join(dir, ".git", "config");
    appendFileSync(cfg, "[core]\n\thooksPath = a\n\thooksPath = b\n");
    const ab = await gitConfigHash(cfg);
    git(dir, "config", "--unset-all", "core.hooksPath");
    appendFileSync(cfg, "[core]\n\thooksPath = b\n\thooksPath = a\n");
    expect(await gitConfigHash(cfg)).not.toBe(ab);

    const parsed = await gitConfigHash(cfg);
    appendFileSync(cfg, "[broken\n");
    const broken = await gitConfigHash(cfg);
    expect(broken).not.toBe(parsed);
    expect(await gitConfigHash(cfg)).toBe(broken);
    expect(await gitConfigHash(join(dir, ".git", "no-such-config"))).toBe("absent");
  });
});

describe("checkRecordingsAnchor", { timeout: 60_000 }, () => {
  it("compares the disk with the latest recordings event after the latest seal", async () => {
    const p: Project = await loadProject(repo());
    const rec = join(p.verifierDir, ".testmuai", "tests", "output-t1_test", "recording.json");
    const events: LedgerEvent[] = [{ at, t: "seal", manifest: {} }];

    const none = await checkRecordingsAnchor(p, events);
    expect(none).toMatchObject({ anchored: false, moved: [] });
    events.push({ at, t: "recordings", digest: none.snapshot.digest, gitConfig: none.snapshot.gitConfig });
    expect(await checkRecordingsAnchor(p, events)).toMatchObject({ anchored: true, moved: [] });

    mkdirSync(join(rec, ".."), { recursive: true });
    writeFileSync(rec, "{}");
    expect((await checkRecordingsAnchor(p, events)).moved).toEqual(["Kane's recordings"]);
    git(p.appDir, "config", "core.hooksPath", "elsewhere");
    expect((await checkRecordingsAnchor(p, events)).moved).toEqual(["Kane's recordings", ".git/config"]);

    // a seal after the last anchor (spec stage, drift, re-seal) leaves it unanchored: the caller seeds a new one
    events.push({ at, t: "seal", manifest: {} });
    expect(await checkRecordingsAnchor(p, events)).toMatchObject({ anchored: false, moved: [] });
  });
});
