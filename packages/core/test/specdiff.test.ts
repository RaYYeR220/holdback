import { execFileSync } from "node:child_process";
import { existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { appendEvent, readEvents } from "../src/ledger/store.js";
import type { LedgerEvent } from "../src/ledger/types.js";
import { reseal, SEALED_DIR, specDiff } from "../src/loop/spec.js";
import { loadProject, type Project } from "../src/project.js";

const saved = { ...process.env };
let root: string;
let p: Project;
const log = (e: LedgerEvent) => appendEvent(p.ledgerFile, e);
const manifest = async () => (await readEvents(p.ledgerFile)).findLast((e) => e.t === "seal")!.manifest as Record<string, string>;

beforeEach(async () => {
  root = mkdtempSync(join(tmpdir(), "hb-specdiff-"));
  process.env.HOLDBACK_HOME = join(root, "home");
  const appDir = join(root, "app");
  mkdirSync(appDir);
  writeFileSync(join(appDir, "PRD.md"), "# PRD\n\nRule 1.\nRule 2.\n");
  p = await loadProject(appDir);
});
afterEach(() => {
  if (saved.HOLDBACK_HOME === undefined) delete process.env.HOLDBACK_HOME;
  else process.env.HOLDBACK_HOME = saved.HOLDBACK_HOME;
  rmSync(root, { recursive: true, force: true });
});

// a dozen git spawns: slow on Windows under a parallel suite
describe("the sealed spec and its diff (R37)", { timeout: 60_000 }, () => {
  it("every seal keeps a copy of the spec in the home, and the diff shows what changed since", async () => {
    await reseal(p, log);
    expect(readFileSync(join(p.home, SEALED_DIR, "PRD.md"), "utf8")).toBe("# PRD\n\nRule 1.\nRule 2.\n");
    writeFileSync(join(p.appDir, "PRD.md"), "# PRD\n\nRule 1.\nRule 2 changed.\n");
    const d = await specDiff(p, await manifest(), "PRD.md");
    expect(d).toContain("--- PRD.md (sealed)");
    expect(d).toContain("+++ PRD.md (now)");
    expect(d).toContain("-Rule 2.");
    expect(d).toContain("+Rule 2 changed.");
  });

  it("a re-seal that keeps the spec's old hash keeps its old copy too", async () => {
    await reseal(p, log);
    const m = await manifest();
    writeFileSync(join(p.appDir, "PRD.md"), "# PRD\n\nsomething else\n");
    await reseal(p, log, undefined, { keep: { "app:PRD.md": m["app:PRD.md"]! } });
    expect(readFileSync(join(p.home, SEALED_DIR, "PRD.md"), "utf8")).toBe("# PRD\n\nRule 1.\nRule 2.\n");
    expect(await specDiff(p, await manifest(), "PRD.md")).toContain("+something else");
  });

  it("without a matching copy it uses the committed file when that is what was sealed, else says it cannot", async () => {
    const git = (...a: string[]) => execFileSync("git", a, { cwd: p.appDir, encoding: "utf8" });
    git("init", "-q");
    git("config", "user.name", "T");
    git("config", "user.email", "t@example.com");
    git("add", "-A");
    git("commit", "-q", "-m", "spec");
    await reseal(p, log);
    rmSync(join(p.home, SEALED_DIR), { recursive: true });
    writeFileSync(join(p.appDir, "PRD.md"), "# PRD\n\nRule 1.\n");
    expect(await specDiff(p, await manifest(), "PRD.md")).toContain("-Rule 2.");
    writeFileSync(join(p.home, "x"), "");
    expect(existsSync(join(p.home, SEALED_DIR))).toBe(false);
    expect(await specDiff(p, { "app:PRD.md": "0".repeat(64) }, "PRD.md")).toBeNull();
  });
});
