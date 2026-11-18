import { fmtClock, fmtCredits, fmtDuration, fmtUsd, turnsText, type Item, type Segment } from "./model";
import { Ring, Thumb, runVerdict } from "./ui";

function Glyph({ item }: { item: Item }) {
  switch (item.kind) {
    case "agent":
      return <i className="g g-agent" aria-hidden="true" />;
    case "run": {
      const t = runVerdict(item.run).tone;
      return t === "pass" ? <Ring status="passing" /> : t === "caught" ? <Ring status="proved" /> : t === "unsure" ? <Ring status="inconclusive" /> : t === "missed" ? <Ring status="vacuous" /> : <Ring status="regressed" />;
    }
    case "mutant":
    case "disputed":
      return <i className="g g-mutant" aria-hidden="true" />;
    case "seal":
      return <i className="g g-seal" aria-hidden="true" />;
    case "tamper":
    case "regression":
    case "stopped":
    case "stalled":
      return <i className="g g-alarm" aria-hidden="true" />;
    default:
      return <Ring status="needs-spec" />;
  }
}

function Row({ item, live }: { item: Item; live: boolean }) {
  let title: React.ReactNode;
  let detail: React.ReactNode = null;
  let meta: React.ReactNode = null;
  let tone = "";
  switch (item.kind) {
    case "spec":
      title = item.title;
      detail = item.detail;
      meta = item.credits ? `${fmtCredits(item.credits)} cr` : null;
      break;
    case "seal":
      title = item.reseal ? "A human re-sealed the tests after a tamper" : "Holdback sealed the tests outside the repo";
      detail = `${item.files} files pinned by sha256`;
      break;
    case "agent":
      title = (
        <>
          Claude Code, turn {item.turn}
          {!item.done && <span className={live ? "pill-run" : "pill-open"}>{live ? "running" : "no end on record"}</span>}
        </>
      );
      detail = [
        item.owedIn ? `${item.owedIn} owed in its brief` : null,
        item.commit ? (
          <span key="c">
            commit <code>{item.commit}</code>
          </span>
        ) : null,
        item.files?.length ? `${item.files.length} ${item.files.length === 1 ? "file" : "files"}: ${item.files.join(", ")}` : null,
        item.exit !== undefined && item.exit !== 0 ? `exit ${item.exit}` : null,
        item.appUp === false ? "app did not come up" : null,
      ]
        .filter(Boolean)
        .flatMap((x, i) => (i ? [" · ", x] : [x]));
      meta = [item.durationMs !== undefined ? fmtDuration(item.durationMs / 1000) : null, item.usd !== undefined ? fmtUsd(item.usd) : null].filter(Boolean).join(" · ");
      break;
    case "run": {
      const o = item.run;
      const v = runVerdict(o);
      const tone = `t-${v.tone}`;
      title = (
        <>
          <span className="mono">{o.test}</span> {item.title ?? ""}
          {o.kind === "falsify" && o.mutantId && <span className="r-ctx"> {o.again ? "replayed again against" : "replayed against"} {o.mutantId}</span>}
          {o.kind === "replay" && <span className="r-ctx"> closing replay of the real build</span>}
        </>
      );
      detail = (
        <>
          <span className={`r-v ${tone}`}>{v.word}</span>
          {o.inconclusive ? <span>: {o.inconclusive}</span> : o.title ? <span>: {o.title}</span> : o.note ? <span>: {o.note}</span> : null}
          {o.observed && !o.inconclusive && (
            <span className="r-saw">
              Kane saw <code className="saw">{o.observed}</code>
            </span>
          )}
          {item.retried && <span className="r-ctx"> (re-run after: {item.retried})</span>}
          {o.screenshot && <Thumb path={o.screenshot} caption={`${o.test}${o.step ? `, step ${o.step}` : ""}${o.observed ? `: Kane saw “${o.observed}”` : o.note ? `: ${o.note}` : ""}`} />}
        </>
      );
      meta = `${fmtCredits(item.credits)} cr · ${fmtDuration(item.durationS)}`;
      break;
    }
    case "mutant": {
      const m = item.mutant;
      title = (
        <>
          Breaker planted <span className="mono">{m.id}</span> against <span className="mono">{m.ac}</span>
        </>
      );
      detail =
        m.removed || m.added ? (
          <span className="diff" aria-label={`Planted in ${m.file ?? "the app"}`}>
            {m.removed && (
              <code className="d-rm">
                <span aria-hidden="true">−</span>
                {m.removed}
              </code>
            )}
            {m.added && (
              <code className="d-add">
                <span aria-hidden="true">+</span>
                {m.added}
              </code>
            )}
          </span>
        ) : (
          m.verdict
        );
      if (m.setAside) {
        detail = (
          <>
            {detail}
            <span className="r-ctx"> {m.setAside.by === "referee" ? "rejected by the referee" : "set aside"}: {m.setAside.why}</span>
          </>
        );
      }
      meta = `${fmtUsd(m.usd)} · ${m.model}`;
      break;
    }
    case "disputed":
      tone = "t-unsure";
      title = (
        <>
          Kane disputed the planted bug <span className="mono">{item.mutant}</span> of <span className="mono">{item.ac}</span>: {item.uc}'s tests were not evolved
        </>
      );
      detail = <>Kane asked: {item.question}</>;
      meta = item.credits ? `${fmtCredits(item.credits)} cr` : null;
      break;
    case "regression":
      tone = "t-fail";
      title = (
        <>
          <span className="mono">{item.ac}</span> regressed in turn {item.turn}
        </>
      );
      detail = [item.blamedTurn !== undefined ? `bisect blames turn ${item.blamedTurn}` : null, item.blamedCommit ? `commit ${item.blamedCommit}` : null, item.detail ?? null].filter(Boolean).join(" · ");
      break;
    case "tamper":
      tone = "t-fail";
      title = "Tamper on record";
      detail = item.detail;
      break;
    case "drift":
      title = `Kane re-planned the spec: ${item.rows} ${item.rows === 1 ? "change" : "changes"}${item.applied ? ", applied" : ", not applied"}`;
      meta = item.credits ? `${fmtCredits(item.credits)} cr` : null;
      break;
    case "meter":
      title = `Kane balance, ${item.source}`;
      detail = item.delta === null ? `unreadable (${item.error ?? "no reason"}); per-run figures stand in` : `balance dropped ${fmtCredits(item.delta)} cr; runs reported ${fmtCredits(item.perRunSum)}`;
      break;
    case "stopped":
      title = `The run stopped (exit ${item.exit}): held back`;
      detail = item.detail ?? item.reason;
      break;
    case "stalled":
      title = `The build loop stalled: ${turnsText(item.turns)} changed nothing on code Kane had checked`;
      detail = [
        item.disputed.length > 0 ? `disputed, review them: ${item.disputed.map((d) => `${d.ac} (${d.test}): “${d.title}”`).join(" · ")}` : null,
        item.inconclusive.length > 0 ? `inconclusive: ${item.inconclusive.map((u) => `${u.test}: ${u.reason}`).join(" · ")}` : null,
      ]
        .filter(Boolean)
        .join(" — ");
      break;
    case "dropped":
      title = `Kane's change rolled back (${item.useCases.join(", ")})`;
      detail = item.detail;
      meta = `${fmtCredits(item.credits)} cr`;
      break;
    case "evolved":
      title = (
        <>
          Kane evolved <span className="mono">{item.uc}</span> {item.followUp ? "again, to cover criteria its tests had lost" : "after a planted bug got past its tests"}
        </>
      );
      detail = (
        <>
          minted <span className="mono">{item.minted.join(", ")}</span>
          {item.retired.length > 0 && (
            <>
              {" "}
              · retired <span className="mono">{item.retired.join(", ")}</span>
            </>
          )}
          <span className="r-ctx"> · because: {item.because}</span>
        </>
      );
      meta = `${fmtCredits(item.credits)} cr`;
      break;
  }
  return (
    <li className={`row row-${item.kind} ${tone}`}>
      <time className="r-at mono" dateTime={item.at}>
        {fmtClock(item.at)}
      </time>
      <span className="r-g">
        <Glyph item={item} />
      </span>
      <div className="r-body">
        <p className="r-title">{title}</p>
        {detail && <div className="r-detail">{detail}</div>}
      </div>
      {meta && <span className="r-meta mono">{meta}</span>}
    </li>
  );
}

export function Timeline({ segs, live }: { segs: Segment[]; live: boolean }) {
  if (segs.length === 0) return <p className="empty-line">The ledger is empty: nothing has run yet.</p>;
  return (
    <ol className="timeline" data-testid="timeline">
      {segs.map((s) => (
        <li key={s.key} className="seg">
          <header className="seg-head">
            <h3>{s.label}</h3>
            <span className="seg-meta mono">
              {fmtClock(s.from)} → {fmtClock(s.to)}
              {s.credits > 0 && <> · {fmtCredits(s.credits)} cr</>}
              {s.kaneS > 0 && <> · Kane {fmtDuration(s.kaneS)}</>}
            </span>
          </header>
          <ol className="rows">
            {s.items.map((it, i) => (
              <Row key={`${it.at}-${i}`} item={it} live={live && s === segs.at(-1)} />
            ))}
          </ol>
        </li>
      ))}
    </ol>
  );
}
