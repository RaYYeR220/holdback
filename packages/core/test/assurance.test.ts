import { cpSync, mkdirSync, mkdtempSync, readFileSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join, dirname } from "node:path";
import { fileURLToPath } from "node:url";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import {
  balance,
  coverGaps,
  designTests,
  extractResume,
  ingest,
  readGraph,
  reconcile,
  review,
} from "../src/kane/assurance.js";

const here = dirname(fileURLToPath(import.meta.url));
const fakeBin = join(here, "fake-kane.mjs");
const fx = (n: string) => join(here, "fixtures", "kane", n);

const saved = { ...process.env };
let cwd: string;
let argvLog: string;

beforeEach(() => {
  cwd = mkdtempSync(join(tmpdir(), "holdback-assurance-"));
  argvLog = join(cwd, "argv.log");
  process.env.HOLDBACK_KANE_BIN = fakeBin;
  process.env.FAKE_KANE_ARGV_LOG = argvLog;
  delete process.env.FAKE_KANE_EXIT;
});
afterEach(() => {
  for (const k of ["HOLDBACK_KANE_BIN", "FAKE_KANE_FIXTURE", "FAKE_KANE_ARGV_LOG", "FAKE_KANE_EXIT"]) {
    if (saved[k] === undefined) delete process.env[k];
    else process.env[k] = saved[k];
  }
});

const useFixture = (p: string) => {
  process.env.FAKE_KANE_FIXTURE = p;
};
const argvs = (): string[][] =>
  readFileSync(argvLog, "utf8")
    .split("\n")
    .filter(Boolean)
    .map((l) => JSON.parse(l) as string[]);
const textFixture = (text: string) => {
  const p = join(cwd, "stdout.txt");
  writeFileSync(p, text);
  return p;
};

describe("ingest / extractResume", () => {
  it("returns Paused with the pending questions", async () => {
    useFixture(fx("01-ingest.ndjson"));
    const r = await ingest(cwd, ["prd.md"]);
    expect(r.status).toBe("paused");
    if (r.status !== "paused") throw new Error("unreachable");
    expect(r.sid).toBe("ext-20261115T023959-a05ab3e0-prd");
    expect(r.resume).toContain("--resume");
    expect(r.questions).toHaveLength(2);
    const q1 = r.questions[0]!;
    expect(q1.id).toBe("q1");
    expect(q1.risk).toBe("med");
    expect(q1.recommendedIndex).toBe(0);
    expect(q1.allowFreeText).toBe(false);
    expect(q1.options[0]).toMatchObject({ label: "Leave unspecified" });
    expect(q1.options.length).toBeGreaterThanOrEqual(2);
    expect(argvs()[0]).toEqual(["context", "ingest", "prd.md", "--mode", "agent"]);
  });

  it("resume completes with minted use cases and summed credits", async () => {
    useFixture(fx("02-extract.ndjson"));
    const r = await extractResume(cwd, "ext-1", { q1: "1", q2: "free text" });
    expect(r.status).toBe("complete");
    if (r.status !== "complete") throw new Error("unreachable");
    expect(r.minted).toEqual(["uc-1"]);
    expect(r.credits).toBeCloseTo(1.41, 2);
    expect(argvs()[0]).toEqual([
      "context", "extract", "--resume", "ext-1", "--mode", "agent",
      "--answer", "q1=1", "--answer", "q2=free text",
    ]);
  });

  it("maps an error event to status error", async () => {
    useFixture(
      textFixture(
        '{"type":"error","v":1,"verb":"extract","code":"E_AUTH","message":"not logged in"}\n' +
          '{"type":"done","v":1,"verb":"extract","status":"error","exit_code":1}\n',
      ),
    );
    process.env.FAKE_KANE_EXIT = "1";
    const r = await ingest(cwd, ["a.md"]);
    expect(r).toEqual({ status: "error", message: "not logged in", code: "E_AUTH" });
  });

  it("maps a bare nonzero exit with no events to status error", async () => {
    useFixture(textFixture("boom\n"));
    process.env.FAKE_KANE_EXIT = "2";
    const r = await ingest(cwd, ["a.md"]);
    expect(r.status).toBe("error");
  });
});

describe("review", () => {
  it("approves refs and uses --json, no --mode", async () => {
    useFixture(textFixture("review: committed record 8 - 2 approved\n"));
    await expect(review(cwd, ["ac-1", "ac-2"])).resolves.toBeUndefined();
    expect(argvs()[0]).toEqual(["context", "review", "--approve", "ac-1", "ac-2", "--json"]);
  });
  it("throws on nonzero exit", async () => {
    useFixture(textFixture("nope\n"));
    process.env.FAKE_KANE_EXIT = "1";
    await expect(review(cwd, ["ac-1"])).rejects.toThrow(/review/);
  });
});

