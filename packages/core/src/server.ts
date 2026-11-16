import { randomBytes, timingSafeEqual } from "node:crypto";
import { createServer, type IncomingMessage, type Server, type ServerResponse } from "node:http";
import type { AddressInfo } from "node:net";
import { open, readFile, realpath, stat, type FileHandle } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import type { PendingQuestion } from "./kane/assurance.js";
import type { ApprovalItem, HumanIO } from "./loop/human.js";
import { EVIDENCE_DIR } from "./loop/build.js";
import type { Project } from "./project.js";
import { readEvents } from "./ledger/store.js";
import { snapshot } from "./snapshot.js";

export const DEFAULT_PORT = 4317;
const HOST = "127.0.0.1";
const MAX_BODY = 1_000_000;
const HEARTBEAT_MS = 15_000;
const HEAD_BYTES = 64;

/** What the dashboard shows the human while a run waits for them. */
export type PendingPrompt =
  | { sid: string; kind: "answer"; questions: PendingQuestion[] }
  | { sid: string; kind: "approve"; items: ApprovalItem[] };

type Waiter =
  | { prompt: Extract<PendingPrompt, { kind: "answer" }>; resolve: (a: Record<string, string>) => void; reject: (e: Error) => void }
  | { prompt: Extract<PendingPrompt, { kind: "approve" }>; resolve: (r: string[]) => void; reject: (e: Error) => void };

export class PromptRejected extends Error {
  constructor(readonly status: number, message: string) {
    super(message);
  }
}

/**
 * The human in the loop, in the browser: a question or approval a run raises stays pending until
 * the dashboard POSTs its answer. Nothing resolves on its own.
 */
export class DashboardHumanIO implements HumanIO {
  readonly interactive = true;
  private waiters: Waiter[] = [];

  /** The dashboard is going away: nobody can answer any more, so every waiting run fails instead of hanging. */
  rejectAll(reason: string): void {
    for (const w of this.waiters.splice(0)) w.reject(new Error(reason));
  }

  pending(): PendingPrompt[] {
    return this.waiters.map((w) => w.prompt);
  }

  answer(qs: PendingQuestion[]): Promise<Record<string, string>> {
    return new Promise((resolve, reject) => {
      this.waiters.push({ prompt: { sid: randomBytes(8).toString("hex"), kind: "answer", questions: qs }, resolve, reject });
    });
  }

  approve(items: ApprovalItem[]): Promise<string[]> {
    return new Promise((resolve, reject) => {
      this.waiters.push({ prompt: { sid: randomBytes(8).toString("hex"), kind: "approve", items }, resolve, reject });
    });
  }

  /** Answers the pending question set `sid`; every question must be answered with a string. */
  submitAnswer(sid: unknown, answers: unknown): void {
    const i = this.waiters.findIndex((w) => w.prompt.kind === "answer" && w.prompt.sid === sid);
    const w = this.waiters[i];
    if (!w || w.prompt.kind !== "answer") throw new PromptRejected(409, "no pending question with that sid");
    if (typeof answers !== "object" || answers === null || Array.isArray(answers)) throw new PromptRejected(400, "answers must be an object");
    const rec = answers as Record<string, unknown>;
    const out: Record<string, string> = {};
    for (const qn of w.prompt.questions) {
      const a = rec[qn.id];
      if (typeof a !== "string" || a.trim() === "") throw new PromptRejected(400, `missing answer for ${qn.id}`);
      out[qn.id] = a;
    }
    this.waiters.splice(i, 1);
    (w.resolve as (a: Record<string, string>) => void)(out);
  }

  /** Approves `refs` of the oldest pending approval; refs it did not ask about are refused. */
  submitApproval(refs: unknown): void {
    const i = this.waiters.findIndex((w) => w.prompt.kind === "approve");
    const w = this.waiters[i];
    if (!w || w.prompt.kind !== "approve") throw new PromptRejected(409, "nothing is waiting for approval");
    if (!Array.isArray(refs) || refs.some((r) => typeof r !== "string")) throw new PromptRejected(400, "refs must be a list of strings");
    const known = new Set(w.prompt.items.map((it) => it.ref));
    const unknown = (refs as string[]).filter((r) => !known.has(r));
    if (unknown.length > 0) throw new PromptRejected(400, `unknown refs: ${unknown.join(", ")}`);
    const chosen = new Set(refs as string[]);
    this.waiters.splice(i, 1);
    (w.resolve as (r: string[]) => void)(w.prompt.items.map((it) => it.ref).filter((r) => chosen.has(r)));
  }
}

