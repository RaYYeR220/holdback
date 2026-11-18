import { existsSync, readFileSync } from "node:fs";
import { createServer } from "node:http";
import path from "node:path";
import { fileURLToPath } from "node:url";

export const DASH = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
/** The shipped replay: the pantry demo run's ledger, config and screenshots, sanitized. */
export const FIXTURE = path.join(DASH, "fixtures");
export const replayText = () => readFileSync(path.join(FIXTURE, "ledger.jsonl"), "utf8");
/** The first live run (2026-11-15, the 4-rule spec), sanitized: the model and live-server tests read it. */
export const FIRST_RUN = path.resolve(DASH, "..", "..", "examples", "first-live-run");
export const fixtureText = () => readFileSync(path.join(FIRST_RUN, "ledger.jsonl"), "utf8");
/** The live rehearsal's ledger (2026-11-16), sanitized: core's test fixture. */
export const REHEARSAL = path.resolve(DASH, "..", "..", "packages", "core", "test", "fixtures", "rehearsal", "ledger.jsonl");

const MIME: Record<string, string> = { ".html": "text/html", ".js": "text/javascript", ".css": "text/css", ".json": "application/json", ".jsonl": "application/x-ndjson", ".png": "image/png", ".woff2": "font/woff2" };

/** A plain static server: what a judge's static host does with the replay build. */
export function staticServer(root: string): Promise<{ url: string; close: () => Promise<void> }> {
  const srv = createServer((req, res) => {
    const rel = decodeURIComponent(new URL(req.url ?? "/", "http://x").pathname);
    const file = path.join(root, rel === "/" ? "index.html" : rel);
    if (!file.startsWith(root) || !existsSync(file)) return void res.writeHead(404).end();
    res.writeHead(200, { "content-type": MIME[path.extname(file)] ?? "application/octet-stream" });
    res.end(readFileSync(file));
  });
  return new Promise((resolve) =>
    srv.listen(0, "127.0.0.1", () => {
      const { port } = srv.address() as { port: number };
      resolve({ url: `http://127.0.0.1:${port}/`, close: () => new Promise((r) => srv.close(() => r())) });
    }),
  );
}

/** `fetch` for the replay loader, reading the fixture folder as the page would read ./ */
export const fixtureFetch = (async (input: RequestInfo | URL) => {
  const rel = String(input).replace(/^\.\//, "");
  const file = path.join(FIXTURE, rel);
  if (!existsSync(file)) return new Response("", { status: 404 });
  return new Response(readFileSync(file));
}) as typeof fetch;
