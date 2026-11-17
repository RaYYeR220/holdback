import { useState } from "react";
import type { PendingPrompt } from "@holdback/core/browser";
import { ARMS, fmtClock, fmtCredits, fmtDuration, fmtUsd, type DriftRow, type EvalSummary, type Meters as M } from "./model";

/* ------------------------------------------------------------------ meters */

export function Meters({ m }: { m: M }) {
  const total = m.split.reduce((s, x) => s + x.credits, 0) || 1;
  const cap = m.capUsd;
  const share = cap ? Math.min(1, m.breakerUsd / cap) : 0;
  return (
    <div className="meters" data-testid="meters">
      <div className="mtr">
        <p className="mtr-k">Kane credits</p>
        <p className="mtr-v">{fmtCredits(m.kaneCredits)}</p>
        <p className="mtr-note">
          {m.metered > 0
            ? `By kane-cli balance: ${m.metered} metered ${m.metered === 1 ? "batch" : "batches"}${m.unmeasured ? `, ${m.unmeasured} unreadable (per-run sum stands in)` : ""}.`
            : "Per-run figures: no balance-metered batch in this ledger."}
        </p>
        {m.split.length > 0 && (
          <>
            <div className="stack" aria-hidden="true">
              {m.split.map((s) => (
                <i key={s.key} className={`sp sp-${s.key}`} style={{ width: `${(s.credits / total) * 100}%` }} />
              ))}
            </div>
            <dl className="legend">
              {m.split.map((s) => (
                <div key={s.key}>
                  <dt>
                    <i className={`sp sp-${s.key}`} aria-hidden="true" />
                    {s.label}
                  </dt>
                  <dd className="mono">{fmtCredits(s.credits)}</dd>
                </div>
              ))}
            </dl>
          </>
        )}
      </div>
      <div className="mtr">
        <p className="mtr-k">Breaker spend</p>
        <p className="mtr-v">
          {fmtUsd(m.breakerUsd)}
          {cap !== null && <span className="mtr-of"> of {fmtUsd(cap)} cap</span>}
        </p>
        {cap !== null && (
          <div className="cap" role="meter" aria-valuemin={0} aria-valuemax={cap} aria-valuenow={m.breakerUsd} aria-label="Breaker spend against its cap">
            <i style={{ width: `${Math.max(share * 100, m.breakerUsd > 0 ? 0.8 : 0)}%` }} />
          </div>
        )}
        <p className="mtr-note">
          {m.mutants.killed} caught · {m.mutants.survived} survived · {m.mutants.invalid} invalid{m.breakerModel ? ` · ${m.breakerModel}` : ""}
        </p>
      </div>
      <div className="mtr mtr-pair">
        <div>
          <p className="mtr-k">Agent turns</p>
          <p className="mtr-v sm">
            {m.turns}
            {m.maxTurns !== null && <span className="mtr-of"> / {m.maxTurns}</span>}
          </p>
        </div>
        <div>
          <p className="mtr-k">Kane runs</p>
          <p className="mtr-v sm">
            {m.runs}
            <span className="mtr-of"> · {fmtDuration(m.kaneS)}</span>
          </p>
        </div>
      </div>
    </div>
  );
}

/* ------------------------------------------------------------------ spec drift */

export function Drift({ rows, specChanged, live }: { rows: DriftRow[]; specChanged: string[]; live: boolean }) {
  return (
    <div className="drift" data-testid="drift">
      {specChanged.length > 0 && (
        <p className="drift-now">
          <b>Edited since the seal:</b> {specChanged.map((k) => k.replace(/^app:/, "")).join(", ")}. Run <code>holdback drift</code> and Kane re-plans what the edit touched.
        </p>
      )}
      {rows.length === 0 ? (
        <p className="empty-line">{live ? "No drift on record." : "No drift in this run."} When the spec changes, Kane's re-plan lands here row by row.</p>
      ) : (
        <ul className="drift-rows">
          {rows.map((r, i) => (
            <li key={i}>
              <span className={`dk dk-${r.kind.toLowerCase()}`}>{r.kind}</span>
              <span className="mono dr-ref">{r.ref}</span>
              <span className="dr-why">{r.why}</span>
              <span className="mono dr-at">
                {fmtClock(r.at)}
                {r.applied ? "" : " · not applied"}
              </span>
            </li>
          ))}
        </ul>
      )}
    </div>
  );
}

/* ------------------------------------------------------------------ eval */

