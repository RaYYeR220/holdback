import { existsSync, mkdirSync, mkdtempSync, readFileSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import type { AcNode, Graph, ReconcileResult } from "../src/kane/assurance.js";
import { reduce } from "../src/ledger/reduce.js";
import { appendEvent, readEvents } from "../src/ledger/store.js";
import type { LedgerEvent } from "../src/ledger/types.js";
import { runDrift, watchSpec, type DriftKane } from "../src/loop/drift.js";
import type { ApprovalItem, HumanIO } from "../src/loop/human.js";
import { reseal } from "../src/loop/spec.js";
import { loadProject, type Project } from "../src/project.js";
import { checkSeal } from "../src/seal.js";

const at = "2026-11-15T00:00:00.000Z";
const T1 = ".testmuai/tests/t-1.test.md";
const T2 = ".testmuai/tests/t-2.test.md";
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
  writeFileSync(join(appDir, "PRD.md"), "# PRD\n\nRule 1.\n");
  p = await loadProject(appDir);
  mkdirSync(join(p.verifierDir, ".testmuai", "tests"), { recursive: true });
  writeFileSync(join(p.verifierDir, T1), "t-1 body");
  await log({ at, t: "spec.ingested", sources: [{ id: "PRD.md", cid: "" }] });
  await log({ at, t: "design", useCase: "uc-1", acs: [ac("ac-1", "rule 1")], tests: [{ id: "t-1", title: "t", file: T1, verifies: ["ac-1"] }], gaps: [], credits: 1 });
  await reseal(p, log);
});
afterEach(() => {
  if (saved.HOLDBACK_HOME === undefined) delete process.env.HOLDBACK_HOME;
  else process.env.HOLDBACK_HOME = saved.HOLDBACK_HOME;
});

const editPrd = () => writeFileSync(join(p.appDir, "PRD.md"), "# PRD\n\nRule 1.\nRule 2.\n");

type Calls = string[];
function fakeKane(calls: Calls): DriftKane {
  const graph: Graph = {
    useCases: [],
    acs: [ac("ac-1", "rule 1"), ac("ac-2", "rule 2")],
    tests: [
      { id: "t-1", title: "one", file: T1, verifies: ["ac-1"] },
      { id: "t-2", title: "two", file: T2, verifies: ["ac-2"] },
    ],
    gaps: [],
  };
  return {
    reconcile: async (_cwd, file, sourceId, mode): Promise<ReconcileResult> => {
      calls.push(`reconcile:${mode}:${file}:${sourceId}`);
      return { status: "complete", rows: [{ kind: "MODIFY", ref: "uc-1", why: "rule 2 added" }], summary: {}, credits: mode === "plan" ? 5 : 3 };
    },
    designTests: async (cwd, uc, o) => {
      calls.push(`design:${uc}:${o.force ? "force" : "plain"}`);
      writeFileSync(join(cwd, T2), "t-2 body");
      return { status: "complete", tests: ["t-2"], acs: ["ac-2"], gaps: [], variables: [], credits: 2, next: [] };
    },
    listNodes: async () => [
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

describe("runDrift", () => {
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
    expect(r).toEqual({ changed: true });
    expect(calls).toEqual([
      "reconcile:plan:PRD.md:prd",
      "approve:uc-1",
      "reconcile:apply:PRD.md:prd",
      "review:uc-1",
      "design:uc-1:force",
      "approve:ac-2,t-2",
      "review:ac-2,t-2",
    ]);
    expect(readFileSync(join(p.verifierDir, "PRD.md"), "utf8")).toContain("Rule 2.");
    const events = await readEvents(p.ledgerFile);
    const drifts = events.filter((e) => e.t === "drift");
    expect(drifts).toMatchObject([{ applied: false, credits: 5, rows: [{ kind: "MODIFY", ref: "uc-1" }] }, { applied: true, credits: 3 }]);
    expect(events.at(-1)?.t).toBe("seal");
    const state = reduce(events);
    expect(state.acs["ac-2"]).toMatchObject({ status: "owed", tests: ["t-2"] });
    expect(state.tampered).toBe(false);
    const manifest = (events.at(-1) as Extract<LedgerEvent, { t: "seal" }>).manifest;
    expect(manifest[T2]).toBeDefined();
    expect(await checkSeal(p.verifierDir, manifest, p.appDir)).toEqual([]);
    const again: Calls = [];
    expect(await runDrift(p, human(again, all), log, { kane: fakeKane(again) })).toEqual({ changed: false });
    expect(again).toEqual([]);
  });

  it("plan rows not approved: apply never called, nothing sealed", async () => {
    editPrd();
    const calls: Calls = [];
    const r = await runDrift(p, human(calls, () => []), log, { kane: fakeKane(calls) });
    expect(r).toEqual({ changed: true });
    expect(calls).toEqual(["reconcile:plan:PRD.md:prd", "approve:uc-1"]);
    const events = await readEvents(p.ledgerFile);
    expect(events.filter((e) => e.t === "seal")).toHaveLength(1);
    expect(events.at(-1)).toMatchObject({ t: "drift", applied: false });
  });

  it("rolls back when a test file nobody approved appears", async () => {
    editPrd();
    const calls: Calls = [];
    const r = await runDrift(p, human(calls, (i) => i.filter((x) => x.kind !== "test").map((x) => x.ref)), log, { kane: fakeKane(calls) });
    expect(r).toEqual({ changed: true });
    expect(existsSync(join(p.verifierDir, T2))).toBe(false);
    expect(readFileSync(join(p.verifierDir, T1), "utf8")).toBe("t-1 body");
    const events = await readEvents(p.ledgerFile);
    expect(events.filter((e) => e.t === "seal")).toHaveLength(1);
    expect(events.at(-1)).toMatchObject({ t: "redesign.dropped", useCases: ["uc-1"], detail: expect.stringContaining(T2) });
    expect(calls.some((c) => c.startsWith("review:ac-2"))).toBe(false);
    expect(reduce(events).acs["ac-2"]).toBeUndefined();
  });

  it("rolls back when nothing was approved", async () => {
    editPrd();
    const calls: Calls = [];
    const io = human(calls, (i) => (i[0]?.kind === "drift" ? all(i) : []));
    await runDrift(p, io, log, { kane: fakeKane(calls) });
    expect(existsSync(join(p.verifierDir, T2))).toBe(false);
    expect((await readEvents(p.ledgerFile)).at(-1)).toMatchObject({ t: "redesign.dropped", credits: 5 });
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
});
