import { appendFileSync, mkdirSync } from "node:fs";
import { readFile, stat } from "node:fs/promises";
import path from "node:path";

/**
 * `<home>/spec-attempts.jsonl`: every coding-agent tool call the guard (or the interactive
 * post-edit hook) saw aimed at a spec file, one JSON line each. It lives in Holdback's home, out of
 * the agent's reach. A spec change in a window where the agent made such an attempt is a tamper,
 * never drift (R37).
 */
export const SPEC_ATTEMPTS = "spec-attempts.jsonl";

/**
 * `edit`: an Edit/Write call onto the spec; `shell`: a shell write onto it; `saved`: a save that went
 * through; `unreadable`: a line of the log Holdback could not read (`line`, and `at` naming the window
 * it was written in).
 */
export type SpecAttempt = { at: string; tool: string; how: "edit" | "shell" | "saved" | "unreadable"; line?: number };

/** Appends one attempt (synchronously: the guard exits right after). Throws when it cannot be written. */
export function logSpecAttempt(home: string, a: { tool: string; how: SpecAttempt["how"] }, at: Date = new Date()): void {
  mkdirSync(home, { recursive: true });
  appendFileSync(path.join(home, SPEC_ATTEMPTS), JSON.stringify({ at: at.toISOString(), tool: a.tool, how: a.how }) + "\n", "utf8");
}

/**
 * The attempts logged at or after `sinceMs`, in log order. A log that cannot be read at all counts as
 * an attempt whenever it was made (fail closed). A line that cannot be read counts only when it may
 * have been written at or after `sinceMs`: lines are appended in order, so it was written between the
 * readable line before it and the one after it (the log's last write, for a last line). One written
 * before a seal is left behind by that seal, so one broken line cannot turn every later spec change
 * into a tamper (N-m5); one that counts is on record with its line number and window.
 */
export async function specAttemptsSince(home: string, sinceMs: number): Promise<SpecAttempt[]> {
  const file = path.join(home, SPEC_ATTEMPTS);
  let raw: string;
  let lastWrite: number;
  try {
    raw = await readFile(file, "utf8");
    lastWrite = (await stat(file)).mtimeMs;
  } catch (e) {
    if ((e as NodeJS.ErrnoException).code === "ENOENT") return [];
    return [{ at: "?", tool: "?", how: "unreadable" }];
  }
  type Read = { line: number; a?: SpecAttempt; ms?: number };
  const lines: Read[] = [];
  for (const [i, line] of raw.split(/\r?\n/).entries()) {
    if (line.trim() === "") continue;
    let a: Partial<SpecAttempt> | null = null;
    try {
      a = JSON.parse(line) as Partial<SpecAttempt>;
    } catch {
      /* unreadable: placed by its neighbours below */
    }
    const ms = typeof a?.at === "string" ? Date.parse(a.at) : NaN;
    if (!a || !Number.isFinite(ms) || typeof a.tool !== "string") lines.push({ line: i + 1 });
    else lines.push({ line: i + 1, ms, a: { at: a.at!, tool: a.tool, how: (a.how ?? "unreadable") as SpecAttempt["how"] } });
  }
  const iso = (ms: number) => new Date(ms).toISOString();
  const out: SpecAttempt[] = [];
  for (const [k, l] of lines.entries()) {
    if (l.a) {
      if (l.ms! >= sinceMs) out.push(l.a);
      continue;
    }
    const prev = lines.slice(0, k).findLast((x) => x.a)?.ms;
    const next = lines.slice(k + 1).find((x) => x.a)?.ms ?? lastWrite;
    if (next < sinceMs) continue; // written before the seal
    out.push({ at: `between ${prev === undefined ? "the start of the log" : iso(prev)} and ${iso(next)}`, tool: "?", how: "unreadable", line: l.line });
  }
  return out;
}

/** `Bash (shell), Edit (edit)`: the attempts as a tamper detail names them. */
export const attemptsText = (list: SpecAttempt[]): string =>
  [...new Set(list.map((a) => (a.line !== undefined ? `an unreadable line ${a.line} of the attempts log (written ${a.at})` : `${a.tool} (${a.how})`)))].join(", ");
