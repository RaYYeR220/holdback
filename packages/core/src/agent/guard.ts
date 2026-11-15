import { mkdir, writeFile } from "node:fs/promises";
import path from "node:path";

export interface GuardInput {
  tool_name: string;
  tool_input: Record<string, unknown>;
}
export interface GuardContext {
  verifierDir: string;
  home: string;
  /** The app's spec files (`config.spec`, relative to the app dir): an Edit/Write or a shell write onto one is denied. */
  specFiles?: string[];
  /** The app dir, which an Edit/Write path is resolved against to tell the spec from another file of its name. */
  appDir?: string;
}
/** `spec`: the call aimed a write at a spec file (`edit`: an Edit/Write call, `shell`: a shell write); the guard logs it (R37). */
export type GuardDecision = { allow: true } | { allow: false; reason: string; spec?: "edit" | "shell" };

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
const DENY_GIT_INTERNALS = "Holdback owns this repository's git hooks and config. Leave .git/hooks and .git/config alone.";
const DENY_SPEC =
  "The spec is the human's: Holdback re-plans the criteria with them when it changes. Do not write to it; if it looks wrong or unclear, tell the human.";
const DENY_HUMAN =
  "Re-sealing, the spec stage, drift, runs, cleanup, the dashboard and the hooks are the human's Holdback commands. You may run `holdback status` and `holdback owed` to read what is owed.";

/** The `holdback` command by any path or shim (`holdback`, `.bin/holdback`, `holdback.cmd`, `holdback.ps1`). */
const HOLDBACK_BIN = /^(?:.*[/\\])?holdback(?:\.(?:cmd|bat|ps1|exe|js|mjs|cjs))?$/i;
/** The CLI's entry file run with node: `…/cli/dist/index.js` (this repo) or `…/holdback/dist/index.js` (installed). */
const HOLDBACK_ENTRY = /(?:^|[/\\])(?:cli|holdback)[/\\]dist[/\\]index\.[cm]?js$/i;
/** Subcommands only the human runs. `status` and `owed` only read, and stay open to the agent. */
const HUMAN_COMMANDS = new Set(["reseal", "spec", "run", "drift", "watch", "init", "clean", "serve", "hook"]);

/** Shell text that reaches into the repo's hooks or git config (lowercased, backslashes as slashes). */
const GIT_INTERNALS = [".git/hooks", ".git/config", "core.hookspath"];

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

/** Lowercase, `/`-separated, no `./` or `../` prefixes, no quotes: how a shell token is matched to a spec path. */
function specPathOf(token: string): string {
  return unquote(token)
    .toLowerCase()
    .replace(/\\/g, "/")
    .replace(/^(?:\.{1,2}\/)+/, "");
}

/** True when `token` names one of `specs` (normalised): the path itself, or one ending in `/<spec>`. */
function namesSpec(token: string, specs: string[]): boolean {
  const t = specPathOf(token);
  return t !== "" && specs.some((s) => t === s || t.endsWith(`/${s}`));
}

/** Commands that write the file named by any of their arguments (PowerShell's, and `tee`). */
const WRITES_ANY_ARG = /^(?:tee|set-content|add-content|out-file|sc|ac)$/i;
/** Commands whose last argument is the file they write (`cp a b`, `Move-Item a b`). */
const WRITES_LAST_ARG = /^(?:cp|mv|copy|move|copy-item|move-item|cpi|mi|install|ln|rename-item|ren)$/i;

/**
 * Best effort: true when `text` writes onto a spec file from a shell: a `>`/`>>` redirect, `tee`,
 * `Set-Content`/`Add-Content`/`Out-File`, `sed -i`, or `cp`/`mv` (and their PowerShell forms) onto it.
 * Reading the spec stays open. An agent set on getting round it still can (R15); the seal then
 * sees the change, which reads as drift a human looks at.
 */
