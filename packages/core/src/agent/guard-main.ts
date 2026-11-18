#!/usr/bin/env node
// PreToolUse hook entry point:
//   node guard-main.js --home <home> --verifier <verifierDir> [--app <appDir>] [--spec <file>]... [--log <file>] [--edits <file>]
// Reads the hook JSON on stdin. Exit 0 = allow; exit 2 + reason on stderr = deny.
// Any failure (bad args, bad stdin, crash) is a deny: exit 1 would let the call through.
import { appendFileSync } from "node:fs";
import { logSpecAttempt } from "./attempts.js";
import { guardPayload } from "./guard.js";

function arg(name: string): string | undefined {
  const i = process.argv.indexOf(name);
  const v = i >= 0 ? process.argv[i + 1] : undefined;
  return v && !v.startsWith("--") ? v : undefined;
}

/** Every value given for a repeatable flag. */
function args(name: string): string[] {
  const out: string[] = [];
  for (let i = 0; i < process.argv.length; i++) {
    const v = process.argv[i + 1];
    if (process.argv[i] === name && v !== undefined && !v.startsWith("--")) out.push(v);
  }
  return out;
}

function log(line: string): void {
  // the agent's environment carries no HOLDBACK_* variable: the log path comes on the command line
  const f = arg("--log") ?? process.env.HOLDBACK_GUARD_LOG;
  if (!f) return;
  try {
    appendFileSync(f, line + "\n");
  } catch {
    /* logging must never change the decision */
  }
}

function deny(reason: string): never {
  try {
    process.stderr.write(reason + "\n");
  } catch {
    /* still exit 2 */
  }
  process.exit(2);
}

function crash(e: unknown): never {
  log("deny guard-error");
  return deny(`guard error: ${e instanceof Error ? e.message : String(e)}`);
}

process.on("uncaughtException", crash);
process.on("unhandledRejection", crash);

async function readStdin(): Promise<string> {
  let s = "";
  process.stdin.setEncoding("utf8");
  for await (const chunk of process.stdin) s += chunk;
  return s;
}

async function main(): Promise<void> {
  const home = arg("--home");
  const verifierDir = arg("--verifier");
  if (!home || !verifierDir) deny("guard error: --home and --verifier are required.");
  // Test hook: proves a crash inside the guard still denies.
  if (process.env.HOLDBACK_GUARD_SELFTEST_THROW) throw new Error("selftest");

  const raw = await readStdin();
  let payload: unknown;
  try {
    payload = JSON.parse(raw);
  } catch {
    log("deny unparseable");
    deny("Holdback guard could not parse the tool call, so it was blocked.");
  }
  const app = arg("--app");
  const d = guardPayload(payload, { home, verifierDir, specFiles: args("--spec"), ...(app ? { appDir: app } : {}) });
  const tool = (payload as { tool_name?: string })?.tool_name ?? "?";
  log(`${d.allow ? "allow" : "deny"} ${tool}`);
  if (!d.allow) {
    // a write aimed at the spec goes on record in Holdback's home: a spec change in this turn is then a tamper (R37)
    if (d.spec) {
      try {
        logSpecAttempt(home!, { tool, how: d.spec });
      } catch {
        /* the call is denied either way */
      }
    }
    deny(d.reason);
  }
  // the build loop's record of the agent's Edit and Write calls: a change to a git-ignored file is still a change (R48)
  const edits = arg("--edits");
  if (edits && /^(Edit|MultiEdit|Write|NotebookEdit)$/.test(tool)) {
    const input = (payload as { tool_input?: Record<string, unknown> }).tool_input ?? {};
    const target = input.file_path ?? input.notebook_path ?? input.path;
    try {
      appendFileSync(edits, JSON.stringify({ tool, path: typeof target === "string" ? target : "" }) + "\n");
    } catch {
      /* the call is allowed either way */
    }
  }
  process.exit(0);
}

main().catch(crash);
