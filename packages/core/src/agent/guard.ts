import { mkdir, writeFile } from "node:fs/promises";
import path from "node:path";

export interface GuardInput {
  tool_name: string;
  tool_input: Record<string, unknown>;
}
export interface GuardContext {
  verifierDir: string;
  home: string;
}
export type GuardDecision = { allow: true } | { allow: false; reason: string };

/** Lowercase, forward slashes, no trailing slash: the shape all path comparisons use. */
function norm(s: string): string {
  return s.toLowerCase().replace(/\\/g, "/").replace(/\/+$/, "");
}

/** `c:/users/x` -> `/c/users/x` (the form shells like Git Bash print). */
function msys(n: string): string | undefined {
  const m = /^([a-z]):\//.exec(n);
  return m ? `/${m[1]}/${n.slice(3)}` : undefined;
}

function needles(ctx: GuardContext): string[] {
  const out = new Set<string>([".holdback", ".testmuai"]);
  for (const p of [ctx.home, ctx.verifierDir]) {
    const n = norm(p);
    if (!n) continue;
    out.add(n);
    const m = msys(n);
    if (m) out.add(m);
  }
  return [...out];
}

function* strings(v: unknown): Generator<string> {
  if (typeof v === "string") yield v;
  else if (Array.isArray(v)) for (const x of v) yield* strings(x);
  else if (v && typeof v === "object") for (const x of Object.values(v)) yield* strings(x);
}

/** Strings that may be shell text: every `command` field, and everything for shell tools. */
function* shellStrings(toolName: string, input: Record<string, unknown>): Generator<string> {
  if (/^(bash|powershell|shell|cmd)/i.test(toolName)) {
    yield* strings(input);
    return;
  }
  function* walk(v: unknown): Generator<string> {
    if (Array.isArray(v)) for (const x of v) yield* walk(x);
    else if (v && typeof v === "object") {
      for (const [k, x] of Object.entries(v)) {
        if (k === "command") yield* strings(x);
        else yield* walk(x);
      }
    }
  }
  yield* walk(input);
}

const DENY_FILES = "Holdback's verification files are off limits. Work from the owed list in your prompt.";
const DENY_KANE = "Holdback runs Kane itself. Do not invoke kane-cli.";
const DENY_HOME_REF = "Reaching for the user's home directory is not needed to build this app. Stay inside the working directory.";
const DENY_GIT =
  "Holdback owns git history. Only read-only git commands (status, diff, log, show, ls-files, blame, rev-parse, branch --list) are allowed.";
const DENY_INPUT = "Holdback guard could not read this tool call, so it was blocked.";

