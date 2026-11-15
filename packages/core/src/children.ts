import { spawnSync } from "node:child_process";
import { systemTool } from "./programs.js";

/**
 * The processes Holdback starts and waits on (the app under test, kane-cli, the coding agent), by
 * pid, while they run. A hard exit (a second Ctrl-C) kills them first: on Windows a child outlives
 * its parent, and with its own hidden console it never sees the Ctrl-C itself (I7).
 */
const live = new Set<number>();

/** Tracks `pid` until the returned function is called (call it when the process exits). */
export function trackChild(pid: number | undefined): () => void {
  if (pid === undefined) return () => {};
  live.add(pid);
  return () => void live.delete(pid);
}

/** The pids tracked now. */
export function trackedChildren(): number[] {
  return [...live];
}

/**
 * Kills every tracked process and its own children, synchronously, before a hard exit:
 * `taskkill /T /F` on Windows (by its full path: never a `taskkill` from the current folder), SIGKILL elsewhere (where a terminal's Ctrl-C reaches the whole group).
 */
export function killTrackedChildrenSync(): void {
  for (const pid of live) {
    try {
      if (process.platform === "win32") spawnSync(systemTool("taskkill.exe"), ["/T", "/F", "/PID", String(pid)], { stdio: "ignore", windowsHide: true, timeout: 10_000, shell: false });
      else process.kill(pid, "SIGKILL");
    } catch {
      /* gone already */
    }
  }
  live.clear();
}
