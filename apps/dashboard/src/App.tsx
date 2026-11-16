import { useEffect, useMemo, useRef, useState } from "react";
import { Board } from "./Board";
import { board, byId, driftRows, fmtClock, fmtDay, gateLabel, meters, timeline, verdictOf, type ApiState, type EvalSummary } from "./model";
import { Drift, HumanPanel, Inbox, Meters, Scoreboard } from "./Panels";
import { connectLive, loadEval, loadReplay, readToken, type Live, type Snapshot, type Status } from "./source";
import { Timeline } from "./Timeline";
import { AppCtx, Brand, GatePill, Lightbox, Ring, Section, type Shot } from "./ui";

export const REPLAY = import.meta.env.VITE_REPLAY === "1";

function lede(api: ApiState): string {
  const g = api.gate;
  const n = api.counts.acs;
  const v = verdictOf(api);
  if (n === 0) return "No acceptance criteria yet. Run holdback spec: Kane reads the spec, asks what is ambiguous and designs the tests.";
  if (api.tamper || v.state === "tampered") return "A tamper is on record. Nothing Kane verified since can be trusted until a human re-seals the tests, so done stays held back whatever the board says.";
  if (v.released) return `All ${v.counts.criteria} criteria pass in a real browser, ${v.counts.proved} of them proved by a planted bug Kane caught. Done was Kane's call, not the agent's.`;
  if (g.open) {
    // the build loop's gate is open, but the run is held back: what is left is Kane's and the human's, not the agent's
    const why: string[] = [];
    const vac = v.counts.vacuous;
    const bare = v.counts.needsSpec;
    if (vac) why.push(`${vac} ${vac === 1 ? "criterion is" : "criteria are"} unproved: a planted bug got past ${vac === 1 ? "its" : "their"} tests`);
    if (bare) why.push(`${bare} ${bare === 1 ? "criterion has" : "criteria have"} no test`);
    return `${v.counts.green} of ${v.counts.criteria} criteria pass in a real browser, but ${why.join(", and ")}. Held back: \`holdback run\` exits 3 until every one is proved or passing.`;
  }
  const owed = g.owed.length + g.regressed.length;
  const parts = [`${owed} of ${n} criteria still owed`];
  if (g.regressed.length) parts.push(`${g.regressed.length} of them broke again after passing`);
  if (g.inconclusive.length) parts.push(`${g.inconclusive.length} ${g.inconclusive.length === 1 ? "test" : "tests"} proved nothing on the last run`);
  return `${parts.join(", ")}. Claude Code can't say done until Kane passes each one in a real browser.`;
}

function Head({ snap }: { snap: Snapshot }) {
  const { api, events } = snap;
  const g = gateLabel(api);
  const acs = Object.values(api.state.acs).sort((a, b) => byId(a.id, b.id));
  const first = events[0]?.at;
  const last = events.at(-1)?.at;
  const facts: [string, React.ReactNode][] = [
    ["Spec", api.config ? api.config.spec.join(", ") : "–"],
    ["Agent", `Claude Code${api.config?.agent.model ? ` · ${api.config.agent.model}` : ""}`],
    ["Verifier", "Kane CLI, sealed tests"],
    ["Breaker", api.config ? api.config.breaker.model : "–"],
    [
      "Ledger",
      <span className="mono" key="l">
        {api.counts.events} events{first && last ? ` · ${fmtClock(first)} → ${fmtClock(last)} UTC` : ""}
      </span>,
    ],
  ];
  return (
    <section className="head" aria-labelledby="head-h">
      <div className="head-l">
        <p className="eyebrow">
          {snap.mode === "replay" ? "Replay of a recorded run" : "Live"}
          {first && <span className="mono"> · {fmtDay(first)}</span>}
        </p>
        <h1 id="head-h" className={g.open ? "open" : ""}>
          {g.word}.
        </h1>
        <p className="lede">{lede(api)}</p>
      </div>
      <dl className="facts">
        {facts.map(([k, v]) => (
          <div key={k}>
            <dt>{k}</dt>
            <dd>{v}</dd>
          </div>
        ))}
      </dl>
      {acs.length > 0 && (
        <ol className="strip" aria-label="Every criterion and its status">
          {acs.map((a) => (
            <li key={a.id} title={`${a.id} · ${a.status}: ${a.text}`}>
              <button type="button" onClick={() => document.querySelector(`[data-ac="${a.id}"]`)?.scrollIntoView({ behavior: "smooth", block: "center" })}>
                <Ring status={a.status} size={18} title={`${a.id} ${a.status}`} />
                <span className="mono">{a.id}</span>
              </button>
            </li>
          ))}
        </ol>
      )}
    </section>
  );
}

