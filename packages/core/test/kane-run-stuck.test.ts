import { mkdtempSync, readFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { describe, expect, it, vi } from "vitest";

// Simulate a kill that does not land: tree-kill becomes a no-op, so the child
// keeps running and "close" never fires on its own.
vi.mock("tree-kill", () => ({ default: vi.fn() }));

const { runKane } = await import("../src/kane/run.js");

const fakeBin = join(dirname(fileURLToPath(import.meta.url)), "fake-kane.mjs");

describe("runKane stuck kill", () => {
  it("resolves timedOut:true within the grace period even if close never arrives", async () => {
    process.env.HOLDBACK_KANE_BIN = fakeBin;
    const pidFile = join(mkdtempSync(join(tmpdir(), "hb-")), "pid");
    const t0 = Date.now();
    const res = await runKane([], {
      cwd: tmpdir(),
      timeoutMs: 300,
      killGraceMs: 500,
      env: { FAKE_KANE_HANG: "1", FAKE_KANE_PID_FILE: pidFile },
    });
    const elapsed = Date.now() - t0;
    expect(res.timedOut).toBe(true);
    expect(elapsed).toBeLessThan(5_000);
    try {
      process.kill(Number(readFileSync(pidFile, "utf8")), "SIGKILL"); // clean up the survivor
    } catch {
      /* already gone */
    }
  });
});
