import { readFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { describe, expect, it } from "vitest";
import { parseEvents } from "../src/ledger/parse.js";
import { retiredTests } from "../src/ledger/retired.js";

/** The live rehearsal's ledger (2026-11-16), sanitized. */
const REHEARSAL = join(dirname(fileURLToPath(import.meta.url)), "fixtures", "rehearsal", "ledger.jsonl");

describe("retiredTests", () => {
  it("lists the tests an evolve retired that no criterion runs any more: the rehearsal's t-1, still sealed", () => {
    const events = parseEvents(readFileSync(REHEARSAL, "utf8"));
    expect(retiredTests(events)).toEqual([
      { id: "t-1", uc: "uc-1", title: "Reject non-SNAP income above the two-person limit", file: expect.stringMatching(/reject-non-snap-income-above-the-two-person-limit_test\.md$/) },
    ]);
  });
});
