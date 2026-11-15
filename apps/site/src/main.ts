import "./style.css";
import results from "./data/results.json";
import { CRITERIA } from "./data/run";
import { initHero } from "./hero";

type Arm = { id: string; name: string; about: string; passed: number | null; failingAtDone: number | null };
type Num = number | null;
type Results = {
  links: { github: string | null; video: string | null };
  firstLiveRun: Record<"specRules" | "questions" | "criteria" | "tests" | "agentBuildSeconds" | "plantedBugs" | "caught" | "breakerUsd", Num>;
  demo: Record<"criteria" | "turns" | "kaneCredits" | "plantedBugs" | "caught" | "breakerUsd", Num>;
  exam: { cases: number; arms: Arm[] };
};
const R = results as unknown as Results;

const $ = <T extends HTMLElement = HTMLElement>(id: string) => document.getElementById(id) as T | null;
const isNum = (v: unknown): v is number => typeof v === "number" && Number.isFinite(v);
const el = (tag: string, cls?: string, text?: string) => {
  const e = document.createElement(tag);
  if (cls) e.className = cls;
  if (text !== undefined) e.textContent = text;
  return e;
};

/* ---------- links: GitHub and repo files, pending until results.json has the URL ---------- */
const github = R.links.github ? R.links.github.replace(/\/+$/, "") : null;
for (const a of document.querySelectorAll<HTMLAnchorElement>("[data-gh]")) {
  if (github) {
    a.href = github;
    a.rel = "noopener";
  } else a.dataset.pending = "";
}
for (const a of document.querySelectorAll<HTMLAnchorElement>("[data-repo]")) {
  if (github) {
    a.href = `${github}/blob/main/${a.dataset.repo}`;
    a.rel = "noopener";
  } else a.dataset.pending = "";
}

/* ---------- first live run: proof line and step facts ---------- */
const run = R.firstLiveRun;
const proof = $("proof");
if (proof && isNum(run.criteria) && isNum(run.specRules) && isNum(run.plantedBugs) && isNum(run.caught)) {
  const caught = run.caught === run.plantedBugs ? (run.caught === 2 ? "both caught" : "all caught") : `${run.caught} caught`;
  proof.replaceChildren(
    el("span", "pf-k", "First live run"),
    el("span", "sep"),
    el("span", undefined, `${run.criteria} criteria from a ${run.specRules}-rule spec`),
    el("span", "sep"),
    el("span", undefined, `${run.plantedBugs} planted bugs, ${caught}`),
  );
}
const facts: Record<string, string | null> = {
  questions: isNum(run.questions) ? `live run: ${run.questions} question${run.questions === 1 ? "" : "s"}` : null,
  design: isNum(run.specRules) && isNum(run.criteria) && isNum(run.tests) ? `${run.specRules} rules → ${run.criteria} criteria, ${run.tests} tests` : null,
  build: isNum(run.agentBuildSeconds) ? `first build: ${run.agentBuildSeconds} s` : null,
  breaker: isNum(run.plantedBugs) && isNum(run.caught) && isNum(run.breakerUsd) ? `${run.plantedBugs} planted, ${run.caught} caught, $${run.breakerUsd}` : null,
};
for (const p of document.querySelectorAll<HTMLElement>("[data-fact]")) {
  const v = facts[p.dataset.fact ?? ""];
  if (v) p.textContent = v;
}

/* ---------- hero ---------- */
const list = $("criteriaList");
if (list) for (const c of CRITERIA) list.appendChild(el("li", undefined, `${c.id}: ${c.text}`));

const hero = $("top");
const canvas = $<HTMLCanvasElement>("field");
const copy = document.querySelector<HTMLElement>(".copy");
const gate = $("gate");
if (hero && canvas && copy && gate) {
  initHero({
    hero, canvas, copy, gate,
    gateRings: $("gateRings")!,
    gateWord: $("gateWord")!,
    gateOwed: $("gateOwed")!,
    gateNote: $("gateNote")!,
    gateProved: $("gateProved")!,
  });
}

