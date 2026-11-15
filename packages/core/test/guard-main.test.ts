import { spawnSync } from "node:child_process";
import { existsSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { describe, expect, it } from "vitest";

const main = join(dirname(fileURLToPath(import.meta.url)), "..", "dist", "agent", "guard-main.js");
const run = (stdin: string) =>
  spawnSync(process.execPath, [main, "--home", "/h/p1", "--verifier", "/h/p1/verifier"], { input: stdin, encoding: "utf8" });

// Exercises the built entry point; skipped until `pnpm build` has run.
describe.skipIf(!existsSync(main))("guard-main", () => {
  it("allows with exit 0", () => {
    expect(run(JSON.stringify({ tool_name: "Bash", tool_input: { command: "npm test" } })).status).toBe(0);
  });
  it("denies with exit 2 and a reason on stderr", () => {
    const r = run(JSON.stringify({ tool_name: "Read", tool_input: { file_path: "/h/p1/verifier/a.md" } }));
    expect(r.status).toBe(2);
    expect(r.stderr.length).toBeGreaterThan(0);
  });
  it("fails closed on garbage", () => {
    const r = run("not json");
    expect(r.status).toBe(2);
    expect(r.stderr).toMatch(/parse/i);
  });
});
