// Fills the results block of README.md (between the results markers) from eval/results/summary.json.
// Idempotent: the same summary always renders the same block.
import { readFileSync, writeFileSync } from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";

export const START = "<!-- results:start -->";
export const END = "<!-- results:end -->";

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const NAMES = { A: "A: Claude Code alone", B: "B: Claude Code + its own Kane checks", C: "C: Holdback" };

const num = (n, digits = 0) => (typeof n === "number" ? n.toFixed(digits) : "n/a");
const usd = (n) => (typeof n === "number" ? "$" + n.toFixed(2) : "n/a");

export function renderResults(summary) {
  const arms = ["A", "B", "C"].filter((a) => summary && typeof summary[a] === "object" && summary[a] !== null);
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
  return `${table}\n\n${sentence}`;
}

/** Rewrite `readmePath` with the block rendered from `summaryPath` (a missing summary renders "Results pending."). */
export function renderReadme(readmePath, summaryPath) {
  const text = readFileSync(readmePath, "utf8");
  const a = text.indexOf(START);
  const b = text.indexOf(END);
  if (a < 0 || b < a) throw new Error(`${readmePath}: results markers not found`);
  let summary = null;
  try {
    summary = JSON.parse(readFileSync(summaryPath, "utf8"));
  } catch (e) {
    if (e.code !== "ENOENT") throw e;
  }
  const next = `${text.slice(0, a + START.length)}\n${renderResults(summary)}\n${text.slice(b)}`;
  if (next !== text) writeFileSync(readmePath, next, "utf8");
  return next;
}

if (process.argv[1] && path.resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  renderReadme(path.join(ROOT, "README.md"), path.join(ROOT, "eval", "results", "summary.json"));
}
