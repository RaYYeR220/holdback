import { existsSync, mkdtempSync, rmSync } from "node:fs";
import { createConnection, createServer } from "node:net";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { describe, expect, it } from "vitest";
import { AppStartError, freePort, PortInUse, startApp } from "../src/app.js";

const here = dirname(fileURLToPath(import.meta.url));
const server = join(here, "fixtures", "tiny-server.mjs");
const nodeCmd = (args: string) => `"${process.execPath}" ${args}`;

function accepts(port: number): Promise<boolean> {
  return new Promise((resolve) => {
    const s = createConnection({ port, host: "127.0.0.1" });
    s.once("connect", () => { s.destroy(); resolve(true); });
    s.once("error", () => resolve(false));
  });
}

describe("app process manager", () => {
  it("starts a tiny server and stops it, freeing the port", async () => {
    const port = await freePort();
    const app = await startApp({ cwd: here, cmd: nodeCmd(`"${server}"`), port, readyPath: "/" });
    expect(app.url).toBe(`http://127.0.0.1:${port}`);
    expect(await accepts(port)).toBe(true);
    expect(app.logs()).toContain("listening");
    await app.stop();
    expect(await accepts(port)).toBe(false);
    await app.stop();
  }, 30000);

  it("rejects with logs when the command exits immediately", async () => {
    const port = await freePort();
    const err = await startApp({
      cwd: here, cmd: nodeCmd(`-e "console.log('boom-output')"`), port, readyPath: "/", timeoutMs: 10000,
    }).catch((e) => e);
    expect(err).toBeInstanceOf(AppStartError);
    expect((err as AppStartError).logs).toContain("boom-output");
  }, 30000);

  it("says the app crashed with its exit code, never that the command was not found", async () => {
    // live smoke (Windows): a crashing app (exit 1, here EADDRINUSE) was reported as
    // "spawn <cmd> ENOENT", cross-spawn's guess for any shell command that exits with 1
    const port = await freePort();
    const err = await startApp({
      cwd: here, cmd: nodeCmd(`-e "console.error('crash-output'); process.exit(1)"`), port, readyPath: "/", timeoutMs: 10000,
    }).catch((e) => e);
    expect(err).toBeInstanceOf(AppStartError);
    expect((err as AppStartError).message).toBe("app exited with code 1 before becoming ready");
    expect((err as AppStartError).logs).toContain("crash-output");
  }, 30000);

  it("rejects after timeoutMs when the server never listens", async () => {
    const port = await freePort();
    const t = Date.now();
    const err = await startApp({
      cwd: here, cmd: nodeCmd(`-e "setInterval(()=>{},1000)"`), port, readyPath: "/", timeoutMs: 1500,
    }).catch((e) => e);
    expect(err).toBeInstanceOf(AppStartError);
    expect(Date.now() - t).toBeLessThan(10000);
  }, 30000);

  it("refuses a port another program already listens on, without starting the command", async () => {
    // live smoke: another dev server held the configured port. The app died on EADDRINUSE and the
    // agent would have been briefed to "fix" it (or, had the probe won the race, Kane would have
    // tested the other server)
    const port = await freePort();
    const other = createServer((s) => s.end("HTTP/1.1 200 OK\r\ncontent-length: 2\r\n\r\nok"));
    await new Promise<void>((r) => other.listen(port, "0.0.0.0", () => r()));
    const dir = mkdtempSync(join(tmpdir(), "hb-port-"));
    try {
      const marker = join(dir, "started");
      const err = await startApp({
        cwd: here, cmd: nodeCmd(`-e "require('fs').writeFileSync(process.argv[1],'x');setInterval(()=>{},1000)" "${marker}"`), port, readyPath: "/", timeoutMs: 3000,
      }).catch((e) => e);
      expect(err).toBeInstanceOf(PortInUse);
      expect(err).not.toBeInstanceOf(AppStartError); // not the app's fault: never briefed to the agent as a start failure
      expect((err as Error).message).toContain(`port ${port} is already in use`);
      await new Promise((r) => setTimeout(r, 500));
      expect(existsSync(marker)).toBe(false);
    } finally {
      await new Promise((r) => other.close(() => r(undefined)));
      rmSync(dir, { recursive: true, force: true });
    }
  }, 30000);
});
