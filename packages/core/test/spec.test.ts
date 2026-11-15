import { mkdirSync, mkdtempSync, readFileSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { appendEvent, readEvents } from "../src/ledger/store.js";
import { ScriptedHumanIO, type HumanIO } from "../src/loop/human.js";
import { runSpecStage } from "../src/loop/spec.js";
import { loadProject } from "../src/project.js";

const here = dirname(fileURLToPath(import.meta.url));
const fx = (n: string) => join(here, "fixtures", "kane", n);
const saved = { ...process.env };
let root: string;

beforeEach(() => {
  root = mkdtempSync(join(tmpdir(), "holdback-spec-"));
  process.env.HOLDBACK_KANE_BIN = join(here, "fake-kane.mjs");
  process.env.HOLDBACK_HOME = join(root, "home");
  process.env.FAKE_KANE_ARGV_LOG = join(root, "argv.log");
  delete process.env.FAKE_KANE_EXIT;
  delete process.env.FAKE_KANE_FIXTURE;
});
afterEach(() => {
  for (const k of ["HOLDBACK_KANE_BIN", "HOLDBACK_HOME", "FAKE_KANE_ARGV_LOG", "FAKE_KANE_SEQUENCE"]) {
    if (saved[k] === undefined) delete process.env[k];
    else process.env[k] = saved[k];
  }
});

function setup(prd: string) {
  const appDir = join(root, "app");
  mkdirSync(appDir, { recursive: true });
  writeFileSync(join(appDir, "PRD.md"), prd);
  const seq = join(root, "seq.txt");
  // ingest, resume, list(uc), review, design, graph, list(derived), review
  const steps = ["01-ingest.ndjson", "02-extract.ndjson", "09-list-uc.ndjson", "-", "03-design.ndjson", "context-view.json", "10-list-derived.ndjson", "-"];
  writeFileSync(seq, steps.map((s) => (s === "-" ? "-" : fx(s))).join("\n"));
  process.env.FAKE_KANE_SEQUENCE = seq;
  return appDir;
}

describe("runSpecStage", () => {
  it("runs ingest -> answers -> approvals -> design -> seal", async () => {
    const appDir = setup("# PRD\n\nSnap rules.\n");
    const p = await loadProject(appDir);
    const asked: string[] = [];
    const approvals: string[][] = [];
    const io: HumanIO = {
      async answer(qs) {
        asked.push(...qs.map((q) => q.id));
        return Object.fromEntries(qs.map((q) => [q.id, "Show errors"]));
      },
      async approve(items) {
        approvals.push(items.map((i) => i.ref));
        return items.map((i) => i.ref);
      },
    };
    await runSpecStage(p, io, (e) => appendEvent(p.ledgerFile, e));

    const events = await readEvents(p.ledgerFile);
    expect(events.map((e) => e.t)).toEqual(["spec.ingested", "spec.paused", "spec.answered", "spec.approved", "design", "spec.approved", "seal"]);
    expect(asked).toEqual(["q1", "q2"]);
    expect(approvals).toEqual([["uc-1"], ["ac-1", "sc-1", "t-1"]]);

    const prd = readFileSync(join(appDir, "PRD.md"), "utf8");
    expect(prd.startsWith("# PRD\n\nSnap rules.\n")).toBe(true);
    expect(prd.match(/## Clarifications/g)).toHaveLength(1);
    expect(prd).toContain("- Q: What should the check do when household size or monthly income is missing or invalid");
    expect(prd).toContain("— A: Show errors");

    const vars = JSON.parse(readFileSync(join(p.verifierDir, ".testmuai", "variables", "assurance.json"), "utf8"));
    expect(vars.start_url.value).toBe(`http://127.0.0.1:${p.config.start.port}/`);
    expect(readFileSync(join(p.verifierDir, "PRD.md"), "utf8")).toContain("Snap rules.");
  }, 60_000);

  it("ScriptedHumanIO answers by text/id and throws on unknown questions", async () => {
    const f = join(root, "script.json");
    writeFileSync(f, JSON.stringify({ answers: { q1: "A" }, approve: ["x"] }));
    const io = new ScriptedHumanIO(f);
    const q = (id: string, text: string) => ({ id, text, risk: "low" as const, rationale: "", options: [], recommendedIndex: 0, allowFreeText: true });
    expect(await io.answer([q("q1", "t")])).toEqual({ q1: "A" });
    await expect(io.answer([q("q9", "mystery?")])).rejects.toThrow("mystery?");
    expect(await io.approve([{ ref: "x", title: "", kind: "" }, { ref: "y", title: "", kind: "" }])).toEqual(["x"]);
  });
});