function Notices({ api }: { api: ApiState }) {
  return (
    <>
      {api.tamper && (
        <div className="notice notice-alarm" role="alert">
          <b>Tamper on record.</b> {api.tamper.detail}
          {api.tamper.changed.length > 0 && <span className="mono"> ({api.tamper.changed.join(", ")})</span>} A human lifts it with <code>holdback reseal</code>, never the agent.
        </div>
      )}
      {api.gate.inconclusive.length > 0 && (
        <div className="notice" role="status">
          <b>Inconclusive.</b>{" "}
          {api.gate.inconclusive.map((u, i) => (
            <span key={u.test}>
              {i > 0 && "; "}
              <span className="mono">{u.test}</span>
              {u.turn !== undefined ? ` (turn ${u.turn})` : ""}: {u.reason}
            </span>
          ))}
          . The gate stays shut until Kane runs {api.gate.inconclusive.length === 1 ? "it" : "them"} conclusively; the agent's brief never names them.
        </div>
      )}
    </>
  );
}

function Dashboard({ snap, stream, summary, live }: { snap: Snapshot; stream: string; summary: EvalSummary | null; live: Live | null }) {
  const { api, events } = snap;
  const cols = useMemo(() => board(api, events), [api, events]);
  const segs = useMemo(() => timeline(events), [events]);
  const m = useMemo(() => meters(api, events), [api, events]);
  const drift = useMemo(() => driftRows(events), [events]);
  const g = gateLabel(api);
  // an agent turn with no end on record is "running" only while the stream is up and the ledger is fresh
  const lastAt = events.at(-1)?.at;
  const running = snap.mode === "live" && stream === "open" && lastAt !== undefined && Date.now() - Date.parse(lastAt) < 30 * 60_000;
  useEffect(() => {
    document.title = `${g.word} · ${g.parts.join(" · ")} · Holdback`;
  }, [g.word, g.parts.join()]);

  return (
    <div className="app" data-mode={snap.mode}>
      <header className="top">
        <div className="wrap top-in">
          <Brand />
          <span className={`mode mode-${snap.mode} st-${stream}`}>
            <i aria-hidden="true" />
            {snap.mode === "replay" ? "Replay" : stream === "open" ? "Live" : stream === "connecting" ? "Reconnecting" : "Disconnected"}
          </span>
          {snap.mode === "live" && <Inbox pending={api.pending.length} />}
          <GatePill api={api} />
        </div>
      </header>
      <main className="wrap" id="main">
        <Head snap={snap} />
        <Notices api={api} />
        {snap.mode === "live" && live && <HumanPanel pending={api.pending} answer={live.answer} approve={live.approve} />}
        <Section
          id="criteria"
          title="Criteria"
          note="Each one cites its spec line. Kane decides its column; the agent only ever sees bug reports for what is owed."
          aside={<p className="sec-aside mono">{api.counts.acs} criteria · {new Set(Object.values(api.state.acs).flatMap((a) => a.tests)).size} tests</p>}
        >
          <Board cols={cols} />
        </Section>
        <div className="split">
          <Section id="loop" title="Loop" note="Every agent turn, every Kane run after it, and every bug the breaker planted, in ledger order.">
            <Timeline segs={segs} live={running} />
          </Section>
          <aside className="side">
            <Section id="meters" title="Spend" className="sec-side">
              <Meters m={m} />
            </Section>
            <Section id="drift" title="Spec drift" className="sec-side">
              <Drift rows={drift} specChanged={api.specChanged} live={snap.mode === "live"} />
            </Section>
          </aside>
        </div>
        <Section
          id="exam"
          title="Exam"
          note="22 browser cases the build never sees, written before any arm ran. Each arm's final app is scored once."
          aside={!summary ? <p className="sec-aside mono">results pending</p> : undefined}
        >
          <Scoreboard summary={summary} />
        </Section>
      </main>
      <footer className="foot">
        <div className="wrap foot-in">
          <Brand />
          <p>Built on Kane CLI by TestMu AI</p>
          <p className="mono foot-r">
            {snap.mode === "replay" ? "static replay · reduced in your browser" : "127.0.0.1 only · token in the URL fragment"}
          </p>
        </div>
      </footer>
    </div>
  );
}

