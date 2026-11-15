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
