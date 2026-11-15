import { createContext, useContext, useEffect, useRef, useState, type ReactNode } from "react";
import type { AcStatus } from "@holdback/core/browser";
import type { ApiState, Observation } from "./model";
import { gateLabel } from "./model";
import { artifactUrl, type Mode } from "./source";

/* ------------------------------------------------------------------ context: mode, token, lightbox */

export type Ctx = { mode: Mode; token: string | null; open: (shot: Shot) => void };
export type Shot = { src: string; caption: string };
export const AppCtx = createContext<Ctx>({ mode: "replay", token: null, open: () => {} });
export const useApp = () => useContext(AppCtx);

/* ------------------------------------------------------------------ status glyphs */

/**
 * The landing page's ring language: owed is a hollow ring, passing a filled one, proved gains the
 * blue outer ring, needs-spec is dashed, vacuous is filled and struck, regressed is a hollow ring
 * in the alarm colour.
 */
export function Ring({ status, size = 14, title }: { status: AcStatus | "inconclusive"; size?: number; title?: string }) {
  const c = size / 2;
  const r = size * 0.3;
  return (
    <svg className={`ring ring-${status}`} width={size} height={size} viewBox={`0 0 ${size} ${size}`} role={title ? "img" : undefined} aria-label={title} aria-hidden={title ? undefined : true}>
      {status === "proved" && <circle cx={c} cy={c} r={size * 0.46} fill="none" stroke="var(--accent)" strokeWidth={1.2} />}
      <circle
        cx={c}
        cy={c}
        r={r}
        fill={status === "passing" || status === "proved" || status === "vacuous" ? "var(--ink)" : "none"}
        stroke={status === "regressed" ? "var(--alarm)" : status === "needs-spec" || status === "inconclusive" || status === "rejected" ? "var(--ink-3)" : "var(--ink)"}
        strokeWidth={1.2}
        strokeDasharray={status === "needs-spec" || status === "inconclusive" || status === "rejected" ? "1.6 1.8" : undefined}
      />
      {status === "rejected" && <path d={`M${c - r} ${c} L${c + r} ${c}`} stroke="var(--ink-3)" strokeWidth={1.2} />}
      {status === "vacuous" && <path d={`M${c - r - 1.5} ${c + r + 1.5} L${c + r + 1.5} ${c - r - 1.5}`} stroke="var(--ground)" strokeWidth={1.6} />}
    </svg>
  );
}

export function Brand() {
  return (
    <span className="brand">
      <svg width="22" height="22" viewBox="0 0 22 22" aria-hidden="true">
        <circle cx="11" cy="11" r="9.6" fill="none" stroke="#2347ff" strokeWidth="1.3" />
        <circle cx="11" cy="11" r="4.6" fill="#17160f" />
      </svg>
      Holdback
    </span>
  );
}

/* ------------------------------------------------------------------ the gate pill */

export function GatePill({ api }: { api: ApiState }) {
  const g = gateLabel(api);
  const acs = Object.values(api.state.acs).sort((a, b) => a.id.localeCompare(b.id, undefined, { numeric: true }));
  const proved = api.counts.byStatus.proved ?? 0;
  return (
    <div className={`gate${g.open ? " open" : ""}${api.tamper ? " tampered" : ""}`} role="status" aria-label={`${g.word}: ${g.parts.join(", ")}`} data-testid="gate">
      {acs.length > 0 && acs.length <= 24 && (
        <span className="gate-rings" aria-hidden="true">
          {acs.map((a) => (
            <i key={a.id} className={`gr gr-${a.status}`} />
          ))}
        </span>
      )}
      <span className="gate-word">{g.word}</span>
      <span className="gate-div" aria-hidden="true" />
      <span className="gate-n">{g.parts.join(" · ")}</span>
      {acs.length > 0 && (
        <span className="gate-n gate-pr">
          <b>{proved}</b>/{acs.length} proved
        </span>
      )}
    </div>
  );
}

/* ------------------------------------------------------------------ screenshots */

type Box = { x: number; y: number; w: number; h: number };

/**
 * The part of a screenshot that is not page background, as fractions of the image: Kane shoots
 * the whole 1920px viewport, and a small form in its corner would be unreadable as a thumbnail.
 */