function Blocked({ title, children }: { title: string; children: React.ReactNode }) {
  return (
    <main className="blocked" data-testid="blocked">
      <div className="blocked-in">
        <Brand />
        <h1>{title}</h1>
        {children}
      </div>
    </main>
  );
}

export function App() {
  const [status, setStatus] = useState<Status>({ kind: "loading" });
  const [summary, setSummary] = useState<EvalSummary | null>(null);
  const [shot, setShot] = useState<Shot | null>(null);
  const live = useRef<Live | null>(null);
  const [token] = useState(() => (REPLAY ? null : readToken(window.location.hash)));

  useEffect(() => {
    if (REPLAY) {
      loadReplay()
        .then((snap) => setStatus({ kind: "ready", snap, stream: "static" }))
        .catch((e: unknown) => setStatus({ kind: "error", message: e instanceof Error ? e.message : String(e) }));
      return;
    }
    live.current = connectLive(window.location.hash, { fetch: window.fetch.bind(window), EventSource: window.EventSource }, setStatus);
    const onHash = () => window.location.reload();
    window.addEventListener("hashchange", onHash);
    return () => {
      window.removeEventListener("hashchange", onHash);
      live.current?.close();
    };
  }, []);

  const ready = status.kind === "ready";
  useEffect(() => {
    if (ready) void loadEval().then(setSummary);
  }, [ready]);

  const ctx = useMemo(() => ({ mode: REPLAY ? ("replay" as const) : ("live" as const), token, open: setShot }), [token]);

  if (status.kind === "no-token")
    return (
      <Blocked title="This dashboard needs its token.">
        <p>
          Open the link <code>holdback serve</code> printed in your terminal. It ends in <code>#token=…</code>, and the page has made no request without it.
        </p>
        <p className="blocked-note">The token keeps the coding agent, which shares this machine, from reading the ledger. It rides in the URL fragment, so it never reaches a server log.</p>
      </Blocked>
    );
  if (status.kind === "denied")
    return (
      <Blocked title="The server refused this token.">
        <p>
          Each <code>holdback serve</code> run makes a new one. Open the link from the server that is running now.
        </p>
      </Blocked>
    );
  if (status.kind === "error")
    return (
      <Blocked title={REPLAY ? "The recorded run did not load." : "The dashboard server is not answering."}>
        <p className="mono">{status.message}</p>
        {!REPLAY && (
          <p>
            Start it with <code>holdback serve</code> in your app folder, then open the link it prints.
          </p>
        )}
      </Blocked>
    );
  if (status.kind === "loading")
    return (
      <main className="blocked" aria-busy="true">
        <div className="blocked-in">
          <Brand />
          <p className="mono">{REPLAY ? "reading the ledger…" : "connecting…"}</p>
        </div>
      </main>
    );

  return (
    <AppCtx.Provider value={ctx}>
      <Dashboard snap={status.snap} stream={status.stream} summary={summary} live={live.current} />
      <Lightbox shot={shot} onClose={() => setShot(null)} />
    </AppCtx.Provider>
  );
}
