// Screenshots of the dashboard at 1440, 1920 and 390 px, on the replay fixture:
//   node scripts/shots.mjs <outDir> [--app <recorded app dir> --verifier <recorded verifier dir>]
// REPLAY: dist-replay/ behind a plain static server. LIVE: the real `holdback serve` (CLI build) in a
// throwaway project whose ledger is the fixture, then core's serve() with one of the fixture's own
// Kane questions (and approvals) pending. --app/--verifier copy the recorded run's sealed files in,
// so the seal checks out as it did; without them the live pages show the seal as broken.
// Needs `pnpm -r build` (core, cli) and both dashboard builds first.
import { spawn } from "node:child_process";
import { cpSync, existsSync, mkdirSync, mkdtempSync, readFileSync, readdirSync, rmSync, writeFileSync } from "node:fs";
import { createServer } from "node:http";
import os from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { loadProject, parseEvents, serve } from "@holdback/core";
import { chromium } from "playwright";

const here = path.dirname(fileURLToPath(import.meta.url));
const dash = path.resolve(here, "..");
const repo = path.resolve(dash, "../..");
const args = process.argv.slice(2);
const opt = (name) => {
  const i = args.indexOf(name);
  return i < 0 ? undefined : args.splice(i, 2)[1];
};
const recordedApp = opt("--app");
const recordedVerifier = opt("--verifier");
const out = path.resolve(args[0] ?? "shots");
mkdirSync(out, { recursive: true });
for (const d of ["dist", "dist-replay"]) if (!existsSync(path.join(dash, d, "index.html"))) throw new Error(`build the dashboard first: ${d}/ is missing`);

const WIDTHS = [
  { w: 1440, h: 900 },
  { w: 1920, h: 1080 },
  { w: 390, h: 844 },
];
const MIME = { ".html": "text/html", ".js": "text/javascript", ".css": "text/css", ".json": "application/json", ".jsonl": "application/x-ndjson", ".png": "image/png", ".woff2": "font/woff2", ".woff": "font/woff" };

function staticServer(root) {
  const srv = createServer((req, res) => {
    const rel = decodeURIComponent(new URL(req.url, "http://x").pathname);
    const file = path.join(root, rel === "/" ? "index.html" : rel);
    if (!file.startsWith(root) || !existsSync(file)) return void res.writeHead(404).end();
    res.writeHead(200, { "content-type": MIME[path.extname(file)] ?? "application/octet-stream" });
    res.end(readFileSync(file));
  });
  return new Promise((r) => srv.listen(0, "127.0.0.1", () => r({ url: `http://127.0.0.1:${srv.address().port}/`, close: () => srv.close() })));
}

async function settle(page) {
  await page.waitForSelector("[data-testid=board]", { timeout: 20_000 });
  await page.evaluate(async () => {
    await document.fonts.ready;
    const wait = (i) => (i.complete ? null : new Promise((r) => (i.addEventListener("load", r), i.addEventListener("error", r), setTimeout(r, 5000))));
    await Promise.all([...document.images].map(wait));
    for (const i of document.images) await i.decode().catch(() => {});
  });
  await page.waitForTimeout(400); // the thumbnails crop themselves once their image is in
}

async function shoot(browser, url, name, { full = true, prep } = {}) {
  for (const { w, h } of WIDTHS) {
    const page = await browser.newPage({ viewport: { width: w, height: h }, deviceScaleFactor: w === 390 ? 2 : 1 });
    await page.goto(url);
    await settle(page);
    if (prep) await prep(page);
    const file = path.join(out, `${name}-${w}.png`);
    await page.screenshot({ path: file, fullPage: full });
    const scrollW = await page.evaluate(() => document.documentElement.scrollWidth);
    console.log(`${file}${scrollW > w ? `  (horizontal overflow: ${scrollW}px)` : ""}`);
    await page.close();
  }
}

