import { mkdtempSync, readFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join, dirname } from "node:path";
import { fileURLToPath } from "node:url";
import { afterEach, describe, expect, it } from "vitest";
import { parseLine } from "../src/kane/ndjson.js";
import { runKane } from "../src/kane/run.js";

const here = dirname(fileURLToPath(import.meta.url));
const fakeBin = join(here, "fake-kane.mjs");
const fixture = (n: string) => join(here, "fixtures", "kane", n);

const saved = process.env.HOLDBACK_KANE_BIN;
afterEach(() => {
  if (saved === undefined) delete process.env.HOLDBACK_KANE_BIN;
  else process.env.HOLDBACK_KANE_BIN = saved;
});

describe("parseLine", () => {
  it("parses a JSON event", () => {
    expect(parseLine('{"type":"done","exit_code":0}')).toEqual({ type: "done", exit_code: 0 });
  });
  it("returns null for non-JSON noise", () => {
    expect(parseLine("Skill update available: run kane-cli update")).toBeNull();
  });
  it("returns null for empty / whitespace lines", () => {
    expect(parseLine("")).toBeNull();
    expect(parseLine("   \r")).toBeNull();
  });
  it("returns null for JSON without a string type, or non-objects", () => {
    expect(parseLine('{"foo":1}')).toBeNull();
    expect(parseLine("[1,2]")).toBeNull();
    expect(parseLine("42")).toBeNull();
    expect(parseLine("{broken")).toBeNull();
  });
  it("tolerates CRLF line endings", () => {
    expect(parseLine('{"type":"x"}\r')).toEqual({ type: "x" });
  });
});

describe("runKane", () => {
  it("collects every event from a fixture and exits 0", async () => {
    process.env.HOLDBACK_KANE_BIN = fakeBin;
    const expected = readFileSync(fixture("03-design.ndjson"), "utf8")
      .split("\n")
      .map(parseLine)
      .filter((e) => e !== null);
    const streamed: string[] = [];
    const res = await runKane(["design"], {
      cwd: tmpdir(),
      timeoutMs: 20_000,
      env: { FAKE_KANE_FIXTURE: fixture("03-design.ndjson") },
      onEvent: (e) => streamed.push(e.type),
    });
    expect(res.exitCode).toBe(0);
    expect(res.timedOut).toBe(false);
    expect(res.events).toEqual(expected);
    expect(res.events.length).toBeGreaterThan(10);
    expect(streamed).toEqual(expected.map((e) => e.type));
    expect(res.durationMs).toBeGreaterThanOrEqual(0);
  });

  it("returns the child's non-zero exit code", async () => {
    process.env.HOLDBACK_KANE_BIN = fakeBin;
    const res = await runKane([], {
      cwd: tmpdir(),
      timeoutMs: 20_000,
      env: { FAKE_KANE_EXIT: "3" },
    });
    expect(res.exitCode).toBe(3);
    expect(res.timedOut).toBe(false);
  });

  it("passes argv through", async () => {
    process.env.HOLDBACK_KANE_BIN = fakeBin;
    const log = join(mkdtempSync(join(tmpdir(), "hb-")), "argv.log");
    await runKane(["run", "a b", "--agent"], {
      cwd: tmpdir(),
      timeoutMs: 20_000,
      env: { FAKE_KANE_ARGV_LOG: log },
    });
    expect(JSON.parse(readFileSync(log, "utf8").trim())).toEqual(["run", "a b", "--agent"]);
  });

  it("times out a hung child and kills it", async () => {
    process.env.HOLDBACK_KANE_BIN = fakeBin;
    const pidFile = join(mkdtempSync(join(tmpdir(), "hb-")), "pid");
    const t0 = Date.now();
    const res = await runKane([], {
      cwd: tmpdir(),
      timeoutMs: 500,
      env: { FAKE_KANE_HANG: "1", FAKE_KANE_PID_FILE: pidFile },
    });
    expect(res.timedOut).toBe(true);
    const pid = Number(readFileSync(pidFile, "utf8"));
    expect(pid).toBeGreaterThan(0);
    expect(() => process.kill(pid, 0)).toThrow();
    expect(Date.now() - t0).toBeLessThan(10_000);
  });
});
