import { existsSync, readFileSync } from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { defineConfig, type Plugin } from "vite";

const here = path.dirname(fileURLToPath(import.meta.url));
/** The exam's results, when the eval has run: the scoreboard shows "pending" without them. */
const EVAL_SUMMARY = path.resolve(here, "../../eval/results/summary.json");

/** Serves (dev) and ships (build) the eval summary as `eval-summary.json` next to the page, when it exists. */
function evalSummary(): Plugin {
  return {
    name: "holdback-eval-summary",
    configureServer(server) {
      server.middlewares.use("/eval-summary.json", (_req, res) => {
        if (!existsSync(EVAL_SUMMARY)) {
          res.statusCode = 404;
          return void res.end();
        }
        res.setHeader("content-type", "application/json; charset=utf-8");
        res.end(readFileSync(EVAL_SUMMARY));
      });
    },
    generateBundle() {
      if (existsSync(EVAL_SUMMARY)) this.emitFile({ type: "asset", fileName: "eval-summary.json", source: readFileSync(EVAL_SUMMARY) });
    },
  };
}

/**
 * Two builds. LIVE (`vite build`, dist/): talks to `holdback serve`, which serves it with
 * `--static`. REPLAY (`vite build --mode replay` or VITE_REPLAY=1, dist-replay/): a static page that
 * reads ./ledger.jsonl, ./config.json and ./artifacts/* (the fixture folder, or VITE_REPLAY_DIR) and
 * reduces the ledger in the browser with @holdback/core/browser.
 */
export default defineConfig(({ mode }) => {
  const replay = mode === "replay" || process.env.VITE_REPLAY === "1";
  const replayDir = path.resolve(here, process.env.VITE_REPLAY_DIR ?? "fixtures");
  return {
    base: "./",
    define: { "import.meta.env.VITE_REPLAY": JSON.stringify(replay ? "1" : "") },
    publicDir: replay ? replayDir : false,
    plugins: [evalSummary()],
    build: { target: "es2022", outDir: replay ? "dist-replay" : "dist", emptyOutDir: true },
    server: { proxy: replay ? undefined : { "/api": { target: "http://127.0.0.1:4317", changeOrigin: true } } },
  };
});
