import { appendFileSync, mkdirSync } from "node:fs";
import { readFile } from "node:fs/promises";
import path from "node:path";

/**
 * `<home>/spec-attempts.jsonl`: every coding-agent tool call the guard (or the interactive
 * post-edit hook) saw aimed at a spec file, one JSON line each. It lives in Holdback's home, out of
 * the agent's reach. A spec change in a window where the agent made such an attempt is a tamper,
 * never drift (R37).
 */
export const SPEC_ATTEMPTS = "spec-attempts.jsonl";

/** `edit`: an Edit/Write call onto the spec; `shell`: a shell write onto it; `saved`: a save that went through. */
export type SpecAttempt = { at: string; tool: string; how: "edit" | "shell" | "saved" | "unreadable" };

/** Appends one attempt (synchronously: the guard exits right after). Throws when it cannot be written. */
export function logSpecAttempt(home: string, a: { tool: string; how: SpecAttempt["how"] }, at: Date = new Date()): void {
  mkdirSync(home, { recursive: true });
  appendFileSync(path.join(home, SPEC_ATTEMPTS), JSON.stringify({ at: at.toISOString(), tool: a.tool, how: a.how }) + "\n", "utf8");
}

/**
 * The attempts logged at or after `sinceMs`. Fails closed: a line that cannot be read, or a log that
 * cannot be read at all, counts as an attempt whenever it was made.
 */
export async function specAttemptsSince(home: string, sinceMs: number): Promise<SpecAttempt[]> {
  let raw: string;
  try {
    raw = await readFile(path.join(home, SPEC_ATTEMPTS), "utf8");
  } catch (e) {
    if ((e as NodeJS.ErrnoException).code === "ENOENT") return [];
    return [{ at: "?", tool: "?", how: "unreadable" }];
  }
  const out: SpecAttempt[] = [];
  for (const line of raw.split(/\r?\n/)) {
    if (line.trim() === "") continue;
    let a: Partial<SpecAttempt> | null = null;
    try {
      a = JSON.parse(line) as Partial<SpecAttempt>;
    } catch {
      /* counted below */
    }
    const at = typeof a?.at === "string" ? Date.parse(a.at) : NaN;
    if (!a || !Number.isFinite(at) || typeof a.tool !== "string") out.push({ at: "?", tool: "?", how: "unreadable" });
    else if (at >= sinceMs) out.push({ at: a.at!, tool: a.tool, how: (a.how ?? "unreadable") as SpecAttempt["how"] });
  }
  return out;
}

/** `Bash (shell), Edit (edit)`: the attempts as a tamper detail names them. */
export const attemptsText = (list: SpecAttempt[]): string => [...new Set(list.map((a) => `${a.tool} (${a.how})`))].join(", ");
