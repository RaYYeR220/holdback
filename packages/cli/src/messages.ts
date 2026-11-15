/** What a tamper means to the human, and what to do about it. */
export function tamperMessage(detail: string): string {
  return [
    `TAMPER: ${detail}`,
    "Something Holdback seals changed behind its back, so the gate stays closed and nothing built since counts.",
    "To continue: look at what changed and undo anything you did not change yourself, then run `holdback reseal`.",
    "The repo's .git/config is held to the same rule: changing a key that makes git run code (a hook, an editor, a filter) between runs also counts as a tamper.",
  ].join("\n");
}

export const HELP_FOOTER = [
  "",
  "Exit codes: 0 done (gate open, every criterion proved or passing); 1 error or not finished;",
  "2 tamper; 3 `run` finished but the gate is not fully green (owed, vacuous or needs-spec remain); 130 interrupted.",
  "",
  "Never delete the mut/ or bisect/ folders under ~/.holdback/<id>/ by hand: they hold",
  "links into your app's node_modules, and removing them with a plain delete can wipe it.",
  "Use `holdback clean` instead.",
].join("\n");
