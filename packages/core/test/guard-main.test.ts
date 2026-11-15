import { spawnSync } from "node:child_process";
import { mkdtempSync, readFileSync } from "node:fs";
import { createRequire } from "node:module";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { beforeAll, describe, expect, it } from "vitest";

const pkg = join(dirname(fileURLToPath(import.meta.url)), "..");
const main = join(pkg, "dist", "agent", "guard-main.js");
const run = (stdin: string, args = ["--home", "/h/p1", "--verifier", "/h/p1/verifier"], env: Record<string, string> = {}) =>
  spawnSync(process.execPath, [main, ...args], { input: stdin, encoding: "utf8", env: { ...process.env, ...env } });
const call = (tool_name: string, tool_input: unknown) => JSON.stringify({ tool_name, tool_input });

// Always exercise the built entry point: build it here rather than skipping when dist is absent.
beforeAll(() => {
  const tsc = createRequire(import.meta.url).resolve("typescript/bin/tsc");
  const r = spawnSync(process.execPath, [tsc, "-b"], { cwd: pkg, encoding: "utf8" });
  if (r.status !== 0) throw new Error(`tsc -b failed:\n${r.stdout}${r.stderr}`);
}, 180_000);

describe("guard-main", () => {
  it("allows with exit 0", () => {
    expect(run(call("Bash", { command: "npm test" })).status).toBe(0);
  });
  it("denies with exit 2 and a reason on stderr", () => {
    const r = run(call("Read", { file_path: "/h/p1/verifier/a.md" }));
    expect(r.status).toBe(2);
    expect(r.stderr.length).toBeGreaterThan(0);
  });
  it("fails closed on garbage", () => {
    const r = run("not json");
    expect(r.status).toBe(2);
    expect(r.stderr).toMatch(/parse/i);
  });
  it("fails closed on missing or malformed args", () => {
    expect(run(call("Bash", { command: "ls" }), []).status).toBe(2);
    expect(run(call("Bash", { command: "ls" }), ["--home", "--verifier", "x"]).status).toBe(2);
  });
  it("denies (exit 2, not 1) when the guard itself throws", () => {
    const r = run(call("Bash", { command: "ls" }), undefined, { HOLDBACK_GUARD_SELFTEST_THROW: "1" });
    expect(r.status).toBe(2);
    expect(r.stderr).toMatch(/guard error/);
  });
  it("denies a non-object tool_input and a missing tool_input", () => {
    expect(run(call("Bash", "ls")).status).toBe(2);
    expect(run(call("Bash", ["ls"])).status).toBe(2);
    expect(run(call("Bash", null)).status).toBe(2);
    expect(run(JSON.stringify({ tool_name: "Bash" })).status).toBe(2);
    expect(run("[]").status).toBe(2);
  });
  it("scans the whole payload for path needles", () => {
    const r = run(JSON.stringify({ tool_name: "Bash", tool_input: { command: "ls" }, cwd: "/h/p1/verifier" }));
    expect(r.status).toBe(2);
  });
  it("writes the marker log", () => {
    const log = join(mkdtempSync(join(tmpdir(), "hb-")), "g.log");
    run(call("Bash", { command: "npm test" }), undefined, { HOLDBACK_GUARD_LOG: log });
    expect(readFileSync(log, "utf8")).toContain("allow Bash");
  });
});