export function Scoreboard({ summary }: { summary: EvalSummary | null }) {
  return (
    <div className="exam" data-testid="exam">
      {ARMS.map((a) => {
        const s = summary?.[a.id];
        const v = s && s.examTotal > 0 ? s.examPassed / s.examTotal : 0;
        return (
          <div key={a.id} className={`meter${a.id === "C" ? " ours" : ""}${s ? "" : " pending"}`}>
            <div className="m-name">
              <span className="m-id">{a.id}</span>
              <span className="m-t">{a.name}</span>
              <span className="m-about">{a.about}</span>
            </div>
            <div className="m-bar" aria-hidden="true">
              {s && <i style={{ ["--v" as string]: v }} />}
            </div>
            <p className="m-score">{s ? <><b>{s.examPassed}</b>/{s.examTotal}</> : <b>–</b>}</p>
            <p className="m-note">
              {s
                ? [
                    s.claimedDone === true ? "claimed done" : s.claimedDone === false ? "did not claim done" : null,
                    typeof s.turns === "number" ? `${s.turns} turns` : null,
                    typeof s.inconclusive === "number" && s.inconclusive > 0 ? `${s.inconclusive} inconclusive` : null,
                    typeof s.kaneCredits === "number" ? `${fmtCredits(s.kaneCredits)} build credits` : null,
                    typeof s.agentUsd === "number" ? `agent ${fmtUsd(s.agentUsd)}` : null,
                    typeof s.wallMin === "number" ? `${s.wallMin.toFixed(1)} min` : null,
                  ]
                    .filter(Boolean)
                    .join(" · ")
                : "pending"}
            </p>
          </div>
        );
      })}
    </div>
  );
}

/* ------------------------------------------------------------------ the human in the loop */

function Questions({ p, onSubmit }: { p: Extract<PendingPrompt, { kind: "answer" }>; onSubmit: (answers: Record<string, string>) => Promise<void> }) {
  const [picked, setPicked] = useState<Record<string, string>>(() => Object.fromEntries(p.questions.map((q) => [q.id, q.options[q.recommendedIndex]?.label ?? ""])));
  const [free, setFree] = useState<Record<string, string>>({});
  const [busy, setBusy] = useState(false);
  const [err, setErr] = useState<string | null>(null);
  const answers = Object.fromEntries(p.questions.map((q) => [q.id, (free[q.id] ?? "").trim() || picked[q.id] || ""]));
  const ready = p.questions.every((q) => answers[q.id]);
  return (
    <form
      className="hp-form"
      onSubmit={(e) => {
        e.preventDefault();
        if (!ready || busy) return;
        setBusy(true);
        setErr(null);
        onSubmit(answers)
          .catch((x: unknown) => setErr(x instanceof Error ? x.message : String(x)))
          .finally(() => setBusy(false));
      }}
    >
      {p.questions.map((q) => (
        <fieldset key={q.id} className="q">
          <legend>
            <span className="tag">{q.id}</span>
            <span className={`risk risk-${q.risk}`}>{q.risk} risk</span>
            <span className="q-text">{q.text}</span>
          </legend>
          {q.rationale && <p className="q-why">{q.rationale}</p>}
          <div className="opts">
            {q.options.map((o, i) => (
              <label key={o.label} className={`opt${picked[q.id] === o.label && !(free[q.id] ?? "").trim() ? " on" : ""}`}>
                <input type="radio" name={`${p.sid}-${q.id}`} value={o.label} checked={picked[q.id] === o.label} onChange={() => setPicked({ ...picked, [q.id]: o.label })} />
                <span className="opt-l">
                  {o.label}
                  {i === q.recommendedIndex && <span className="rec">Kane recommends</span>}
                </span>
                {o.detail && <span className="opt-d">{o.detail}</span>}
              </label>
            ))}
          </div>
          {q.allowFreeText && (
            <label className="free">
              <span>Or answer in your own words</span>
              <input type="text" value={free[q.id] ?? ""} onChange={(e) => setFree({ ...free, [q.id]: e.target.value })} />
            </label>
          )}
        </fieldset>
      ))}
      <div className="hp-actions">
        <button type="submit" className="btn" disabled={!ready || busy}>
          <i aria-hidden="true" />
          {busy ? "Sending…" : `Send ${p.questions.length === 1 ? "answer" : "answers"} to Kane`}
        </button>
        {err && <p className="hp-err" role="alert">{err}</p>}
      </div>
    </form>
  );
}