describe("designTests", () => {
  it("collects tests, acs, gaps, variables, credits, next", async () => {
    useFixture(fx("03-design.ndjson"));
    const r = await designTests(cwd, "uc-1", { max: 3, force: true });
    expect(r.status).toBe("complete");
    if (r.status === "paused") throw new Error("unreachable");
    expect(r.tests).toEqual(["t-1", "t-2", "t-3"]);
    expect(r.acs).toHaveLength(9);
    expect(r.acs[0]).toBe("ac-1");
    expect(r.gaps.length).toBeGreaterThan(0);
    expect(r.variables).toEqual([
      { name: "start_url", description: expect.stringContaining("Food pantry"), secret: false },
    ]);
    expect(r.credits).toBeGreaterThan(19.43);
    expect(r.credits).toBeLessThan(19.45);
    expect(r.next[0]).toBe("kane-cli context review --approve ac-1 --mode agent");
    expect(argvs()[0]).toEqual([
      "design", "tests", "--use-case", "uc-1", "--mode", "agent", "--max", "3", "--force",
    ]);
  });
  it("omits optional flags", async () => {
    useFixture(fx("03-design.ndjson"));
    await designTests(cwd, "uc-1", {});
    expect(argvs()[0]).toEqual(["design", "tests", "--use-case", "uc-1", "--mode", "agent"]);
  });
});

describe("reconcile", () => {
  it("plan mode returns rows, plan path, summary, credits", async () => {
    useFixture(fx("07-reconcile-plan.ndjson"));
    const r = await reconcile(cwd, "prd-v2.md", "prd", "plan");
    if (r.status === "paused") throw new Error("unexpected pause");
    expect(r.rows).toEqual([{ kind: "MODIFY", ref: "uc-1", why: expect.stringContaining("updated") }]);
    expect(r.planPath).toContain("reconcile");
    expect(r.summary).toMatchObject({ applied: 0, failed: 0 });
    expect(r.credits).toBeCloseTo(4.99, 2);
    expect(argvs()[0]).toEqual([
      "maintain", "reconcile", "--from", "prd-v2.md", "--source-id", "prd", "--plan", "--mode", "agent",
    ]);
  });
  it("apply mode passes --apply", async () => {
    useFixture(fx("07-reconcile-plan.ndjson"));
    await reconcile(cwd, "prd-v2.md", "prd", "apply");
    expect(argvs()[0]).toContain("--apply");
    expect(argvs()[0]).not.toContain("--plan");
  });
});

describe("balance", () => {
  it("parses Available credits after a noise line", async () => {
    useFixture(textFixture("Skill update available: not installed\nAvailable credits: 11089.1683\n"));
    expect(await balance()).toBeCloseTo(11089.1683, 4);
  });
  it("throws when no balance line", async () => {
    useFixture(textFixture("hello\n"));
    await expect(balance()).rejects.toThrow(/balance/);
  });
});

describe("coverGaps", () => {
  it("flattens pending rows into gaps", async () => {
    useFixture(fx("cover-gaps.json"));
    const g = await coverGaps(cwd);
    expect(g.map((x) => x.id)).toEqual(["ac-3", "ac-4", "ac-5", "ac-1", "ac-2"]);
    expect(g[0]).toMatchObject({ kind: "execution-failed", acs: ["ac-3"] });
    expect(g[0]!.title.length).toBeGreaterThan(0);
    expect(argvs()[0]).toEqual(["cover", "gaps", "--json"]);
  });
});

describe("readGraph", () => {
  const seed = () => {
    mkdirSync(join(cwd, ".context"), { recursive: true });
    cpSync(fx("context-commits"), join(cwd, ".context", "commits"), { recursive: true });
    cpSync(fx("tests"), join(cwd, ".testmuai", "tests"), { recursive: true });
  };

  it("maps nodes, test files, verifies and citations", async () => {
    seed();
    useFixture(fx("context-view.json"));
    const g = await readGraph(cwd);
    expect(g.useCases.map((u) => u.id)).toEqual(["uc-1"]);
    expect(g.acs).toHaveLength(9);
    const ac4 = g.acs.find((a) => a.id === "ac-4")!;
    expect(ac4.text.startsWith("The reported applied monthly limit")).toBe(true);
    expect(ac4.useCase).toBe("uc-1");
    expect(ac4.trust).toBe("trusted");
    expect(ac4.cites.length).toBeGreaterThan(0);
    expect(ac4.cites.length).toBeLessThanOrEqual(2);
    expect(ac4.cites[0]).toMatchObject({ source: "prd" });
    expect(ac4.cites[0]!.anchor).toMatch(/^L\d+-L\d+$/);
    expect(ac4.cites[0]!.quote.length).toBeGreaterThan(0);
    expect(g.tests.map((t) => t.id)).toEqual(["t-1", "t-2", "t-3"]);
    const t3 = g.tests.find((t) => t.id === "t-3")!;
    expect(t3.title).toBe("Non-SNAP household above $2,461 is not eligible");
    expect(t3.verifies).toContain("ac-3");
    expect(t3.file.replaceAll("\\", "/")).toMatch(/\.testmuai\/tests\/non-snap-.*_test\.md$/);
    expect(g.gaps.map((x) => x.id)).toEqual(["gap-1", "gap-2", "gap-3", "gap-4"]);
    expect(argvs()[0]).toEqual(["context", "view", "--json"]);
  });

  it("never throws when the context store is missing: cites are empty", async () => {
    useFixture(fx("context-view.json"));
    const g = await readGraph(cwd);
    expect(g.acs).toHaveLength(9);
    expect(g.acs.every((a) => a.cites.length === 0)).toBe(true);
    expect(g.tests.every((t) => t.file === "")).toBe(true);
    expect(g.tests.find((t) => t.id === "t-3")!.verifies).toContain("ac-3");
  });
});
