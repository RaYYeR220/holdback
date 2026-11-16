import { mkdirSync, mkdtempSync, readFileSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

/** Called before every `readFile` of `node:fs/promises` in this file's module graph: lets a test land an edit at an exact point. */
let beforeRead: ((file: string) => void) | undefined;
vi.mock("node:fs/promises", async (importOriginal) => {
  const mod = await importOriginal<typeof import("node:fs/promises")>();
  const readFile = ((file: Parameters<typeof mod.readFile>[0], ...rest: unknown[]) => {
    beforeRead?.(String(file));
    return (mod.readFile as (...a: unknown[]) => unknown)(file, ...rest);
  }) as typeof mod.readFile;
  return { ...mod, readFile, default: { ...mod, readFile } };
});

const { appendEvent, readEvents } = await import("../src/ledger/store.js");
const { runDrift } = await import("../src/loop/drift.js");
const { reseal } = await import("../src/loop/spec.js");
const { loadProject } = await import("../src/project.js");
type LedgerEvent = import("../src/ledger/types.js").LedgerEvent;
type Project = import("../src/project.js").Project;

const at = "2026-11-16T00:00:00.000Z";
const saved = { ...process.env };
let root: string;
let p: Project;
const log = (e: LedgerEvent) => appendEvent(p.ledgerFile, e);

beforeEach(async () => {
  root = mkdtempSync(join(tmpdir(), "holdback-drift-pin-"));
  process.env.HOLDBACK_HOME = join(root, "home");
  const appDir = join(root, "app");
  mkdirSync(appDir, { recursive: true });
  writeFileSync(join(appDir, "PRD.md"), "# PRD\n\nRule 1.\n");
  writeFileSync(join(appDir, "rules.md"), "# Rules\n\nRule A.\n");
  writeFileSync(join(appDir, "holdback.config.json"), JSON.stringify({ spec: ["PRD.md", "rules.md"] }));
  p = await loadProject(appDir);
  mkdirSync(join(p.verifierDir, ".testmuai", "tests"), { recursive: true });
  await log({ at, t: "spec.ingested", sources: [{ id: "prd", cid: "sha256:a", status: "created", file: "PRD.md" }, { id: "rules", cid: "sha256:b", status: "created", file: "rules.md" }] });
  await reseal(p, log);
});
afterEach(() => {
  beforeRead = undefined;
  if (saved.HOLDBACK_HOME === undefined) delete process.env.HOLDBACK_HOME;
  else process.env.HOLDBACK_HOME = saved.HOLDBACK_HOME;
});

describe("drift's pin of the spec (coordinator addendum to I-1)", () => {
  it("a spec file nobody changed that moves between the seal check and the pin is caught: an unverified change, nothing re-planned", async () => {
    writeFileSync(join(p.appDir, "PRD.md"), "# PRD\n\nRule 1.\nRule 2.\n");
    const { createHash } = await import("node:crypto");
    const reviewed = { "PRD.md": createHash("sha256").update(readFileSync(join(p.appDir, "PRD.md"))).digest("hex") };
    // rules.md: read once by the seal check (unchanged), then edited right before drift pins it
    let reads = 0;
    beforeRead = (file) => {
      if (file.endsWith("rules.md") && file.startsWith(p.appDir) && ++reads === 2) writeFileSync(join(p.appDir, "rules.md"), "# Rules\n\nRule A.\nSlipped in.\n");
    };
    const kane = new Proxy({}, { get: (_t, name) => () => Promise.reject(new Error(`Kane must not be called (${String(name)})`)) });
    const io = { answer: async () => ({}), approve: async () => [] };
    const r = await runDrift(p, io, log, { kane: kane as never, reviewed });
    expect(reads).toBeGreaterThanOrEqual(2);
    expect(r).toMatchObject({ changed: true, applied: false, specMoved: ["rules.md"] });
    const events = await readEvents(p.ledgerFile);
    expect(events.filter((e) => e.t === "seal")).toHaveLength(1);
    expect(events.at(-1)).toMatchObject({ t: "spec.changed", files: ["rules.md"], duringAgentTurn: true });
  });
});