function specWrite(text: string, specFiles: string[]): boolean {
  const specs = specFiles.map(specPathOf).filter((s) => s !== "");
  if (specs.length === 0) return false;
  // a redirect: `> PRD.md`, `>>PRD.md`, `1> "PRD.md"`, `&> PRD.md`
  for (const m of text.matchAll(/>{1,2}\|?\s*("[^"]*"|'[^']*'|[^\s;&|<>()]+)/g)) if (namesSpec(m[1]!, specs)) return true;
  for (const seg of text.split(/;|&&|\|\||\||\r?\n|`|\$\(|\(|\)/)) {
    const toks = seg
      .trim()
      .split(/\s+/)
      .map(unquote)
      .filter((t) => t.length > 0);
    const at = toks.findIndex((t) => !/^\w+=/.test(t) && t !== "sudo" && t !== "env"); // past env prefixes
    if (at < 0) continue;
    const cmd = toks[at]!.replace(/^.*[/\\]/, "").replace(/\.exe$/i, "");
    const args = toks.slice(at + 1);
    const operands = args.filter((a) => !a.startsWith("-"));
    if (WRITES_ANY_ARG.test(cmd) && operands.some((a) => namesSpec(a, specs))) return true;
    if (/^sed$/i.test(cmd) && args.some((a) => /^-[a-zA-Z]*i/.test(a) || a.startsWith("--in-place")) && operands.some((a) => namesSpec(a, specs))) return true;
    if (WRITES_LAST_ARG.test(cmd)) {
      const dest = args.findIndex((a) => /^-destination$/i.test(a));
      const target = dest >= 0 ? args[dest + 1] : operands.at(-1);
      if (operands.length >= 2 || dest >= 0) if (target !== undefined && namesSpec(target, specs)) return true;
    }
  }
  return false;
}

/** Claude Code's file-writing tools, and the input fields that name the file they write. */
const EDIT_TOOLS = /^(?:edit|write|multiedit|notebookedit)$/i;
const EDIT_PATH_FIELDS = ["file_path", "notebook_path", "path"];

/**
 * True when an Edit/Write/MultiEdit/NotebookEdit call writes a spec file. With the app dir known the
 * path is resolved against it, so only the spec itself matches; without it, any path ending in the
 * spec's relative path does. The permission rules deny these edits too: this also logs them (R37).
 */
function editsSpec(toolName: string, input: Record<string, unknown>, ctx: GuardContext): boolean {
  if (!EDIT_TOOLS.test(toolName) || !ctx.specFiles) return false;
  for (const field of EDIT_PATH_FIELDS) {
    const f = input[field];
    if (typeof f !== "string" || f === "") continue;
    if (ctx.appDir !== undefined) {
      const abs = norm(path.resolve(ctx.appDir, f));
      if (ctx.specFiles.some((s) => norm(path.resolve(ctx.appDir!, s)) === abs)) return true;
    } else if (namesSpec(f, ctx.specFiles.map(specPathOf))) return true;
  }
  return false;
}

/**
 * True when `text` runs one of the human's Holdback commands: the `holdback` binary (any path,
 * any shim, behind npx, an env prefix, `cmd /c` or `powershell -c`) or the CLI's entry file,
 * followed by a human-only subcommand. The CLI's own refusal reads `CLAUDECODE`, which a shell can
 * unset; this check does not depend on it.
 */
function humanCommand(text: string): boolean {
  for (const seg of text.split(GIT_SPLIT)) {
    const toks = seg
      .trim()
      .split(/\s+/)
      .map(unquote)
      .filter((t) => t.length > 0);
    for (let i = 0; i < toks.length; i++) {
      if (!HOLDBACK_BIN.test(toks[i]!) && !HOLDBACK_ENTRY.test(toks[i]!)) continue;
      const sub = toks.slice(i + 1).find((t) => !t.startsWith("-"));
      if (sub !== undefined && HUMAN_COMMANDS.has(sub.toLowerCase())) return true;
    }
  }
  return false;
}

/**
 * Decide whether a tool call may proceed. Denies anything that mentions the
 * Holdback home, verifier directory or Kane's own store (any slash style, any
 * case), runs Kane, reaches for the user's home directory from a shell, runs
 * git beyond a read-only allowlist or touches the repo's git hooks/config, or
 * runs one of the human's Holdback commands (anything but `status` and `owed`).
 * A malformed `tool_input` is denied.
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
  if (ctx.specFiles && editsSpec(String(input.tool_name ?? ""), toolInput, ctx)) return { allow: false, reason: DENY_SPEC, spec: "edit" };
  for (const s of shellStrings(String(input.tool_name ?? ""), toolInput)) {
    if (HOME_REFS.some((re) => re.test(s))) return { allow: false, reason: DENY_HOME_REF };
    const n = s.toLowerCase().replace(/[\\/]+/g, "/"); // `.git\\hooks` (escaped) counts too
    if (GIT_INTERNALS.some((x) => n.includes(x))) return { allow: false, reason: DENY_GIT_INTERNALS };
    const g = gitViolation(s);
    if (g) return { allow: false, reason: g };
    if (humanCommand(s)) return { allow: false, reason: DENY_HUMAN };
    if (ctx.specFiles && specWrite(s, ctx.specFiles)) return { allow: false, reason: DENY_SPEC, spec: "shell" };
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
  /** App-repo files the agent may read but not edit (spec, config), relative to `appDir`. */
  protect?: { appDir: string; files: string[] };
}

/** `Edit(...)` deny rules for app files (and the repo's `.git`), in both the cwd-relative and the absolute rule form. */
function protectRules(p: { appDir: string; files: string[] }): string[] {
  const abs = posixAbs(p.appDir);
  return [...p.files, ".git/**"].flatMap((f) => {
    const rel = f.replace(/\\/g, "/").replace(/^\.\//, "");
    return [`Edit(./${rel})`, `Edit(${abs}/${rel})`];
  });
}

/**
 * `"<abs node>" "<guard-main.js>" --home "<home>" --verifier "<verifierDir>" [--spec "<file>"]…
 * [--log "<file>"]`: every path quoted. `log`: where the guard appends its decisions (debugging).
 */
export function guardHookCommand(ctx: GuardContext, guardMain: string, nodeBin: string = process.execPath, log?: string): string {
  const q = (s: string) => `"${s}"`;
  return [
    q(nodeBin),
    q(guardMain),
    "--home",
    q(ctx.home),
    "--verifier",
    q(ctx.verifierDir),
    ...(ctx.appDir !== undefined ? ["--app", q(ctx.appDir)] : []),
    ...(ctx.specFiles ?? []).flatMap((f) => ["--spec", q(f)]),
    ...(log ? ["--log", q(log)] : []),
  ].join(" ");
}

/**
 * The permission deny rules every Holdback agent runs under: the verifier home (in both rule
 * forms), the repo's `.git`, the protected app files, and optionally the web tools.
 */
export function agentDenyRules(ctx: GuardContext, opts: Pick<AgentSettingsOptions, "denyWeb" | "protect"> = {}): string[] {
  const home = posixAbs(ctx.home);
  const rules = [
    "Read(~/.holdback/**)",
    "Edit(~/.holdback/**)",
    `Read(${home}/**)`,
    `Edit(${home}/**)`,
    "Edit(./.git/**)",
    ...(opts.protect ? protectRules(opts.protect) : []),
    ...(opts.denyWeb ? ["WebFetch", "WebSearch"] : []),
  ];
  return [...new Set(rules)];
}

/** Write the settings file passed to `claude --settings`: deny rules plus the guard hook. */
export async function writeAgentSettings(file: string, ctx: GuardContext, opts: AgentSettingsOptions): Promise<void> {
  const deny = agentDenyRules(ctx, opts);
  const settings = {
    permissions: { deny, blockReadsOutsideWorkingDirectories: true },
    hooks: { PreToolUse: [{ matcher: "*", hooks: [{ type: "command", command: opts.guardCommand }] }] },
  };
  await mkdir(path.dirname(file), { recursive: true });
  await writeFile(file, JSON.stringify(settings, null, 2) + "\n", "utf8");
}
