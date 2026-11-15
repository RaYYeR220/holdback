// Fills the generated parts of the public docs from files, never from typed numbers:
//   results, headline, exam-status  <- eval/results/summary.json (the scored exam)
//   links, demo, demo-status        <- docs/demo-run.json (the recorded demo run)
// A part sits between `<!-- name:start -->` and `<!-- name:end -->`. Block parts render on lines of
// their own; inline parts sit inside a sentence or a table cell. A missing input renders as pending.
// Idempotent: the same inputs always render the same text.
import { existsSync, readFileSync, writeFileSync } from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";

export const START = "<!-- results:start -->";
export const END = "<!-- results:end -->";

/** The docs `pnpm render-readme` fills. README.md must hold the results block; the others are filled when they exist. */
export const DOCS = ["README.md", "JUDGES.md", "CLAIMS.md"];

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const NAMES = { A: "A: Claude Code alone", B: "B: Claude Code + its own Kane checks", C: "C: Holdback" };

const num = (n, digits = 0) => (typeof n === "number" ? n.toFixed(digits) : "n/a");
const usd = (n) => (typeof n === "number" ? "$" + n.toFixed(2) : "n/a");
const arm = (summary, a) => (summary && typeof summary[a] === "object" && summary[a] !== null ? summary[a] : undefined);

export function renderResults(summary) {
  const arms = ["A", "B", "C"].filter((a) => arm(summary, a));
  if (arms.length === 0) return "Results pending.";
  const rows = arms.map((a) => {
    const s = summary[a];
    return `| ${NAMES[a]} | ${s.examPassed}/${s.examTotal} | ${num(s.inconclusive)} | ${s.claimedDone ? "yes" : "no"} | ${num(s.turns)} | ${num(s.kaneCredits, 1)} | ${usd(s.agentUsd)} | ${usd(s.breakerUsd)} | ${num(s.wallMin, 1)} |`;
  });
  const table = [
    "| Arm | Exam passed | Inconclusive | Claimed done | Agent turns | Build credits | Agent cost | Breaker cost | Wall minutes |",
    "| --- | --- | --- | --- | --- | --- | --- | --- | --- |",
    ...rows,
  ].join("\n");
  const score = arms.map((a) => `${a} ${summary[a].examPassed}/${summary[a].examTotal}`).join(", ");
  const sentence = `Each finished app was scored once on the pre-registered 22-case exam in \`eval/\` (${score}); a case that failed for a reason other than the app counts as not passed.`;
  const notes = footnotes(summary, arms);
  return `${table}\n\n${sentence}${notes.length > 0 ? `\n\n${notes.map((n) => `- ${n}`).join("\n")}` : ""}`;
}

/** Footnotes the table cannot show: how the arms' figures differ, and what went wrong. */
function footnotes(summary, arms) {
  const out = [];
  for (const a of arms) {
    const s = summary[a];
    if (s.appFailure) out.push(`${a}: the app could not be installed or started, so it scores 0 of ${s.examTotal} (${s.appFailure}).`);
    if (s.stopReason === "transient-exhausted") out.push(`${a}: the build stopped after repeated API errors, not because the agent finished.`);
    if (s.assuranceCallsUsed > 0) out.push(`${a}: the agent ran ${s.assuranceCallsUsed} Kane assurance command${s.assuranceCallsUsed === 1 ? "" : "s"} (context, design, maintain or cover) despite the deny rules.`);
    if (typeof s.specCredits === "number") {
      const mins = typeof s.specMinutes === "number" ? `, ${s.specMinutes.toFixed(1)} minutes` : "";
      out.push(`${a}: build credits and wall minutes count from its first build turn; its spec stage is not in them (${s.specCredits.toFixed(1)} credits${mins}).`);
    }
    if (s.kaneUnmeasured > 0) out.push(`${a}: ${s.kaneUnmeasured} Kane batch${s.kaneUnmeasured === 1 ? "" : "es"} had no balance reading, so build credits are a lower bound.`);
    if (s.turnsWithoutCost > 0) out.push(`${a}: ${s.turnsWithoutCost} loop turn${s.turnsWithoutCost === 1 ? "" : "s"} did not report agent cost, so turns and agent cost are not shown.`);
  }
  return out;
}

