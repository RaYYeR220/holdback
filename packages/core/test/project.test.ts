import { describe, it, expect, beforeEach, afterEach } from "vitest";
import { mkdtemp, mkdir, writeFile, rm, stat } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import { loadProject, seal, checkSeal } from "../src/index.js";

let tmp: string;
let prevHome: string | undefined;
beforeEach(async () => {
  tmp = await mkdtemp(path.join(tmpdir(), "hb-proj-"));
  prevHome = process.env.HOLDBACK_HOME;
  process.env.HOLDBACK_HOME = path.join(tmp, "hbhome");
});
afterEach(async () => {
  if (prevHome === undefined) delete process.env.HOLDBACK_HOME;
  else process.env.HOLDBACK_HOME = prevHome;
  await rm(tmp, { recursive: true, force: true });
});

async function mkApp(name: string, config?: string) {
  const dir = path.join(tmp, name);
  await mkdir(dir, { recursive: true });
  if (config !== undefined) await writeFile(path.join(dir, "holdback.config.json"), config);
  return dir;
}

describe("loadProject", () => {
  it("projectId is stable per path and differs across paths", async () => {
    const a = await mkApp("a");
    const b = await mkApp("b");
    const p1 = await loadProject(a);
    const p2 = await loadProject(a);
    const p3 = await loadProject(b);
    expect(p1.projectId).toMatch(/^[0-9a-f]{12}$/);
    expect(p1.projectId).toBe(p2.projectId);
    expect(p1.projectId).not.toBe(p3.projectId);
  });

  it("normalises case, slashes and trailing slash", async () => {
    const a = await mkApp("App");
    const p1 = await loadProject(a);
    const alt = a.toUpperCase().replace(/\\/g, "/") + "/";
    const p2 = await loadProject(alt);
    expect(p2.projectId).toBe(p1.projectId);
  });

  it("creates home + verifierDir and lays out paths", async () => {
    const a = await mkApp("a");
    const p = await loadProject(a);
    expect(p.home).toBe(path.join(tmp, "hbhome", p.projectId));
    expect(p.verifierDir).toBe(path.join(p.home, "verifier"));
    expect(p.ledgerFile).toBe(path.join(p.home, "ledger.jsonl"));
    expect((await stat(p.verifierDir)).isDirectory()).toBe(true);
  });

  it("returns defaults when config is missing", async () => {
    const p = await loadProject(await mkApp("a"));
    expect(p.config).toEqual({
      spec: ["PRD.md"],
      specUrls: [],
      start: { cmd: "", port: 3100, readyPath: "/" },
      agent: { kind: "claude", maxTurnsPerCall: 60 },
      kane: { parallel: 3, timeoutS: 420, designMax: 5 },
      breaker: { model: "deepseek-v4-flash", capUsd: 2 },
      loop: { maxTurns: 15 },
    });
  });

  it("deep-merges user config over defaults", async () => {
    const a = await mkApp(
      "a",
      JSON.stringify({ spec: ["docs/spec.md"], start: { cmd: "npm start" }, kane: { parallel: 1 } }),
    );
    const { config } = await loadProject(a);
    expect(config.spec).toEqual(["docs/spec.md"]);
    expect(config.start).toEqual({ cmd: "npm start", port: 3100, readyPath: "/" });
    expect(config.kane).toEqual({ parallel: 1, timeoutS: 420, designMax: 5 });
    expect(config.loop.maxTurns).toBe(15);
  });

  it("throws a clear error naming the file on invalid JSON", async () => {
    const a = await mkApp("a", "{ nope");
    await expect(loadProject(a)).rejects.toThrow(/holdback\.config\.json/);
  });
});

describe("seal", () => {
  async function verifier() {
    const v = path.join(tmp, "v");
    await mkdir(path.join(v, ".testmuai", "tests", "sub"), { recursive: true });
    await mkdir(path.join(v, ".testmuai", "variables"), { recursive: true });
    await writeFile(path.join(v, ".testmuai", "tests", "a.md"), "A");
    await writeFile(path.join(v, ".testmuai", "tests", "sub", "b.md"), "B");
    await writeFile(path.join(v, ".testmuai", "variables", "x.json"), "{}");
    return v;
  }

  it("hashes files with relative / keys; clean check is empty", async () => {
    const v = await verifier();
    const m = await seal(v);
    expect(Object.keys(m).sort()).toEqual([
      ".testmuai/tests/a.md",
      ".testmuai/tests/sub/b.md",
      ".testmuai/variables/x.json",
    ]);
    expect(await checkSeal(v, m)).toEqual([]);
  });

  it("reports edited, deleted and added files (sorted)", async () => {
    const v = await verifier();
    const m = await seal(v);
    await writeFile(path.join(v, ".testmuai", "tests", "a.md"), "A2");
    await rm(path.join(v, ".testmuai", "tests", "sub", "b.md"));
    await writeFile(path.join(v, ".testmuai", "tests", "c.md"), "C");
    expect(await checkSeal(v, m)).toEqual([
      ".testmuai/tests/a.md",
      ".testmuai/tests/c.md",
      ".testmuai/tests/sub/b.md",
    ]);
  });

  it("missing folders give an empty manifest without throwing", async () => {
    const v = path.join(tmp, "empty");
    await mkdir(v, { recursive: true });
    expect(await seal(v)).toEqual({});
    expect(await checkSeal(v, {})).toEqual([]);
  });
});
