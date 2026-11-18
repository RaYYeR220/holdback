import { execFileSync } from "node:child_process";
import { mkdirSync, mkdtempSync, readdirSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import os from "node:os";
import path from "node:path";
import { afterAll, beforeAll, describe, expect, inject, it } from "vitest";
import { appendEvent, appSealFiles, gate, loadProject, readEvents, reduce, seal, serve, type Verdict } from "@holdback/core";
import { gate as browserGate, parseEvents as browserParse, reduce as browserReduce } from "@holdback/core/browser";
import { gateLabel, stateFromLedger } from "../src/model";
import { loadReplay } from "../src/source";
import { DASH, FIXTURE, fixtureFetch, fixtureText, REHEARSAL, replayText } from "./helpers";

/** The built CLI (`pnpm -r build` runs before the tests). */
const CLI = path.resolve(DASH, "..", "..", "packages", "cli", "dist", "index.js");

const json = <T>(v: T): T => JSON.parse(JSON.stringify(v)) as T;

describe("the replay reduces the ledger exactly as core does", () => {
  it("the fixture is the pantry demo run: 58 criteria, 23 owed, 7 passing, 2 proved, 4 vacuous, 22 without a test; 26 planted bugs, 4 caught", async () => {
    const snap = await loadReplay(fixtureFetch);
    const by = snap.api.counts.byStatus;
    expect(snap.events).toHaveLength(331);
    expect(by).toEqual({ owed: 23, passing: 7, proved: 2, vacuous: 4, "needs-spec": 22 });
    expect(snap.api.state.mutants).toEqual({ killed: 4, survived: 6, invalid: 16 });
    expect(snap.api.gate.open).toBe(false);
    expect(snap.api.config?.breaker.capUsd).toBe(2);
    expect(snap.api.config?.kane.capCredits).toBe(4500);
  });

  it("browser parse + reduce + gate equal core's node entry on the fixture file", async () => {
    const nodeEvents = await readEvents(path.join(FIXTURE, "ledger.jsonl"));
    const snap = await loadReplay(fixtureFetch);
    expect(snap.events).toEqual(nodeEvents);
    expect(snap.api.state).toEqual(reduce(nodeEvents));
    const g = gate(reduce(nodeEvents));
    expect(snap.api.gate).toEqual({
      open: g.allowStop && Object.keys(snap.api.state.acs).length > 0,
      allowStop: g.allowStop,
      tampered: g.tampered,
      owed: g.owed.map((a) => a.id),
      regressed: g.regressed.map((a) => a.id),
      vacuous: g.vacuous.map((a) => a.id),
      needsSpec: g.needsSpec.map((a) => a.id),
      rejected: g.rejected.map((a) => a.id),
      inconclusive: g.inconclusive,
    });
    // and the browser entry's functions give the same answer on their own
    expect(browserReduce(browserParse(replayText()))).toEqual(reduce(nodeEvents));
    expect(json(browserGate(browserReduce(browserParse(replayText()))))).toEqual(json(g));
  });

  it("the replay build ships no node module", () => {
    const dir = path.join(inject("replayDir"), "assets");
    const js = readdirSync(dir).filter((f) => f.endsWith(".js"));
    expect(js.length).toBeGreaterThan(0);
    for (const f of js) {
      const text = readFileSync(path.join(dir, f), "utf8");
      expect(text).not.toMatch(/["'`]node:[a-z_/]+["'`]/);
      expect(text).not.toContain("createRequire");
    }
  });
});

describe("the CLI and the dashboard give one verdict (R44)", () => {
  let tmp: string;
  beforeAll(() => {
    tmp = mkdtempSync(path.join(os.tmpdir(), "hb-dash-verdict-"));
  });
  afterAll(() => rmSync(tmp, { recursive: true, force: true }));

  it("on the rehearsal's ledger: `holdback status --json`, the server and the dashboard's headline all hold it back, as `run`'s exit 3 did", async () => {
    // a throwaway app with the rehearsal's ledger, sealed as it is on disk: no tamper anywhere
    const home = path.join(tmp, "home");
    const app = path.join(tmp, "app");
    mkdirSync(app, { recursive: true });
    writeFileSync(path.join(app, "PRD.md"), "# Pantry\n");
    const prevHome = process.env.HOLDBACK_HOME;
    process.env.HOLDBACK_HOME = home;
    let srv: Awaited<ReturnType<typeof serve>> | undefined;
    try {
      const p = await loadProject(app);
      writeFileSync(p.ledgerFile, readFileSync(REHEARSAL, "utf8"));
      await appendEvent(p.ledgerFile, { at: "2026-11-16T03:00:00.000Z", t: "seal", manifest: await seal(p.verifierDir, { appDir: app, files: appSealFiles(p) }) });
      const events = await readEvents(p.ledgerFile);

      // the CLI, as a human runs it (no Claude Code session in its environment)
      const env = Object.fromEntries(Object.entries(process.env).filter(([k]) => !k.startsWith("CLAUDE")));
      const out = execFileSync(process.execPath, [CLI, "status", "--json"], { cwd: app, env: { ...env, HOLDBACK_HOME: home }, encoding: "utf8" });
      const cli = (JSON.parse(out) as { verdict: Verdict }).verdict;
      const dash = stateFromLedger(browserParse(readFileSync(p.ledgerFile, "utf8")), null);
      expect(cli).toEqual(json(dash.verdict));
      expect(cli).toMatchObject({ released: false, exit: 3, headline: "Held back — 8/10 green, 2 criteria unproved: a planted bug survived" });
      expect(gateLabel(dash)).toMatchObject({ word: "Held back", open: false });
      expect(`${gateLabel(dash).word} — ${gateLabel(dash).parts.join(", ")}`).toBe(cli.headline);

      // and the live dashboard's /api/state carries the same verdict
      srv = await serve(p, { port: 0 });
      const r = await fetch(`http://127.0.0.1:${srv.port}/api/state`, { headers: { "x-holdback-token": srv.token } });
      expect(((await r.json()) as { verdict: Verdict }).verdict).toEqual(cli);
      expect(events.length).toBe(102);
    } finally {
      await srv?.close();
      if (prevHome === undefined) delete process.env.HOLDBACK_HOME;
      else process.env.HOLDBACK_HOME = prevHome;
    }
  });
});

describe("a run that stopped reads the same in the CLI and the dashboard (N-1)", () => {
  let tmp: string;
  beforeAll(() => {
    tmp = mkdtempSync(path.join(os.tmpdir(), "hb-dash-stop-"));
  });
  afterAll(() => rmSync(tmp, { recursive: true, force: true }));

  it("every criterion green, then the run stopped at the Kane credit cap: `status --json`, the server and the dashboard all hold it back with exit 3", async () => {
    const home = path.join(tmp, "home");
    const app = path.join(tmp, "app");
    mkdirSync(app, { recursive: true });
    writeFileSync(path.join(app, "PRD.md"), "# Pantry\n");
    const prevHome = process.env.HOLDBACK_HOME;
    process.env.HOLDBACK_HOME = home;
    let srv: Awaited<ReturnType<typeof serve>> | undefined;
    try {
      const p = await loadProject(app);
      const at = "2026-11-16T03:00:00.000Z";
      const ac = { id: "ac-1", text: "criterion", useCase: "uc-1", cites: [], trust: "derived" };
      const passed = { testFile: "t1.md", testId: "t-1", status: "passed", steps: [], criteriaPassed: ["ac-1"], criteriaFailed: [], credits: 0, replayDecisions: 1, authorDecisions: 0, healTriggered: false, durationS: 1 };
      for (const e of [
        { at, t: "design", useCase: "uc-1", acs: [ac], tests: [{ id: "t-1", title: "one", file: "t1.md", verifies: ["ac-1"] }], gaps: [], credits: 0 },
        { at, t: "seal", manifest: await seal(p.verifierDir, { appDir: app, files: appSealFiles(p) }) },
        { at, t: "run", kind: "build", turn: 1, result: passed },
        { at, t: "run.end", stop: "kane-budget", exit: 3, detail: "Kane credit cap reached: 40 of 30" },
      ])
        await appendEvent(p.ledgerFile, e as never);
      const env = Object.fromEntries(Object.entries(process.env).filter(([k]) => !k.startsWith("CLAUDE")));
      const cli = (JSON.parse(execFileSync(process.execPath, [CLI, "status", "--json"], { cwd: app, env: { ...env, HOLDBACK_HOME: home }, encoding: "utf8" })) as { verdict: Verdict }).verdict;
      const dash = stateFromLedger(browserParse(readFileSync(p.ledgerFile, "utf8")), null);
      expect(cli).toEqual(json(dash.verdict));
      expect(cli).toMatchObject({ released: false, exit: 3, headline: "Held back — 1/1 green, the last run stopped: the Kane credit cap was reached" });
      expect(gateLabel(dash).word).toBe("Held back");
      srv = await serve(p, { port: 0 });
      const r = await fetch(`http://127.0.0.1:${srv.port}/api/state`, { headers: { "x-holdback-token": srv.token } });
      expect(((await r.json()) as { verdict: Verdict }).verdict).toEqual(cli);
    } finally {
      await srv?.close();
      if (prevHome === undefined) delete process.env.HOLDBACK_HOME;
      else process.env.HOLDBACK_HOME = prevHome;
    }
  });
});

describe("the browser's /api/state equals the server's", () => {
  let tmp: string;
  let prevHome: string | undefined;
  beforeAll(() => {
    tmp = mkdtempSync(path.join(os.tmpdir(), "hb-dash-parity-"));
    prevHome = process.env.HOLDBACK_HOME;
    process.env.HOLDBACK_HOME = path.join(tmp, "home");
  });
  afterAll(() => {
    if (prevHome === undefined) delete process.env.HOLDBACK_HOME;
    else process.env.HOLDBACK_HOME = prevHome;
    rmSync(tmp, { recursive: true, force: true });
  });

  it("on the fixture ledger, every field the ledger alone decides", async () => {
    const app = path.join(tmp, "app");
    mkdirSync(app, { recursive: true });
    const p = await loadProject(app);
    writeFileSync(p.ledgerFile, fixtureText());
    const srv = await serve(p, { port: 0 });
    try {
      const r = await fetch(`http://127.0.0.1:${srv.port}/api/state`, { headers: { "x-holdback-token": srv.token } });
      expect(r.status).toBe(200);
      const server = (await r.json()) as Record<string, unknown>;
      const mine = json(stateFromLedger(browserParse(fixtureText()), null));
      for (const k of ["state", "gate", "counts", "credits", "breakerUsd", "pending"] as const) expect({ [k]: mine[k] }).toEqual({ [k]: server[k] });
      // the server also counts the disk's tamper in its verdict; on the ledger alone they agree
      expect(server.verdict).toMatchObject({ state: "tampered", exit: 2 });
      expect(mine.verdict).toMatchObject({ state: "held-back", exit: 3 });
      // the seal is checked against disk only on the server: this throwaway project has none of the sealed files
      expect(server.tamper).not.toBeNull();
      expect(mine.tamper).toBeNull();
    } finally {
      await srv.close();
    }
  });
});
