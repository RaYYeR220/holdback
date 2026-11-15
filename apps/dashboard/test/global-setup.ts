import { mkdtempSync, rmSync } from "node:fs";
import os from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";
import type { GlobalSetupContext } from "vitest/node";

const dash = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");

/** Both dashboard builds, made once for the whole run into a temp folder (never dist/). */
export default async function setup({ provide }: GlobalSetupContext) {
  const { build } = await import("vite");
  const out = mkdtempSync(path.join(os.tmpdir(), "hb-dash-test-"));
  const live = path.join(out, "live");
  const replay = path.join(out, "replay");
  const opts = { root: dash, configFile: path.join(dash, "vite.config.ts"), logLevel: "silent" as const };
  await build({ ...opts, mode: "production", build: { outDir: live, emptyOutDir: true } });
  await build({ ...opts, mode: "replay", build: { outDir: replay, emptyOutDir: true } });
  provide("liveDir", live);
  provide("replayDir", replay);
  return () => rmSync(out, { recursive: true, force: true });
}

declare module "vitest" {
  export interface ProvidedContext {
    liveDir: string;
    replayDir: string;
  }
}
