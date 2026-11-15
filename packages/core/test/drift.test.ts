import { execFileSync } from "node:child_process";
import { createHash } from "node:crypto";
import { existsSync, mkdirSync, mkdtempSync, readFileSync, renameSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import type { AcNode, Graph, ListedNode, ReconcileResult, ReconcileRow } from "../src/kane/assurance.js";
import { reduce } from "../src/ledger/reduce.js";
import { appendEvent, readEvents } from "../src/ledger/store.js";
import type { LedgerEvent } from "../src/ledger/types.js";
import { runDrift, watchSpec, type DriftKane } from "../src/loop/drift.js";
import type { ApprovalItem, HumanIO } from "../src/loop/human.js";
import { reseal } from "../src/loop/spec.js";
import { loadProject, type Project } from "../src/project.js";
import { checkSeal } from "../src/seal.js";
import { markTampered, tamperMarker } from "../src/tamper.js";

const at = "2026-11-15T00:00:00.000Z";
const T1 = ".testmuai/tests/t-1.test.md";
const T2 = ".testmuai/tests/t-2.test.md";
const T3 = ".testmuai/tests/t-3.test.md";
const OLD_PRD = "# PRD\n\nRule 1.\n";
const saved = { ...process.env };
let root: string;
let p: Project;
const log = (e: LedgerEvent) => appendEvent(p.ledgerFile, e);
const ac = (id: string, text: string) => ({ id, text, useCase: "uc-1", cites: [] }) as unknown as AcNode;

beforeEach(async () => {
  root = mkdtempSync(join(tmpdir(), "holdback-drift-"));
  process.env.HOLDBACK_HOME = join(root, "home");
  const appDir = join(root, "app");
  mkdirSync(appDir, { recursive: true });
  writeFileSync(join(appDir, "PRD.md"), OLD_PRD);
  p = await loadProject(appDir);
  mkdirSync(join(p.verifierDir, ".testmuai", "tests"), { recursive: true });
  writeFileSync(join(p.verifierDir, T1), "t-1 body");
  writeFileSync(join(p.verifierDir, "PRD.md"), OLD_PRD); // the verifier's spec copy from the spec stage
  await log({ at, t: "spec.ingested", sources: [{ id: "prd", cid: "sha256:abc", status: "created", file: "PRD.md" }] });
  await log({ at, t: "design", useCase: "uc-1", acs: [ac("ac-1", "rule 1")], tests: [{ id: "t-1", title: "t", file: T1, verifies: ["ac-1"] }], gaps: [], credits: 1 });
  await reseal(p, log);
});
afterEach(() => {
  if (saved.HOLDBACK_HOME === undefined) delete process.env.HOLDBACK_HOME;
  else process.env.HOLDBACK_HOME = saved.HOLDBACK_HOME;
});

const editPrd = () => writeFileSync(join(p.appDir, "PRD.md"), "# PRD\n\nRule 1.\nRule 2.\n");

type Calls = string[];
type FakeOpts = { rows?: ReconcileRow[]; nodes?: ListedNode[]; extraFiles?: boolean };
const MODIFY: ReconcileRow = { kind: "MODIFY", ref: "uc-1", why: "rule 2 added" };

function fakeKane(calls: Calls, o: FakeOpts = {}): DriftKane {
  const graph: Graph = {
    useCases: [],
    acs: [ac("ac-1", "rule 1"), ac("ac-2", "rule 2"), ac("ac-3", "rule 3")],
    tests: [
      { id: "t-1", title: "one", file: T1, verifies: ["ac-1"] },
      { id: "t-2", title: "two", file: T2, verifies: ["ac-2"] },
      { id: "t-3", title: "three", file: T3, verifies: ["ac-3"] },
    ],
    gaps: [],
  };
  return {
    reconcile: async (_cwd, file, sourceId, mode): Promise<ReconcileResult> => {
      calls.push(`reconcile:${mode}:${file}:${sourceId}`);
      return { status: "complete", rows: o.rows ?? [MODIFY], summary: {}, credits: mode === "plan" ? 5 : 3 };
    },
    designTests: async (cwd, uc, opt) => {
      calls.push(`design:${uc}:${opt.force ? "force" : "plain"}`);
      writeFileSync(join(cwd, T2), "t-2 body");
      if (o.extraFiles) writeFileSync(join(cwd, T3), "t-3 body");
      return { status: "complete", tests: ["t-2"], acs: ["ac-2"], gaps: [], variables: [], credits: 2, next: [] };
    },
    listNodes: async () =>
      o.nodes ?? [
        { id: "ac-2", label: "ac", title: "rule 2", trust: "derived" },
        { id: "t-2", label: "test", title: "two", trust: "derived" },
      ],
    readGraph: async () => graph,
    review: async (_cwd, refs) => void calls.push(`review:${refs.join(",")}`),
    resumeSession: async () => {
      throw new Error("no pause expected");
    },
    extractResume: async () => {
      throw new Error("no pause expected");
    },
  };
}

function human(calls: Calls, pick: (items: ApprovalItem[]) => string[]): HumanIO {
  return {
    answer: async () => ({}),
    approve: async (items) => {
      calls.push(`approve:${items.map((i) => i.ref).join(",")}`);
      return pick(items);
    },
  };
}
const all = (i: ApprovalItem[]) => i.map((x) => x.ref);
const sealed = async () => (await readEvents(p.ledgerFile)).filter((e) => e.t === "seal").at(-1) as Extract<LedgerEvent, { t: "seal" }>;
/** Verifier side only: nothing the seal covers moved. */
const verifierClean = async () => expect(await checkSeal(p.verifierDir, (await sealed()).manifest)).toEqual([]);
const verifierPrd = () => readFileSync(join(p.verifierDir, "PRD.md"), "utf8");

// git spawns and fake Kane calls: slow on Windows under a parallel suite
describe("runDrift", { timeout: 60_000 }, () => {
  it("unchanged spec: no Kane call, no event", async () => {
    const calls: Calls = [];
    const before = (await readEvents(p.ledgerFile)).length;
    const r = await runDrift(p, human(calls, all), log, { kane: fakeKane(calls) });
    expect(r).toEqual({ changed: false });
    expect(calls).toEqual([]);
    expect((await readEvents(p.ledgerFile)).length).toBe(before);
  });

  it("changed spec: plan, approve, apply, design, approve, re-seal, new ACs owed", async () => {
    editPrd();
    const calls: Calls = [];
    const r = await runDrift(p, human(calls, all), log, { kane: fakeKane(calls) });
    expect(r).toEqual({ changed: true, applied: true });
    // the source id is the one Kane reported at ingest and the ledger recorded
    expect(calls).toEqual([
      "reconcile:plan:PRD.md:prd",
      "approve:uc-1",
      "reconcile:apply:PRD.md:prd",
      "review:uc-1",
      "design:uc-1:force",
      "approve:ac-2,t-2",
      "review:ac-2,t-2",
    ]);
    expect(verifierPrd()).toContain("Rule 2.");
    const events = await readEvents(p.ledgerFile);
    const drifts = events.filter((e) => e.t === "drift");
    expect(drifts).toMatchObject([{ applied: false, credits: 5, rows: [{ kind: "MODIFY", ref: "uc-1" }] }, { applied: true, credits: 3 }]);
    expect(events.at(-1)?.t).toBe("seal");
    const state = reduce(events);
    expect(state.acs["ac-2"]).toMatchObject({ status: "owed", tests: ["t-2"] });
    expect(state.tampered).toBe(false);
    const manifest = (await sealed()).manifest;
    expect(manifest[T2]).toBeDefined();
    expect(await checkSeal(p.verifierDir, manifest, p.appDir)).toEqual([]);
    const again: Calls = [];
    expect(await runDrift(p, human(again, all), log, { kane: fakeKane(again) })).toEqual({ changed: false });
    expect(again).toEqual([]);
  });

  it("reads the Kane source id from the ledger, never from the file name", async () => {
    await log({ at, t: "spec.ingested", sources: [{ id: "product-req", cid: "sha256:x", status: "created", file: "PRD.md" }] });
    await reseal(p, log);
    editPrd();
    const calls: Calls = [];
    await runDrift(p, human(calls, all), log, { kane: fakeKane(calls) });
    expect(calls[0]).toBe("reconcile:plan:PRD.md:product-req");
  });

  it("no source id on record: clear error, no reconcile call", async () => {
    writeFileSync(p.ledgerFile, "");
    await log({ at, t: "design", useCase: "uc-1", acs: [ac("ac-1", "rule 1")], tests: [{ id: "t-1", title: "t", file: T1, verifies: ["ac-1"] }], gaps: [], credits: 1 });
    await log({ at, t: "spec.ingested", sources: [{ id: "x", cid: "", status: "created" }] }); // no file mapping
    await reseal(p, log);
    editPrd();
    const calls: Calls = [];
    await expect(runDrift(p, human(calls, all), log, { kane: fakeKane(calls) })).rejects.toThrow(/no Kane source id/);
    expect(calls).toEqual([]);
    expect(verifierPrd()).toBe(OLD_PRD);
  });

  it("logs Kane's balance drop for the whole drift run before the re-seal, applied or declined (R34)", async () => {
    editPrd();
    const calls: Calls = [];
    const balances = [300, 288];
    await runDrift(p, human(calls, all), log, { kane: fakeKane(calls), balance: async () => balances.shift()! });
    let events = await readEvents(p.ledgerFile);
    const tail = events.slice(-3).map((e) => e.t);
    expect(tail).toEqual(["design", "credits", "seal"]);
    // plan 5 + apply 3 + design 2 by Kane's own figures; the balance says 12
    expect(events.find((e) => e.t === "credits")).toMatchObject({ source: "drift", delta: 12, perRunSum: 10 });

    // a declined plan still cost the plan
    writeFileSync(join(p.appDir, "PRD.md"), "# PRD\n\nRule 1.\nRule 2.\nRule 3.\n");
    const before = events.length;
    const more = [288, 283];
    const r = await runDrift(p, human([], () => []), log, { kane: fakeKane([]), balance: async () => more.shift()! });
    expect(r).toMatchObject({ changed: true, applied: false });
    events = (await readEvents(p.ledgerFile)).slice(before);
    expect(events.map((e) => e.t)).toEqual(["drift", "credits"]);
    expect(events[1]).toMatchObject({ source: "drift", delta: 5, perRunSum: 5 });
  });

  it("commits the human's spec edit on its own before the re-seal, so no agent turn carries it (M8)", async () => {
    const git = (...args: string[]) => execFileSync("git", args, { cwd: p.appDir, encoding: "utf8" }).trim();
    git("init", "-q");
    git("config", "user.name", "Test");
    git("config", "user.email", "test@example.com");
    git("add", "-A");
    git("commit", "-q", "-m", "spec");
    await reseal(p, log);
    writeFileSync(join(p.appDir, "app.js"), "// the agent's work in progress\n");
    editPrd();
    const r = await runDrift(p, { answer: async () => ({}), approve: async (items) => all(items) }, log, { kane: fakeKane([]) });
    expect(r).toEqual({ changed: true, applied: true });
    expect(git("log", "--format=%s")).toBe("spec: PRD.md\nspec");
    expect(git("show", "--name-only", "--format=", "HEAD")).toBe("PRD.md");
    expect(git("status", "--porcelain")).toBe("?? app.js"); // nothing else of the work tree went in
  }, 60_000);

  it("never implies the human wrote a change first seen right after an agent turn: its commit says origin unverified (R37)", async () => {
    const git = (...args: string[]) => execFileSync("git", args, { cwd: p.appDir, encoding: "utf8" }).trim();
    git("init", "-q");
    git("config", "user.name", "Test");
    git("config", "user.email", "test@example.com");
    git("add", "-A");
    git("commit", "-q", "-m", "spec");
    await reseal(p, log);
    editPrd();
    await log({ at: new Date().toISOString(), t: "spec.changed", files: ["PRD.md"], duringAgentTurn: true, before: {}, after: {} });
    const r = await runDrift(p, { answer: async () => ({}), approve: async (items) => all(items) }, log, { kane: fakeKane([]) });
    expect(r).toEqual({ changed: true, applied: true });
    expect(git("log", "-1", "--format=%s")).toBe("spec: PRD.md (origin unverified)");
  }, 60_000);

  it("commits the Clarifications it added to PRD.md before the re-seal; a declined drift commits nothing", async () => {
    const git = (...args: string[]) => execFileSync("git", args, { cwd: p.appDir, encoding: "utf8" }).trim();
    git("init", "-q");
    git("config", "user.name", "Test");
    git("config", "user.email", "test@example.com");
    git("add", "-A");
    git("commit", "-q", "-m", "spec");
    await reseal(p, log); // anchors the repo's git config
    const pausing = (calls: Calls): DriftKane => {
      const base = fakeKane(calls);
      let asked = false;
      return {
        ...base,
        reconcile: async (cwd, file, sourceId, mode) => {
          if (mode === "plan" && !asked) {
            asked = true;
            return {
              status: "paused",
              verb: "reconcile",
              sid: "s9",
              resume: "kane-cli maintain reconcile --resume s9 --mode agent",
              questions: [{ id: "q1", text: "Does rule 2 replace rule 1?", risk: "low", rationale: "", options: [{ label: "No" }], recommendedIndex: 0, allowFreeText: false }],
              credits: 1,
            };
          }
          return base.reconcile(cwd, file, sourceId, mode);
        },
        resumeSession: async () => ({ status: "complete", rows: [MODIFY], summary: {}, credits: 4 }),
      };
    };
    const answering = (pick: (i: ApprovalItem[]) => string[]): HumanIO => ({ answer: async () => ({ q1: "No" }), approve: async (items) => pick(items) });

    editPrd();
    const declined = await runDrift(p, answering(() => []), log, { kane: pausing([]) });
    expect(declined).toMatchObject({ changed: true, applied: false });
    expect(git("log", "--format=%s")).toBe("spec");

    const r = await runDrift(p, answering(all), log, { kane: pausing([]) });
    expect(r).toEqual({ changed: true, applied: true });
    expect(git("log", "--format=%s")).toBe("spec: PRD.md\nspec");
    expect(git("show", "--name-only", "--format=", "HEAD")).toBe("PRD.md");
    const committed = git("show", "HEAD:PRD.md");
    expect(committed).toContain("Rule 2."); // the human's spec edit goes in with them
    expect(committed).toContain("- Q: Does rule 2 replace rule 1? — A: No");
    expect(git("status", "--porcelain", "--", "PRD.md")).toBe("");
  }, 60_000); // a dozen git spawns: slow on Windows under a parallel suite

  it('loop.appendClarifications "spec-only": a drift answer stays on the ledger and PRD.md is left as the human wrote it', async () => {
    p.config.loop.appendClarifications = 'spec-only';
    const base = fakeKane([]);
    let asked = false;
    const kane: DriftKane = {
      ...base,
      reconcile: async (cwd, file, sourceId, mode) => {
        if (mode === 'plan' && !asked) {
          asked = true;
          return {
            status: 'paused',
            verb: 'reconcile',
            sid: 's9',
            resume: 'kane-cli maintain reconcile --resume s9 --mode agent',
            questions: [{ id: 'q1', text: 'Does rule 2 replace rule 1?', risk: 'low', rationale: '', options: [{ label: 'No' }], recommendedIndex: 0, allowFreeText: false }],
            credits: 1,
          };
        }
        return base.reconcile(cwd, file, sourceId, mode);
      },
      resumeSession: async () => ({ status: 'complete', rows: [MODIFY], summary: {}, credits: 4 }),
    };
    editPrd();
    const io: HumanIO = { answer: async () => ({ q1: 'No' }), approve: async (items) => all(items) };
    const r = await runDrift(p, io, log, { kane });
    expect(r).toEqual({ changed: true, applied: true });
    const prd = readFileSync(join(p.appDir, 'PRD.md'), 'utf8');
    expect(prd).not.toContain('Clarifications');
    expect(prd).not.toContain('Does rule 2 replace rule 1?');
    const answered = (await readEvents(p.ledgerFile)).find((e) => e.t === 'spec.answered');
    expect(answered).toMatchObject({ answers: { q1: 'No' } });
  });

  it("plan not approved: nothing applied or sealed, verifier restored, app edit kept", async () => {
    editPrd();
    const calls: Calls = [];
    const r = await runDrift(p, human(calls, () => []), log, { kane: fakeKane(calls) });
    expect(r).toMatchObject({ changed: true, applied: false, reason: expect.stringContaining("not approved") });
    expect(calls).toEqual(["reconcile:plan:PRD.md:prd", "approve:uc-1"]);
    const events = await readEvents(p.ledgerFile);
    expect(events.filter((e) => e.t === "seal")).toHaveLength(1);
    expect(events.at(-1)).toMatchObject({ t: "drift", applied: false });
    expect(verifierPrd()).toBe(OLD_PRD);
    expect(readFileSync(join(p.appDir, "PRD.md"), "utf8")).toContain("Rule 2.");
    await verifierClean();
  });

  it("empty plan: declined, no reseal", async () => {
    editPrd();
    const calls: Calls = [];
    const r = await runDrift(p, human(calls, all), log, { kane: fakeKane(calls, { rows: [] }) });
    expect(r).toMatchObject({ changed: true, applied: false });
    expect(calls).toEqual(["reconcile:plan:PRD.md:prd"]);
    expect((await readEvents(p.ledgerFile)).filter((e) => e.t === "seal")).toHaveLength(1);
    expect(verifierPrd()).toBe(OLD_PRD);
  });

  it("ARCHIVE/REMOVE-only plan: needs interactive Kane, never applied or sealed", async () => {
    editPrd();
    const calls: Calls = [];
    const rows: ReconcileRow[] = [
      { kind: "ARCHIVE", ref: "uc-2", why: "dropped" },
      { kind: "REMOVE", ref: "uc-3", why: "gone" },
    ];
    const r = await runDrift(p, human(calls, all), log, { kane: fakeKane(calls, { rows }) });
    expect(r).toMatchObject({ changed: true, applied: false, needsInteractive: true, reason: expect.stringContaining(p.verifierDir) });
    expect(r).toMatchObject({ reason: expect.stringContaining("kane-cli maintain reconcile") });
    expect(calls).toEqual(["reconcile:plan:PRD.md:prd"]);
    expect((await readEvents(p.ledgerFile)).filter((e) => e.t === "seal")).toHaveLength(1);
    expect(verifierPrd()).toBe(OLD_PRD);
  });

  it("only use-case refs are designed; other refs are shown and skipped", async () => {
    editPrd();
    const calls: Calls = [];
    const rows: ReconcileRow[] = [MODIFY, { kind: "ADD", ref: "rule-9", why: "stray" }];
    await runDrift(p, human(calls, all), log, { kane: fakeKane(calls, { rows }) });
    expect(calls[1]).toBe("approve:uc-1,rule-9");
    expect(calls.filter((c) => c.startsWith("design:"))).toEqual(["design:uc-1:force"]);
  });

  it("rolls back when a test file nobody approved appears", async () => {
    editPrd();
    const calls: Calls = [];
    const r = await runDrift(p, human(calls, (i) => i.filter((x) => x.kind !== "test").map((x) => x.ref)), log, { kane: fakeKane(calls) });
    expect(r).toMatchObject({ changed: true, applied: false });
    expect(existsSync(join(p.verifierDir, T2))).toBe(false);
    expect(readFileSync(join(p.verifierDir, T1), "utf8")).toBe("t-1 body");
    const events = await readEvents(p.ledgerFile);
    expect(events.filter((e) => e.t === "seal")).toHaveLength(1);
    expect(events.at(-1)).toMatchObject({ t: "redesign.dropped", useCases: ["uc-1"], detail: expect.stringContaining(T2) });
    expect(calls.some((c) => c.startsWith("review:ac-2"))).toBe(false);
    expect(reduce(events).acs["ac-2"]).toBeUndefined();
    expect(verifierPrd()).toBe(OLD_PRD);
    await verifierClean();
  });

  it("rolls back when nothing was approved", async () => {
    editPrd();
    const calls: Calls = [];
    const io = human(calls, (i) => (i[0]?.kind === "drift" ? all(i) : []));
    await runDrift(p, io, log, { kane: fakeKane(calls) });
    expect(existsSync(join(p.verifierDir, T2))).toBe(false);
    expect((await readEvents(p.ledgerFile)).at(-1)).toMatchObject({ t: "redesign.dropped", credits: 5 });
    expect(verifierPrd()).toBe(OLD_PRD);
    await verifierClean();
  });

  it("rolls back and restores the verifier when Kane throws", async () => {
    editPrd();
    const calls: Calls = [];
    const kane = fakeKane(calls);
    kane.designTests = async (cwd) => {
      writeFileSync(join(cwd, T2), "half written");
      throw new Error("kane crashed");
    };
    const r = await runDrift(p, human(calls, all), log, { kane });
    expect(r).toMatchObject({ changed: true, applied: false, reason: expect.stringContaining("kane crashed") });
    expect(existsSync(join(p.verifierDir, T2))).toBe(false);
    expect(verifierPrd()).toBe(OLD_PRD);
    await verifierClean();
  });

  it("partial approval of derived refs: only the approved test may change", async () => {
    editPrd();
    const calls: Calls = [];
    const nodes: ListedNode[] = [
      { id: "ac-2", label: "ac", title: "rule 2", trust: "derived" },
      { id: "t-2", label: "test", title: "two", trust: "derived" },
      { id: "ac-3", label: "ac", title: "rule 3", trust: "derived" },
      { id: "t-3", label: "test", title: "three", trust: "derived" },
    ];
    const subset = (i: ApprovalItem[]) => i.filter((x) => x.ref !== "ac-3" && x.ref !== "t-3").map((x) => x.ref);
    // Kane writes t-3 too, but the human only approved ac-2/t-2: rolled back
    const bad = await runDrift(p, human(calls, subset), log, { kane: fakeKane(calls, { nodes, extraFiles: true }) });
    expect(bad).toMatchObject({ applied: false, reason: expect.stringContaining(T3) });
    expect(existsSync(join(p.verifierDir, T3))).toBe(false);
    expect(existsSync(join(p.verifierDir, T2))).toBe(false);
    // the same subset with only the approved file written goes through; the rejected AC is not designed in
    const ok = await runDrift(p, human(calls, subset), log, { kane: fakeKane(calls, { nodes }) });
    expect(ok).toEqual({ changed: true, applied: true });
    expect(Object.keys(reduce(await readEvents(p.ledgerFile)).acs).sort()).toEqual(["ac-1", "ac-2"]);
    expect(existsSync(join(p.verifierDir, T3))).toBe(false);
  });

  describe("seals the spec the human reviewed (N-I2)", () => {
    const sha = (s: string | Buffer) => createHash("sha256").update(s).digest("hex");
    const prd = () => readFileSync(join(p.appDir, "PRD.md"));
    const reviewedNow = () => ({ "PRD.md": sha(prd()) });
    const lastSealIndex = async () => (await readEvents(p.ledgerFile)).findLastIndex((e) => e.t === "seal");

    it("a spec that moved after the review stops drift before any Kane call, as an unverified change, nothing sealed", async () => {
      editPrd();
      const reviewed = reviewedNow();
      writeFileSync(join(p.appDir, "PRD.md"), "# PRD\n\nRule 1.\nRule 2.\nA line nobody reviewed.\n");
      const sealAt = await lastSealIndex();
      const calls: Calls = [];
      const r = await runDrift(p, human(calls, all), log, { kane: fakeKane(calls), reviewed });
      expect(r).toMatchObject({ changed: true, applied: false, specMoved: ["PRD.md"], reason: expect.stringMatching(/after you reviewed it/) });
      expect(calls).toEqual([]);
      const events = await readEvents(p.ledgerFile);
      expect(events.findLastIndex((e) => e.t === "seal")).toBe(sealAt);
      expect(events.at(-1)).toMatchObject({ t: "spec.changed", files: ["PRD.md"], duringAgentTurn: true, after: { "PRD.md": sha(prd()) } });
      expect(verifierPrd()).toBe(OLD_PRD);
    });

    it("a spec edited while Kane re-plans it rolls the re-plan back, keeps the newer edit, and is recorded as unverified", async () => {
      editPrd();
      const reviewed = reviewedNow();
      const sealAt = await lastSealIndex();
      const calls: Calls = [];
      const kane = fakeKane(calls);
      const design = kane.designTests;
      kane.designTests = async (...a) => {
        writeFileSync(join(p.appDir, "PRD.md"), "# PRD\n\nRule 1.\nRule 2.\nSlipped in while Kane designed.\n");
        return design(...a);
      };
      const r = await runDrift(p, human(calls, all), log, { kane, reviewed });
      expect(r).toMatchObject({ changed: true, applied: false, specMoved: ["PRD.md"] });
      const events = await readEvents(p.ledgerFile);
      expect(events.findLastIndex((e) => e.t === "seal")).toBe(sealAt);
      expect(events.slice(sealAt).some((e) => e.t === "design")).toBe(false);
      expect(events.findLast((e) => e.t === "spec.changed")).toMatchObject({ files: ["PRD.md"], duringAgentTurn: true });
      expect(existsSync(join(p.verifierDir, T2))).toBe(false);
      await verifierClean();
      // the newer edit is the human's to review: never overwritten by the rollback
      expect(prd().toString()).toContain("Slipped in while Kane designed.");
      expect(calls).not.toContain("review:ac-2,t-2");
    });

    it("the seal holds the reviewed bytes plus Holdback's own Clarifications, and its sealed copy is those bytes", async () => {
      editPrd();
      const reviewed = reviewedNow();
      const calls: Calls = [];
      const kane = fakeKane(calls);
      const reconcile = kane.reconcile;
      kane.reconcile = async (cwd, file, id, mode) =>
        mode === "plan"
          ? {
              status: "paused",
              verb: "reconcile",
              sid: "r1",
              resume: "kane-cli maintain reconcile --resume r1 --mode agent",
              questions: [{ id: "q1", text: "Does rule 2 apply to SNAP households?", risk: "low", rationale: "", options: [{ label: "Yes" }], recommendedIndex: 0, allowFreeText: false }],
              credits: 1,
            }
          : reconcile(cwd, file, id, mode);
      kane.resumeSession = async () => ({ status: "complete", rows: [MODIFY], summary: {}, credits: 4 });
      const io = { ...human(calls, all), answer: async () => ({ q1: "Yes" }) };
      const r = await runDrift(p, io, log, { kane, reviewed });
      expect(r).toEqual({ changed: true, applied: true });
      expect(prd().toString()).toContain("- Q: Does rule 2 apply to SNAP households? — A: Yes");
      const manifest = (await sealed()).manifest;
      expect(manifest["app:PRD.md"]).toBe(sha(prd()));
      expect(readFileSync(join(p.home, "sealed", "PRD.md")).equals(prd())).toBe(true);
    });

    it("an edit that lands after the last check is not sealed: the seal keeps the reviewed hash and the change stays unverified", async () => {
      editPrd();
      const reviewed = reviewedNow();
      const reviewedHash = reviewed["PRD.md"];
      const calls: Calls = [];
      const late = async (e: LedgerEvent) => {
        await log(e);
        if (e.t === "design") writeFileSync(join(p.appDir, "PRD.md"), "# PRD\n\nRule 1.\nRule 2.\nToo late to be reviewed.\n");
      };
      const r = await runDrift(p, human(calls, all), late, { kane: fakeKane(calls), reviewed });
      expect(r).toEqual({ changed: true, applied: true });
      const events = await readEvents(p.ledgerFile);
      const sealAt = events.findLastIndex((e) => e.t === "seal");
      expect((events[sealAt] as Extract<LedgerEvent, { t: "seal" }>).manifest["app:PRD.md"]).toBe(reviewedHash);
      expect(events.slice(sealAt).find((e) => e.t === "spec.changed")).toMatchObject({ files: ["PRD.md"], duringAgentTurn: true, after: { "PRD.md": sha(prd()) } });
    });
  });

  describe("preflight", () => {
    it("refuses on a tamper marker, no Kane call", async () => {
      editPrd();
      await markTampered(p, "agent poked the seal");
      const calls: Calls = [];
      await expect(runDrift(p, human(calls, all), log, { kane: fakeKane(calls) })).rejects.toThrow(/tamper is on record/);
      expect(calls).toEqual([]);
    });

    it("refuses on a tampered ledger, no Kane call", async () => {
      editPrd();
      await log({ at, t: "tamper", detail: "x" });
      const calls: Calls = [];
      await expect(runDrift(p, human(calls, all), log, { kane: fakeKane(calls) })).rejects.toThrow(/ledger records a tamper/);
      expect(calls).toEqual([]);
    });

    it("records a tamper when a sealed test file changed, no Kane call", async () => {
      editPrd();
      writeFileSync(join(p.verifierDir, T1), "forged");
      const calls: Calls = [];
      await expect(runDrift(p, human(calls, all), log, { kane: fakeKane(calls) })).rejects.toThrow(/sealed files changed/);
      expect(calls).toEqual([]);
      expect((await readEvents(p.ledgerFile)).at(-1)).toMatchObject({ t: "tamper" });
      expect(await tamperMarker(p)).not.toBeNull();
    });

    it("records a tamper when the app config changed too", async () => {
      editPrd();
      writeFileSync(join(p.appDir, "holdback.config.json"), JSON.stringify({ spec: ["PRD.md"], note: "x" }));
      const calls: Calls = [];
      await expect(runDrift(p, human(calls, all), log, { kane: fakeKane(calls) })).rejects.toThrow(/holdback\.config\.json/);
      expect(calls).toEqual([]);
    });

    it("records a tamper when recordings moved since the anchor", async () => {
      editPrd();
      execFileSync("git", ["init", "-q"], { cwd: p.appDir });
      await log({ at, t: "recordings", digest: "bogus", gitConfig: "bogus" });
      const calls: Calls = [];
      await expect(runDrift(p, human(calls, all), log, { kane: fakeKane(calls) })).rejects.toThrow(/changed since Holdback last recorded/);
      expect(calls).toEqual([]);
      expect((await readEvents(p.ledgerFile)).at(-1)).toMatchObject({ t: "tamper" });
    });
  });
});

describe("watchSpec", () => {
  it("debounces a burst of edits into one call and stops", async () => {
    let n = 0;
    const stop = watchSpec(p, () => void n++, { debounceMs: 80 });
    try {
      for (let i = 0; i < 4; i++) {
        writeFileSync(join(p.appDir, "PRD.md"), `edit ${i}`);
        await new Promise((r) => setTimeout(r, 10));
      }
      await new Promise((r) => setTimeout(r, 400));
      expect(n).toBe(1);
    } finally {
      stop();
    }
    writeFileSync(join(p.appDir, "PRD.md"), "after stop");
    await new Promise((r) => setTimeout(r, 250));
    expect(n).toBe(1);
  });

  it("survives an atomic rename-save and ignores other files", async () => {
    let n = 0;
    const stop = watchSpec(p, () => void n++, { debounceMs: 60 });
    try {
      writeFileSync(join(p.appDir, "other.txt"), "x");
      await new Promise((r) => setTimeout(r, 250));
      expect(n).toBe(0);
      for (let i = 0; i < 2; i++) {
        writeFileSync(join(p.appDir, "PRD.md.tmp"), `save ${i}`);
        renameSync(join(p.appDir, "PRD.md.tmp"), join(p.appDir, "PRD.md"));
        await new Promise((r) => setTimeout(r, 300));
      }
      expect(n).toBe(2);
    } finally {
      stop();
    }
  });
});
