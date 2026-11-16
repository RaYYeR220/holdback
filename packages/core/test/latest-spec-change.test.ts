import { describe, expect, it } from "vitest";
import type { LedgerEvent } from "../src/ledger/types.js";
import { latestSpecChange } from "../src/loop/spec.js";

const at = "2026-11-16T00:00:00.000Z";

describe("latestSpecChange (n-4)", () => {
  it("scans the ledger once, not once per step", () => {
    const events = Array.from({ length: 500 }, () => ({ at, t: "turn.start" }) as unknown as LedgerEvent);
    let scans = 0;
    const counted = new Proxy(events, {
      get(target, key, receiver) {
        if (key === "findLastIndex") scans++;
        return Reflect.get(target, key, receiver);
      },
    });
    expect(latestSpecChange(counted)).toBeUndefined();
    expect(scans).toBe(1);
  });

  it("returns the latest spec.changed after the latest checkpoint seal", () => {
    const changed = (n: string) => ({ at, t: "spec.changed", files: [n] }) as unknown as LedgerEvent;
    const seal = { at, t: "seal", manifest: {}, checkpoint: true } as unknown as LedgerEvent;
    expect(latestSpecChange([changed("a"), seal])).toBeUndefined();
    expect(latestSpecChange([changed("a"), seal, changed("b"), changed("c")])).toMatchObject({ files: ["c"] });
  });
});
