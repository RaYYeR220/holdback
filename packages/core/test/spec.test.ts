import { execFileSync, spawnSync } from "node:child_process";
import { chmodSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { appendEvent, readEvents } from "../src/ledger/store.js";
import { ScriptedHumanIO, type HumanIO } from "../src/loop/human.js";
import { checkSpecPaths, resealAppFiles, runSpecStage } from "../src/loop/spec.js";
import { checkSeal } from "../src/seal.js";
import { reduce } from "../src/ledger/reduce.js";
import { loadProject } from "../src/project.js";
import { markTampered, tamperMarker } from "../src/tamper.js";

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
    await markTampered(p, "left over from an earlier build"); // a fresh seal lifts it
    await runSpecStage(p, io, (e) => appendEvent(p.ledgerFile, e));
    expect(await tamperMarker(p)).toBeNull();

    const events = await readEvents(p.ledgerFile);
    // the marker's tamper goes into the ledger before the seal, so the seal drops any result from before it;
    // the app dir is not a git repo here, so no recordings anchor follows the seal
    expect(events.map((e) => e.t)).toEqual(["spec.ingested", "spec.paused", "spec.answered", "spec.approved", "design", "spec.approved", "tamper", "seal"]);
    expect(events.at(-2)).toMatchObject({ t: "tamper", detail: expect.stringContaining("left over from an earlier build") });
    expect(events[0]).toMatchObject({ t: "spec.ingested", sources: [{ id: "prd", cid: expect.stringMatching(/^sha256:/), status: "created", file: "PRD.md" }] });
    // live smoke: the ledger was 4.44 credits short of the balance drop: the ingest that paused was never counted
    expect(events[1]).toMatchObject({ t: "spec.paused", credits: 4.49 });
    const billed = events.reduce((n, e) => n + ("credits" in e && typeof e.credits === "number" ? e.credits : 0), 0);
    expect(reduce(events).credits).toBeCloseTo(billed, 6);
    expect(billed).toBeGreaterThan(4.49 + 1.41);
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

  it("logs Kane's balance drop for the ingest and for each design, next to their per-run credits (R34)", async () => {
    const appDir = setup("# PRD\n\nSnap rules.\n");
    const p = await loadProject(appDir);
    const balances = [100, 92.5, 92.5, 70];
    await runSpecStage(p, acceptAll, (e) => appendEvent(p.ledgerFile, e), { balance: async () => balances.shift()! });
    const events = await readEvents(p.ledgerFile);
    expect(events.map((e) => e.t)).toEqual(["spec.ingested", "spec.paused", "spec.answered", "credits", "spec.approved", "design", "credits", "spec.approved", "seal"]);
    const [ingest, design] = events.filter((e) => e.t === "credits");
    const perRun = (ts: string[]) => events.filter((e) => ts.includes(e.t)).reduce((n, e) => n + ("credits" in e && typeof e.credits === "number" ? e.credits : 0), 0);
    expect(ingest).toMatchObject({ source: "spec", delta: 7.5, perRunSum: expect.closeTo(perRun(["spec.ingested", "spec.paused", "spec.answered"]), 4) });
    expect(design).toMatchObject({ source: "design", delta: 22.5, perRunSum: expect.closeTo(perRun(["design"]), 4) });
    expect(reduce(events).kaneCredits).toBe(30);
  }, 60_000);

  it("commits its own Clarifications to the app repo before the seal, and nothing else (R34)", async () => {
    const appDir = setup("# PRD\n\nSnap rules.\n");
    const git = (...args: string[]) => execFileSync("git", args, { cwd: appDir, encoding: "utf8" }).trim();
    git("init", "-q");
    git("config", "user.name", "Test");
    git("config", "user.email", "test@example.com");
    git("config", "commit.gpgsign", "false");
    git("add", "-A");
    git("commit", "-q", "-m", "spec");
    // the human's own work in progress stays theirs: one staged file, one untracked
    writeFileSync(join(appDir, "staged.txt"), "staged\n");
    git("add", "staged.txt");
    writeFileSync(join(appDir, "notes.txt"), "mine\n");
    // a repo hook never runs on Holdback's commit
    writeFileSync(join(appDir, ".git", "hooks", "pre-commit"), "#!/bin/sh\nexit 1\n");
    chmodSync(join(appDir, ".git", "hooks", "pre-commit"), 0o755);
    const p = await loadProject(appDir);
    await runSpecStage(p, acceptAll, (e) => appendEvent(p.ledgerFile, e));

    expect(git("log", "--format=%s")).toBe("spec: clarifications\nspec");
    expect(git("log", "-1", "--format=%B")).toBe("spec: clarifications");
    expect(git("show", "--name-only", "--format=", "HEAD")).toBe("PRD.md");
    expect(git("show", "HEAD:PRD.md")).toContain("## Clarifications");
    // PRD.md is clean now; the human's files are as they were
    expect(git("status", "--porcelain")).toBe("A  staged.txt\n?? notes.txt");
    const events = await readEvents(p.ledgerFile);
    expect(events.filter((e) => e.t === "seal")).toHaveLength(1);
  }, 60_000);

  it("a Clarifications commit that fails is a warning: the paid spec stage still seals", async () => {
    const appDir = setup("# PRD\n\nSnap rules.\n");
    const git = (...args: string[]) => execFileSync("git", args, { cwd: appDir, encoding: "utf8" }).trim();
    git("init", "-q");
    git("config", "user.name", "Test");
    git("config", "user.email", "test@example.com");
    git("add", "-A");
    git("commit", "-q", "-m", "spec");
    writeFileSync(join(appDir, ".git", "index.lock"), ""); // another git process holds the index
    const p = await loadProject(appDir);
    const warnings: string[] = [];
    await runSpecStage(p, acceptAll, (e) => appendEvent(p.ledgerFile, e), { warn: (l) => warnings.push(l) });
    expect(warnings).toHaveLength(1);
    expect(warnings[0]).toMatch(/^warning: could not commit the Clarifications Holdback added to PRD\.md .*index\.lock/s);
    expect((await readEvents(p.ledgerFile)).filter((e) => e.t === "seal")).toHaveLength(1);
    rmSync(join(appDir, ".git", "index.lock"));
    expect(git("log", "--format=%s")).toBe("spec");
    expect(git("status", "--porcelain")).toBe("M PRD.md");
  }, 60_000);

  it("leaves an unborn HEAD alone: the build loop's first commit takes the whole tree", async () => {
    const appDir = setup("# PRD\n");
    execFileSync("git", ["init", "-q"], { cwd: appDir });
    const p = await loadProject(appDir);
    await runSpecStage(p, acceptAll, (e) => appendEvent(p.ledgerFile, e));
    expect(spawnSync("git", ["rev-parse", "--verify", "-q", "HEAD"], { cwd: appDir }).status).not.toBe(0);
  }, 60_000);

  it("ScriptedHumanIO answers by text/id and throws on unknown questions", async () => {
    const f = join(root, "script.json");
    writeFileSync(f, JSON.stringify({ answers: { q1: "A" }, approve: ["x"] }));
    const io = await ScriptedHumanIO.fromFile(f);
    const q = (id: string, text: string) => ({ id, text, risk: "low" as const, rationale: "", options: [], recommendedIndex: 0, allowFreeText: true });
    expect(await io.answer([q("q1", "t")])).toEqual({ q1: "A" });
    await expect(io.answer([q("q9", "mystery?")])).rejects.toThrow("mystery?");
    expect(await io.approve([{ ref: "x", title: "", kind: "" }, { ref: "y", title: "", kind: "" }])).toEqual(["x"]);
  });

  it("ScriptedHumanIO with default \"recommended\" takes Kane's recommended option for unscripted questions", async () => {
    // Kane's questions are written by its model at run time: a script for a live run cannot list them in advance
    const f = join(root, "script.json");
    writeFileSync(f, JSON.stringify({ answers: { q1: "Show errors" }, default: "recommended", approve: "all" }));
    const io = await ScriptedHumanIO.fromFile(f);
    // read once, up front: later edits to the file (by anyone) change nothing
    writeFileSync(f, JSON.stringify({ answers: { q1: "Provide spec", q2: "Provide spec" }, approve: [] }));
    const q = (id: string, recommendedIndex: number) => ({
      id,
      text: `question ${id}?`,
      risk: "med" as const,
      rationale: "",
      options: [{ label: "Leave unspecified" }, { label: "Show errors" }, { label: "Provide spec" }],
      recommendedIndex,
      allowFreeText: false,
    });
    expect(await io.answer([q("q1", 0), q("q2", 0), q("q3", 2)])).toEqual({ q1: "Show errors", q2: "Leave unspecified", q3: "Provide spec" });
    // a question with no option to recommend still fails loudly
    await expect(io.answer([{ ...q("q4", 0), options: [] }])).rejects.toThrow("question q4?");
    expect(await io.approve([{ ref: "x", title: "", kind: "" }])).toEqual(["x"]);
    io.close(); // the CLI closes every human IO it opens
  });

  it("ScriptedHumanIO validates the whole file when it is read, before any question", async () => {
    const f = join(root, "script.json");
    const bad = async (doc: string) => {
      writeFileSync(f, doc);
      return ScriptedHumanIO.fromFile(f).then(
        () => "accepted",
        (e: Error) => e.message,
      );
    };
    expect(await bad(JSON.stringify({ answers: {}, default: "first" }))).toMatch(/"default" must be "recommended"/);
    expect(await bad(JSON.stringify({ answers: { q1: 1 } }))).toMatch(/"answers" must map/);
    expect(await bad(JSON.stringify({ approve: "some" }))).toMatch(/"approve" must be/);
    expect(await bad("[]")).toMatch(/expected a JSON object/);
    expect(await bad("{nope")).toMatch(/not valid JSON/);
    expect(await bad(JSON.stringify({ default: "recommended", approve: "all" }))).toBe("accepted");
  });

  const acceptAll: HumanIO = {
    answer: async (qs) => Object.fromEntries(qs.map((q) => [q.id, "a\n  b"])),
    approve: async (items) => items.map((i) => i.ref),
  };

  it("rejects spec paths that escape the app dir", async () => {
    for (const bad of ["../x.md", join(root, "abs.md")]) {
      const appDir = setup("# PRD\n");
      writeFileSync(join(appDir, "holdback.config.json"), JSON.stringify({ spec: [bad] }));
      const p = await loadProject(appDir);
      await expect(runSpecStage(p, acceptAll, async () => {})).rejects.toThrow(/spec path/);
    }
  });

  it("takes a spec in a folder whose name starts with two dots as inside the app dir", async () => {
    const appDir = setup("# PRD\n");
    mkdirSync(join(appDir, "..docs"));
    writeFileSync(join(appDir, "..docs", "PRD.md"), "# PRD\n");
    writeFileSync(join(appDir, "holdback.config.json"), JSON.stringify({ spec: ["..docs/PRD.md"] }));
    const p = await loadProject(appDir);
    expect(() => checkSpecPaths(p)).not.toThrow();
    writeFileSync(join(appDir, "holdback.config.json"), JSON.stringify({ spec: ["..docs/../../x.md"] }));
    const escaped = await loadProject(appDir);
    expect(() => checkSpecPaths(escaped)).toThrow(/escapes the app dir/);
  });

  it("refuses to seal when the design approval is empty, and logs rejections", async () => {
    const appDir = setup("# PRD\n");
    const p = await loadProject(appDir);
    const io: HumanIO = { ...acceptAll, approve: async (items) => (items[0]?.kind === "usecase" ? items.map((i) => i.ref) : []) };
    await expect(runSpecStage(p, io, (e) => appendEvent(p.ledgerFile, e))).rejects.toThrow(/refusing to seal/);
    const events = await readEvents(p.ledgerFile);
    expect(events.some((e) => e.t === "seal")).toBe(false);
    const last = events.filter((e) => e.t === "spec.approved").pop();
    expect(last).toMatchObject({ refs: [], rejected: ["ac-1", "sc-1", "t-1"] });
    expect(() => reduce(events)).not.toThrow();
  }, 60_000);

  it("seals app config + spec, collapses whitespace, and counts credits", async () => {
    const appDir = setup("# PRD\n");
    writeFileSync(join(appDir, "holdback.config.json"), JSON.stringify({ spec: ["PRD.md"] }));
    const p = await loadProject(appDir);
    await runSpecStage(p, acceptAll, (e) => appendEvent(p.ledgerFile, e));
    const events = await readEvents(p.ledgerFile);
    const manifest = (events.find((e) => e.t === "seal") as { manifest: Record<string, string> }).manifest;
    expect(Object.keys(manifest)).toEqual(expect.arrayContaining(["app:PRD.md", "app:holdback.config.json"]));
    expect(await checkSeal(p.verifierDir, manifest, p.appDir)).toEqual([]);
    expect(readFileSync(join(appDir, "PRD.md"), "utf8")).toContain("— A: a b\n");
    expect(reduce(events).credits).toBeGreaterThan(0);

    writeFileSync(join(appDir, "PRD.md"), "tampered");
    writeFileSync(join(appDir, "holdback.config.json"), "{}");
    expect(await checkSeal(p.verifierDir, manifest, p.appDir)).toEqual(["app:PRD.md", "app:holdback.config.json"]);
    const re = await resealAppFiles(p, manifest);
    expect(await checkSeal(p.verifierDir, re, p.appDir)).toEqual([]);
  }, 60_000);
});
