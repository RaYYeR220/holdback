import { mkdtempSync, readFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { describe, expect, it } from "vitest";
import { guardDecision, guardHookCommand, guardPayload, writeAgentSettings, posixAbs } from "../src/agent/guard.js";

const ctx = {
  home: "C:\\Users\\x\\.holdback\\abc",
  verifierDir: "C:\\Users\\x\\.holdback\\abc\\verifier",
};
const denied = (tool_name: string, tool_input: Record<string, unknown>, c = ctx) =>
  guardDecision({ tool_name, tool_input }, c).allow === false;

describe("guardDecision", () => {
  it("denies Read of a tilde path into the home dir", () => {
    expect(denied("Read", { file_path: "~/.holdback/x/verifier/.testmuai/tests/a_test.md" })).toBe(true);
  });
  it("denies backslash, forward-slash and msys forms, case-insensitively", () => {
    expect(denied("Read", { file_path: "C:\\Users\\x\\.holdback\\abc\\verifier\\a.md" })).toBe(true);
    expect(denied("Read", { file_path: "c:/users/X/.HOLDBACK/abc/verifier/a.md" })).toBe(true);
    expect(denied("Bash", { command: "cat /c/Users/x/.holdback/abc/verifier/a.md" })).toBe(true);
  });
  it("denies a temp home that is not named .holdback", () => {
    const c = { home: "/tmp/hb-home/p1", verifierDir: "/tmp/hb-home/p1/verifier" };
    expect(denied("Bash", { command: "ls /tmp/hb-home/p1/verifier" }, c)).toBe(true);
    expect(denied("Glob", { pattern: "\\tmp\\HB-HOME\\p1\\**" }, c)).toBe(true);
  });
  it("inspects nested strings", () => {
    expect(denied("Task", { a: { b: ["x", "~/.holdback/y"] } })).toBe(true);
  });
  it("denies kane-cli and git history commands", () => {
    expect(denied("Bash", { command: "kane-cli testmd run x" })).toBe(true);
    expect(denied("Bash", { command: "git commit -m x" })).toBe(true);
    expect(denied("Bash", { command: "cd a && git reset --hard" })).toBe(true);
    expect(denied("Bash", { command: "git push origin main" })).toBe(true);
  });
  it("allows ordinary work", () => {
    expect(guardDecision({ tool_name: "Bash", tool_input: { command: "npm test" } }, ctx)).toEqual({ allow: true });
    expect(denied("Edit", { file_path: "src/app.ts", old_string: "a", new_string: "b" })).toBe(false);
    expect(denied("Bash", { command: "git status && git diff" })).toBe(false);
  });
  it("gives a reason on deny", () => {
    const d = guardDecision({ tool_name: "Bash", tool_input: { command: "kane-cli x" } }, ctx);
    expect(d.allow === false && d.reason.length > 0).toBe(true);
  });
});

describe("guardDecision hardening", () => {
  const sh = (command: string, tool = "Bash") => denied(tool, { command });
  it("rejects a tool_input that is not a plain object", () => {
    for (const bad of ["ls", ["ls"], null, undefined, 3])
      expect(guardDecision({ tool_name: "Bash", tool_input: bad as never }, ctx).allow).toBe(false);
  });
  it("applies shell rules to PowerShell and to any command field", () => {
    expect(sh("kane-cli testmd run x", "PowerShell")).toBe(true);
    expect(sh("git commit -m x", "PowerShell")).toBe(true);
    expect(denied("Mcp", { command: "git push" })).toBe(true);
    expect(denied("Mcp", { args: { command: "kane-cli x" } })).toBe(true);
    expect(sh("npm test", "PowerShell")).toBe(false);
  });
  it("denies Kane's own store", () => {
    expect(sh("cat .testmuai/sessions/1.log")).toBe(true);
    expect(denied("Read", { file_path: "/somewhere/.TestMuai/x" })).toBe(true);
  });
  it("denies shell references to the user home", () => {
    for (const c of [
      "cat ~/.hold*/x", "ls ~", "ls $HOME", "ls ${HOME}/x", "dir %USERPROFILE%", "type %HOME%\\x",
      "Get-ChildItem $env:USERPROFILE", "Get-ChildItem $env:HOME", "echo USERPROFILE", "echo $HOMEPATH", "cd \"~\"",
    ])
      expect(sh(c), c).toBe(true);
    expect(sh("Get-ChildItem $env:USERPROFILE", "PowerShell")).toBe(true);
  });
  it("does not trip on ordinary tildes", () => {
    expect(sh("npm i left-pad@~1.2.0")).toBe(false);
    expect(sh("echo a~b")).toBe(false);
    expect(denied("Write", { file_path: "README.md", content: "see ~/.config for details" })).toBe(false);
  });
  it("denies git outside the read-only allowlist", () => {
    for (const c of [
      "git -C . commit", "git -c k=v push", "git --no-pager stash", "npm test && git commit -am x",
      "git add .", "git checkout -b x", "git switch main", "git restore f", "git merge x", "git clean -fd",
      "git branch -D x", "git branch newname", "git tag v1", "git config user.name x", "git -c alias.s=!rm status",
      "echo hi; git reset --hard", "ls | git apply p", "x\ngit rebase main", "(git commit -m x)", "$(git push)",
      "/usr/bin/git commit", "git.exe commit", "git --git-dir x --work-tree y commit", "git -p stash",
    ])
      expect(sh(c), c).toBe(true);
  });
  it("allows read-only git", () => {
    for (const c of [
      "git status", "git diff HEAD~1", "git log --oneline", "git show HEAD", "git ls-files", "git blame f",
      "git rev-parse HEAD", "git branch", "git branch --list", "git branch -a", "git -C . status",
      "git --no-pager log -5", "cd x && git diff && npm test",
    ])
      expect(sh(c), c).toBe(false);
  });
  it("denies shell text that touches the repo's git hooks or config", () => {
    for (const c of [
      "cp pre.sh .git/hooks/pre-commit", "echo exit 0 > .git\\hooks\\commit-msg", "Set-Content .GIT\\Hooks\\post-commit x",
      "cat .git/config", "notepad .git\\\\config", "node -e \"fs.appendFileSync('.git/config','')\"", "echo hooksPath core.hooksPath",
    ])
      expect(sh(c), c).toBe(true);
    expect(sh("cp pre.sh .git/hooks/pre-commit", "PowerShell")).toBe(true);
    expect(sh("git status && git log -1")).toBe(false);
    expect(sh("cat .gitignore && ls .github/workflows")).toBe(false);
  });

  it("denies the human's Holdback commands however they are invoked", () => {
    for (const c of [
      "holdback reseal --yes",
      "holdback spec",
      "holdback run --max-turns 30",
      "holdback drift",
      "holdback watch",
      "holdback init --agent claude --remove",
      "holdback init --force",
      "holdback clean",
      "holdback serve --port 0",
      "holdback hook stop --app .",
      "HOLDBACK RESEAL --yes",
      "npx holdback reseal --yes",
      "npx --yes holdback reseal",
      "pnpm exec holdback run",
      "./node_modules/.bin/holdback reseal",
      "C:\\Users\\x\\AppData\\Roaming\\npm\\holdback.cmd reseal --yes",
      "holdback.ps1 drift",
      "node packages/cli/dist/index.js reseal --yes",
      'node "C:\\work\\holdback\\packages\\cli\\dist\\index.js" reseal',
      "node /opt/lib/node_modules/holdback/dist/index.js spec",
      "env -u CLAUDECODE holdback reseal --yes",
      "env -i PATH=/usr/bin holdback run",
      "CLAUDECODE= holdback reseal --yes",
      "FOO=bar holdback drift",
      "npm test && holdback reseal --yes",
      "echo y | holdback reseal",
      "cmd /c holdback reseal --yes",
      'cmd /c "holdback reseal --yes"',
      'powershell -c "holdback reseal --yes"',
      'powershell -Command "& { Remove-Item Env:CLAUDECODE; holdback reseal --yes }"',
      "$(holdback run)",
    ])
      expect(sh(c), c).toBe(true);
    expect(sh("holdback reseal --yes", "PowerShell")).toBe(true);
    expect(denied("Mcp", { command: "holdback run" })).toBe(true);
  });

  it("allows the read-only Holdback commands and other mentions of the name", () => {
    for (const c of [
      "holdback status",
      "holdback status --json",
      "holdback owed",
      "npx holdback owed",
      "env -u CLAUDECODE holdback status",
      "node packages/cli/dist/index.js status",
      "holdback --help",
      "holdback --version",
      "cat holdback.config.json",
      "grep -r holdback src",
      "npm test && holdback owed",
    ])
      expect(sh(c), c).toBe(false);
    expect(sh("holdback owed", "PowerShell")).toBe(false);
  });

  it("names the read-only commands in the reason", () => {
    const d = guardDecision({ tool_name: "Bash", tool_input: { command: "env -u CLAUDECODE holdback reseal --yes" } }, ctx);
    expect(d.allow).toBe(false);
    if (!d.allow) expect(d.reason).toMatch(/holdback status.*holdback owed/);
  });
});

describe("guardHookCommand", () => {
  it("quotes the absolute node binary and every path", () => {
    const c = { home: "C:\\Users\\Jane Doe\\.holdback\\abc", verifierDir: "C:\\Users\\Jane Doe\\.holdback\\abc\\verifier" };
    expect(guardHookCommand(c, "C:\\Program Files\\hb\\dist\\agent\\guard-main.js", "C:\\Program Files\\nodejs\\node.exe")).toBe(
      '"C:\\Program Files\\nodejs\\node.exe" "C:\\Program Files\\hb\\dist\\agent\\guard-main.js" --home "C:\\Users\\Jane Doe\\.holdback\\abc" --verifier "C:\\Users\\Jane Doe\\.holdback\\abc\\verifier"',
    );
    expect(guardHookCommand(c, "g.js").startsWith(`"${process.execPath}" "g.js" `)).toBe(true);
  });
});

describe("guardPayload", () => {
  it("scans all payload strings and rejects bad shapes", () => {
    expect(guardPayload({ tool_name: "Bash", tool_input: { command: "ls" }, cwd: ctx.verifierDir }, ctx).allow).toBe(false);
    expect(guardPayload({ tool_name: "Bash" }, ctx).allow).toBe(false);
    expect(guardPayload("x", ctx).allow).toBe(false);
    expect(guardPayload({ tool_name: "Bash", tool_input: { command: "ls" } }, ctx).allow).toBe(true);
  });
});

describe("posixAbs", () => {
  it("converts Windows paths to the //c/... rule form", () => {
    expect(posixAbs("C:\\Users\\x\\.holdback\\abc")).toBe("//c/Users/x/.holdback/abc");
  });
  it("keeps POSIX absolute paths", () => {
    expect(posixAbs("/tmp/h")).toBe("//tmp/h");
  });
});

describe("writeAgentSettings", () => {
  it("writes deny rules, the hook and the boundary flag", async () => {
    const f = join(mkdtempSync(join(tmpdir(), "hb-")), "settings.json");
    await writeAgentSettings(f, ctx, { guardCommand: "node g.js" });
    const s = JSON.parse(readFileSync(f, "utf8"));
    expect(s.permissions.blockReadsOutsideWorkingDirectories).toBe(true);
    expect(s.permissions.deny).toEqual(
      expect.arrayContaining([
        "Read(~/.holdback/**)",
        "Edit(~/.holdback/**)",
        "Read(//c/Users/x/.holdback/abc/**)",
        "Edit(//c/Users/x/.holdback/abc/**)",
        "Edit(./.git/**)",
      ]),
    );
    expect(s.permissions.deny).not.toContain("WebFetch");
    expect(s.hooks.PreToolUse).toEqual([{ matcher: "*", hooks: [{ type: "command", command: "node g.js" }] }]);
  });
  it("denyWeb adds WebFetch and WebSearch", async () => {
    const f = join(mkdtempSync(join(tmpdir(), "hb-")), "s.json");
    await writeAgentSettings(f, ctx, { guardCommand: "x", denyWeb: true });
    const s = JSON.parse(readFileSync(f, "utf8"));
    expect(s.permissions.deny).toEqual(expect.arrayContaining(["WebFetch", "WebSearch"]));
  });
  it("protect denies edits to app files in the relative and the absolute rule form", async () => {
    const f = join(mkdtempSync(join(tmpdir(), "hb-")), "s.json");
    await writeAgentSettings(f, ctx, {
      guardCommand: "x",
      protect: { appDir: "C:\\Users\\x\\app", files: ["holdback.config.json", "docs\\PRD.md", "./NOTES.md"] },
    });
    const deny: string[] = JSON.parse(readFileSync(f, "utf8")).permissions.deny;
    expect(deny).toEqual(
      expect.arrayContaining([
        "Edit(./holdback.config.json)",
        "Edit(//c/Users/x/app/holdback.config.json)",
        "Edit(./docs/PRD.md)",
        "Edit(//c/Users/x/app/docs/PRD.md)",
        "Edit(./NOTES.md)",
        "Edit(//c/Users/x/app/NOTES.md)",
        "Edit(./.git/**)",
        "Edit(//c/Users/x/app/.git/**)",
      ]),
    );
    expect(deny.filter((r) => r === "Edit(./.git/**)")).toHaveLength(1);
    expect(deny.some((r) => r.startsWith("Read(./"))).toBe(false); // the agent still reads its spec
  });
});