/** The outcome-first line: Holdback's score next to the agent alone's, once both are scored. */
export function renderHeadline(summary) {
  const a = arm(summary, "A");
  const b = arm(summary, "B");
  const c = arm(summary, "C");
  if (!a || !c) {
    return "Exam pending: Holdback's build and Claude Code alone have not been scored yet on the held-out 22-case exam ([pre-registration](eval/PREREGISTERED.md)).";
  }
  const withKane = b ? `, and with its own Kane checks ${b.examPassed}/${b.examTotal}` : "";
  return `On a held-out ${c.examTotal}-case exam, Holdback's build passed ${c.examPassed}/${c.examTotal}; Claude Code alone passed ${a.examPassed}/${a.examTotal}${withKane}.`;
}

const PENDING_TAG = "NOT-CLAIMED (pending)";

/** The claim tag of the exam score: claimed only once both compared arms are scored. */
export const renderExamStatus = (summary) => (arm(summary, "A") && arm(summary, "C") ? "VERIFIED-LIVE" : PENDING_TAG);

/** The demo run's figures: the form each one must take. */
const DEMO_SCHEMA = {
  links: { landing: "url", video: "url", replay: "url" },
  recorded: { ledger: "path" },
  spec: { questions: "count", criteria: "count", tests: "count" },
  build: { turns: "count", bugReports: "count", gateOpen: "bool" },
  falsify: { planted: "count", caught: "count", breakerUsd: "number" },
  drift: { reopened: "count" },
  spend: { kaneCredits: "number", agentUsd: "number", wallMin: "number" },
};

/** A demo record with every figure null. */
export function emptyDemo() {
  return Object.fromEntries(Object.entries(DEMO_SCHEMA).map(([k, fields]) => [k, Object.fromEntries(Object.keys(fields).map((f) => [f, null]))]));
}

const KINDS = {
  url: (v) => typeof v === "string" && /^https:\/\/\S+$/.test(v),
  path: (v) => typeof v === "string" && v.length > 0 && !path.isAbsolute(v) && !/^[a-zA-Z]:/.test(v) && !v.split(/[\\/]/).includes(".."),
  count: (v) => Number.isInteger(v) && v >= 0,
  number: (v) => typeof v === "number" && Number.isFinite(v) && v >= 0,
  bool: (v) => typeof v === "boolean",
};

/** Checks a demo record: a figure is null or of its form; unknown keys are refused, so a typo never vanishes. */
export function checkDemo(demo) {
  if (demo === null || typeof demo !== "object" || Array.isArray(demo)) throw new Error("demo-run: expected a JSON object");
  const out = emptyDemo();
  for (const [section, value] of Object.entries(demo)) {
    if (section === "_readme") continue;
    const fields = Object.hasOwn(DEMO_SCHEMA, section) ? DEMO_SCHEMA[section] : undefined;
    if (!fields) throw new Error(`demo-run: unknown section "${section}"`);
    if (value === null || typeof value !== "object" || Array.isArray(value)) throw new Error(`demo-run: "${section}" must be an object`);
    for (const [k, v] of Object.entries(value)) {
      const kind = Object.hasOwn(fields, k) ? fields[k] : undefined;
      if (!kind) throw new Error(`demo-run: unknown figure "${section}.${k}"`);
      if (v !== null && !KINDS[kind](v)) throw new Error(`demo-run: "${section}.${k}" must be null or a ${kind}, got ${JSON.stringify(v)}`);
      out[section][k] = v;
    }
  }
  return out;
}

/** The three places to look: a link each, or pending. */
export function renderLinks(demo) {
  const d = demo ?? emptyDemo();
  const one = (label, url) => (url ? `[${label}](${url})` : `${label}: pending`);
  return [one("Landing page", d.links.landing), one("Demo video", d.links.video), one("Dashboard replay", d.links.replay)].join(" · ");
}

/** The demo run's claim tag: claimed only once its ledger is in the repo. */
export const renderDemoStatus = (demo) => (demo?.recorded.ledger ? "VERIFIED-LIVE" : PENDING_TAG);