async function contentBox(img: HTMLImageElement): Promise<Box | null> {
  const W = 192;
  const H = Math.max(1, Math.round((img.naturalHeight / img.naturalWidth) * W));
  const cv = document.createElement("canvas");
  cv.width = W;
  cv.height = H;
  const cx = cv.getContext("2d", { willReadFrequently: true });
  if (!cx) return null;
  cx.drawImage(img, 0, 0, W, H);
  const { data } = cx.getImageData(0, 0, W, H);
  const bg = [data[0]!, data[1]!, data[2]!];
  let x0 = W;
  let y0 = H;
  let x1 = -1;
  let y1 = -1;
  for (let y = 0; y < H; y++) {
    for (let x = 0; x < W; x++) {
      const i = (y * W + x) * 4;
      if (Math.abs(data[i]! - bg[0]!) + Math.abs(data[i + 1]! - bg[1]!) + Math.abs(data[i + 2]! - bg[2]!) > 36) {
        if (x < x0) x0 = x;
        if (x > x1) x1 = x;
        if (y < y0) y0 = y;
        if (y > y1) y1 = y;
      }
    }
  }
  if (x1 < 0) return null;
  const pad = 6;
  return { x: Math.max(0, x0 - pad) / W, y: Math.max(0, y0 - pad) / H, w: Math.min(W, x1 - x0 + 1 + 2 * pad) / W, h: Math.min(H, y1 - y0 + 1 + 2 * pad) / H };
}

/** A screenshot thumbnail cropped to the page's content; click opens the full image. */
export function Thumb({ path, caption }: { path?: string; caption: string }) {
  const { mode, token, open } = useApp();
  const src = artifactUrl(mode, path, token);
  const [box, setBox] = useState<Box | null>(null);
  const [failed, setFailed] = useState(false);
  const [ratio, setRatio] = useState(16 / 9);
  const ref = useRef<HTMLImageElement>(null);
  useEffect(() => {
    setBox(null);
    setFailed(false);
  }, [src]);
  if (!src) return null;
  const onLoad = () => {
    const img = ref.current;
    if (!img) return;
    setRatio(img.naturalWidth / Math.max(1, img.naturalHeight));
    contentBox(img)
      .then(setBox)
      .catch(() => setBox(null));
  };
  // Fit the content box into the 16:10 frame: the image is drawn 1/w frame-widths wide and shifted
  // by the box's own corner (translate percentages are of the image itself). The box is first
  // widened or deepened to the frame's shape, keeping its top-left corner (pages read from there),
  // and never zooms past 4x.
  const FRAME = 16 / 10;
  let style: React.CSSProperties | undefined;
  if (box) {
    const want = FRAME / ratio; // the box's w/h, in image fractions, that has the frame's shape
    let w = Math.max(box.w, 0.25);
    let h = Math.max(box.h, w / want);
    w = Math.min(1, Math.max(w, h * want));
    h = Math.min(1, w / want);
    const x = Math.min(box.x, 1 - w);
    const y = Math.min(box.y, Math.max(0, 1 - h));
    style = { width: `${(100 / w).toFixed(3)}%`, transform: `translate(${(-x * 100).toFixed(3)}%, ${(-y * 100).toFixed(3)}%)` };
  }
  if (failed) return <span className="thumb thumb-missing">screenshot not available</span>;
  return (
    <button type="button" className={`thumb${box ? " cropped" : ""}`} onClick={() => open({ src, caption })} aria-label={`Open screenshot: ${caption}`}>
      <img ref={ref} src={src} alt="" decoding="async" onLoad={onLoad} onError={() => setFailed(true)} style={style} />
    </button>
  );
}

export function Lightbox({ shot, onClose }: { shot: Shot | null; onClose: () => void }) {
  const ref = useRef<HTMLDialogElement>(null);
  useEffect(() => {
    const d = ref.current;
    if (!d) return;
    if (shot && !d.open) d.showModal();
    if (!shot && d.open) d.close();
  }, [shot]);
  return (
    <dialog ref={ref} className="lightbox" onClose={onClose} onClick={(e) => e.target === ref.current && onClose()} aria-label="Screenshot">
      {shot && (
        <figure>
          <img src={shot.src} alt={shot.caption} />
          <figcaption>
            <span>{shot.caption}</span>
            <button type="button" className="lb-close" onClick={onClose}>
              Close
            </button>
          </figcaption>
        </figure>
      )}
    </dialog>
  );
}

/* ------------------------------------------------------------------ bits */

export function Section({ id, title, note, aside, children, className }: { id: string; title: string; note?: ReactNode; aside?: ReactNode; children: ReactNode; className?: string }) {
  return (
    <section className={`sec ${className ?? ""}`} id={id} aria-labelledby={`${id}-h`}>
      <div className="sec-head">
        <div>
          <h2 id={`${id}-h`}>{title}</h2>
          {note && <p>{note}</p>}
        </div>
        {aside}
      </div>
      {children}
    </section>
  );
}

/** How a run reads in one line: passed, failed at step n, or inconclusive (and why). */
export function runVerdict(o: Observation): { word: string; tone: "pass" | "fail" | "unsure" | "caught" | "missed" } {
  if (o.inconclusive) return { word: "Inconclusive", tone: "unsure" };
  if (o.kind === "falsify") return o.status === "passed" ? { word: "Missed the bug", tone: "missed" } : { word: o.step ? `Caught at step ${o.step}` : "Caught", tone: "caught" };
  if (o.status === "passed") return { word: o.healed ? "Passed after a heal" : "Passed", tone: "pass" };
  return { word: o.step ? `Failed at step ${o.step}` : "Failed", tone: "fail" };
}
