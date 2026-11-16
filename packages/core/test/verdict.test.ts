import { readFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { describe, expect, it } from "vitest";
import { parseEvents } from "../src/ledger/parse.js";
import { reduce } from "../src/ledger/reduce.js";
import type { AcState, LedgerState } from "../src/ledger/types.js";
import { verdict } from "../src/ledger/verdict.js";

const here = dirname(fileURLToPath(import.meta.url));
/** The live rehearsal's ledger (2026-11-16), sanitized: 10 criteria, 5 proved, 3 passing, 2 vacuous, exit 3. */
const REHEARSAL = join(here, "fixtures", "rehearsal", "ledger.jsonl");

const ac = (id: string, status: AcState["status"], tests = ["t-1"]): AcState => ({ id, text: id, useCase: "uc-1", cites: [], tests, status });
const state = (acs: AcState[], extra: Partial<LedgerState> = {}): LedgerState => ({
  ...reduce([]),
  acs: Object.fromEntries(acs.map((a) => [a.id, a])),
  ...extra,
});

describe("verdict", () => {
  it("the rehearsal's ledger is held back with exit 3, though the build loop's gate is open", () => {
    const v = verdict(reduce(parseEvents(readFileSync(REHEARSAL, "utf8"))));
    expect(v).toMatchObject({
      state: "held-back",
      released: false,
      word: "Held back",
      headline: "Held back — 8/10 green, 2 criteria unproved: a planted bug survived",
      gateOpen: true,
      exit: 3,
      counts: { criteria: 10, green: 8, proved: 5, passing: 3, vacuous: 2, owed: 0, regressed: 0, needsSpec: 0, rejected: 0, inconclusive: 0 },
    });
  });

  it("is released only when every criterion not turned down is proved or passing and the gate is open", () => {
    const v = verdict(state([ac("ac-1", "proved"), ac("ac-2", "passing"), ac("ac-3", "rejected", [])]));
    expect(v).toMatchObject({ state: "released", released: true, word: "Released", headline: "Released — 2/2 green, 1/2 proved", exit: 0 });
  });

  it("names every reason it is held back", () => {
    const v = verdict(
      state([ac("ac-1", "owed"), ac("ac-2", "regressed"), ac("ac-3", "vacuous"), ac("ac-4", "needs-spec", []), ac("ac-5", "proved", ["t-5"])], {
        inconclusive: [{ test: "t-5", turn: 2, reason: "environment_issue: browser closed" }],
      }),
    );
    expect(v.headline).toBe("Held back — 1/5 green, 2 owed (1 regressed), 1 criterion unproved: a planted bug survived, 1 criterion with no test, 1 test proved nothing on the last run");
    expect(v).toMatchObject({ released: false, gateOpen: false, exit: 3 });
    // a needs-spec criterion alone holds it back too, with the gate open
    expect(verdict(state([ac("ac-1", "passing"), ac("ac-2", "needs-spec", [])]))).toMatchObject({ released: false, gateOpen: true, headline: "Held back — 1/2 green, 1 criterion with no test", exit: 3 });
  });

  it("a tamper, in the ledger or seen on disk, holds it back with exit 2; no criteria is never released", () => {
    const green = [ac("ac-1", "proved")];
    expect(verdict(state(green, { tampered: true }))).toMatchObject({ state: "tampered", released: false, gateOpen: false, exit: 2, headline: "Held back — tampered: nothing counts until a human re-seals" });
    expect(verdict(state(green), { tampered: true })).toMatchObject({ state: "tampered", exit: 2 });
    expect(verdict(state([]))).toMatchObject({ state: "empty", released: false, exit: 3, headline: "Held back — no criteria yet" });
  });
});
