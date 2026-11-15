import { spawnSync } from "node:child_process";
import { linkSync, mkdtempSync, readFileSync, realpathSync, writeFileSync } from "node:fs";
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

  it("denies shell writes onto a spec file, best effort (the spec is the human's: Edit is denied by rule)", () => {
    const c = { ...ctx, specFiles: ["PRD.md", "docs/RULES.md"] };
    const sh = (command: string, tool = "Bash") => denied(tool, { command }, c);
    for (const cmd of [
      "echo 'Income limits do not apply.' >> PRD.md",
      "echo x > ./PRD.md",
      "cat new.md >PRD.md",
      'printf "x" 1> "PRD.md"',
      "echo x | tee -a PRD.md",
      "sed -i 's/2461/9999/' PRD.md",
      "sed -i.bak -e 's/a/b/' prd.md",
      "cp /tmp/other.md PRD.md",
      "mv draft.md ./PRD.md",
      "cp draft.md docs/RULES.md",
      "cd src && echo x >> ../PRD.md",
    ])
      expect(sh(cmd), cmd).toBe(true);
    for (const cmd of [
      "Set-Content -Path PRD.md -Value 'x'",
      "'x' | Out-File PRD.md",
      "Add-Content PRD.md 'more'",
      "Copy-Item draft.md -Destination PRD.md",
      "Move-Item draft.md PRD.md",
    ])
      expect(sh(cmd, "PowerShell"), cmd).toBe(true);
    const d = guardDecision({ tool_name: "Bash", tool_input: { command: "echo x >> PRD.md" } }, c);
    if (!d.allow) expect(d.reason).toMatch(/spec/i);
  });

  it("denies Edit/Write onto a spec file too, and marks every spec denial as one (R37)", () => {
    const app = join(tmpdir(), "hb-guard-app");
    const c = { ...ctx, specFiles: ["PRD.md"], appDir: app };
    const edit = (tool_name: string, file_path: string) => guardDecision({ tool_name, tool_input: { file_path, old_string: "a", new_string: "b" } }, c);
    expect(edit("Edit", join(app, "PRD.md"))).toMatchObject({ allow: false, spec: "edit" });
    expect(edit("Write", "PRD.md")).toMatchObject({ allow: false, spec: "edit" });
    expect(edit("MultiEdit", `${app}/./prd.md`)).toMatchObject({ allow: false, spec: "edit" });
    expect(guardDecision({ tool_name: "Bash", tool_input: { command: "echo x >> PRD.md" } }, c)).toMatchObject({ allow: false, spec: "shell" });
    // another file of that name elsewhere is not the spec
    expect(edit("Edit", join(app, "docs", "PRD.md"))).toEqual({ allow: true });
    expect(guardDecision({ tool_name: "Read", tool_input: { file_path: join(app, "PRD.md") } }, c)).toEqual({ allow: true });
    // other denials carry no spec mark
    const other = guardDecision({ tool_name: "Bash", tool_input: { command: "git commit -m x" } }, c);
    expect(other.allow === false && other.spec).toBeFalsy();
  });

  it("reads a spec path the way Windows does: case, trailing dots and spaces, streams, dot segments, short names, links (R38)", () => {
    const app = realpathSync.native(mkdtempSync(join(tmpdir(), "hb-guard-spec-")));
    writeFileSync(join(app, "PRD.md"), "# spec\n");
    writeFileSync(join(app, "P R D.md"), "# a spec with a short name\n");
    const c = { ...ctx, specFiles: ["PRD.md", "P R D.md"], appDir: app };
    const edit = (file_path: string) => guardDecision({ tool_name: "Write", tool_input: { file_path, content: "x" } }, c);
    for (const form of ["PRD.md.", "PRD.md. . ", "PRD.md::$DATA", "PRD.md:hidden", "prd.MD", ".\\sub\\..\\PRD.md", "./sub/../PRD.md"]) {
      expect(edit(join(app, form)), form).toMatchObject({ allow: false, spec: "edit" });
      expect(edit(form), form).toMatchObject({ allow: false, spec: "edit" });
      expect(guardDecision({ tool_name: "Bash", tool_input: { command: `echo x >> "${form}"` } }, c), form).toMatchObject({ allow: false, spec: "shell" });
    }
    // a hard link to the spec is the spec
    linkSync(join(app, "PRD.md"), join(app, "notes.md"));
    expect(edit(join(app, "notes.md"))).toMatchObject({ allow: false, spec: "edit" });
    expect(guardDecision({ tool_name: "Bash", tool_input: { command: "echo x >> notes.md" } }, c)).toMatchObject({ allow: false, spec: "shell" });
    // an 8.3 short name (Windows, where the volume keeps them): `PRD~1.MD` for `P R D.md`
    if (process.platform === "win32") {
      const short = spawnSync("cmd", ["/d", "/s", "/c", '"for %I in ("P R D.md") do @echo %~snxI"'], { cwd: app, encoding: "utf8", windowsVerbatimArguments: true }).stdout.trim();
      if (short && short.toLowerCase() !== "p r d.md") {
        expect(edit(join(app, short)), short).toMatchObject({ allow: false, spec: "edit" });
        expect(edit(short), short).toMatchObject({ allow: false, spec: "edit" });
      }
    }
    // other files stay open
    expect(edit(join(app, "PRD.md.bak"))).toEqual({ allow: true });
    expect(edit(join(app, "src", "app.js"))).toEqual({ allow: true });
  });

  it("still lets the agent read the spec, and write other files", () => {
    const c = { ...ctx, specFiles: ["PRD.md"] };
    const sh = (command: string, tool = "Bash") => denied(tool, { command }, c);
    for (const cmd of [
      "cat PRD.md",
      "grep -n limit PRD.md",
      "cp PRD.md notes/PRD-copy.md",
      "sed -n 1,20p PRD.md",
      "echo x > src/PRD.md.bak",
      "echo x >> notes.md",
      "diff PRD.md other.md > out.txt",
      "wc -l PRD.md 2>&1",
    ])
      expect(sh(cmd), cmd).toBe(false);
    expect(sh("Get-Content PRD.md", "PowerShell")).toBe(false);
    expect(sh("echo x >> PRD.md")).toBe(true);
    // without spec files in the context the rule does nothing
    expect(denied("Bash", { command: "echo x >> PRD.md" })).toBe(false);
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
  it("passes the app dir and each spec file, quoted", () => {
    const c = { home: "/h/p", verifierDir: "/h/p/verifier", appDir: "/w/my app", specFiles: ["PRD.md", "docs/My Rules.md"] };
    expect(guardHookCommand(c, "g.js", "node")).toBe('"node" "g.js" --home "/h/p" --verifier "/h/p/verifier" --app "/w/my app" --spec "PRD.md" --spec "docs/My Rules.md"');
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
