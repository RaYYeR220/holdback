import { execFileSync, spawnSync } from "node:child_process";
import { appendFileSync, chmodSync, cpSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { appendEvent, readEvents } from "../src/ledger/store.js";
import { ScriptedHumanIO, type ApprovalItem, type HumanIO, type VariableAsk } from "../src/loop/human.js";
import { checkSpecPaths, designNotes, mapIngestedFiles, runSpecStage, specHashAfterAppend, specSource, TESTS_TURNED_DOWN } from "../src/loop/spec.js";
import { checkSeal } from "../src/seal.js";
import { reduce } from "../src/ledger/reduce.js";
import { gate } from "../src/ledger/gate.js";
import { loadProject } from "../src/project.js";
import type { LedgerEvent } from "../src/ledger/types.js";
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

/** Kane's graph with no test verifying `uncovered` (written for the test from the recorded view): the sequence reads it instead. */
function withUncovered(...uncovered: string[]) {
  const view = JSON.parse(readFileSync(fx("context-view.json"), "utf8")) as { nodes: { cid: string; slug: string; label: string }[]; edges: { src: string; dst: string; type: string }[] };
  const slugOf = new Map(view.nodes.map((n) => [n.cid, n.slug]));
  view.edges = view.edges.filter((e) => !(e.type === "verifies" && uncovered.includes(slugOf.get(e.dst) ?? "")));
  const file = join(root, "view-uncovered.json");
  writeFileSync(file, JSON.stringify(view));
  const seq = join(root, "seq.txt");
  writeFileSync(seq, readFileSync(seq, "utf8").replace(fx("context-view.json"), file));
}

/** The file Kane wrote for test `id` in the verifier (the graph's t-1 to t-3 each have one). */
const testFileOf = (p: Awaited<ReturnType<typeof loadProject>>, id: string) => join(p.verifierDir, ".testmuai", "tests", `${id}_test.md`);

async function setup(prd: string) {
  const appDir = join(root, "app");
  mkdirSync(appDir, { recursive: true });
  writeFileSync(join(appDir, "PRD.md"), prd);
  const seq = join(root, "seq.txt");
  // ingest, resume, list(uc), review, design, graph, list(derived), review
  const steps = ["01-ingest.ndjson", "02-extract.ndjson", "09-list-uc.ndjson", "-", "03-design.ndjson", "context-view.json", "10-list-derived.ndjson", "-"];
  writeFileSync(seq, steps.map((s) => (s === "-" ? "-" : fx(s))).join("\n"));
  process.env.FAKE_KANE_SEQUENCE = seq;
  // the test files Kane's design leaves in the verifier: an id and a title, the criteria from the graph's edges
  const p = await loadProject(appDir);
  mkdirSync(join(p.verifierDir, ".testmuai", "tests"), { recursive: true });
  for (const id of ["t-1", "t-2", "t-3"]) writeFileSync(testFileOf(p, id), `---\nassurance:\n  id: ${id}\n---\n# ${id}\n`);
  return appDir;
}

describe("the spec as the stage knows it (n-3, wave-4 m-3)", () => {
  it("after Holdback's own append, the expected hash comes from the bytes it checked plus what it appended: an edit that lands in between is caught", async () => {
    const appDir = join(root, "app");
    mkdirSync(appDir, { recursive: true });
    writeFileSync(join(appDir, "PRD.md"), "# PRD\n\nSnap rules.\n");
    const p = await loadProject(appDir);
    const checked = await specSource(p);
    const added = "\n## Clarifications\n\n- Q: a — A: b\n";
    // a clean append: what the stage expects is what the disk holds
    appendFileSync(join(appDir, "PRD.md"), added);
    expect(specHashAfterAppend(p, checked.bytes, added)).toBe((await specSource(p)).hash);
    // a human edit between the check and the append: the disk no longer matches what the stage expects
    writeFileSync(join(appDir, "PRD.md"), "# PRD\n\nSnap rules, edited.\n" + added);
    expect(specHashAfterAppend(p, checked.bytes, added)).not.toBe((await specSource(p)).hash);
  });
});

describe("designNotes (rehearsal issue 7, wave-4 m-5)", () => {
  const acs = ["ac-1", "ac-2", "ac-3"].map((id) => ({ id }));
  it("reads the cap on Kane's own set, rejections apart, and names a criterion whose every test the human turned down", () => {
    const tests = [
      { id: "t-1", verifies: ["ac-1"] },
      { id: "t-2", verifies: ["ac-2"] },
    ];
    // at the cap (2 tests): ac-3 has no test because of it
    expect(designNotes(acs, tests, 2)).toEqual({ "ac-3": "no test designed (design cap 2)" });
    // a rejected test still counts toward the cap; the criterion it alone verified says why it has none
    expect(designNotes(acs, tests, 2, new Set(["t-2"]))).toEqual({ "ac-2": TESTS_TURNED_DOWN, "ac-3": "no test designed (design cap 2)" });
    // under the cap: only the turned-down one has a reason; a rejected criterion has none
    expect(designNotes(acs, tests, 5, new Set(["t-2", "ac-3"]))).toEqual({ "ac-2": TESTS_TURNED_DOWN });
    expect(designNotes(acs, tests, 5)).toBeUndefined();
  });
});

describe("runSpecStage", () => {
  it("runs ingest -> answers -> approvals -> design -> seal", async () => {
    const appDir = await setup("# PRD\n\nSnap rules.\n");
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
      values: async () => ({}),
    };
    await markTampered(p, "left over from an earlier build"); // a fresh seal lifts it
    await runSpecStage(p, io, (e) => appendEvent(p.ledgerFile, e));
    expect(await tamperMarker(p)).toBeNull();

    const events = await readEvents(p.ledgerFile);
    // the marker's tamper goes into the ledger before the seal, so the seal drops any result from before it;
    // the app dir is not a git repo here, so no recordings anchor follows the seal
    expect(events.map((e) => e.t)).toEqual(["spec.ingested", "spec.paused", "spec.answered", "spec.extracted", "spec.approved", "design", "spec.approved", "tamper", "seal"]);
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
    const appDir = await setup("# PRD\n\nSnap rules.\n");
    const p = await loadProject(appDir);
    const balances = [100, 92.5, 92.5, 70];
    await runSpecStage(p, acceptAll, (e) => appendEvent(p.ledgerFile, e), { balance: async () => balances.shift()! });
    const events = await readEvents(p.ledgerFile);
    expect(events.map((e) => e.t)).toEqual(["spec.ingested", "spec.paused", "spec.answered", "spec.extracted", "credits", "spec.approved", "design", "credits", "spec.approved", "seal"]);
    const [ingest, design] = events.filter((e) => e.t === "credits");
    const perRun = (ts: string[]) => events.filter((e) => ts.includes(e.t)).reduce((n, e) => n + ("credits" in e && typeof e.credits === "number" ? e.credits : 0), 0);
    expect(ingest).toMatchObject({ source: "spec", delta: 7.5, perRunSum: expect.closeTo(perRun(["spec.ingested", "spec.paused", "spec.answered"]), 4) });
    expect(design).toMatchObject({ source: "design", delta: 22.5, perRunSum: expect.closeTo(perRun(["design"]), 4) });
    expect(reduce(events).kaneCredits).toBe(30);
  }, 60_000);

  it("commits its own Clarifications to the app repo before the seal, and nothing else (R34)", async () => {
    const appDir = await setup("# PRD\n\nSnap rules.\n");
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
    const appDir = await setup("# PRD\n\nSnap rules.\n");
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
    const appDir = await setup("# PRD\n");
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
    expect(await bad(JSON.stringify({ variables: { phone: 2155550101 } }))).toMatch(/"variables" must map/);
  });

  it("ScriptedHumanIO fills test variables from its \"variables\", and with default \"recommended\" takes Holdback's suggestion, never for a secret or a placeholder", async () => {
    const f = join(root, "script.json");
    const ask = (name: string, extra: object = {}) => ({ name, description: "", secret: false, usedBy: ["t-1"], ...extra });
    const asks = [ask("phone", { suggested: "2155550101" }), ask("coupon", { placeholder: "<coupon>" }), ask("password", { secret: true }), ask("guest_name", { suggested: "Maria Lopez" })];
    writeFileSync(f, JSON.stringify({ variables: { password: "s3cret", guest_name: "Ana Ruiz" }, default: "recommended" }));
    expect(await (await ScriptedHumanIO.fromFile(f)).values(asks)).toEqual({ phone: "2155550101", coupon: "", password: "s3cret", guest_name: "Ana Ruiz" });
    // without the standing choice, an unnamed variable stays empty: the stage then stops before the seal
    writeFileSync(f, JSON.stringify({ variables: { phone: "2155550199" } }));
    expect(await (await ScriptedHumanIO.fromFile(f)).values(asks)).toEqual({ phone: "2155550199", coupon: "", password: "", guest_name: "" });
  });

  const acceptAll: HumanIO = {
    answer: async (qs) => Object.fromEntries(qs.map((q) => [q.id, "a\n  b"])),
    approve: async (items) => items.map((i) => i.ref),
    values: async (asks) => Object.fromEntries(asks.map((a) => [a.name, a.suggested ?? ""])),
  };

  it("maps Kane's sources to spec files by Kane's source id, never by event order (M6)", () => {
    const m = mapIngestedFiles([{ id: "rules" }, { id: "url-1" }, { id: "prd" }], ["PRD.md", "a.md", "b.md", "docs/rules.md"]);
    expect(m.get("prd")).toBe("PRD.md");
    expect(m.get("rules")).toBe("docs/rules.md");
    expect(m.has("url-1")).toBe(false); // two files left unmatched: no guess
    expect(mapIngestedFiles([{ id: "pantry-rules" }], ["docs/Pantry Rules.md"]).get("pantry-rules")).toBe("docs/Pantry Rules.md");
    // one file and one source left: paired
    expect(mapIngestedFiles([{ id: "src-1" }], ["SPEC.md"]).get("src-1")).toBe("SPEC.md");
  });

  it("rejects spec paths that escape the app dir", async () => {
    for (const bad of ["../x.md", join(root, "abs.md")]) {
      const appDir = await setup("# PRD\n");
      writeFileSync(join(appDir, "holdback.config.json"), JSON.stringify({ spec: [bad] }));
      const p = await loadProject(appDir);
      await expect(runSpecStage(p, acceptAll, async () => {})).rejects.toThrow(/spec path/);
    }
  });

  it("takes a spec in a folder whose name starts with two dots as inside the app dir", async () => {
    const appDir = await setup("# PRD\n");
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
    const appDir = await setup("# PRD\n");
    const p = await loadProject(appDir);
    const io: HumanIO = { ...acceptAll, approve: async (items) => (items[0]?.kind === "usecase" ? items.map((i) => i.ref) : []) };
    await expect(runSpecStage(p, io, (e) => appendEvent(p.ledgerFile, e))).rejects.toThrow(/refusing to seal/);
    const events = await readEvents(p.ledgerFile);
    expect(events.some((e) => e.t === "seal")).toBe(false);
    const last = events.filter((e) => e.t === "spec.approved").pop();
    expect(last).toMatchObject({ refs: [], rejected: ["ac-1", "sc-1", "t-1"] });
    expect(() => reduce(events)).not.toThrow();
  }, 60_000);

  it("honours the human's rejections in the design approval: rejected nodes are logged on the design, and never owed (I3)", async () => {
    const appDir = await setup("# PRD\n");
    const p = await loadProject(appDir);
    const io: HumanIO = { ...acceptAll, approve: async (items) => items.map((i) => i.ref).filter((r) => r !== "ac-1" && r !== "t-1") };
    await runSpecStage(p, io, (e) => appendEvent(p.ledgerFile, e));
    const events = await readEvents(p.ledgerFile);
    const designs = events.filter((e) => e.t === "design");
    expect(designs).toHaveLength(2);
    expect(designs[1]).toMatchObject({ useCase: "uc-1", credits: 0, rejected: ["ac-1", "t-1"] });
    expect(events.at(-1)!.t).toBe("seal");
    const s = reduce(events);
    expect(s.acs["ac-1"]!.status).toBe("rejected");
    expect(Object.values(s.acs).some((a) => a.tests.includes("t-1"))).toBe(false);
    expect(gate(s).owed.map((a) => a.id)).not.toContain("ac-1");
  }, 60_000);

  it("refuses to run again once the criteria are sealed: a spec change goes through drift (I4)", async () => {
    const appDir = await setup("# PRD\n");
    const p = await loadProject(appDir);
    await runSpecStage(p, acceptAll, (e) => appendEvent(p.ledgerFile, e));
    const calls = readFileSync(process.env.FAKE_KANE_ARGV_LOG!, "utf8");
    const before = (await readEvents(p.ledgerFile)).length;
    await expect(runSpecStage(p, acceptAll, (e) => appendEvent(p.ledgerFile, e))).rejects.toThrow(/already sealed.*holdback drift/);
    expect(readFileSync(process.env.FAKE_KANE_ARGV_LOG!, "utf8")).toBe(calls); // no Kane call
    expect(await readEvents(p.ledgerFile)).toHaveLength(before);
  }, 60_000);

  it("resumes a stage cut short after the design: no new ingest or design, the approval, then the seal (I4)", async () => {
    const appDir = await setup("# PRD\n");
    const p = await loadProject(appDir);
    const closing: HumanIO = {
      ...acceptAll,
      approve: async (items) => {
        if (items[0]?.kind !== "usecase") throw new Error("the dashboard server closed");
        return items.map((i) => i.ref);
      },
    };
    await expect(runSpecStage(p, closing, (e) => appendEvent(p.ledgerFile, e))).rejects.toThrow(/dashboard server closed/);
    const first = await readEvents(p.ledgerFile);
    expect(first.some((e) => e.t === "seal")).toBe(false);
    expect(first.filter((e) => e.t === "design")).toHaveLength(1);

    // the resumed stage: list (use cases, all approved now), list (derived nodes), review
    const seq = join(root, "seq-resume.txt");
    writeFileSync(seq, [fx("10-list-derived.ndjson"), fx("10-list-derived.ndjson"), "-"].join("\n"));
    process.env.FAKE_KANE_SEQUENCE = seq;
    writeFileSync(process.env.FAKE_KANE_ARGV_LOG!, "");
    const approvals: string[][] = [];
    const io: HumanIO = { ...acceptAll, approve: async (items) => (approvals.push(items.map((i) => i.ref)), items.map((i) => i.ref)) };
    await runSpecStage(p, io, (e) => appendEvent(p.ledgerFile, e));
    const calls = readFileSync(process.env.FAKE_KANE_ARGV_LOG!, "utf8").trim().split("\n").map((l) => JSON.parse(l) as string[]);
    expect(calls.map((c) => c.slice(0, 2).join(" "))).toEqual(["context list", "context list", "context review"]);
    expect(approvals).toEqual([["ac-1", "sc-1", "t-1"]]); // the use case was approved before: not asked again
    const events = await readEvents(p.ledgerFile);
    expect(events.filter((e) => e.t === "design")).toHaveLength(1);
    expect(events.at(-1)!.t).toBe("seal");
    expect(Object.keys(reduce(events).acs).length).toBeGreaterThan(0);
  }, 60_000);

  /** A first attempt that gets through the design approval (rejecting t-1) and fails at the seal step. */
  async function failAtSeal(appDir: string) {
    const p = await loadProject(appDir);
    const vars = join(p.verifierDir, ".testmuai", "variables");
    mkdirSync(dirname(vars), { recursive: true });
    writeFileSync(vars, "a file where the variables folder goes"); // writing the start URL fails
    const io: HumanIO = { ...acceptAll, approve: async (items) => items.map((i) => i.ref).filter((r) => r !== "t-1") };
    await expect(runSpecStage(p, io, (e) => appendEvent(p.ledgerFile, e))).rejects.toThrow();
    rmSync(vars, { force: true });
    const first = await readEvents(p.ledgerFile);
    expect(first.some((e) => e.t === "seal")).toBe(false);
    expect(first.filter((e) => e.t === "design").at(-1)).toMatchObject({ useCase: "uc-1", rejected: ["t-1"] });
    // the resumed stage: list (use cases), list (derived nodes: Kane still lists the rejected t-1), review
    const seq = join(root, "seq-resume.txt");
    writeFileSync(seq, [fx("10-list-derived.ndjson"), fx("10-list-derived.ndjson"), "-"].join("\n"));
    process.env.FAKE_KANE_SEQUENCE = seq;
    return p;
  }

  it("a stage resumed after its design approval never offers a node the human rejected again, and keeps that rejection (N-m3)", async () => {
    const p = await failAtSeal(await setup("# PRD\n"));
    const approvals: string[][] = [];
    const io: HumanIO = { ...acceptAll, approve: async (items) => (approvals.push(items.map((i) => i.ref)), items.map((i) => i.ref)) };
    await runSpecStage(p, io, (e) => appendEvent(p.ledgerFile, e));
    expect(approvals).toEqual([["ac-1", "sc-1"]]);
    const events = await readEvents(p.ledgerFile);
    expect(events.at(-1)!.t).toBe("seal");
    expect(events.filter((e) => e.t === "design").at(-1)).toMatchObject({ rejected: ["t-1"] });
    expect(Object.values(reduce(events).acs).some((a) => a.tests.includes("t-1"))).toBe(false);
  }, 60_000);

  it("a stage resumed after its design approval seals even when the human turns down everything offered again: the earlier approval stands (N-m3)", async () => {
    const p = await failAtSeal(await setup("# PRD\n"));
    const io: HumanIO = { ...acceptAll, approve: async () => [] };
    await runSpecStage(p, io, (e) => appendEvent(p.ledgerFile, e));
    const events = await readEvents(p.ledgerFile);
    expect(events.at(-1)!.t).toBe("seal");
    // what they turned down now is added to what they turned down before
    expect(events.filter((e) => e.t === "design").at(-1)).toMatchObject({ rejected: ["t-1", "ac-1"] });
  }, 60_000);

  it("a design re-emitted by a resumed stage carries its own timestamp, not the earlier attempt's (N-m4)", async () => {
    const appDir = await setup("# PRD\n");
    const p = await loadProject(appDir);
    const closing: HumanIO = {
      ...acceptAll,
      approve: async (items) => {
        if (items[0]?.kind !== "usecase") throw new Error("the dashboard server closed");
        return items.map((i) => i.ref);
      },
    };
    await expect(runSpecStage(p, closing, (e) => appendEvent(p.ledgerFile, e))).rejects.toThrow(/dashboard server closed/);
    await new Promise((r) => setTimeout(r, 15));
    const seq = join(root, "seq-resume.txt");
    writeFileSync(seq, [fx("10-list-derived.ndjson"), fx("10-list-derived.ndjson"), "-"].join("\n"));
    process.env.FAKE_KANE_SEQUENCE = seq;
    const io: HumanIO = { ...acceptAll, approve: async (items) => items.map((i) => i.ref).filter((r) => r !== "t-1") };
    await runSpecStage(p, io, (e) => appendEvent(p.ledgerFile, e));
    const events = await readEvents(p.ledgerFile);
    const designs = events.filter((e) => e.t === "design");
    expect(designs).toHaveLength(2);
    expect(designs[1]).toMatchObject({ rejected: ["t-1"], credits: 0 });
    expect(designs[1]!.at).not.toBe(designs[0]!.at);
    const times = events.map((e) => Date.parse(e.at));
    expect(times).toEqual([...times].sort((a, b) => a - b));
  }, 60_000);

  it("re-ingests on a resume when the spec changed since the extraction", async () => {
    const appDir = await setup("# PRD\n");
    const p = await loadProject(appDir);
    const closing: HumanIO = { ...acceptAll, approve: async () => Promise.reject(new Error("closed")) };
    await expect(runSpecStage(p, closing, (e) => appendEvent(p.ledgerFile, e))).rejects.toThrow(/closed/);
    expect((await readEvents(p.ledgerFile)).find((e) => e.t === "spec.extracted")).toMatchObject({ hash: expect.stringMatching(/^[0-9a-f]{64}$/) });
    appendFileSync(join(appDir, "PRD.md"), "\nRule 2.\n");
    const seq = join(root, "seq-again.txt");
    writeFileSync(seq, [fx("01-ingest.ndjson"), fx("02-extract.ndjson")].join("\n"));
    process.env.FAKE_KANE_SEQUENCE = seq;
    writeFileSync(process.env.FAKE_KANE_ARGV_LOG!, "");
    await expect(runSpecStage(p, closing, (e) => appendEvent(p.ledgerFile, e))).rejects.toThrow();
    const calls = readFileSync(process.env.FAKE_KANE_ARGV_LOG!, "utf8").trim().split("\n").map((l) => JSON.parse(l) as string[]);
    expect(calls[0]!.slice(0, 2)).toEqual(["context", "ingest"]);
  }, 60_000);

  it("seals app config + spec, collapses whitespace, and counts credits", async () => {
    const appDir = await setup("# PRD\n");
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
  }, 60_000);

  it("a criterion left without a test because Kane's design hit kane.designMax says so: not the spec's fault, still not proved (rehearsal issue 7)", async () => {
    const appDir = await setup("# PRD\n\nSnap rules.\n");
    writeFileSync(join(appDir, "holdback.config.json"), JSON.stringify({ kane: { designMax: 3 } }));
    withUncovered("ac-2", "ac-3");
    const p = await loadProject(appDir);
    await runSpecStage(p, acceptAll, (e) => appendEvent(p.ledgerFile, e));
    const events = await readEvents(p.ledgerFile);
    const design = events.findLast((e) => e.t === "design") as Extract<LedgerEvent, { t: "design" }>;
    expect(design.tests).toHaveLength(3); // as many tests as the cap allows
    const bare = Object.values(reduce(events).acs).filter((a) => a.tests.length === 0);
    expect(bare.map((a) => a.id)).toEqual(["ac-2", "ac-3"]);
    for (const a of bare) expect(a).toMatchObject({ status: "needs-spec", reason: "no test designed (design cap 3)" });
    expect(Object.keys(design.notes ?? {}).sort()).toEqual(bare.map((a) => a.id).sort());
    expect(gate(reduce(events)).needsSpec.map((a) => a.id).sort()).toEqual(bare.map((a) => a.id).sort());
  }, 60_000);

  it("with room left under kane.designMax, a criterion without a test carries no design-cap reason", async () => {
    const appDir = await setup("# PRD\n\nSnap rules.\n");
    withUncovered("ac-2", "ac-3");
    const p = await loadProject(appDir); // designMax 5, and Kane designed 3 tests
    await runSpecStage(p, acceptAll, (e) => appendEvent(p.ledgerFile, e));
    const bare = Object.values(reduce(await readEvents(p.ledgerFile)).acs).filter((a) => a.tests.length === 0);
    expect(bare.map((a) => a.id)).toEqual(["ac-2", "ac-3"]);
    for (const a of bare) expect(a).toMatchObject({ status: "needs-spec" });
    for (const a of bare) expect(a.reason).toBeUndefined();
  }, 60_000);

  it("a spec edited after the extraction is never sealed: the stage stops before the seal and says to run it again (n-3)", async () => {
    const appDir = await setup("# PRD\n\nSnap rules.\n");
    const p = await loadProject(appDir);
    const io: HumanIO = {
      async answer(qs) {
        return Object.fromEntries(qs.map((q) => [q.id, "Show errors"]));
      },
      async approve(items) {
        // the design approval takes minutes: an edit lands while the human reads it
        if (items.some((i) => i.ref === "t-1")) appendFileSync(join(appDir, "PRD.md"), "\nA late rule.\n");
        return items.map((i) => i.ref);
      },
      values: async () => ({}),
    };
    const err = await runSpecStage(p, io, (e) => appendEvent(p.ledgerFile, e)).then(() => null, (e: unknown) => e as Error);
    expect(err?.message).toContain("the spec changed during the spec stage — run `holdback spec` again");
    expect(err?.name).toBe("SpecChangedDuringStage");
    expect((await readEvents(p.ledgerFile)).some((e) => e.t === "seal")).toBe(false);
  }, 60_000);

  it("a spec edited while the human approves the use cases stops the stage before Kane is called again: the edit is never absorbed (n-3)", async () => {
    const appDir = await setup("# PRD\n\nSnap rules.\n");
    const p = await loadProject(appDir);
    const io: HumanIO = {
      async answer(qs) {
        return Object.fromEntries(qs.map((q) => [q.id, "Show errors"]));
      },
      async approve(items) {
        if (items.some((i) => i.kind === "usecase")) appendFileSync(join(appDir, "PRD.md"), "\nA rule added during the approval.\n");
        return items.map((i) => i.ref);
      },
      values: async () => ({}),
    };
    const err = await runSpecStage(p, io, (e) => appendEvent(p.ledgerFile, e)).then(() => null, (e: unknown) => e as Error);
    expect(err?.name).toBe("SpecChangedDuringStage");
    // ingest, resume, list(uc): nothing after the approval reached Kane (no review, no design)
    const argv = readFileSync(join(root, "argv.log"), "utf8").trim().split("\n");
    expect(argv).toHaveLength(3);
    const events = await readEvents(p.ledgerFile);
    expect(events.some((e) => e.t === "design" || e.t === "seal")).toBe(false);
  }, 60_000);

  it("a spec edited while the human answers Kane's question stops the stage before the answer goes to Kane (n-3)", async () => {
    const appDir = await setup("# PRD\n\nSnap rules.\n");
    const p = await loadProject(appDir);
    const io: HumanIO = {
      async answer(qs) {
        appendFileSync(join(appDir, "PRD.md"), "\nAn edit made while answering.\n");
        return Object.fromEntries(qs.map((q) => [q.id, "Show errors"]));
      },
      async approve(items) {
        return items.map((i) => i.ref);
      },
      values: async () => ({}),
    };
    const err = await runSpecStage(p, io, (e) => appendEvent(p.ledgerFile, e)).then(() => null, (e: unknown) => e as Error);
    expect(err?.name).toBe("SpecChangedDuringStage");
    // only the ingest ran: the answer never reached Kane, nor went into PRD.md under the edit
    expect(readFileSync(join(root, "argv.log"), "utf8").trim().split("\n")).toHaveLength(1);
    expect(readFileSync(join(appDir, "PRD.md"), "utf8")).not.toContain("Clarifications");
    expect((await readEvents(p.ledgerFile)).some((e) => e.t === "spec.extracted")).toBe(false);
  }, 60_000);

  /** The test Kane designed for t-1 (it verifies uc-1's ac-1), and the variables it declared, written into the verifier before the stage. */
  function kaneWrote(p: Awaited<ReturnType<typeof loadProject>>, body: string, vars: Record<string, { value: string; secret: boolean; description: string }>) {
    const tests = join(p.verifierDir, ".testmuai", "tests");
    mkdirSync(tests, { recursive: true });
    mkdirSync(join(p.verifierDir, ".testmuai", "variables"), { recursive: true });
    writeFileSync(join(tests, "t-1_test.md"), `---\nassurance:\n  id: t-1\n---\n# Snap test\n\n${body}\n\n## Step 1 @verifies ac-1\n\nAt {{start_url}}, book with {{primary_phone}} for {{proxy_name}}.\n`);
    writeFileSync(join(p.verifierDir, ".testmuai", "variables", "assurance.json"), JSON.stringify(vars, null, 2));
    return () => JSON.parse(readFileSync(join(p.verifierDir, ".testmuai", "variables", "assurance.json"), "utf8")) as Record<string, { value: string }>;
  }
  const empty = (description: string) => ({ value: "", secret: false, description });

  it("the variables gate: every empty variable an approved test types is asked with a suggestion, filled, and only then sealed", async () => {
    const appDir = await setup("# PRD\n\nSnap rules.\n");
    const p = await loadProject(appDir);
    const vars = kaneWrote(p, "", { primary_phone: empty("Unused ten-digit household test phone."), proxy_name: empty("Test proxy's name."), spare_phone: empty("Unused phone.") });
    let asked: VariableAsk[] = [];
    const io: HumanIO = { ...acceptAll, values: async (asks) => ((asked = asks), { primary_phone: asks[0]!.suggested!, proxy_name: "Ana Ruiz" }) };
    await runSpecStage(p, io, (e) => appendEvent(p.ledgerFile, e));
    expect(asked).toEqual([
      { name: "primary_phone", description: "Unused ten-digit household test phone.", secret: false, suggested: "2155550101", usedBy: ["t-1"] },
      { name: "proxy_name", description: "Test proxy's name.", secret: false, suggested: "Maria Lopez", usedBy: ["t-1"] },
    ]);
    expect(vars()).toMatchObject({ start_url: { value: `http://127.0.0.1:${p.config.start.port}/` }, primary_phone: { value: "2155550101" }, proxy_name: { value: "Ana Ruiz" }, spare_phone: { value: "" } });
    const events = await readEvents(p.ledgerFile);
    expect(events.map((e) => e.t).slice(-3)).toEqual(["spec.approved", "spec.variables", "seal"]);
    expect(events.at(-2)).toMatchObject({ t: "spec.variables", names: ["primary_phone", "proxy_name"], filledBy: "human" });
    // the seal holds the values: a later edit of the variables file is a tamper
    const manifest = (events.at(-1) as Extract<LedgerEvent, { t: "seal" }>).manifest;
    expect(await checkSeal(p.verifierDir, manifest, p.appDir)).toEqual([]);
  }, 60_000);

  it("a variable the human leaves empty stops the stage before the seal (exit 3 in the CLI), and the resumed stage asks only for it", async () => {
    const appDir = await setup("# PRD\n\nSnap rules.\n");
    const p = await loadProject(appDir);
    const vars = kaneWrote(p, "", { primary_phone: empty("Unused ten-digit phone."), proxy_name: empty("Test proxy's name.") });
    const io: HumanIO = { ...acceptAll, values: async () => ({ primary_phone: "2155550101", proxy_name: "" }) };
    const err = await runSpecStage(p, io, (e) => appendEvent(p.ledgerFile, e)).then(() => null, (e: unknown) => e as Error);
    expect(err?.name).toBe("VariablesMissing");
    expect(err?.message).toContain("proxy_name");
    expect((await readEvents(p.ledgerFile)).some((e) => e.t === "seal")).toBe(false);
    expect(vars().primary_phone!.value).toBe("2155550101");

    // the resumed stage: list (use cases), list (derived nodes), review; then the gate asks for what is still empty
    const seq = join(root, "seq-resume.txt");
    writeFileSync(seq, [fx("10-list-derived.ndjson"), fx("10-list-derived.ndjson"), "-"].join("\n"));
    process.env.FAKE_KANE_SEQUENCE = seq;
    let asked: string[] = [];
    await runSpecStage(p, { ...acceptAll, values: async (asks) => ((asked = asks.map((a) => a.name)), { proxy_name: "Ana Ruiz" }) }, (e) => appendEvent(p.ledgerFile, e));
    expect(asked).toEqual(["proxy_name"]);
    expect(vars().proxy_name!.value).toBe("Ana Ruiz");
    expect((await readEvents(p.ledgerFile)).at(-1)!.t).toBe("seal");
  }, 60_000);

  it("a variable only a turned-down test types is never asked for", async () => {
    const appDir = await setup("# PRD\n\nSnap rules.\n");
    const p = await loadProject(appDir);
    kaneWrote(p, "", { primary_phone: empty("Unused ten-digit phone."), proxy_name: empty("Test proxy's name.") });
    const io: HumanIO = { ...acceptAll, approve: async (items) => items.map((i) => i.ref).filter((r) => r !== "t-1"), values: async () => Promise.reject(new Error("must not ask")) };
    await runSpecStage(p, io, (e) => appendEvent(p.ledgerFile, e));
    const events = await readEvents(p.ledgerFile);
    expect(events.at(-1)!.t).toBe("seal");
    expect(events.some((e) => e.t === "spec.variables")).toBe(false);
  }, 60_000);

  it("an @import Kane wrote with an absolute path is repaired before the test approval, logged, and shown on the test", async () => {
    const appDir = await setup("# PRD\n\nSnap rules.\n");
    const p = await loadProject(appDir);
    kaneWrote(p, "@import ./C:\\Users\\dev\\.holdback\\x\\verifier\\.testmuai\\tests\\base_test.md", { primary_phone: empty("Unused ten-digit phone."), proxy_name: empty("Test proxy's name.") });
    writeFileSync(join(p.verifierDir, ".testmuai", "tests", "base_test.md"), "# Base\n\n## Step 1\n\nOpen {{start_url}}.\n");
    let offered: ApprovalItem[] = [];
    const io: HumanIO = { ...acceptAll, approve: async (items) => (items.some((i) => i.kind === "test") && (offered = items), items.map((i) => i.ref)) };
    await runSpecStage(p, io, (e) => appendEvent(p.ledgerFile, e));
    expect(readFileSync(join(p.verifierDir, ".testmuai", "tests", "t-1_test.md"), "utf8")).toContain("\n@import ./base_test.md\n");
    const events = await readEvents(p.ledgerFile);
    const repaired = events.filter((e) => e.t === "spec.repaired");
    expect(repaired).toEqual([
      { at: expect.any(String), t: "spec.repaired", file: ".testmuai/tests/t-1_test.md", line: 7, from: "@import ./C:\\Users\\dev\\.holdback\\x\\verifier\\.testmuai\\tests\\base_test.md", to: "@import ./base_test.md" },
    ]);
    // logged before the human approves the tests, and shown on the test it repaired
    expect(events.findIndex((e) => e.t === "spec.repaired")).toBeLessThan(events.findLastIndex((e) => e.t === "spec.approved"));
    expect(offered.find((i) => i.ref === "t-1")?.note).toMatch(/^Holdback repaired a broken import Kane wrote \(line 7\): @import \.\/C:.*base_test\.md -> @import \.\/base_test\.md$/);
    expect(events.at(-1)!.t).toBe("seal");
  }, 60_000);

  it("an @import that resolves to nothing is flagged on the test at its approval", async () => {
    const appDir = await setup("# PRD\n\nSnap rules.\n");
    const p = await loadProject(appDir);
    kaneWrote(p, "@import ./C:\\nowhere\\gone_test.md", { primary_phone: empty("Unused ten-digit phone."), proxy_name: empty("Test proxy's name.") });
    let offered: ApprovalItem[] = [];
    const io: HumanIO = { ...acceptAll, approve: async (items) => (items.some((i) => i.kind === "test") && (offered = items), items.map((i) => i.ref)) };
    await runSpecStage(p, io, (e) => appendEvent(p.ledgerFile, e));
    expect(offered.find((i) => i.ref === "t-1")?.note).toBe("broken import Kane wrote (line 7): ./C:\\nowhere\\gone_test.md is not in the tests folder, so `testmd run` stops on it");
    expect((await readEvents(p.ledgerFile)).some((e) => e.t === "spec.repaired")).toBe(false);
  }, 60_000);

  it("a design carries the gaps of its own use case, with Kane's kind and question", async () => {
    const appDir = await setup("# PRD\n\nSnap rules.\n");
    const p = await loadProject(appDir);
    mkdirSync(join(p.verifierDir, ".context"), { recursive: true });
    cpSync(fx("context-commits"), join(p.verifierDir, ".context", "commits"), { recursive: true });
    await runSpecStage(p, acceptAll, (e) => appendEvent(p.ledgerFile, e));
    const design = (await readEvents(p.ledgerFile)).find((e) => e.t === "design") as Extract<LedgerEvent, { t: "design" }>;
    expect(design.gaps.map((g) => [g.id, g.kind, g.question?.header])).toEqual([
      ["gap-1", "incomplete", "Missing inputs"],
      ["gap-2", "budget-evicted", "Eight-person equality"],
      ["gap-3", "budget-evicted", "Below-limit household"],
      ["gap-4", "incomplete", "Pantry page URL"],
    ]);
  }, 60_000);

  it("an approved test Kane's graph names but whose file Holdback cannot find fails closed: its variables are unchecked, nothing is sealed (fix round 1)", async () => {
    const appDir = await setup("# PRD\n\nSnap rules.\n");
    const p = await loadProject(appDir);
    rmSync(testFileOf(p, "t-3"));
    const err = await runSpecStage(p, acceptAll, (e) => appendEvent(p.ledgerFile, e)).then(() => null, (e: unknown) => e as Error);
    expect(err?.name).toBe("VariablesUnchecked");
    expect(err?.message).toContain("t-3");
    expect((await readEvents(p.ledgerFile)).some((e) => e.t === "seal")).toBe(false);
  }, 60_000);
});
