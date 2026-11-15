import { mkdtempSync, readFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { describe, expect, it } from "vitest";
import { guardDecision, writeAgentSettings, posixAbs } from "../src/agent/guard.js";

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
});