export type ServeOptions = {
  /** 0 picks a free port. */
  port: number;
  /** A built dashboard to serve at `/`. */
  staticDir?: string;
  /** Pending prompts live here; defaults to a new one. */
  human?: DashboardHumanIO;
  /** How often the ledger file is polled for new lines. */
  pollMs?: number;
};

export type Served = {
  host: string;
  port: number;
  /** Required as `x-holdback-token` on every POST. */
  token: string;
  human: DashboardHumanIO;
  close(): Promise<void>;
};

/** What `/api/artifact` serves: screenshots only. */
const IMAGE_TYPES: Record<string, string> = {
  ".png": "image/png",
  ".jpg": "image/jpeg",
  ".jpeg": "image/jpeg",
  ".webp": "image/webp",
};
const STATIC_TYPES: Record<string, string> = {
  ...IMAGE_TYPES,
  ".json": "application/json; charset=utf-8",
  ".txt": "text/plain; charset=utf-8",
  ".html": "text/html; charset=utf-8",
  ".js": "text/javascript; charset=utf-8",
  ".mjs": "text/javascript; charset=utf-8",
  ".css": "text/css; charset=utf-8",
  ".svg": "image/svg+xml",
  ".ico": "image/x-icon",
  ".map": "application/json; charset=utf-8",
  ".woff2": "font/woff2",
};

/** `~/x` (as Kane may print a path) under the user's home. */
const expandHome = (f: string) => f.replace(/^~(?=[\\/]|$)/, os.homedir());
/** Windows paths compare without case. */
const sameCase = (f: string) => (process.platform === "win32" ? f.toLowerCase() : f);
const outside = (rel: string) => rel === ".." || rel.startsWith(".." + path.sep) || path.isAbsolute(rel);
const within = (root: string, file: string) => !outside(path.relative(root, file));

const json = (res: ServerResponse, status: number, body: unknown) => {
  res.writeHead(status, { "content-type": "application/json; charset=utf-8", "cache-control": "no-store" });
  res.end(JSON.stringify(body));
};

async function readBody(req: IncomingMessage): Promise<unknown> {
  const chunks: Buffer[] = [];
  let size = 0;
  for await (const c of req) {
    size += (c as Buffer).length;
    if (size > MAX_BODY) throw new PromptRejected(413, "body too large");
    chunks.push(c as Buffer);
  }
  try {
    return JSON.parse(Buffer.concat(chunks).toString("utf8"));
  } catch {
    throw new PromptRejected(400, "body is not valid JSON");
  }
}

/** Config the dashboard may show: no start command, env or URLs. */
function configSummary(p: Project) {
  const c = p.config;
  return {
    spec: c.spec,
    start: { port: c.start.port, readyPath: c.start.readyPath },
    agent: { model: c.agent.model ?? null },
    kane: { parallel: c.kane.parallel, timeoutS: c.kane.timeoutS, designMax: c.kane.designMax },
    breaker: { model: c.breaker.model, capUsd: c.breaker.capUsd, parallel: c.breaker.parallel },
    loop: { maxTurns: c.loop.maxTurns },
  };
}

/**
 * `holdback serve`: the ledger and gate as JSON, the ledger as a live event stream, Kane's
 * screenshots, and the answers a human gives in the browser. Loopback only.
 */
