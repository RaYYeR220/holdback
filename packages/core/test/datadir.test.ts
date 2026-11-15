import { existsSync, mkdtempSync, readdirSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { appEnv, freshDataDir, KEEP_DATA_DIRS } from "../src/datadir.js";

let home: string;
beforeEach(() => {
  home = mkdtempSync(join(tmpdir(), "hb-data-"));
});
afterEach(() => rmSync(home, { recursive: true, force: true }));

describe("freshDataDir", () => {
  it("gives every start a new, empty folder under <home>/data, and keeps only the newest few", async () => {
    const made: string[] = [];
    for (let i = 0; i < KEEP_DATA_DIRS + 3; i++) {
      const d = await freshDataDir({ home }, `turn-${i}`);
      expect(readdirSync(d)).toEqual([]);
      writeFileSync(join(d, "app.db"), "rows");
      made.push(d);
    }
    expect(new Set(made).size).toBe(made.length);
    expect(made.every((d) => d.startsWith(join(home, "data")))).toBe(true);
    const left = readdirSync(join(home, "data"));
    expect(left).toHaveLength(KEEP_DATA_DIRS);
    // the newest survive, in order; the oldest went
    expect(made.slice(-KEEP_DATA_DIRS).every((d) => existsSync(d))).toBe(true);
    expect(existsSync(made[0]!)).toBe(false);
  });

  it("names the folder after its label, safely", async () => {
    const d = await freshDataDir({ home }, "m-ac/3:1");
    expect(d.endsWith("m-ac_3_1")).toBe(true);
  });
});

describe("appEnv", () => {
  it("lays Holdback's DATA_DIR over start.env's, and blanks the breaker's key", () => {
    const p = { config: { start: { cmd: "npm start", port: 1, readyPath: "/", env: { DATA_DIR: "./data", HOLDBACK_TODAY: "2026-11-19", VENICE_API_KEY: "x" } } } } as never;
    expect(appEnv(p, "/h/data/1")).toEqual({ DATA_DIR: "/h/data/1", HOLDBACK_TODAY: "2026-11-19", VENICE_API_KEY: "" });
  });
});
