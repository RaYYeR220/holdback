import { appendFileSync, mkdirSync, mkdtempSync, rmSync, statSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { attemptsText, logSpecAttempt, SPEC_ATTEMPTS, specAttemptsSince } from "../src/agent/attempts.js";

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

  it("a line it cannot read counts as an attempt only in its window: from the readable line before it to the one after it (N-m5)", async () => {
    const file = join(home, SPEC_ATTEMPTS);
    logSpecAttempt(home, { tool: "Edit", how: "edit" }, new Date("2026-11-15T10:00:00.000Z"));
    appendFileSync(file, '{"at": "2026-11-15T10:0\n');
    logSpecAttempt(home, { tool: "Bash", how: "shell" }, new Date("2026-11-15T10:05:00.000Z"));
    // a seal after the line that follows it: the broken line was written before that seal
    expect(await specAttemptsSince(home, Date.parse("2026-11-15T10:06:00.000Z"))).toEqual([]);
    // a seal inside its window: it may have come after, so it counts (fail closed), on record with its line and window
    expect(await specAttemptsSince(home, Date.parse("2026-11-15T10:03:00.000Z"))).toEqual([
      { at: "between 2026-11-15T10:00:00.000Z and 2026-11-15T10:05:00.000Z", tool: "?", how: "unreadable", line: 2 },
      { at: "2026-11-15T10:05:00.000Z", tool: "Bash", how: "shell" },
    ]);
    expect(attemptsText(await specAttemptsSince(home, 0))).toBe(
      "Edit (edit), an unreadable line 2 of the attempts log (written between 2026-11-15T10:00:00.000Z and 2026-11-15T10:05:00.000Z), Bash (shell)",
    );
  });

  it("a last line it cannot read counts until the log was last written: a later seal leaves it behind (N-m5)", async () => {
    const file = join(home, SPEC_ATTEMPTS);
    writeFileSync(file, "not json\n");
    const written = statSync(file).mtimeMs;
    expect(await specAttemptsSince(home, Math.floor(written) - 1)).toEqual([
      { at: expect.stringMatching(/^between the start of the log and \d{4}-/), tool: "?", how: "unreadable", line: 1 },
    ]);
    expect(await specAttemptsSince(home, Math.ceil(written) + 1000)).toEqual([]);
  });

  it("fails closed when the log itself cannot be read", async () => {
    mkdirSync(join(home, SPEC_ATTEMPTS)); // a directory in its place
    expect(await specAttemptsSince(home, Date.now())).toHaveLength(1);
  });
});
