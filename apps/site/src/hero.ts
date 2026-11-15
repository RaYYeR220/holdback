import { CRITERIA, FIRST_FAIL, MUTANTS, type Mutant } from "./data/run";

/*
 * The hero field: the live run's criteria as nodes in a dot field, replaying the loop on a timer.
 * Owed (hollow ring) -> Kane's first check (scan) -> reports sent for what failed -> the agent fixes ->
 * re-check -> the breaker plants a bug -> replay (blue proved arc on every criterion, the bug struck)
 * -> done. Reduced motion holds one frame of the held-back state.
 */

const INK = "#17160f";
const INK2 = "#4d4b43";
const INK3 = "#86837a";
const ACC = "#2347ff";
const GROUND = "#f1f0ec";

const F_ID = '500 10.5px "Geist Mono"';
const F_IDS = '500 10px "Geist Mono"';
const F_TX = '400 13px "Figtree"';
const F_TXS = '400 11.5px "Figtree"';
const F_CODE = '400 13px "Geist Mono"';
const F_SM = '400 10.5px "Geist Mono"';
const F_DIAG = '400 12.5px "Figtree"';

/* cubic-bezier(.16,1,.3,1), the page's one easing */
function bezier(x1: number, y1: number, x2: number, y2: number) {
  const cx = 3 * x1, bx = 3 * (x2 - x1) - cx, ax = 1 - cx - bx;
  const cy = 3 * y1, by = 3 * (y2 - y1) - cy, ay = 1 - cy - by;
  const X = (t: number) => ((ax * t + bx) * t + cx) * t;
  const Y = (t: number) => ((ay * t + by) * t + cy) * t;
  const D = (t: number) => (3 * ax * t + 2 * bx) * t + cx;
  return (x: number) => {
    if (x <= 0) return 0;
    if (x >= 1) return 1;
    let t = x;
    for (let i = 0; i < 8; i++) {
      const e = X(t) - x, d = D(t);
      if (Math.abs(e) < 1e-5 || Math.abs(d) < 1e-6) break;
      t -= e / d;
    }
    if (t < 0 || t > 1) {
      let lo = 0, hi = 1;
      t = x;
      for (let i = 0; i < 30; i++) {
        if (X(t) < x) lo = t; else hi = t;
        t = (lo + hi) / 2;
      }
    }
    return Y(t);
  };
}
const E = bezier(0.16, 1, 0.3, 1);
const cl = (v: number, a = 0, b = 1) => (v < a ? a : v > b ? b : v);
const P = (t: number, t0: number, d: number) => E(cl((t - t0) / d));
const sm = (v: number) => v * v * (3 - 2 * v);

/* seconds: owed -> first check -> agent fixes -> re-check -> breaker plants -> replay -> done -> reset */
const T = { s1: 1.2, s1d: 3.6, fix: 5.0, s2: 6.3, s2d: 2.8, plant: 9.3, s3: 10.7, s3d: 3.8, rel: 14.7, reset: 18.4, resetD: 1.0, loop: 19.6 };
const HELD_T = 5.6; // reduced motion: 8 passing, 3 owed with reports sent

type Mode = "wide" | "tablet" | "phone";
type Geo = { dx: number; dy: number; pdx: number; pdy: number; w: number; h: number };
type Node = {
  id: string;
  label: string;
  short: string;
  fail: boolean;
  hx: number; hy: number; x: number; y: number;
  side: "r" | "b";
  w: number;
  lines: string[];
  geo: Geo;
  ph: number; ax: number; ay: number; f1: number; f2: number;
  c1: number; c2: number; c3: number; passAt: number;
  fill: number; prov: number; flash: number;
  status: string;
  cls: "" | "p" | "v";
};
type Scan = { p: number; tag: string };
type State = { owed: number; proved: number; scan: Scan | null; open: boolean; note: string };

/* value noise for the field's density */
const hash = (i: number, j: number) => {
  let h = (Math.imul(i, 374761393) + Math.imul(j, 668265263)) | 0;
  h = Math.imul(h ^ (h >>> 13), 1274126177);
  h ^= h >>> 16;
  return (h >>> 0) / 4294967296;
};
const vn = (x: number, y: number) => {
  const i = Math.floor(x), j = Math.floor(y), fx = x - i, fy = y - j;
  const sx = fx * fx * (3 - 2 * fx), sy = fy * fy * (3 - 2 * fy);
  const a = hash(i, j), b = hash(i + 1, j), c = hash(i, j + 1), d = hash(i + 1, j + 1);
  return a + (b - a) * sx + (c - a) * sy + (a - b - c + d) * sx * sy;
};

