import { createConnection } from "node:net";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { describe, expect, it } from "vitest";
import { AppStartError, freePort, startApp } from "../src/app.js";

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

  it("rejects after timeoutMs when the server never listens", async () => {
    const port = await freePort();
    const t = Date.now();
    const err = await startApp({
      cwd: here, cmd: nodeCmd(`-e "setInterval(()=>{},1000)"`), port, readyPath: "/", timeoutMs: 1500,
    }).catch((e) => e);
    expect(err).toBeInstanceOf(AppStartError);
    expect(Date.now() - t).toBeLessThan(10000);
  }, 30000);
});
