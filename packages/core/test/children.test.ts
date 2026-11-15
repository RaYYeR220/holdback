import { spawn } from "node:child_process";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { describe, expect, it, vi } from "vitest";
import { freePort, PortInUse, startApp } from "../src/app.js";
import { killTrackedChildrenSync, trackChild, trackedChildren } from "../src/children.js";

const here = dirname(fileURLToPath(import.meta.url));
const server = join(here, "fixtures", "tiny-server.mjs");

const alive = (pid: number) => {
  try {
    process.kill(pid, 0);
    return true;
  } catch {
    return false;
  }
};

describe("tracked children (I7)", { timeout: 30_000 }, () => {
  it("kills every tracked child, with its own children, synchronously", async () => {
    // a child that starts a grandchild of its own, as a shell running `npm start` does
    const child = spawn(process.execPath, ["-e", `require("child_process").spawn(process.execPath, ["-e", "setInterval(() => {}, 1000)"], { stdio: "inherit" }); console.log("up"); setInterval(() => {}, 1000)`], {
      stdio: ["ignore", "pipe", "ignore"],
      windowsHide: true,
    });
    await new Promise((r) => child.stdout!.once("data", r));
    const untrack = trackChild(child.pid);
    expect(trackedChildren()).toContain(child.pid);
    killTrackedChildrenSync();
    await vi.waitFor(() => expect(alive(child.pid!)).toBe(false), { timeout: 10_000 });
    untrack();
    expect(trackedChildren()).not.toContain(child.pid);
  });

  it("the app under test is tracked while it runs and untracked once stopped; a port in use names an orphan as a cause", async () => {
    const port = await freePort();
    const app = await startApp({ cwd: here, cmd: `"${process.execPath}" "${server}"`, port, readyPath: "/" });
    expect(trackedChildren().length).toBeGreaterThan(0);
    const err = await startApp({ cwd: here, cmd: `"${process.execPath}" "${server}"`, port, readyPath: "/" }).catch((e) => e);
    expect(err).toBeInstanceOf(PortInUse);
    expect((err as Error).message).toMatch(/interrupted Holdback run/);
    await app.stop();
    await vi.waitFor(() => expect(trackedChildren()).toEqual([]), { timeout: 10_000 });
  });
});

describe("Kane's process is tracked too (I7)", { timeout: 30_000 }, () => {
  it("while it runs, and no longer once it ends", async () => {
    const saved = process.env.HOLDBACK_KANE_BIN;
    process.env.HOLDBACK_KANE_BIN = join(here, "fake-kane.mjs");
    process.env.FAKE_KANE_HANG = "1";
    try {
      const { runKane } = await import("../src/kane/run.js");
      const running = runKane(["testmd", "run", "x"], { cwd: here, timeoutMs: 1500, killGraceMs: 500 });
      await vi.waitFor(() => expect(trackedChildren().length).toBeGreaterThan(0), { timeout: 5_000 });
      await running;
      expect(trackedChildren()).toEqual([]);
    } finally {
      delete process.env.FAKE_KANE_HANG;
      if (saved === undefined) delete process.env.HOLDBACK_KANE_BIN;
      else process.env.HOLDBACK_KANE_BIN = saved;
    }
  });
});
