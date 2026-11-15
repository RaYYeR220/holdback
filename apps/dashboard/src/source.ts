import { parseEvents } from "@holdback/core/browser";
import type { LedgerEvent } from "@holdback/core/browser";
import { parseEvalSummary, stateFromLedger, type ApiState, type ConfigSummary, type EvalSummary } from "./model";

export type Mode = "live" | "replay";

export type Snapshot = { mode: Mode; events: LedgerEvent[]; api: ApiState };

export type Status =
  | { kind: "loading" }
  | { kind: "no-token" }
  | { kind: "denied" }
  | { kind: "error"; message: string }
  | { kind: "ready"; snap: Snapshot; stream: "open" | "connecting" | "closed" | "static" };

/* ------------------------------------------------------------------ token */

/** The API token from the URL fragment (`#token=…`), which never reaches a server or a log. */
export function readToken(hash: string): string | null {
  const h = hash.startsWith("#") ? hash.slice(1) : hash;
  for (const part of h.split("&")) {
    const [k, ...rest] = part.split("=");
    if (k !== "token") continue;
    let v: string;
    try {
      v = decodeURIComponent(rest.join("="));
    } catch {
      return null;
    }
    return /^[A-Za-z0-9_-]{8,256}$/.test(v) ? v : null;
  }
  return null;
}

/* ------------------------------------------------------------------ artifacts */

/**
 * Where the page loads a screenshot the ledger names. Live: an absolute path through
 * /api/artifact (the server allows only Kane's sessions and the evidence folder). Replay: only
 * `artifacts/<file>` next to the page; anything else in a recorded ledger is not shown.
 */
export function artifactUrl(mode: Mode, p: string | undefined, token: string | null): string | null {
  if (!p) return null;
  if (mode === "replay") return /^artifacts\/[A-Za-z0-9._-]+\.(png|jpe?g|webp)$/i.test(p) ? `./${p}` : null;
  if (!token) return null;
  const abs = /^[A-Za-z]:[\\/]/.test(p) || p.startsWith("/") || p.startsWith("\\\\");
  if (!abs) return null;
  return `/api/artifact?path=${encodeURIComponent(p)}&token=${encodeURIComponent(token)}`;
}

/* ------------------------------------------------------------------ the eval summary */

export async function loadEval(fetcher: typeof fetch = fetch): Promise<EvalSummary | null> {
  try {
    const r = await fetcher("./eval-summary.json", { cache: "no-store" });
    if (!r.ok) return null;
    return parseEvalSummary(await r.json());
  } catch {
    return null;
  }
}

/* ------------------------------------------------------------------ replay */

/** A recorded run: ./ledger.jsonl (and ./config.json, when there is one), reduced in the browser. */
export async function loadReplay(fetcher: typeof fetch = fetch): Promise<Snapshot> {
  const r = await fetcher("./ledger.jsonl", { cache: "no-store" });
  if (!r.ok) throw new Error(`ledger.jsonl: HTTP ${r.status}`);
  const events = parseEvents(await r.text());
  let config: ConfigSummary | null = null;
  try {
    const c = await fetcher("./config.json", { cache: "no-store" });
    if (c.ok) config = (await c.json()) as ConfigSummary;
  } catch {
    // no config: the breaker cap and turn limit show as unknown
  }
  return { mode: "replay", events, api: stateFromLedger(events, config) };
}

/* ------------------------------------------------------------------ live */

export type LiveDeps = {
  fetch: typeof fetch;
  EventSource: typeof EventSource;
  /** How often /api/state is polled for prompts that wait without a ledger line. */
  pollMs?: number;
};

export type Live = {
  close(): void;
  answer(sid: string, answers: Record<string, string>): Promise<void>;
  approve(refs: string[]): Promise<void>;
};

class Denied extends Error {}

/**
 * Talks to `holdback serve`: GET /api/state (the gate as the server sees it, prompts included),
 * the ledger as a server-sent event stream, and the human's answers. Without a token it makes no
 * request at all and says so.
 */
export function connectLive(hash: string, deps: LiveDeps, onStatus: (s: Status) => void): Live | null {
  const token = readToken(hash);
  if (!token) {
    onStatus({ kind: "no-token" });
    return null;
  }
  const headers = { "x-holdback-token": token };
  let events: LedgerEvent[] = [];
  let api: ApiState | null = null;
  let stream: "open" | "connecting" | "closed" = "connecting";
  let closed = false;
  let refetch: ReturnType<typeof setTimeout> | undefined;

  const emit = () => {
    if (closed || !api) return;
    onStatus({ kind: "ready", snap: { mode: "live", events, api }, stream });
  };

  const fetchState = async () => {
    try {
      const r = await deps.fetch("/api/state", { headers, cache: "no-store" });
      if (r.status === 403) throw new Denied();
      if (!r.ok) throw new Error(`/api/state: HTTP ${r.status}`);
      api = (await r.json()) as ApiState;
      emit();
    } catch (e) {
      if (closed) return;
      if (e instanceof Denied) {
        onStatus({ kind: "denied" });
        close();
      } else if (!api) onStatus({ kind: "error", message: e instanceof Error ? e.message : String(e) });
      else {
        stream = "closed";
        emit();
      }
    }
  };
  const soon = () => {
    clearTimeout(refetch);
    refetch = setTimeout(() => void fetchState(), 150);
  };

  const es = new deps.EventSource(`/api/events?token=${encodeURIComponent(token)}`);
  // every (re)connection streams the whole ledger again from its first line
  es.onopen = () => {
    events = [];
    stream = "open";
    emit();
  };
  es.addEventListener("ledger", (m) => {
    try {
      const e = JSON.parse((m as MessageEvent<string>).data) as LedgerEvent;
      if (e && typeof e === "object" && typeof e.t === "string") events = [...events, e];
    } catch {
      return; // a line that is not JSON: the reducer would skip it too
    }
    soon();
  });
  es.addEventListener("reset", () => {
    events = [];
    soon();
  });
  es.onerror = () => {
    stream = es.readyState === 2 ? "closed" : "connecting";
    emit();
  };

  void fetchState();
  const poll = setInterval(() => void fetchState(), deps.pollMs ?? 2000);

  function close() {
    closed = true;
    clearInterval(poll);
    clearTimeout(refetch);
    es.close();
  }

  const post = async (route: string, body: unknown) => {
    const r = await deps.fetch(route, { method: "POST", headers: { ...headers, "content-type": "application/json" }, body: JSON.stringify(body) });
    if (!r.ok) {
      let msg = `HTTP ${r.status}`;
      try {
        msg = ((await r.json()) as { error?: string }).error ?? msg;
      } catch {
        // keep the status
      }
      throw new Error(msg);
    }
    await fetchState();
  };

  return {
    close,
    answer: (sid, answers) => post("/api/answer", { sid, answers }),
    approve: (refs) => post("/api/approve", { refs }),
  };
}
