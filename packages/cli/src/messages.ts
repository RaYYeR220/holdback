import type { LedgerState } from "@holdback/core";

/** What a tamper means to the human, and what to do about it. */
export function tamperMessage(detail: string): string {
  return [
    `TAMPER: ${detail}`,
    "Something Holdback seals changed behind its back, so the gate stays closed and nothing built since counts.",
    "To continue: look at what changed and undo anything you did not change yourself, then run `holdback reseal`.",
    "The repo's .git/config is held to the same rule: changing a key that makes git run code (a hook, an editor, a filter) between runs also counts as a tamper.",
  ].join("\n");
}

/** A command only the human may run, refused inside a Claude Code session. */
export const HUMAN_ONLY = (cmd: string) =>
  `\`${cmd}\` is for you, not the coding agent: run it in your own terminal, outside Claude Code.`;

export const HELP_FOOTER = [
  "",
  "Exit codes: 0 done (gate open, every criterion proved or passing); 1 error or not finished;",
  "2 tamper; 3 `run` finished but the gate is not fully green (owed, vacuous or needs-spec remain); 130 interrupted.",
  "",
  "Never delete the mut/ or bisect/ folders under ~/.holdback/<id>/ by hand: they hold",
  "links into your app's node_modules, and removing them with a plain delete can wipe it.",
  "Use `holdback clean` instead.",
].join("\n");

/** Kane's spend by its balance, with the per-run sum beside it when they differ (and batches the balance could not be read for). */
export function kaneCreditsText(s: LedgerState): string {
  const notes: string[] = [];
  if (s.kaneCredits !== s.credits) notes.push(`per-run sum ${s.credits}`);
  if (s.kaneUnmeasured > 0) notes.push(`${s.kaneUnmeasured} batch${s.kaneUnmeasured === 1 ? "" : "es"} without a balance reading`);
  return `${s.kaneCredits}${notes.length > 0 ? ` (${notes.join("; ")})` : ""}`;
}

/**
 * The tests whose latest Kane run proved nothing (Kane's own environment or replay, a timeout, a
 * crash), or undefined. `countOnly` (the coding agent reading `holdback status`): how many, not which or why.
 */
export function inconclusiveLine(s: LedgerState, countOnly = false): string | undefined {
  if (s.inconclusive.length === 0) return undefined;
  if (countOnly) return `Inconclusive Kane runs: ${s.inconclusive.length} (not counted; the gate stays shut until Kane re-checks them)`;
  const runs = s.inconclusive.map((u) => `${u.test}${u.turn !== undefined ? ` turn ${u.turn}` : ""}: ${u.reason}`);
  return `Inconclusive Kane runs (not counted; their criteria kept their status): ${runs.join("; ")}`;
}

/** Why `holdback run` stopped when only Kane runs that proved nothing, even re-checked, keep the gate shut. */
export function inconclusiveStop(list: LedgerState["inconclusive"]): string {
  const runs = list.map((u) => `${u.test}${u.turn !== undefined ? ` (turn ${u.turn})` : ""}: ${u.reason}`).join("; ");
  return [
    `Kane could not finish checking ${list.length === 1 ? "this test" : "these tests"}, even re-run: ${runs}.`,
    "Their criteria keep their status and the gate stays shut; the coding agent has nothing to fix for them.",
    "Look at what Kane reported (`holdback status`), then run `holdback run` again.",
  ].join("\n");
}