export type HeroEls = {
  hero: HTMLElement;
  canvas: HTMLCanvasElement;
  copy: HTMLElement;
  gate: HTMLElement;
  gateRings: HTMLElement;
  gateWord: HTMLElement;
  gateOwed: HTMLElement;
  gateNote: HTMLElement;
  gateProved: HTMLElement;
};

export function initHero(els: HeroEls): { restart: () => void } {
  const { hero, canvas: cv, copy, gate } = els;
  const ctx = cv.getContext("2d");
  if (!ctx) return { restart: () => {} };
  const reduce = matchMedia("(prefers-reduced-motion: reduce)").matches;
  const N = CRITERIA.length;

  let W = 0, H = 0, DPR = 1;
  let mode: Mode = "wide";
  let nodes: Node[] = [];
  let copyR = { l: 0, r: 0, t: 0, b: 0 };
  let gateC = { x: 0, y: 0 };
  let scanTop = 0;
  let grid = { cols: 0, y0: 0, pitch: 0, gw: 0 };
  let start = performance.now();
  const mouse = { x: -9999, y: -9999, tx: -9999, ty: -9999 };

  /* dots, struct-of-arrays */
  let nd = 0;
  let dX = new Float32Array(0), dY = new Float32Array(0), dA = new Float32Array(0), dPh = new Float32Array(0), dM = new Float32Array(0);
  let dI0 = new Int8Array(0), dI1 = new Int8Array(0), dH0 = new Float32Array(0), dH1 = new Float32Array(0);

  /* gate pill */
  const rings = CRITERIA.map(() => {
    const s = document.createElement("span");
    s.className = "gr";
    els.gateRings.appendChild(s);
    return s;
  });
  let gateKey = "";

  function wrap(text: string, maxW: number, font: string): string[] {
    ctx!.font = font;
    const words = text.split(" ");
    const lines: string[] = [];
    let line = "";
    for (const w of words) {
      const test = line ? line + " " + w : w;
      if (ctx!.measureText(test).width > maxW && line) {
        lines.push(line);
        line = w;
      } else line = test;
    }
    if (line) lines.push(line);
    return lines;
  }
  /* the same line count, at the narrowest width that keeps it: even lines */
  function wrapBal(text: string, maxW: number, font: string): string[] {
    const n0 = wrap(text, maxW, font).length;
    if (n0 < 2) return wrap(text, maxW, font);
    let lo = maxW * 0.4, hi = maxW;
    for (let i = 0; i < 14; i++) {
      const mid = (lo + hi) / 2;
      if (wrap(text, mid, font).length <= n0) hi = mid; else lo = mid;
    }
    return wrap(text, hi + 1, font);
  }

  const small = () => mode !== "wide";
  const LH = () => (small() ? 14 : 17);
  const txFont = () => (small() ? F_TXS : F_TX);
  const idFont = () => (mode === "phone" ? F_IDS : F_ID);

  function layout() {
    const r = hero.getBoundingClientRect();
    W = Math.round(r.width);
    H = Math.round(r.height);
    DPR = Math.min(window.devicePixelRatio || 1, 2);
    cv.width = Math.round(W * DPR);
    cv.height = Math.round(H * DPR);
    ctx!.setTransform(DPR, 0, 0, DPR, 0, 0);
    mode = W < 720 ? "phone" : W < 1120 ? "tablet" : "wide";

    const c = copy.getBoundingClientRect();
    const g = gate.getBoundingClientRect();
    const textW = mode === "wide" ? Math.min(c.width, 820) : W;
    copyR = { l: (W - textW) / 2, r: (W + textW) / 2, t: g.top - r.top, b: c.bottom - r.top };
    gateC = { x: g.left - r.left + g.width / 2, y: g.top - r.top + g.height / 2 };

    type Slot = { x: number; y: number; side: "r" | "b"; w: number };
    const slots: Record<string, Slot> = {};
    if (mode === "wide") {
      const CW = Math.min(W, 1400), ox = (W - CW) / 2;
      const side = copyR.l - ox;
      const lw = Math.max(120, Math.min(236, side - 84));
      const lx = ox + Math.max(36, side / 2 - (lw + 22) / 2);
      const rx = copyR.r + Math.max(30, side / 2 - (lw + 22) / 2);
      const ch = copyR.b - copyR.t;
      const fy = [0.03, 0.34, 0.65, 0.96];
      const jl = [0, 18, 4, 14], jr = [12, -6, 16, 0];
      ["ac-4", "ac-5", "ac-6", "ac-7"].forEach((id, i) => (slots[id] = { x: lx + jl[i], y: copyR.t + ch * fy[i], side: "r", w: lw }));
      ["ac-8", "ac-9", "ac-10", "ac-11"].forEach((id, i) => (slots[id] = { x: rx + jr[i], y: copyR.t + ch * fy[i] - 10 + (i % 2) * 8, side: "r", w: lw }));
      const bandY = copyR.b + Math.max(66, Math.min(110, (H - copyR.b) * 0.24));
      slots["ac-1"] = { x: ox + CW * 0.26, y: bandY + 10, side: "b", w: 250 };
      slots["ac-2"] = { x: W * 0.5, y: bandY - 4, side: "b", w: 280 };
      slots["ac-3"] = { x: ox + CW * 0.74, y: bandY + 14, side: "b", w: 250 };
      scanTop = 0;
    } else {
      const cols = mode === "phone" ? 3 : 4;
      const GW = Math.min(W - (mode === "phone" ? 20 : 64), 860);
      const colW = GW / cols;
      const pitch = mode === "phone" ? 74 : 86;
      const y0 = copyR.b + (mode === "phone" ? 44 : 58);
      CRITERIA.forEach((a, i) => {
        const row = Math.floor(i / cols), col = i - row * cols;
        const inRow = Math.min(cols, N - row * cols);
        const x = (W - inRow * colW) / 2 + colW * (col + 0.5);
        const jy = ((col + row) % 3) * 4 - 4;
        slots[a.id] = { x, y: y0 + row * pitch + jy, side: "b", w: colW - 10 };
      });
      scanTop = copyR.b + 14;
      grid = { cols, y0, pitch, gw: GW };
    }

    nodes = CRITERIA.map((a, i) => {
      const s = slots[a.id];
      const n: Node = {
        id: a.id, label: a.label, short: a.short, fail: FIRST_FAIL.has(a.id),
        hx: s.x, hy: s.y, x: s.x, y: s.y, side: s.side, w: s.w,
        lines: [], geo: { dx: 0, dy: 0, pdx: 0, pdy: 0, w: 0, h: 0 },
        ph: i * 1.7 + 0.4, ax: 6 + (i % 3) * 3, ay: 5 + (i % 2) * 4, f1: 0.05 + (i % 4) * 0.012, f2: 0.04 + (i % 3) * 0.015,
        c1: 0, c2: 0, c3: 0, passAt: 0, fill: 0, prov: 0, flash: -1, status: "owed", cls: "",
      };
      n.lines = small() ? wrap(a.short, s.w, F_TXS).slice(0, 2) : wrapBal(a.label, s.w, F_TX);
      return n;
    });
    /* the scan crosses each node by its home x */
    const fx = (n: Node) => cl((n.hx + 60) / (W + 120));
    for (const n of nodes) {
      n.c1 = T.s1 + T.s1d * fx(n);
      n.c2 = T.s2 + T.s2d * fx(n);
      n.c3 = T.s3 + T.s3d * fx(n);
      n.passAt = n.fail ? n.c2 : n.c1;
      n.geo = labelGeo(n);
    }

    /* the dot field: value-noise density, cleared behind the copy */
    const sp = mode === "phone" ? 11 : 12;
    const cx = (copyR.l + copyR.r) / 2, cy = (copyR.t + copyR.b) / 2;
    const rx = (copyR.r - copyR.l) / 2 + (mode === "wide" ? 30 : 0), ry = (copyR.b - copyR.t) / 2 + 30;
    const HR = mode === "phone" ? 52 : mode === "tablet" ? 70 : 112, HR2 = HR * HR;
    const xs: number[] = [], ys: number[] = [], as: number[] = [], phs: number[] = [], ms: number[] = [];
    const i0s: number[] = [], i1s: number[] = [], h0s: number[] = [], h1s: number[] = [];
    for (let y = sp / 2; y < H; y += sp) {
      const odd = Math.round(y / sp) % 2 ? sp / 2 : 0;
      for (let x = sp / 2 + odd; x < W; x += sp) {
        const nz = 0.6 * vn(x / 210, y / 210) + 0.4 * vn(x / 70 + 11, y / 70 + 5);
        const base = 0.03 + 0.4 * sm(cl((nz - 0.38) / 0.42));
        const m = small() && y < copyR.b
          ? ((x - cx) / (W * 0.62)) ** 2 + ((y - cy) / ry) ** 2
          : ((x - cx) / rx) ** 2 + ((y - cy) / ry) ** 2;
        let mask = 0.12 + 0.88 * sm(cl((m - 0.7) / 0.6));
        if (y < 76) mask *= 0.4;
        let i0 = -1, i1 = -1, h0 = 0, h1 = 0;
        for (let k = 0; k < nodes.length; k++) {
          const ddx = x - nodes[k].hx, ddy = y - nodes[k].hy, dd = ddx * ddx + ddy * ddy;
          if (dd >= HR2) continue;
          const h = 1 - Math.sqrt(dd) / HR, hh = h * h;
          if (hh > h0) { i1 = i0; h1 = h0; i0 = k; h0 = hh; }
          else if (hh > h1) { i1 = k; h1 = hh; }
        }
        const a = base * mask;
        if (a < 0.012 && i0 < 0) continue; // never visible, never lit by a node
        xs.push(x); ys.push(y); as.push(a); phs.push(hash(x | 0, y | 0) * 6.283); ms.push(mask);
        i0s.push(i0); i1s.push(i1); h0s.push(h0); h1s.push(h1);
      }
    }
    nd = xs.length;
    dX = Float32Array.from(xs); dY = Float32Array.from(ys); dA = Float32Array.from(as); dPh = Float32Array.from(phs); dM = Float32Array.from(ms);
    dI0 = Int8Array.from(i0s); dI1 = Int8Array.from(i1s); dH0 = Float32Array.from(h0s); dH1 = Float32Array.from(h1s);
  }

  function labelGeo(n: Node): Geo {
    const lh = LH();
    ctx!.font = txFont();
    const tw = Math.max(...n.lines.map((l) => ctx!.measureText(l).width));
    ctx!.font = idFont();
    const sw = ctx!.measureText(n.id + " · " + (mode === "phone" ? "reported" : "owed · report sent")).width;
    const w = Math.max(tw, sw) + 12, h = 14 + n.lines.length * lh + 6;
    if (n.side === "r") return { dx: 22, dy: -3, pdx: 16, pdy: -16, w, h };
    const dy = small() ? 23 : 26;
    return { dx: 0, dy, pdx: -w / 2, pdy: dy - 12, w, h };
  }

  function stateAt(t: number): State {
    const resetK = 1 - P(t, T.reset, T.resetD);
    const after = t >= T.reset;
    let owed = 0, proved = 0;
    for (const n of nodes) {
      n.fill = P(t, n.passAt, 0.55) * resetK;
      n.prov = P(t, n.c3, 0.8) * resetK;
      n.flash = n.fail && t >= n.c1 && t < n.c1 + 1.1 ? (t - n.c1) / 1.1 : -1;
      const isOwed = after || t < n.passAt;
      const isProved = !after && t >= n.c3;
      if (isOwed) owed++;
      if (isProved) proved++;
      const reported = n.fail && t >= n.c1;
      n.status = after ? "owed" : isProved ? "proved" : !isOwed ? "passing" : reported ? (mode === "phone" ? "reported" : "owed · report sent") : "owed";
      n.cls = isProved ? "v" : !isOwed ? "p" : "";
    }
    let scan: Scan | null = null;
    if (t >= T.s1 && t < T.s1 + T.s1d) scan = { p: (t - T.s1) / T.s1d, tag: "kane · first check" };
    else if (t >= T.s2 && t < T.s2 + T.s2d) scan = { p: (t - T.s2) / T.s2d, tag: "kane · re-check after the agent’s fix" };
    else if (t >= T.s3 && t < T.s3 + T.s3d) scan = { p: (t - T.s3) / T.s3d, tag: "kane · replay against planted bugs" };
    let note = "";
    if (t >= T.fix && t < T.s2) note = "agent fixing";
    else if (t >= T.s2 + T.s2d && t < T.s3) note = "planting bugs";
    else if (t >= T.s3 && t < T.s3 + T.s3d) note = "replaying";
    return { owed, proved, scan, open: proved === N && !after, note };
  }

  /* ---------- drawing ---------- */
  const NB = 14;
  const AMAX = 0.46;
  const inkP: Path2D[] = new Array(NB);
  /* rects (x0, y0, x1, y1) the dot field leaves empty so text sits on clean ground */
  const clear = new Float32Array(4 * 16);
  let nClear = 0;
  const addClear = (x: number, y: number, w: number, h: number) => {
    if (nClear >= 16) return;
    clear.set([x - 2, y - 2, x + w + 2, y + h + 2], nClear * 4);
    nClear++;
  };
  const accP: Path2D[] = new Array(NB);

  function drawDots(time: number, t: number, st: State, scanX: number | null) {
    const phone = mode === "phone";
    const R = phone ? 70 : 110, R2 = R * R;
    const sz0 = phone ? 0.9 : 1, szK = phone ? 1.6 : 1.9;
    for (let b = 0; b < NB; b++) { inkP[b] = new Path2D(); accP[b] = new Path2D(); }
    const fill = nodes.map((n) => 0.3 + 0.12 * n.fill);
    const prov = nodes.map((n) => n.prov * 2.2);
    const nodeDX = nodes.map((n) => n.x - n.hx), nodeDY = nodes.map((n) => n.y - n.hy);
    let wave = -1, waveK = 0;
    if (st.open && t < T.rel + 2.6) {
      const p = (t - T.rel) / 2.6;
      wave = E(p) * Math.hypot(W, H) * 0.9;
      waveK = 1 - p;
    }
    const mouseOn = mouse.x > -999;
    const tw = time * 0.8;
    for (let k = 0; k < nd; k++) {
      let x = dX[k], y = dY[k];
      const m = dM[k];
      if (mouseOn) {
        const mx = x - mouse.x, my = y - mouse.y;
        if (mx < R && mx > -R && my < R && my > -R) {
          const r2 = mx * mx + my * my;
          if (r2 < R2) {
            const r = Math.sqrt(r2) || 1, q = 1 - r / R, push = q * q * 20;
            x += (mx / r) * push;
            y += (my / r) * push;
          }
        }
      }
      let a = dA[k] * (0.84 + 0.16 * Math.sin(tw + dPh[k]));
      let blue = 0;
      const i0 = dI0[k];
      if (i0 >= 0) {
        // nodes drift a few px; the dot follows its node's drift so the halo stays centred
        x += nodeDX[i0] * dH0[k] * 0.6;
        y += nodeDY[i0] * dH0[k] * 0.6;
        const mm = 0.45 + 0.55 * m;
        a += fill[i0] * dH0[k] * mm;
        if (prov[i0] > 0) blue = dH0[k] * prov[i0];
        const i1 = dI1[k];
        if (i1 >= 0) {
          a += fill[i1] * dH1[k] * mm;
          if (prov[i1] > 0) blue = Math.max(blue, dH1[k] * prov[i1]);
        }
      }
      if (scanX !== null && y > scanTop) {
        const sd = x - scanX;
        if (sd < 30 && sd > -140) {
          const s = sd >= 0 ? 1 - sd / 30 : (1 + sd / 140) * 0.35;
          a += 0.2 * s * (0.35 + 0.65 * m);
          if (s > 0.3) blue = Math.max(blue, s * 1.4);
        }
      }
      if (wave > 0) {
        const wd = Math.abs(Math.hypot(x - gateC.x, y - gateC.y) - wave);
        if (wd < 46) {
          const s = (1 - wd / 46) * waveK;
          a += 0.22 * s * (0.3 + 0.7 * m);
          if (s > 0.18) blue = 1;
        }
      }
      if (a < 0.014) continue;
      let hidden = false;
      for (let c = 0; c < nClear * 4; c += 4) {
        if (x > clear[c] && x < clear[c + 2] && y > clear[c + 1] && y < clear[c + 3]) { hidden = true; break; }
      }
      if (hidden) continue;
      const b = Math.min(NB - 1, Math.floor((a / AMAX) * NB));
      const z = sz0 + (szK * b) / (NB - 1);
      (blue > 0.5 ? accP : inkP)[b].rect(x - z / 2, y - z / 2, z, z);
    }
    ctx!.fillStyle = INK;
    for (let b = 0; b < NB; b++) {
      ctx!.globalAlpha = 0.16 + (0.5 * b) / (NB - 1);
      ctx!.fill(inkP[b]);
    }
    ctx!.fillStyle = ACC;
    for (let b = 0; b < NB; b++) {
      ctx!.globalAlpha = 0.3 + (0.6 * b) / (NB - 1);
      ctx!.fill(accP[b]);
    }
    ctx!.globalAlpha = 1;
  }

  function rr(x: number, y: number, w: number, h: number, r: number) {
    ctx!.beginPath();
    if ("roundRect" in ctx!) ctx!.roundRect(x, y, w, h, r);
    else ctx!.rect(x, y, w, h);
  }

  function drawNode(n: Node) {
    const x = n.x, y = n.y, g = n.geo, lh = LH();
    if (n.flash >= 0) {
      const p = E(n.flash);
      ctx!.strokeStyle = INK;
      ctx!.globalAlpha = 0.5 * (1 - p);
      ctx!.lineWidth = 1;
      ctx!.beginPath();
      ctx!.arc(x, y, 7 + p * 20, 0, Math.PI * 2);
      ctx!.stroke();
      ctx!.globalAlpha = 1;
    }
    if (n.prov > 0.001) {
      ctx!.strokeStyle = ACC;
      ctx!.lineWidth = 1.3;
      ctx!.beginPath();
      ctx!.arc(x, y, 12.5, -Math.PI / 2, -Math.PI / 2 + Math.PI * 2 * n.prov);
      ctx!.stroke();
    }
    ctx!.fillStyle = GROUND;
    ctx!.beginPath();
    ctx!.arc(x, y, 6.6, 0, Math.PI * 2);
    ctx!.fill();
    ctx!.strokeStyle = INK;
    ctx!.lineWidth = 1.25;
    ctx!.beginPath();
    ctx!.arc(x, y, 6.6, 0, Math.PI * 2);
    ctx!.stroke();
    if (n.fill > 0.001) {
      ctx!.fillStyle = INK;
      ctx!.beginPath();
      ctx!.arc(x, y, 4.3 * n.fill, 0, Math.PI * 2);
      ctx!.fill();
    }

    const statusCol = n.status === "proved" ? ACC : INK3;
    ctx!.textBaseline = "alphabetic";
    ctx!.font = idFont();
    const idw = ctx!.measureText(n.id + " ").width;
    const full = ctx!.measureText(n.id + " · " + n.status).width;
    ctx!.textAlign = "left";
    if (n.side === "r") {
      const lx = x + g.dx, ly = y + g.dy;
      ctx!.fillStyle = INK;
      ctx!.fillText(n.id, lx, ly);
      ctx!.fillStyle = statusCol;
      ctx!.fillText("· " + n.status, lx + idw, ly);
      ctx!.font = txFont();
      ctx!.fillStyle = INK2;
      n.lines.forEach((l, i) => ctx!.fillText(l, lx, ly + 17 + i * lh));
    } else {
      const ly = y + g.dy;
      ctx!.fillStyle = INK;
      ctx!.fillText(n.id, x - full / 2, ly);
      ctx!.fillStyle = statusCol;
      ctx!.fillText("· " + n.status, x - full / 2 + idw, ly);
      ctx!.textAlign = "center";
      ctx!.font = txFont();
      ctx!.fillStyle = INK2;
      const first = small() ? 15 : 17;
      n.lines.forEach((l, i) => ctx!.fillText(l, x, ly + first + i * lh));
    }
    ctx!.textAlign = "left";
  }

  /* the breaker's planted bug under (or, on small screens, over) its criterion; struck when Kane catches it */
  type MBox = { n: Node; fade: number; caught: boolean; k: number; diag: string[]; sev: string; head0: string; head1: string; pad: number; w: number; h1: number; left: number; top: number; pw: number; ph: number };
  function mutantBox(mu: Mutant, t: number): MBox | null {
    if (t < T.plant || t >= T.reset + 0.6) return null;
    const n = nodes.find((x) => x.id === mu.ac);
    if (!n) return null;
    const fade = (1 - P(t, T.reset, 0.6)) * P(t, T.plant, 0.5);
    const caught = t >= n.c3 + 0.15;
    const k = caught ? P(t, n.c3 + 0.15, 0.6) : 0;
    const maxW = Math.min(330, W - 56);
    const diag = wrap("“" + mu.diagnosis + "”", maxW, F_DIAG);
    const sev = `${mu.severity} · confidence ${mu.confidence.toFixed(2)}`;
    const head0 = "breaker plants a bug · " + mu.ac, head1 = "caught on replay · " + mu.ac;
    ctx!.font = F_CODE;
    const codeW = Math.max(ctx!.measureText("− " + mu.minus).width, ctx!.measureText("+ " + mu.plus).width);
    ctx!.font = F_SM;
    const headW = Math.max(ctx!.measureText(head0).width, ctx!.measureText(sev).width);
    ctx!.font = F_DIAG;
    const diagW = Math.max(...diag.map((l) => ctx!.measureText(l).width));
    const pad = small() ? 16 : 12;
    const w = Math.max(codeW, headW, caught ? diagW : 0) + pad * 2;
    const h0 = 66, h1 = 66 + 8 + diag.length * 16 + 16;
    const h = h0 + (h1 - h0) * k;
    let top: number, left: number, pw = w, ph = h;
    if (mode === "wide") {
      top = n.y + n.geo.dy + 17 + (n.lines.length - 1) * LH() + 22;
      left = cl(n.x - w / 2, 14, W - 14 - w);
    } else {
      // over the two grid rows under the planted criterion, full rows wide so no label pokes out
      const row = Math.floor(CRITERIA.findIndex((c) => c.id === mu.ac) / grid.cols);
      top = grid.y0 + (row + 1) * grid.pitch - 20;
      ph = Math.max(h, 2 * grid.pitch - 6);
      pw = mode === "phone" ? W - 20 : grid.gw + 16;
      left = (W - pw) / 2;
    }
    return { n, fade, caught, k, diag, sev, head0, head1, pad, w, h1, left, top, pw, ph };
  }

  function drawMutant(b: MBox, mu: Mutant, t: number) {
    const { n, fade, caught, k, diag, sev, head0, head1, pad, w, h1, left, top, pw, ph } = b;
    ctx!.globalAlpha = fade;
    if (small()) {
      // over the grid: a solid plate with a hairline so the nodes underneath don't read through
      ctx!.fillStyle = "rgba(241,240,236,0.99)";
      rr(left, top, pw, ph, 4);
      ctx!.fill();
      ctx!.strokeStyle = "rgba(23,22,15,0.12)";
      ctx!.lineWidth = 1;
      rr(left + 0.5, top + 0.5, pw - 1, ph - 1, 4);
      ctx!.stroke();
    }
    // the content block sits centred in a full-width plate
    const x0 = left + (mode === "wide" ? pad : Math.max(pad, (pw - w) / 2 + pad));
    const tt = top + Math.max(0, (ph - h1) / 2);
    ctx!.textAlign = "left";
    ctx!.font = F_SM;
    ctx!.fillStyle = caught ? ACC : INK3;
    ctx!.fillText(caught ? head1 : head0, x0, tt + 18);
    ctx!.font = F_CODE;
    ctx!.fillStyle = INK3;
    ctx!.fillText("− " + mu.minus, x0, tt + 38);
    const typed = Math.floor(cl((t - (T.plant + 0.4)) / 0.7) * (mu.plus.length + 2));
    const plusLine = ("+ " + mu.plus).slice(0, typed);
    ctx!.fillStyle = INK;
    ctx!.fillText(plusLine, x0, tt + 57);
    if (!caught && typed < mu.plus.length + 2 && Math.floor(t * 3) % 2 === 0) {
      ctx!.fillRect(x0 + ctx!.measureText(plusLine).width + 1, tt + 46, 1, 14);
    }
    if (caught) {
      const sw = ctx!.measureText("+ " + mu.plus).width - 14;
      ctx!.strokeStyle = ACC;
      ctx!.lineWidth = 1.2;
      ctx!.beginPath();
      ctx!.moveTo(x0 + 14, tt + 52.5);
      ctx!.lineTo(x0 + 14 + sw * k, tt + 52.5);
      ctx!.stroke();
      ctx!.globalAlpha = fade * P(t, n.c3 + 0.35, 0.6);
      ctx!.font = F_DIAG;
      ctx!.fillStyle = INK2;
      diag.forEach((l, i) => ctx!.fillText(l, x0, tt + 82 + i * 16));
      ctx!.font = F_SM;
      ctx!.fillStyle = INK3;
      ctx!.fillText(sev, x0, tt + 82 + diag.length * 16 + 4);
    }
    ctx!.globalAlpha = 1;
  }

  function scanTag(st: State, x: number | null) {
    if (x === null || !st.scan) return null;
    ctx!.font = F_SM;
    const tag = st.scan.tag;
    const tw = ctx!.measureText(tag).width;
    const ty = H - (small() ? 16 : 22);
    // the tag rides right of the line, and flips to its left near the edge so the line never crosses it
    const tx = x + 10 + tw > W - 14 ? Math.max(12, x - 10 - tw) : Math.max(12, x + 10);
    return { tag, tx, ty, tw };
  }

  function drawScan(st: State, x: number | null) {
    if (x === null || !st.scan) return;
    const top = scanTop;
    const g = ctx!.createLinearGradient(x - 170, 0, x, 0);
    g.addColorStop(0, "rgba(35,71,255,0)");
    g.addColorStop(1, "rgba(35,71,255,0.065)");
    ctx!.fillStyle = g;
    ctx!.fillRect(x - 170, top, 170, H - top);
    ctx!.fillStyle = ACC;
    ctx!.globalAlpha = 0.75;
    ctx!.fillRect(x - 0.5, top, 1, H - top);
    ctx!.globalAlpha = 1;
    ctx!.font = F_SM;
    const { tag, tx, ty } = scanTag(st, x)!;
    ctx!.fillStyle = ACC;
    ctx!.textAlign = "left";
    ctx!.fillText(tag, tx, ty);
  }

  function updateGate(st: State) {
    const key = `${st.owed}|${st.proved}|${st.open}|${st.note}|${nodes.map((n) => n.cls).join("")}`;
    if (key === gateKey) return;
    gateKey = key;
    nodes.forEach((n, i) => (rings[i].className = "gr" + (n.cls ? " " + n.cls : "")));
    gate.classList.toggle("open", st.open);
    els.gateWord.textContent = st.open ? "Done" : "Held back";
    els.gateOwed.innerHTML = `<b>${st.owed}</b> owed`;
    els.gateNote.textContent = st.open ? "" : st.note ? "· " + st.note : "";
    els.gateProved.innerHTML = `<b>${st.proved}</b>/${N} proved`;
  }

  function draw(now: number) {
    const elapsed = (now - start) / 1000;
    const t = reduce ? HELD_T : elapsed % T.loop;
    const time = reduce ? 0 : now / 1000;
    const mu = MUTANTS[reduce ? 0 : Math.floor(elapsed / T.loop) % MUTANTS.length];
    mouse.x += (mouse.tx - mouse.x) * 0.14;
    mouse.y += (mouse.ty - mouse.y) * 0.14;
    for (const n of nodes) {
      n.x = n.hx + (reduce ? 0 : n.ax * Math.sin(time * n.f1 * 6.283 + n.ph));
      n.y = n.hy + (reduce ? 0 : n.ay * Math.cos(time * n.f2 * 6.283 + n.ph * 1.3));
    }
    const st = stateAt(t);
    ctx!.clearRect(0, 0, W, H);
    const scanX = st.scan ? -40 + (W + 80) * st.scan.p : null;
    const mb = mutantBox(mu, t);
    const tag = scanTag(st, scanX);
    nClear = 0;
    for (const n of nodes) addClear(n.x + n.geo.pdx, n.y + n.geo.pdy, n.geo.w, n.geo.h);
    if (mb && mode === "wide") addClear(mb.left, mb.top, mb.pw, mb.ph);
    if (tag) addClear(tag.tx - 6, tag.ty - 13, tag.tw + 12, 19);
    drawDots(time, t, st, scanX);
    drawScan(st, scanX);
    for (const n of nodes) drawNode(n);
    if (mb) drawMutant(mb, mu, t);
    updateGate(st);
  }

  /* ---------- loop: paused offscreen and in background tabs ---------- */
  let raf = 0;
  let onScreen = true;
  const tick = (now: number) => {
    raf = 0;
    draw(now);
    if (!reduce && onScreen && !document.hidden) raf = requestAnimationFrame(tick);
  };
  const kick = () => {
    if (!raf) raf = requestAnimationFrame(tick);
  };
  if ("IntersectionObserver" in window) {
    new IntersectionObserver((entries) => {
      onScreen = entries[entries.length - 1].isIntersecting;
      if (onScreen) kick();
    }).observe(hero);
  }
  document.addEventListener("visibilitychange", () => {
    if (!document.hidden) kick();
  });

  hero.addEventListener("pointermove", (e) => {
    if (e.pointerType === "touch") return;
    const r = hero.getBoundingClientRect();
    mouse.tx = e.clientX - r.left;
    mouse.ty = e.clientY - r.top;
    if (mouse.x < -999) { mouse.x = mouse.tx; mouse.y = mouse.ty; }
  });
  hero.addEventListener("pointerleave", () => {
    mouse.tx = mouse.ty = mouse.x = mouse.y = -9999;
  });
  const restart = () => {
    start = performance.now();
    kick();
  };
  cv.addEventListener("click", restart);

  let rt = 0;
  let lastW = 0;
  window.addEventListener("resize", () => {
    clearTimeout(rt);
    rt = window.setTimeout(() => {
      // phones fire resize when the URL bar hides; only a width change moves the layout
      if (mode !== "wide" && Math.round(hero.getBoundingClientRect().width) === lastW) return;
      layout();
      lastW = W;
      kick();
    }, 120);
  });
  layout();
  lastW = W;
  kick();
  if (document.fonts?.load) {
    Promise.all([document.fonts.load(F_ID), document.fonts.load(F_TX), document.fonts.load(F_CODE)])
      .then(() => { layout(); lastW = W; kick(); })
      .catch(() => {});
  }
  return { restart };
}
