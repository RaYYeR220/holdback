/* eslint-disable @typescript-eslint/no-explicit-any */
import { request } from "node:http";
import { appendFileSync, mkdirSync, mkdtempSync, rmSync, symlinkSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { appendEvent, loadProject, parseEvents, reduce, serve, type LedgerEvent, type PendingQuestion } from "../src/index.js";

const rawFetch = globalThis.fetch;
/** fetch with the running server's token, unless a test passes its own header (or uses rawFetch). */
const fetch: typeof rawFetch = (url, init) => rawFetch(url, { ...init, headers: { "x-holdback-token": srv?.token ?? "", ...(init?.headers as Record<string, string> | undefined) } });
type Served = Awaited<ReturnType<typeof serve>>;
const at = "2026-01-01T00:00:00.000Z";
const ev = (e: object) => e as LedgerEvent;
const q: PendingQuestion = { id: "q1", text: "Which currency?", risk: "low", rationale: "", options: [{ label: "EUR" }, { label: "USD" }], recommendedIndex: 0, allowFreeText: false };

let tmp: string;
let srv: Served | undefined;
let sessions: string;
let prevHome: string | undefined;

beforeEach(() => {
  tmp = mkdtempSync(join(tmpdir(), "hb-srv-"));
  prevHome = process.env.HOLDBACK_HOME;
  process.env.HOLDBACK_HOME = join(tmp, "home");
  sessions = join(tmp, "sessions");
  mkdirSync(sessions, { recursive: true });
});
afterEach(async () => {
  await srv?.close();
  srv = undefined;
  if (prevHome === undefined) delete process.env.HOLDBACK_HOME;
  else process.env.HOLDBACK_HOME = prevHome;
  rmSync(tmp, { recursive: true, force: true });
});

async function start(setup?: (p: Awaited<ReturnType<typeof loadProject>>) => Promise<void> | void) {
  const app = join(tmp, "app");
  mkdirSync(app, { recursive: true });
  const p = await loadProject(app);
  await setup?.(p);
  srv = await serve(p, { port: 0, sessionsDir: sessions, pollMs: 25 });
  return { p, s: srv, base: `http://127.0.0.1:${srv.port}` };
}
const post = (base: string, path: string, body: unknown, token?: string) =>
  rawFetch(base + path, { method: "POST", headers: { "content-type": "application/json", ...(token ? { "x-holdback-token": token } : {}) }, body: JSON.stringify(body) });

describe("server", () => {
  it("binds 127.0.0.1 and /api/state equals reduce", async () => {
    const { base, s } = await start(async (p) => {
      await appendEvent(p.ledgerFile, ev({ at, t: "turn.start", n: 1, owed: [] }));
      await appendEvent(p.ledgerFile, ev({ at, t: "turn.start", n: 2, owed: [] }));
    });
    expect(s.host).toBe("127.0.0.1");
    const r = await fetch(`${base}/api/state`);
    expect(r.status).toBe(200);
    const body = (await r.json()) as any;
    const raw = await (await fetch(`${base}/api/ledger.jsonl`)).text();
    expect(body.state).toEqual(JSON.parse(JSON.stringify(reduce(parseEvents(raw)))));
    expect(body.state.turn).toBe(2);
    expect(body.gate).toBeDefined();
    expect(body.config.start.env).toBeUndefined();
    expect(body.pending).toEqual([]);
  });

  it("a ledger read error is a 500, never an empty state", async () => {
    // a directory where the ledger file should be: readFile fails with EISDIR, not ENOENT
    const { base } = await start((p) => {
      mkdirSync(p.ledgerFile, { recursive: true });
    });
    const r = await fetch(`${base}/api/state`);
    expect(r.status).toBe(500);
    expect(typeof ((await r.json()) as any).error).toBe("string");
  });

  it("SSE replays the ledger then delivers an event appended after connect", async () => {
    const { p, base } = await start((p) => appendEvent(p.ledgerFile, ev({ at, t: "turn.start", n: 1, owed: [] })));
    const ctl = new AbortController();
    const res = await fetch(`${base}/api/events`, { signal: ctl.signal });
    expect(res.headers.get("content-type")).toContain("text/event-stream");
    const reader = res.body!.getReader();
    const dec = new TextDecoder();
    let buf = "";
    const until = async (needle: string) => {
      const deadline = Date.now() + 5000;
      while (!buf.includes(needle) && Date.now() < deadline) {
        const { value, done } = await reader.read();
        if (done) break;
        buf += dec.decode(value);
      }
      expect(buf).toContain(needle);
    };
    await until('"n":1');
    expect(buf).toContain("event: ledger");
    appendFileSync(p.ledgerFile, JSON.stringify(ev({ at, t: "turn.start", n: 7, owed: [] })) + "\n");
    await until('"n":7');
    ctl.abort();
  });

  describe("artifact", () => {
    it("serves a file under the sessions dir with its content type", async () => {
      writeFileSync(join(sessions, "a.png"), "PNG");
      const { base } = await start();
      const r = await fetch(`${base}/api/artifact?path=${encodeURIComponent(join(sessions, "a.png"))}`);
      expect(r.status).toBe(200);
      expect(r.headers.get("content-type")).toBe("image/png");
      expect(await r.text()).toBe("PNG");
    });

    it("serves kane-evidence under the app dir; relative paths are refused", async () => {
      const { base, p } = await start((p) => {
        mkdirSync(join(p.appDir, "kane-evidence", "turn-1"), { recursive: true });
        writeFileSync(join(p.appDir, "kane-evidence", "turn-1", "t-step-1.png"), "E");
      });
      const abs = join(p.appDir, "kane-evidence", "turn-1", "t-step-1.png");
      expect((await fetch(`${base}/api/artifact?path=${encodeURIComponent(abs)}`)).status).toBe(200);
      expect((await fetch(`${base}/api/artifact?path=${encodeURIComponent("kane-evidence/turn-1/t-step-1.png")}`)).status).toBe(400);
    });

    it("403 outside the roots, incl. a ..x sibling, traversal and a junction", async () => {
      const sibling = join(tmp, "sessions..x");
      mkdirSync(sibling);
      writeFileSync(join(sibling, "s.png"), "no");
      const outside = join(tmp, "outside");
      mkdirSync(outside);
      writeFileSync(join(outside, "secret.txt"), "no");
      symlinkSync(outside, join(sessions, "link"), "junction");
      const { base } = await start();
      const get = (p: string) => fetch(`${base}/api/artifact?path=${encodeURIComponent(p)}`);
      expect((await get(join(sibling, "s.png"))).status).toBe(403);
      expect((await get(join(sessions, "..", "outside", "secret.txt"))).status).toBe(403);
      expect((await get(join(sessions, "link", "secret.txt"))).status).toBe(403);
      expect((await get(join(tmp, "outside", "nope.txt"))).status).toBe(403);
      expect((await get(join(sessions, "missing.png"))).status).toBe(404);
      expect((await fetch(`${base}/api/artifact`)).status).toBe(400);
    });
  });

  describe("human prompts", () => {
    it("POST without or with a wrong token is 403", async () => {
      const { base } = await start();
      expect((await post(base, "/api/answer", { sid: "x", answers: {} })).status).toBe(403);
      expect((await post(base, "/api/approve", { refs: [] }, "wrong")).status).toBe(403);
    });

    it("409 when nothing is pending", async () => {
      const { base, s } = await start();
      expect((await post(base, "/api/answer", { sid: "x", answers: {} }, s.token)).status).toBe(409);
      expect((await post(base, "/api/approve", { refs: [] }, s.token)).status).toBe(409);
    });

    it("answer and approve resolve a pending dashboard prompt", async () => {
      const { base, s } = await start();
      const answered = s.human.answer([q]);
      let state = (await (await fetch(`${base}/api/state`)).json()) as any;
      expect(state.pending).toHaveLength(1);
      const sid = state.pending[0].sid;
      expect(state.pending[0].kind).toBe("answer");
      expect((await post(base, "/api/answer", { sid: "stale", answers: { q1: "EUR" } }, s.token)).status).toBe(409);
      expect((await post(base, "/api/answer", { sid, answers: {} }, s.token)).status).toBe(400);
      expect((await post(base, "/api/answer", { sid, answers: { q1: "USD" } }, s.token)).status).toBe(200);
      expect(await answered).toEqual({ q1: "USD" });

      const approved = s.human.approve([{ ref: "ac-1", title: "t", kind: "ac" }, { ref: "ac-2", title: "u", kind: "ac" }]);
      state = (await (await fetch(`${base}/api/state`)).json()) as any;
      expect(state.pending[0].kind).toBe("approve");
      expect((await post(base, "/api/approve", { refs: ["zzz"] }, s.token)).status).toBe(400);
      expect((await post(base, "/api/approve", { refs: ["ac-2"] }, s.token)).status).toBe(200);
      expect(await approved).toEqual(["ac-2"]);
      expect(((await (await fetch(`${base}/api/state`)).json()) as any).pending).toEqual([]);
    });
  });

  it("404s an unknown route", async () => {
    const { base } = await start();
    expect((await fetch(`${base}/api/nope`)).status).toBe(404);
  });

  it("every /api route needs the token: without or with a wrong one is 403", async () => {
    const { base, s } = await start();
    for (const route of ["/api/state", "/api/events", "/api/ledger.jsonl", "/api/artifact?path=x", "/api/nope"]) {
      expect((await rawFetch(base + route)).status, route).toBe(403);
      expect((await rawFetch(base + route, { headers: { "x-holdback-token": "wrong" } })).status, route).toBe(403);
    }
    expect((await rawFetch(`${base}/api/state?token=${s.token}`)).status).toBe(200);
  });

  it("a foreign Host header is 403 (DNS rebinding)", async () => {
    const { s } = await start();
    const status = await new Promise<number>((resolve, reject) => {
      const rq = request({ host: "127.0.0.1", port: s.port, path: "/api/state", headers: { host: "evil.example", "x-holdback-token": s.token } }, (r) => (r.resume(), resolve(r.statusCode ?? 0)));
      rq.on("error", reject);
      rq.end();
    });
    expect(status).toBe(403);
  });

  it("413 on a body over the cap", async () => {
    const { base, s } = await start();
    void s.human.approve([{ ref: "a", title: "t", kind: "ac" }]).catch(() => {});
    const r = await rawFetch(base + "/api/approve", { method: "POST", headers: { "x-holdback-token": s.token }, body: "x".repeat(1_100_000) });
    expect(r.status).toBe(413);
  });

  it("close() rejects waiting dashboard prompts", async () => {
    const { s } = await start();
    const caught = s.human.answer([q]).catch((e: Error) => e.message);
    await s.close();
    expect(await caught).toContain("closed");
    srv = undefined;
  });

  it("config summary carries only whitelisted keys", async () => {
    const { base } = await start();
    const body = (await (await fetch(`${base}/api/state`)).json()) as any;
    expect(Object.keys(body.config).sort()).toEqual(["agent", "breaker", "kane", "loop", "spec", "start"]);
    expect(Object.keys(body.config.start).sort()).toEqual(["port", "readyPath"]);
    expect(Object.keys(body.config.agent)).toEqual(["model"]);
  });

  it("SSE never cuts a multibyte character split across two polls", async () => {
    const { p, base } = await start();
    const bytes = Buffer.from(JSON.stringify(ev({ at, t: "turn.start", n: 3, owed: ["é€"] })) + "\n", "utf8");
    const cut = bytes.indexOf(0xe2) + 1; // inside the 3-byte euro sign
    appendFileSync(p.ledgerFile, bytes.subarray(0, cut));
    const ctl = new AbortController();
    const res = await fetch(`${base}/api/events`, { signal: ctl.signal });
    const reader = res.body!.getReader();
    await new Promise((r) => setTimeout(r, 150)); // several polls see only the first half
    appendFileSync(p.ledgerFile, bytes.subarray(cut));
    const dec = new TextDecoder();
    let buf = "";
    const deadline = Date.now() + 5000;
    while (!buf.includes("€") && Date.now() < deadline) {
      const { value, done } = await reader.read();
      if (done) break;
      buf += dec.decode(value, { stream: true });
    }
    expect(buf).toContain('"owed":["é€"]');
    expect(buf).not.toContain("�");
    ctl.abort();
  });

  it("SSE restarts the replay when the ledger file is replaced by a larger one", async () => {
    const { p, base } = await start((p) => appendEvent(p.ledgerFile, ev({ at, t: "turn.start", n: 1, owed: [] })));
    const ctl = new AbortController();
    const res = await fetch(`${base}/api/events`, { signal: ctl.signal });
    const reader = res.body!.getReader();
    const dec = new TextDecoder();
    let buf = "";
    const until = async (needle: string) => {
      const deadline = Date.now() + 5000;
      while (!buf.includes(needle) && Date.now() < deadline) {
        const { value, done } = await reader.read();
        if (done) break;
        buf += dec.decode(value);
      }
      expect(buf).toContain(needle);
    };
    await until('"n":1');
    const line = (n: number) => JSON.stringify(ev({ at: "2027-05-05T00:00:00.000Z", t: "turn.start", n, owed: ["padding-padding-padding"] })) + "\n";
    writeFileSync(p.ledgerFile, line(21) + line(22) + line(23));
    await until('"n":23');
    expect(buf).toContain("event: reset");
    expect(buf).toContain('"n":21');
    ctl.abort();
  });

  describe("static dashboard", () => {
    async function withStatic(setup?: (dir: string) => void) {
      const dir = join(tmp, "dash");
      mkdirSync(join(dir, "assets"), { recursive: true });
      writeFileSync(join(dir, "index.html"), "<html>INDEX</html>");
      writeFileSync(join(dir, "assets", "app.js"), "console.log(1)");
      writeFileSync(join(tmp, "secret.txt"), "secret");
      setup?.(dir);
      const app = join(tmp, "app");
      mkdirSync(app, { recursive: true });
      srv = await serve(await loadProject(app), { port: 0, staticDir: dir, sessionsDir: sessions });
      return `http://127.0.0.1:${srv.port}`;
    }
    const rawStatus = (base: string, p: string) =>
      new Promise<number>((resolve, reject) => {
        const rq = request({ host: "127.0.0.1", port: Number(new URL(base).port), path: p, method: "GET" }, (r) => (r.resume(), resolve(r.statusCode ?? 0)));
        rq.on("error", reject);
        rq.end();
      });

    it("serves index.html and assets without a token", async () => {
      const base = await withStatic();
      const r = await rawFetch(base + "/");
      expect(r.status).toBe(200);
      expect(r.headers.get("content-type")).toContain("text/html");
      expect(await r.text()).toContain("INDEX");
      expect((await rawFetch(base + "/assets/app.js")).headers.get("content-type")).toContain("javascript");
    });

    it("falls back to index.html for an unknown client route", async () => {
      const base = await withStatic();
      const r = await rawFetch(base + "/some/client/route");
      expect(r.status).toBe(200);
      expect(await r.text()).toContain("INDEX");
    });

    it("never leaves the static root: traversal and a junction are 403", async () => {
      const base = await withStatic((dir) => symlinkSync(tmp, join(dir, "escape"), "junction"));
      expect(await rawStatus(base, "/..%2fsecret.txt")).toBe(403);
      expect(await rawStatus(base, "/escape/secret.txt")).toBe(403);
    });
  });
});