export async function serve(p: Project, opts: ServeOptions): Promise<Served> {
  const token = randomBytes(24).toString("hex");
  const human = opts.human ?? new DashboardHumanIO();
  const pollMs = opts.pollMs ?? 500;
  const streams = new Set<ServerResponse>();
  let port = 0;

  const tokenOk = (req: IncomingMessage, url: URL): boolean => {
    // the header, or ?token= for EventSource and <img>, which cannot set headers
    const got = Buffer.from(String(req.headers["x-holdback-token"] ?? url.searchParams.get("token") ?? ""));
    const want = Buffer.from(token);
    return got.length === want.length && timingSafeEqual(got, want);
  };

  /** Serves `file` if its real path stays inside one of `roots`; 403 otherwise, 404 only for a path inside a root. */
  async function sendFile(res: ServerResponse, roots: string[], file: string, types: Record<string, string>): Promise<void> {
    const rawRoots = roots.map((r) => path.resolve(r));
    const lexical = path.resolve(file);
    let real: string;
    try {
      real = await realpath(lexical);
    } catch (e) {
      const code = (e as NodeJS.ErrnoException).code;
      if (code === "ENOENT" || code === "ENOTDIR") {
        // never say whether a file outside the roots exists
        return json(res, rawRoots.some((r) => within(r, lexical)) ? 404 : 403, { error: rawRoots.some((r) => within(r, lexical)) ? "not found" : "outside the allowed folders" });
      }
      throw e;
    }
    const realRoots: string[] = [];
    for (const r of rawRoots) {
      try {
        realRoots.push(await realpath(r));
      } catch {
        // a root that does not exist allows nothing
      }
    }
    if (!realRoots.some((r) => within(r, real))) return json(res, 403, { error: "outside the allowed folders" });
    const type = types[path.extname(real).toLowerCase()];
    if (!type) return json(res, 415, { error: "unsupported file type" });
    const st = await stat(real);
    if (!st.isFile()) return json(res, 404, { error: "not found" });
    const body = await readFile(real);
    res.writeHead(200, { "content-type": type, "content-length": body.length, "cache-control": "no-store", "x-content-type-options": "nosniff" });
    res.end(body);
  }

  /**
   * `/api/artifact` (I9): an exact-file allowlist, after realpath. A file is served only when a run
   * in this project's ledger names it as its screenshot (a build run's or a mutant's), or when it is
   * under `<appDir>/kane-evidence/`; and only an image. 404 only for an allowed file that is gone.
   */
  async function sendArtifact(res: ServerResponse, file: string): Promise<void> {
    const named = new Set<string>();
    for (const e of await readEvents(p.ledgerFile)) {
      if (e.t !== "run" || !e.result.screenshot) continue;
      const shot = path.resolve(expandHome(e.result.screenshot));
      named.add(sameCase(shot));
      try {
        named.add(sameCase(await realpath(shot)));
      } catch {
        /* gone: only its own path is on the list */
      }
    }
    let real: string;
    try {
      real = await realpath(file);
    } catch (e) {
      const code = (e as NodeJS.ErrnoException).code;
      if (code !== "ENOENT" && code !== "ENOTDIR") throw e;
      // never say whether a file nobody named exists
      return named.has(sameCase(file)) ? json(res, 404, { error: "not found" }) : json(res, 403, { error: "not an artifact of this project" });
    }
    const evidence = await realpath(path.join(p.appDir, EVIDENCE_DIR)).catch(() => null);
    const allowed = named.has(sameCase(real)) || (evidence !== null && within(evidence, real));
    if (!allowed) return json(res, 403, { error: "not an artifact of this project" });
    const type = IMAGE_TYPES[path.extname(real).toLowerCase()];
    if (!type) return json(res, 415, { error: "unsupported file type" });
    const st = await stat(real);
    if (!st.isFile()) return json(res, 404, { error: "not found" });
    const body = await readFile(real);
    res.writeHead(200, { "content-type": type, "content-length": body.length, "cache-control": "no-store", "x-content-type-options": "nosniff" });
    res.end(body);
  }

  async function state(res: ServerResponse): Promise<void> {
    const s = await snapshot(p); // a read error throws -> 500, never an empty state
    const acs = Object.values(s.state.acs);
    const counts: Record<string, number> = {};
    for (const a of acs) counts[a.status] = (counts[a.status] ?? 0) + 1;
    const g = s.gate;
    json(res, 200, {
      state: s.state,
      gate: {
        open: g.allowStop && acs.length > 0,
        allowStop: g.allowStop,
        tampered: g.tampered,
        owed: g.owed.map((a) => a.id),
        regressed: g.regressed.map((a) => a.id),
        vacuous: g.vacuous.map((a) => a.id),
        needsSpec: g.needsSpec.map((a) => a.id),
        rejected: g.rejected.map((a) => a.id),
        inconclusive: g.inconclusive,
      },
      config: configSummary(p),
      counts: { events: s.events.length, acs: acs.length, byStatus: counts },
      credits: { kane: s.state.kaneCredits, unmeasured: s.state.kaneUnmeasured },
      breakerUsd: s.state.breakerUsd,
      tamper: s.tamperDetail === null ? null : { detail: s.tamperDetail, marker: s.marker, changed: s.changed },
      specChanged: s.specChanged,
      verdict: s.verdict,
      pending: human.pending(),
    });
  }

  async function events(req: IncomingMessage, res: ServerResponse): Promise<void> {
    // read once before any header goes out: an unreadable ledger is a 500, not an empty stream
    let offset = 0;
    let carry: Buffer = Buffer.alloc(0);
    let head: Buffer = Buffer.alloc(0); // the first bytes already streamed: a replaced file no longer starts with them
    const first = await readFrom(0);
    res.writeHead(200, { "content-type": "text/event-stream; charset=utf-8", "cache-control": "no-store", connection: "keep-alive" });
    res.write(": holdback\n\n");
    streams.add(res);
    let closed = false;
    let busy = false;
    const finish = () => {
      if (closed) return;
      closed = true;
      clearInterval(poll);
      clearInterval(beat);
      streams.delete(res);
      res.end();
    };
    const emit = (buf: Buffer) => {
      if (head.length < HEAD_BYTES) head = Buffer.concat([head, buf]).subarray(0, HEAD_BYTES);
      offset += buf.length;
      const all = Buffer.concat([carry, buf]);
      const cut = all.lastIndexOf(0x0a);
      carry = cut < 0 ? all : all.subarray(cut + 1);
      if (cut < 0) return;
      // decode only complete lines: a multibyte character split across polls is never cut
      for (const line of all.subarray(0, cut).toString("utf8").split("\n")) {
        const l = line.trim();
        if (l) res.write(`event: ledger\ndata: ${l}\n\n`);
      }
    };
    const tick = async () => {
      if (closed || busy) return;
      busy = true;
      try {
        const got = await readFrom(offset, head);
        if (got.reset) {
          offset = 0;
          carry = Buffer.alloc(0);
          head = Buffer.alloc(0);
          res.write("event: reset\ndata: {}\n\n");
          emit(await readFrom(0).then((r) => r.bytes));
        } else if (got.bytes.length > 0) emit(got.bytes);
      } catch (e) {
        if (!closed) res.write(`event: error\ndata: ${JSON.stringify({ error: e instanceof Error ? e.message : String(e) })}\n\n`);
        finish();
      } finally {
        busy = false;
      }
    };
    emit(first.bytes);
    const poll = setInterval(() => void tick(), pollMs);
    const beat = setInterval(() => res.write(": heartbeat\n\n"), HEARTBEAT_MS);
    res.on("close", finish);
    req.on("close", finish);
  }

  /**
   * Bytes of the ledger from `offset`, opened fresh by path each time. `reset` when the file is now
   * shorter than `offset` or no longer starts with the `head` bytes already streamed (replaced).
   */
  async function readFrom(offset: number, head: Buffer = Buffer.alloc(0)): Promise<{ bytes: Buffer; reset: boolean }> {
    let fh: FileHandle;
    try {
      fh = await open(p.ledgerFile, "r");
    } catch (e) {
      if ((e as NodeJS.ErrnoException).code === "ENOENT") return { bytes: Buffer.alloc(0), reset: offset > 0 };
      throw e;
    }
    try {
      const size = (await fh.stat()).size;
      if (size < offset) return { bytes: Buffer.alloc(0), reset: true };
      if (head.length > 0) {
        const h = Buffer.alloc(head.length);
        const { bytesRead } = await fh.read(h, 0, h.length, 0);
        if (bytesRead < head.length || !h.equals(head)) return { bytes: Buffer.alloc(0), reset: true };
      }
      const buf = Buffer.alloc(size - offset);
      const { bytesRead } = await fh.read(buf, 0, buf.length, offset);
      return { bytes: buf.subarray(0, bytesRead), reset: false };
    } finally {
      await fh.close();
    }
  }

  async function handle(req: IncomingMessage, res: ServerResponse): Promise<void> {
    const url = new URL(req.url ?? "/", `http://${HOST}`);
    const route = url.pathname;
    // DNS-rebinding guard: only a loopback Host may talk to us
    const host = (req.headers.host ?? "").replace(/:\d+$/, "").toLowerCase();
    if (host !== "127.0.0.1" && host !== "localhost" && host !== "[::1]") return json(res, 403, { error: "bad host" });

    // every API route needs the per-process token: the coding agent shares this machine and must not read the ledger
    if (route.startsWith("/api/") && !tokenOk(req, url)) return json(res, 403, { error: "missing or wrong x-holdback-token" });

    if (req.method === "POST") {
      if (route !== "/api/answer" && route !== "/api/approve") return json(res, 404, { error: "not found" });
      // a 409 for "nothing pending" comes before the body is looked at
      const pending = human.pending();
      if (!pending.some((x) => x.kind === (route === "/api/answer" ? "answer" : "approve"))) return json(res, 409, { error: "nothing is pending" });
      const body = (await readBody(req)) as Record<string, unknown> | null;
      if (typeof body !== "object" || body === null) return json(res, 400, { error: "body must be an object" });
      if (route === "/api/answer") human.submitAnswer(body.sid, body.answers);
      else human.submitApproval(body.refs);
      return json(res, 200, { ok: true });
    }
    if (req.method !== "GET" && req.method !== "HEAD") return json(res, 405, { error: "method not allowed" });

    if (route === "/api/state") return await state(res);
    if (route === "/api/events") return await events(req, res);
    if (route === "/api/ledger.jsonl") {
      let raw: string;
      try {
        raw = await readFile(p.ledgerFile, "utf8");
      } catch (e) {
        if ((e as NodeJS.ErrnoException).code !== "ENOENT") throw e;
        raw = "";
      }
      res.writeHead(200, { "content-type": "application/x-ndjson; charset=utf-8", "cache-control": "no-store" });
      return void res.end(raw);
    }
    if (route === "/api/artifact") {
      const q = url.searchParams.get("path");
      if (!q) return json(res, 400, { error: "path is required" });
      if (!path.isAbsolute(expandHome(q))) return json(res, 400, { error: "path must be absolute" });
      return await sendArtifact(res, path.resolve(expandHome(q)));
    }
    if (route.startsWith("/api/")) return json(res, 404, { error: "not found" });
    if (opts.staticDir) {
      let rel: string;
      try {
        rel = decodeURIComponent(route);
      } catch {
        return json(res, 400, { error: "bad path" });
      }
      const file = path.join(opts.staticDir, rel === "/" ? "index.html" : rel);
      const target = await stat(file).then((s) => (s.isFile() ? file : null), () => null);
      return await sendFile(res, [opts.staticDir], target ?? path.join(opts.staticDir, "index.html"), STATIC_TYPES);
    }
    return json(res, 404, { error: "not found" });
  }

  const server: Server = createServer((req, res) => {
    handle(req, res).catch((e: unknown) => {
      if (res.headersSent) return void res.end();
      if (e instanceof PromptRejected) return json(res, e.status, { error: e.message });
      json(res, 500, { error: e instanceof Error ? e.message : String(e) });
    });
  });

  await new Promise<void>((resolve, reject) => {
    server.once("error", reject);
    server.listen(opts.port, HOST, () => {
      server.off("error", reject);
      port = (server.address() as AddressInfo).port;
      resolve();
    });
  });

  return {
    host: HOST,
    port,
    token,
    human,
    close: () =>
      new Promise<void>((resolve) => {
        human.rejectAll("the dashboard server closed");
        for (const s of streams) s.end();
        server.close(() => resolve());
        server.closeAllConnections();
      }),
  };
}
