import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { logSpecAttempt, SPEC_ATTEMPTS, specAttemptsSince } from "../src/agent/attempts.js";

let home: string;
beforeEach(() => {
  home = mkdtempSync(join(tmpdir(), "hb-attempts-"));
});
afterEach(() => rmSync(home, { recursive: true, force: true }));

describe("spec attempts", () => {
  it("logs each agent call aimed at a spec file, and reads back those since a moment", async () => {
    expect(await specAttemptsSince(home, 0)).toEqual([]);
    logSpecAttempt(home, { tool: "Edit", how: "edit" }, new Date("2026-11-15T10:00:00.000Z"));
    logSpecAttempt(home, { tool: "Bash", how: "shell" }, new Date("2026-11-15T10:05:00.000Z"));
    const since = await specAttemptsSince(home, Date.parse("2026-11-15T10:01:00.000Z"));
    expect(since).toEqual([{ at: "2026-11-15T10:05:00.000Z", tool: "Bash", how: "shell" }]);
    expect(await specAttemptsSince(home, 0)).toHaveLength(2);
  });

  it("fails closed: a line it cannot read counts as an attempt, whenever it was", async () => {
    writeFileSync(join(home, SPEC_ATTEMPTS), "not json\n");
    expect(await specAttemptsSince(home, Date.now())).toHaveLength(1);
  });

  it("fails closed when the log itself cannot be read", async () => {
    mkdirSync(join(home, SPEC_ATTEMPTS)); // a directory in its place
    expect(await specAttemptsSince(home, Date.now())).toHaveLength(1);
  });
});