function Approvals({ p, onSubmit }: { p: Extract<PendingPrompt, { kind: "approve" }>; onSubmit: (refs: string[]) => Promise<void> }) {
  const [on, setOn] = useState<Set<string>>(() => new Set(p.items.map((i) => i.ref)));
  const [busy, setBusy] = useState(false);
  const [err, setErr] = useState<string | null>(null);
  const send = (refs: string[]) => {
    setBusy(true);
    setErr(null);
    onSubmit(refs)
      .catch((x: unknown) => setErr(x instanceof Error ? x.message : String(x)))
      .finally(() => setBusy(false));
  };
  return (
    <div className="hp-form">
      <ul className="appr">
        {p.items.map((it) => (
          <li key={it.ref}>
            <label>
              <input
                type="checkbox"
                checked={on.has(it.ref)}
                onChange={(e) => {
                  const n = new Set(on);
                  if (e.target.checked) n.add(it.ref);
                  else n.delete(it.ref);
                  setOn(n);
                }}
              />
              <span className="tag">{it.ref}</span>
              <span className="appr-kind mono">{it.kind}</span>
              <span className="appr-t">{it.title}</span>
            </label>
            {it.note && <span className="appr-note">{it.note}</span>}
          </li>
        ))}
      </ul>
      <div className="hp-actions">
        <button type="button" className="btn" disabled={busy || on.size === 0} onClick={() => send([...on])}>
          <i aria-hidden="true" />
          Approve {on.size === p.items.length ? "all" : `${on.size} of ${p.items.length}`}
        </button>
        <button type="button" className="btn-ghost" disabled={busy} onClick={() => send([])}>
          Reject all
        </button>
        {err && <p className="hp-err" role="alert">{err}</p>}
      </div>
    </div>
  );
}

function Values({ p, onSubmit }: { p: Extract<PendingPrompt, { kind: "values" }>; onSubmit: (values: Record<string, string>) => Promise<void> }) {
  const [v, setV] = useState<Record<string, string>>(() => Object.fromEntries(p.vars.map((a) => [a.name, a.suggested ?? ""])));
  const [busy, setBusy] = useState(false);
  const [err, setErr] = useState<string | null>(null);
  const ready = p.vars.every((a) => (v[a.name] ?? "").trim() !== "");
  return (
    <form
      className="hp-form"
      onSubmit={(e) => {
        e.preventDefault();
        if (!ready || busy) return;
        setBusy(true);
        setErr(null);
        onSubmit(v)
          .catch((x: unknown) => setErr(x instanceof Error ? x.message : String(x)))
          .finally(() => setBusy(false));
      }}
    >
      <div className="vars">
        {p.vars.map((a) => (
          <label key={a.name} className="var">
            <span className="var-d">
              <span className="tag">{a.name}</span>
              {a.description}
              <span className="var-u">
                used by {a.usedBy.join(", ")}
                {a.sameAs && ` · same digits as ${a.sameAs}`}
                {a.suggested !== undefined && " · Holdback suggests a test value"}
                {a.secret && " · secret: never shown or logged"}
              </span>
            </span>
            <input
              type={a.secret ? "password" : "text"}
              aria-label={a.name}
              autoComplete="off"
              spellCheck={false}
              value={v[a.name] ?? ""}
              placeholder={a.placeholder ?? ""}
              onChange={(e) => setV({ ...v, [a.name]: e.target.value })}
            />
          </label>
        ))}
      </div>
      <div className="hp-actions">
        <button type="submit" className="btn" disabled={!ready || busy}>
          <i aria-hidden="true" />
          {busy ? "Saving…" : `Save ${p.vars.length === 1 ? "value" : `${p.vars.length} values`}`}
        </button>
        {err && <p className="hp-err" role="alert">{err}</p>}
      </div>
    </form>
  );
}

const HEADS: Record<PendingPrompt["kind"], { h: string; p: string }> = {
  answer: { h: "Kane is waiting for your answers", p: "The run is paused until you answer. Your answers go to Kane." },
  approve: { h: "Kane is waiting for your approval", p: "Approve what Kane designed before Holdback seals it. Anything you leave unticked is rejected." },
  values: {
    h: "Kane's tests need values",
    p: "Kane's tests type these values, and Kane left them empty. Holdback suggests test values where it can: check or edit each. Nothing is sealed with an empty one.",
  },
};

export function HumanPanel({
  pending,
  answer,
  approve,
  values,
}: {
  pending: PendingPrompt[];
  answer: (sid: string, a: Record<string, string>) => Promise<void>;
  approve: (refs: string[]) => Promise<void>;
  values: (sid: string, v: Record<string, string>) => Promise<void>;
}) {
  if (pending.length === 0) return null;
  const p = pending[0]!;
  return (
    <section className="human" aria-labelledby="human-h" data-testid="human">
      <div className="hp-head">
        <span className="hp-dot" aria-hidden="true" />
        <h2 id="human-h">{HEADS[p.kind].h}</h2>
        <p>
          {HEADS[p.kind].p}
          {pending.length > 1 && ` ${pending.length - 1} more waiting after this one.`}
        </p>
      </div>
      {p.kind === "answer" ? (
        <Questions key={p.sid} p={p} onSubmit={(a) => answer(p.sid, a)} />
      ) : p.kind === "values" ? (
        <Values key={p.sid} p={p} onSubmit={(v) => values(p.sid, v)} />
      ) : (
        <Approvals key={p.sid} p={p} onSubmit={approve} />
      )}
    </section>
  );
}

export function Inbox({ pending }: { pending: number }) {
  return <p className="inbox mono">{pending === 0 ? "nothing waiting for you" : `${pending} waiting for you`}</p>;
}

