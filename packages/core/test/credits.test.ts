import { describe, expect, it } from "vitest";
import { KaneCapReached, KaneMeter, type KaneCap } from "../src/ledger/credits.js";
import { kaneCapCredits } from "../src/project.js";

describe("KaneMeter's credit cap (I6)", () => {
  const meter = (spent: number, cap: number | null) => {
    const logged: unknown[] = [];
    let reads = 0;
    const c: KaneCap | undefined = cap === null ? undefined : { credits: cap, spent: async () => spent };
    const m = new KaneMeter(async () => (reads++, 100), async (e) => void logged.push(e), c);
    return { m, logged, reads: () => reads };
  };

  it("refuses to start a batch once the measured spend reaches the cap: nothing runs, nothing is read or logged", async () => {
    const { m, logged, reads } = meter(50, 50);
    let ran = false;
    await expect(m.batch("build", async () => void (ran = true))).rejects.toBeInstanceOf(KaneCapReached);
    expect(ran).toBe(false);
    expect(reads()).toBe(0);
    expect(logged).toEqual([]);
    await expect(m.batch("build", async () => {})).rejects.toThrow(/Kane credit cap reached: 50 of 50/);
  });

  it("runs a batch below the cap, and without one", async () => {
    for (const [spent, cap] of [
      [49.9, 50],
      [1e9, null],
    ] as const) {
      const { m } = meter(spent, cap);
      expect(await m.batch("build", async () => "ok")).toBe("ok");
    }
  });

  it("checks the cap even with no balance reader (the per-run sum is then the measure)", async () => {
    const m = new KaneMeter(undefined, async () => {}, { credits: 10, spent: () => 12 });
    await expect(m.batch("spec", async () => {})).rejects.toBeInstanceOf(KaneCapReached);
    await expect(m.assertBudget()).rejects.toBeInstanceOf(KaneCapReached);
  });
});

describe("kaneCapCredits", () => {
  it("takes a human's override over kane.capCredits, and refuses anything but a number of credits", () => {
    const cfg = (capCredits: unknown) => ({ kane: { parallel: 1, timeoutS: 1, designMax: 1, capCredits } }) as never;
    expect(kaneCapCredits(cfg(null))).toBeUndefined();
    expect(kaneCapCredits(cfg(500))).toBe(500);
    expect(kaneCapCredits(cfg(500), 20)).toBe(20);
    expect(() => kaneCapCredits(cfg("500"))).toThrow(/kane.capCredits must be a number/);
    expect(() => kaneCapCredits(cfg(-1))).toThrow(/kane.capCredits/);
  });
});
