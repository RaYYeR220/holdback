#!/usr/bin/env node
// PreToolUse hook entry point:
//   node guard-main.js --home <home> --verifier <verifierDir>
// Reads the hook JSON on stdin. Exit 0 = allow; exit 2 + reason on stderr = deny.
// Unparseable input is denied (fail closed).
import { appendFileSync } from "node:fs";
import { guardDecision } from "./guard.js";

function arg(name: string): string | undefined {
  const i = process.argv.indexOf(name);
  return i >= 0 ? process.argv[i + 1] : undefined;
}

function log(line: string): void {
  const f = process.env.HOLDBACK_GUARD_LOG;
  if (!f) return;
  try {
    appendFileSync(f, line + "\n");
  } catch {
    /* logging must never change the decision */
  }
}

function deny(reason: string): never {
  process.stderr.write(reason + "\n");
  process.exit(2);
}

async function readStdin(): Promise<string> {
  let s = "";
  process.stdin.setEncoding("utf8");
  for await (const chunk of process.stdin) s += chunk;
  return s;
}

const home = arg("--home");
const verifierDir = arg("--verifier");
if (!home || !verifierDir) deny("Holdback guard misconfigured: --home and --verifier are required.");

const raw = await readStdin();
let input: { tool_name?: unknown; tool_input?: unknown };
try {
  input = JSON.parse(raw);
  if (typeof input !== "object" || input === null || typeof input.tool_name !== "string") throw new Error("bad shape");
} catch {
  log("deny unparseable");
  deny("Holdback guard could not parse the tool call, so it was blocked.");
}

const toolInput =
  typeof input.tool_input === "object" && input.tool_input !== null ? (input.tool_input as Record<string, unknown>) : {};
const d = guardDecision({ tool_name: input.tool_name as string, tool_input: toolInput }, { home: home!, verifierDir: verifierDir! });
log(`${d.allow ? "allow" : "deny"} ${input.tool_name}`);
if (!d.allow) deny(d.reason);
process.exit(0);