/** The recorded demo run as a table, or pending until its ledger is in the repo. */
export function renderDemo(demo) {
  const d = demo ?? emptyDemo();
  if (!d.recorded.ledger) return "Demo run pending: nothing from it is claimed yet.";
  const n = (v, f = (x) => String(x)) => (v === null ? "not recorded" : f(v));
  const money = (digits) => (v) => "$" + v.toFixed(digits);
  const caught = d.falsify.planted === null || d.falsify.caught === null ? "not recorded" : `${d.falsify.caught} of ${d.falsify.planted}`;
  const rows = [
    ["Questions Kane asked about the spec", n(d.spec.questions)],
    ["Acceptance criteria Kane designed", n(d.spec.criteria)],
    ["Browser tests Kane designed", n(d.spec.tests)],
    ["Agent turns", n(d.build.turns)],
    ["Kane bug reports sent back to the agent", n(d.build.bugReports)],
    ["Planted bugs Kane caught", caught],
    ["Criteria a spec edit reopened", n(d.drift.reopened)],
    ["Gate at the end", n(d.build.gateOpen, (v) => (v ? "open" : "closed"))],
    ["Kane credits, by balance", n(d.spend.kaneCredits, (v) => v.toFixed(1))],
    ["Agent cost", n(d.spend.agentUsd, money(2))],
    ["Breaker cost", n(d.falsify.breakerUsd, money(4))],
    ["Wall-clock minutes", n(d.spend.wallMin, (v) => v.toFixed(1))],
  ];
  return [`| Recorded demo run ([ledger](${d.recorded.ledger})) | |`, "| --- | --- |", ...rows.map(([k, v]) => `| ${k} | ${v} |`)].join("\n");
}

/** Every part the docs may hold. `block` parts sit on lines of their own. */
const PARTS = {
  results: { block: true, render: (d) => renderResults(d.summary) },
  headline: { block: false, render: (d) => renderHeadline(d.summary) },
  "exam-status": { block: false, render: (d) => renderExamStatus(d.summary) },
  links: { block: false, render: (d) => renderLinks(d.demo) },
  demo: { block: true, render: (d) => renderDemo(d.demo) },
  "demo-status": { block: false, render: (d) => renderDemoStatus(d.demo) },
};

/** Replaces the inside of every known part in `text`, every time it occurs. A start marker without its end is refused. */
export function fillMarkers(text, data) {
  let out = text;
  for (const [name, part] of Object.entries(PARTS)) {
    const start = `<!-- ${name}:start -->`;
    const end = `<!-- ${name}:end -->`;
    const inner = part.block ? `\n${part.render(data)}\n` : part.render(data);
    let from = 0;
    for (;;) {
      const a = out.indexOf(start, from);
      if (a < 0) break;
      const b = out.indexOf(end, a + start.length);
      if (b < 0) throw new Error(`"${start}" has no "${end}" after it`);
      out = `${out.slice(0, a + start.length)}${inner}${out.slice(b)}`;
      from = a + start.length + inner.length + end.length;
    }
  }
  return out;
}

function readJson(file) {
  let text;
  try {
    text = readFileSync(file, "utf8");
  } catch (e) {
    if (e.code === "ENOENT") return null;
    throw e;
  }
  try {
    return JSON.parse(text);
  } catch (e) {
    throw new Error(`${file}: ${e.message}`);
  }
}

/** The inputs: the exam summary (null until scored) and the demo record (every figure null until recorded). */
export function readInputs(summaryPath, demoPath) {
  const demo = demoPath ? readJson(demoPath) : null;
  return { summary: readJson(summaryPath), demo: demo === null ? emptyDemo() : checkDemo(demo) };
}

function rewrite(file, data, needResults) {
  const text = readFileSync(file, "utf8");
  if (needResults) {
    const a = text.indexOf(START);
    const b = text.indexOf(END);
    if (a < 0 || b < a) throw new Error(`${file}: results markers not found`);
  }
  const next = fillMarkers(text, data);
  if (next !== text) writeFileSync(file, next, "utf8");
  return next;
}

/** Rewrites `readmePath` from `summaryPath` (and `demoPath`, when given); the README must hold the results block. */
export function renderReadme(readmePath, summaryPath, demoPath) {
  return rewrite(readmePath, readInputs(summaryPath, demoPath), true);
}

/** Fills README.md and every other doc in DOCS that exists under `root`; returns the docs it filled. */
export function renderDocs(root = ROOT) {
  const data = readInputs(path.join(root, "eval", "results", "summary.json"), path.join(root, "docs", "demo-run.json"));
  const done = [];
  for (const doc of DOCS) {
    const file = path.join(root, doc);
    if (doc !== "README.md" && !existsSync(file)) continue;
    rewrite(file, data, doc === "README.md");
    done.push(doc);
  }
  return done;
}

if (process.argv[1] && path.resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  console.log(`rendered ${renderDocs().join(", ")}`);
}
