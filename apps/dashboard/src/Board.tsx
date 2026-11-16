import { anchorLabel, COLUMNS, fmtUsd, type Card, type ColumnKey, type MutantView } from "./model";
import { Ring, Thumb, runVerdict } from "./ui";

const MARK_LABEL = { pass: "passed", fail: "failed", inconclusive: "inconclusive", none: "not run yet" } as const;

function Observed({ card }: { card: Card }) {
  const o = card.observation;
  // a criterion no test verifies has nothing to run: its reason and its column say why
  if (!o) return card.ac.tests.length === 0 ? null : <p className="c-none">Kane has not run a test for it yet.</p>;
  // a plain pass on a passing criterion says nothing the test marks below do not
  if (card.ac.status === "passing" && o.status === "passed" && !o.note && !o.screenshot) return null;
  const v = runVerdict(o);
  const where = [o.test, o.kind === "falsify" ? (o.mutantId ? `${o.again ? "second replay" : "replay"} vs ${o.mutantId}` : "replay") : o.turn !== undefined ? `turn ${o.turn}` : null].filter(Boolean).join(" · ");
  const caption = `${o.test}${o.step ? `, step ${o.step}` : ""}${o.observed ? `: Kane saw “${o.observed}”` : o.note ? `: ${o.note}` : ""}`;
  return (
    <div className="c-block">
      <p className="c-k">
        <span>Kane</span>
        <span className="mono">{where}</span>
      </p>
      <p className={`c-verdict t-${v.tone}`}>{v.word}</p>
      {o.inconclusive && <p className="c-why">{o.inconclusive}</p>}
      {o.title && !o.inconclusive && <p className="c-title">{o.title}</p>}
      {o.observed && (
        <p className="c-saw">
          <span>Kane saw</span> <code className="saw">{o.observed}</code>
        </p>
      )}
      {o.note && !o.observed && !o.inconclusive && <p className="c-why">{o.note}</p>}
      {o.screenshot && <Thumb path={o.screenshot} caption={caption} />}
    </div>
  );
}

function Breaker({ m }: { m: MutantView }) {
  const word = m.verdict === "killed" ? "Caught" : m.verdict === "invalid" ? "Invalid patch" : m.verdict === "survived-by-heal" ? "Survived by a heal" : "Survived";
  return (
    <div className="c-block">
      <p className="c-k">
        <span>Breaker</span>
        <span className="mono">
          {m.id} · {fmtUsd(m.usd)}
        </span>
      </p>
      <p className={`c-verdict t-${m.verdict === "killed" ? "caught" : m.verdict === "invalid" ? "unsure" : "missed"}`}>{word}</p>
      {(m.removed || m.added) && (
        <div className="diff" aria-label={`Planted in ${m.file ?? "the app"}`}>
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
        </div>
      )}
      {m.note && <p className="c-why">{m.note}</p>}
    </div>
  );
}

function AcCard({ card }: { card: Card }) {
  const { ac } = card;
  return (
    <article className={`card ac s-${ac.status}`} data-ac={ac.id} aria-labelledby={`${ac.id}-t`}>
      <header className="c-head">
        <span className="tag">{ac.id}</span>
        <span className="c-uc mono">{ac.useCase}</span>
        {card.regressed && <span className="flag flag-alarm">Regressed</span>}
        {card.inconclusive.length > 0 && <span className="flag flag-unsure">Inconclusive</span>}
      </header>
      <p className="c-text" id={`${ac.id}-t`}>
        {ac.text}
      </p>
      {card.quote && (
        <blockquote className="c-quote">
          <p>{card.quote.text}</p>
          <cite className="mono">
            {card.quote.source} {anchorLabel(card.quote.anchor)}
          </cite>
        </blockquote>
      )}
      {card.inconclusive.map((u) => (
        <p className="c-flagline" key={u.test}>
          <Ring status="inconclusive" size={12} />
          <span>
            <b className="mono">{u.test}</b> proved nothing{u.turn !== undefined ? ` in turn ${u.turn}` : ""}: {u.reason}
          </span>
        </p>
      ))}
      {(ac.status === "needs-spec" || ac.status === "vacuous") && ac.reason && <p className="c-why">{ac.reason}</p>}
      <Observed card={card} />
      {card.mutant && <Breaker m={card.mutant} />}
      {card.tests.length > 0 && (
        <ul className="c-tests" aria-label="Tests that verify it">
          {card.tests.map((t) => (
            <li key={t.id} className={`tm tm-${t.mark}`} title={`${t.id}${t.title ? ` ${t.title}` : ""}: ${MARK_LABEL[t.mark]}${t.turn !== undefined ? ` (turn ${t.turn})` : ""}`}>
              <i aria-hidden="true" />
              <span className="mono">{t.id}</span>
              <span className="sr-only">{MARK_LABEL[t.mark]}</span>
            </li>
          ))}
        </ul>
      )}
    </article>
  );
}

export function Board({ cols }: { cols: Record<ColumnKey, Card[]> }) {
  return (
    <div
      className="board"
      data-testid="board"
      // an empty column keeps its place on a wide screen but gives its width to the full ones
      style={{ gridTemplateColumns: COLUMNS.map((c) => (cols[c.key].length ? "minmax(0, 1fr)" : "minmax(132px, 0.42fr)")).join(" ") }}
    >
      {COLUMNS.map((c) => {
        const cards = cols[c.key];
        return (
          <section key={c.key} className={`col col-${c.key}${cards.length === 0 ? " empty" : ""}`} aria-label={`${c.label}: ${cards.length}`} data-col={c.key}>
            <header className="col-head">
              <Ring status={c.key === "owed" ? "owed" : c.key} />
              <h3>{c.label}</h3>
              <span className="col-n mono">{cards.length}</span>
              <p className="col-note">{c.note}</p>
            </header>
            {cards.length === 0 ? (
              <p className="col-empty">None</p>
            ) : (
              <div className="col-cards">
                {cards.map((card) => (
                  <AcCard key={card.ac.id} card={card} />
                ))}
              </div>
            )}
          </section>
        );
      })}
    </div>
  );
}
