import { describe, expect, it, vi } from "vitest";
import { connectLive, readToken, type Status } from "../src/source";

class FakeES {
  static made: FakeES[] = [];
  readyState = 0;
  onopen: (() => void) | null = null;
  onerror: (() => void) | null = null;
  listeners = new Map<string, (m: { data: string }) => void>();
  closed = false;
  constructor(readonly url: string) {
    FakeES.made.push(this);
  }
  addEventListener(t: string, fn: (m: { data: string }) => void) {
    this.listeners.set(t, fn);
  }
  close() {
    this.closed = true;
  }
}

const deps = (fetchImpl: typeof fetch) => ({ fetch: vi.fn(fetchImpl) as unknown as typeof fetch, EventSource: FakeES as unknown as typeof EventSource, pollMs: 60_000 });

describe("the token", () => {
  it("is read from the fragment only, and must look like one", () => {
    const t = "a".repeat(48);
    expect(readToken(`#token=${t}`)).toBe(t);
    expect(readToken(`#foo=1&token=${t}`)).toBe(t);
    expect(readToken("")).toBeNull();
    expect(readToken("#token=")).toBeNull();
    expect(readToken("#token=short")).toBeNull();
    expect(readToken("#token=abc%")).toBeNull();
    expect(readToken("#token=<script>alert(1)</script>")).toBeNull();
    expect(readToken(`#tokens=${t}`)).toBeNull();
  });

  it("missing: says so and makes no request at all", () => {
    for (const hash of ["", "#", "#token=", "#other=1"]) {
      FakeES.made = [];
      const d = deps(async () => new Response("{}"));
      const seen: Status[] = [];
      const live = connectLive(hash, d, (s) => seen.push(s));
      expect(live).toBeNull();
      expect(seen).toEqual([{ kind: "no-token" }]);
      expect(d.fetch).not.toHaveBeenCalled();
      expect(FakeES.made).toEqual([]);
    }
  });

  it("present: rides in the header for fetch and in the query for the event stream", async () => {
    FakeES.made = [];
    const token = "f".repeat(48);
    const d = deps(async () => new Response(JSON.stringify({ state: { acs: {} }, gate: {}, pending: [] })));
    const seen: Status[] = [];
    const live = connectLive(`#token=${token}`, d, (s) => seen.push(s));
    await vi.waitFor(() => expect(seen.some((s) => s.kind === "ready")).toBe(true));
    const [url, init] = (d.fetch as unknown as ReturnType<typeof vi.fn>).mock.calls[0]!;
    expect(url).toBe("/api/state");
    expect((init as RequestInit).headers).toEqual({ "x-holdback-token": token });
    expect(FakeES.made[0]!.url).toBe(`/api/events?token=${token}`);
    live!.close();
    expect(FakeES.made[0]!.closed).toBe(true);
  });

  it("refused: says so and stops", async () => {
    FakeES.made = [];
    const d = deps(async () => new Response(JSON.stringify({ error: "missing or wrong x-holdback-token" }), { status: 403 }));
    const seen: Status[] = [];
    connectLive(`#token=${"0".repeat(48)}`, d, (s) => seen.push(s));
    await vi.waitFor(() => expect(seen.at(-1)).toEqual({ kind: "denied" }));
    expect(FakeES.made[0]!.closed).toBe(true);
  });
});