/** A throwaway project whose ledger is the fixture, its screenshots in the app's evidence folder. */
async function liveProject() {
  const tmp = mkdtempSync(path.join(os.tmpdir(), "hb-dash-shots-"));
  const app = path.join(tmp, "app");
  mkdirSync(app);
  if (recordedApp) {
    for (const f of readdirSync(recordedApp)) if (f !== "node_modules" && f !== ".git") cpSync(path.join(recordedApp, f), path.join(app, f), { recursive: true });
  } else writeFileSync(path.join(app, "holdback.config.json"), JSON.stringify({ spec: ["PRD.md"] }));
  process.env.HOLDBACK_HOME = path.join(tmp, "home");
  const p = await loadProject(app);
  if (recordedVerifier) cpSync(recordedVerifier, p.verifierDir, { recursive: true });
  const ev = path.join(app, "kane-evidence");
  mkdirSync(ev, { recursive: true });
  const lines = readFileSync(path.join(dash, "fixtures", "ledger.jsonl"), "utf8")
    .split("\n")
    .filter(Boolean)
    .map((l) => {
      const e = JSON.parse(l);
      const s = e.t === "run" ? e.result.screenshot : undefined;
      if (typeof s === "string" && s.startsWith("artifacts/")) {
        cpSync(path.join(dash, "fixtures", s), path.join(ev, path.basename(s)));
        e.result.screenshot = path.join(ev, path.basename(s));
      }
      return JSON.stringify(e);
    });
  writeFileSync(p.ledgerFile, lines.join("\n") + "\n");
  return { tmp, app, p };
}

function cliServe(app) {
  const env = { ...process.env };
  delete env.CLAUDECODE; // a human runs serve; this script stands in for them
  const child = spawn(process.execPath, [path.join(repo, "packages/cli/dist/index.js"), "serve", "--port", "0"], { cwd: app, env });
  return new Promise((resolve, reject) => {
    let buf = "";
    child.stdout.on("data", (d) => {
      buf += d;
      const m = /Holdback dashboard: (http:\/\/127\.0\.0\.1:\d+\/)(#token=\w+)?/.exec(buf);
      if (m) {
        if (!m[2]) return reject(new Error(`serve found no dashboard build: ${buf}`));
        resolve({ base: m[1], url: m[1] + m[2], kill: () => child.kill() });
      }
    });
    child.stderr.on("data", (d) => process.stderr.write(d));
    child.on("exit", (c) => reject(new Error(`holdback serve exited ${c}: ${buf}`)));
  });
}

const browser = await chromium.launch();
try {
  // REPLAY
  const st = await staticServer(path.join(dash, "dist-replay"));
  await shoot(browser, st.url, "replay");
  await shoot(browser, st.url, "replay-lightbox", {
    full: false,
    prep: async (page) => {
      await page.locator("[data-ac=ac-2] .thumb").first().click();
      await page.waitForSelector("dialog.lightbox[open] img");
      await page.waitForTimeout(200);
    },
  });
  st.close();

  // LIVE: the real CLI, on the fixture ledger
  const { tmp, app, p } = await liveProject();
  const cli = await cliServe(app);
  await shoot(browser, cli.url, "live");
  {
    const page = await browser.newPage({ viewport: { width: 1440, height: 900 } });
    const api = [];
    page.on("request", (r) => r.url().includes("/api/") && api.push(r.url()));
    await page.goto(cli.base);
    await page.waitForSelector("[data-testid=blocked]");
    await page.screenshot({ path: path.join(out, "live-no-token-1440.png") });
    console.log(`${path.join(out, "live-no-token-1440.png")}  (api requests without a token: ${api.length})`);
    await page.close();
  }
  cli.kill();

  // LIVE: Kane's own questions from the fixture, pending in the browser
  const events = parseEvents(readFileSync(p.ledgerFile, "utf8"));
  const paused = events.find((e) => e.t === "spec.paused");
  const design = events.find((e) => e.t === "design");
  const srv = await serve(p, { port: 0, staticDir: path.join(dash, "dist") });
  const url = `http://127.0.0.1:${srv.port}/#token=${srv.token}`;
  const answered = srv.human.answer(paused.questions);
  await shoot(browser, url, "live-question", { full: false, prep: (page) => page.locator("[data-testid=human]").scrollIntoViewIfNeeded() });
  {
    const page = await browser.newPage({ viewport: { width: 1440, height: 900 } });
    await page.goto(url);
    await settle(page);
    await page.getByRole("button", { name: /Send answers to Kane/ }).click();
    console.log("answered from the page:", JSON.stringify(await answered));
    await page.close();
  }
  const items = design.tests.map((t) => ({ ref: t.id, title: t.title, kind: "test" }));
  const approved = srv.human.approve(items);
  await shoot(browser, url, "live-approve", { full: false, prep: (page) => page.locator("[data-testid=human]").scrollIntoViewIfNeeded() });
  srv.human.rejectAll("shots done");
  await approved.catch(() => {});
  await srv.close();
  rmSync(tmp, { recursive: true, force: true });
} finally {
  await browser.close();
}