/* ---------- demo: the recording and its figures ---------- */
const video = $("video");
const src = (R.links.video ?? "").trim();
if (video && src) {
  const yt = /(?:youtube\.com\/(?:watch\?v=|embed\/|shorts\/)|youtu\.be\/)([\w-]{6,})/.exec(src);
  if (yt) {
    const f = document.createElement("iframe");
    f.src = `https://www.youtube-nocookie.com/embed/${yt[1]}?rel=0`;
    f.title = "Holdback: one run, start to finish";
    f.allow = "accelerometer; encrypted-media; gyroscope; picture-in-picture; fullscreen";
    f.allowFullscreen = true;
    f.loading = "lazy";
    video.replaceChildren(f);
  } else if (/\.(mp4|webm)(\?|$)/i.test(src)) {
    const v = document.createElement("video");
    v.src = src;
    v.controls = true;
    v.preload = "metadata";
    v.playsInline = true;
    video.replaceChildren(v);
  } else {
    const a = el("a", "video-link", "Watch the recording") as HTMLAnchorElement;
    a.href = src;
    a.rel = "noopener";
    video.replaceChildren(a);
  }
  video.classList.add("ready");
} else if (video) {
  video.classList.add("pending");
}

const demo = R.demo;
const statsEl = $("demoStats");
if (statsEl) {
  const usd = (v: number) => `$${v < 0.01 ? v.toPrecision(2) : v.toFixed(2)}`;
  const rows: [string, number | null, (v: number) => string][] = [
    ["Criteria", demo.criteria, String],
    ["Agent turns", demo.turns, String],
    ["Kane credits", demo.kaneCredits, (v) => Math.round(v).toLocaleString("en-US")],
    ["Bugs planted", demo.plantedBugs, String],
    ["Caught by Kane", demo.caught, String],
    ["Breaker cost", demo.breakerUsd, usd],
  ];
  for (const [label, v, fmt] of rows) {
    const d = el("div", isNum(v) ? "stat" : "stat pending");
    const dd = el("dd", undefined, isNum(v) ? fmt(v) : "–");
    if (!isNum(v)) dd.setAttribute("aria-label", "pending");
    d.append(el("dt", undefined, label), dd);
    statsEl.appendChild(d);
  }
  const note = $("demoNote");
  if (note && rows.some(([, v]) => !isNum(v))) note.hidden = false;
}

/* ---------- the exam: one meter per arm ---------- */
const meters = $("meters");
if (meters) {
  const cases = R.exam.cases;
  for (const arm of R.exam.arms) {
    const done = isNum(arm.passed);
    const row = el("div", `meter${arm.id === "C" ? " ours" : ""}${done ? "" : " pending"}`);
    row.setAttribute("role", "listitem");
    const name = el("div", "m-name");
    name.append(el("span", "m-id", arm.id), el("span", "m-t", arm.name), el("span", "m-about", arm.about));
    const bar = el("div", "m-bar");
    bar.setAttribute("aria-hidden", "true");
    const fill = el("i");
    fill.style.setProperty("--v", done ? String(Math.max(0, Math.min(1, (arm.passed as number) / cases))) : "0");
    bar.appendChild(fill);
    const score = el("div", "m-score");
    if (done) score.append(el("b", undefined, String(arm.passed)), `/${cases}`);
    else score.append(el("b", undefined, "–"), `/${cases}`);
    const note = el(
      "div",
      "m-note",
      !done ? "pending" : isNum(arm.failingAtDone) ? `${arm.failingAtDone} failing when it stopped` : "",
    );
    row.setAttribute("aria-label", done ? `${arm.name}: ${arm.passed} of ${cases} exam cases passed` : `${arm.name}: score pending`);
    row.append(name, bar, score, note);
    meters.appendChild(row);
  }
}

/* ---------- copy buttons ---------- */
const live = $("live");
for (const b of document.querySelectorAll<HTMLButtonElement>("[data-copy]")) {
  b.addEventListener("click", async () => {
    const text = b.dataset.copy ?? "";
    let ok = false;
    try {
      await navigator.clipboard.writeText(text);
      ok = true;
    } catch {
      const ta = document.createElement("textarea");
      ta.value = text;
      ta.setAttribute("readonly", "");
      ta.style.position = "fixed";
      ta.style.opacity = "0";
      document.body.appendChild(ta);
      ta.select();
      try { ok = document.execCommand("copy"); } catch { ok = false; }
      ta.remove();
    }
    if (!ok) return;
    b.classList.add("done");
    if (live) live.textContent = `Copied ${text}`;
    window.setTimeout(() => b.classList.remove("done"), 1600);
  });
}