// References to the user's home directory from a shell. A tilde must stand alone as a word.
const HOME_REFS: RegExp[] = [
  /(^|[\s"'`=(:;|&<>])~([/\\]|$|[\s"'`;|&)<>])/,
  /\$\{?HOME\b/i,
  /%HOME%/i,
  /\benv:HOME\b/i,
  /\bUSERPROFILE\b/i,
  /\bHOMEPATH\b/i,
  /\bHOMEDRIVE\b/i,
];

const GIT_OK = new Set(["status", "diff", "log", "show", "ls-files", "blame", "rev-parse"]);
const BRANCH_OK = new Set(["--list", "-a", "-l"]);
const GIT_SPLIT = /;|&&|\|\||\||&|\r?\n|`|\$\(|\(|\)/;
const GIT_BIN = /^(.*[/\\])?git(\.exe)?$/i;

function unquote(t: string): string {
  return t.replace(/^["'`]+|["'`]+$/g, "");
}

/** Returns a deny reason when `text` runs git outside the read-only allowlist. */
function gitViolation(text: string): string | undefined {
  for (const seg of text.split(GIT_SPLIT)) {
    const toks = seg
      .trim()
      .split(/\s+/)
      .map(unquote)
      .filter((t) => t.length > 0);
    for (let i = 0; i < toks.length; i++) {
      if (!GIT_BIN.test(toks[i]!)) continue;
      let j = i + 1;
      while (j < toks.length && toks[j]!.startsWith("-")) {
        const o = toks[j]!;
        if (o === "-C" || o === "--git-dir" || o === "--work-tree" || o === "--namespace") j += 2;
        else if (o === "-c") {
          // Aliases and core.* settings can smuggle arbitrary commands past the subcommand check.
          if (/^(alias|core)\./i.test(toks[j + 1] ?? "")) return DENY_GIT;
          j += 2;
        } else if (/^--config-env/i.test(o)) return DENY_GIT;
        else j += 1;
      }
      const sub = toks[j];
      if (sub === undefined || GIT_OK.has(sub)) continue;
      if (sub === "branch" && toks.slice(j + 1).every((a) => BRANCH_OK.has(a))) continue;
      return DENY_GIT;
    }
  }
  return undefined;
}

/**
 * Decide whether a tool call may proceed. Denies anything that mentions the
 * Holdback home, verifier directory or Kane's own store (any slash style, any
 * case), runs Kane, reaches for the user's home directory from a shell, or runs
 * git beyond a read-only allowlist. A malformed `tool_input` is denied.
 *
 * Path and kane-cli checks cover every string of any tool; home and git checks
 * cover shell tools (Bash, PowerShell) and any `command` field.
 */
export function guardDecision(input: GuardInput, ctx: GuardContext): GuardDecision {
  const ti: unknown = input?.tool_input;
  if (typeof ti !== "object" || ti === null || Array.isArray(ti)) return { allow: false, reason: DENY_INPUT };
  const toolInput = ti as Record<string, unknown>;
  const ns = needles(ctx);
  for (const s of strings(toolInput)) {
    const n = s.toLowerCase().replace(/\\/g, "/");
    if (ns.some((x) => n.includes(x))) return { allow: false, reason: DENY_FILES };
    if (/\bkane-cli\b/i.test(s)) return { allow: false, reason: DENY_KANE };
  }
  for (const s of shellStrings(String(input.tool_name ?? ""), toolInput)) {
    if (HOME_REFS.some((re) => re.test(s))) return { allow: false, reason: DENY_HOME_REF };
    const g = gitViolation(s);
    if (g) return { allow: false, reason: g };
  }
  return { allow: true };
}

/** Like guardDecision on a raw hook payload, but also scans every string of the payload for the path needles. */
export function guardPayload(payload: unknown, ctx: GuardContext): GuardDecision {
  if (typeof payload !== "object" || payload === null || Array.isArray(payload)) return { allow: false, reason: DENY_INPUT };
  const p = payload as Record<string, unknown>;
  if (typeof p.tool_name !== "string") return { allow: false, reason: DENY_INPUT };
  const ns = needles(ctx);
  for (const s of strings(p)) {
    const n = s.toLowerCase().replace(/\\/g, "/");
    if (ns.some((x) => n.includes(x))) return { allow: false, reason: DENY_FILES };
  }
  return guardDecision({ tool_name: p.tool_name, tool_input: p.tool_input as Record<string, unknown> }, ctx);
}

/** Absolute path in the `//c/Users/x` form Claude Code permission rules expect. */
export function posixAbs(p: string): string {
  const s = p.replace(/\\/g, "/");
  const m = /^([a-zA-Z]):\/(.*)$/.exec(s);
  if (m) return `//${m[1]!.toLowerCase()}/${m[2]}`.replace(/\/+$/, "");
  return `/${s}`.replace(/\/+$/, "");
}

export interface AgentSettingsOptions {
  /** Shell command that runs the guard (reads the hook JSON on stdin). */
  guardCommand: string;
  /** Also remove WebFetch / WebSearch from the agent. */
  denyWeb?: boolean;
}

/** Write the settings file passed to `claude --settings`: deny rules plus the guard hook. */
export async function writeAgentSettings(file: string, ctx: GuardContext, opts: AgentSettingsOptions): Promise<void> {
  const home = posixAbs(ctx.home);
  const deny = [
    "Read(~/.holdback/**)",
    "Edit(~/.holdback/**)",
    `Read(${home}/**)`,
    `Edit(${home}/**)`,
    ...(opts.denyWeb ? ["WebFetch", "WebSearch"] : []),
  ];
  const settings = {
    permissions: { deny, blockReadsOutsideWorkingDirectories: true },
    hooks: { PreToolUse: [{ matcher: "*", hooks: [{ type: "command", command: opts.guardCommand }] }] },
  };
  await mkdir(path.dirname(file), { recursive: true });
  await writeFile(file, JSON.stringify(settings, null, 2) + "\n", "utf8");
}
