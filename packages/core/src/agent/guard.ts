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

/** Lowercase, forward slashes, no trailing slash: the shape all comparisons use. */
function norm(s: string): string {
  return s.toLowerCase().replace(/\\/g, "/").replace(/\/+$/, "");
}

/** `c:/users/x` -> `/c/users/x` (the form shells like Git Bash print). */
function msys(n: string): string | undefined {
  const m = /^([a-z]):\//.exec(n);
  return m ? `/${m[1]}/${n.slice(3)}` : undefined;
}

function needles(ctx: GuardContext): string[] {
  const out = new Set<string>([".holdback"]);
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

const BASH_RULES: Array<[RegExp, string]> = [
  [/\bkane-cli\b/i, "Holdback runs Kane itself. Do not invoke kane-cli."],
  [
    /\bgit\s+(commit|push|reset|checkout|rebase|stash|worktree)\b/i,
    "Holdback owns git history. Do not commit, push, reset, checkout, rebase, stash or manage worktrees.",
  ],
];

/**
 * Decide whether a tool call may proceed. Denies anything that mentions the
 * Holdback home or verifier directory (any slash style, any case), runs Kane,
 * or rewrites git history.
 */
export function guardDecision(input: GuardInput, ctx: GuardContext): GuardDecision {
  const ns = needles(ctx);
  for (const s of strings(input.tool_input)) {
    const n = s.toLowerCase().replace(/\\/g, "/");
    if (ns.some((x) => n.includes(x))) {
      return { allow: false, reason: "Holdback's verification files are off limits. Work from the owed list in your prompt." };
    }
  }
  if (input.tool_name === "Bash") {
    const cmd = typeof input.tool_input?.command === "string" ? input.tool_input.command : "";
    for (const [re, reason] of BASH_RULES) if (re.test(cmd)) return { allow: false, reason };
  }
  return { allow: true };
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
