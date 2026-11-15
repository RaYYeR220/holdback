import { mkdirSync, mkdtempSync, readdirSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import os from "node:os";
import path from "node:path";
import { afterAll, beforeAll, describe, expect, inject, it } from "vitest";
import { gate, loadProject, readEvents, reduce, serve } from "@holdback/core";
import { gate as browserGate, parseEvents as browserParse, reduce as browserReduce } from "@holdback/core/browser";
import { stateFromLedger } from "../src/model";
import { loadReplay } from "../src/source";
import { FIXTURE, fixtureFetch, fixtureText } from "./helpers";

const json = <T>(v: T): T => JSON.parse(JSON.stringify(v)) as T;

describe("the replay reduces the ledger exactly as core does", () => {
  it("the fixture is the real run: 11 criteria, 5 owed, 4 passing, 2 proved, 2 planted bugs caught", async () => {
    const snap = await loadReplay(fixtureFetch);
    const by = snap.api.counts.byStatus;
    expect(snap.events).toHaveLength(25);
    expect(by).toEqual({ owed: 5, passing: 4, proved: 2 });
    expect(snap.api.state.mutants).toEqual({ killed: 2, survived: 0, invalid: 0 });
    expect(snap.api.gate.open).toBe(false);
    expect(snap.api.config?.breaker.capUsd).toBe(0.25);
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
    expect(browserReduce(browserParse(fixtureText()))).toEqual(reduce(nodeEvents));
    expect(json(browserGate(browserReduce(browserParse(fixtureText()))))).toEqual(json(g));
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
      // the seal is checked against disk only on the server: this throwaway project has none of the sealed files
      expect(server.tamper).not.toBeNull();
      expect(mine.tamper).toBeNull();
    } finally {
      await srv.close();
    }
  });
});
