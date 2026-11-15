import { spawn } from "node:child_process";
import { randomUUID } from "node:crypto";
import { existsSync } from "node:fs";
import { appendFile, mkdir, readFile, rm, rmdir, writeFile } from "node:fs/promises";
import path from "node:path";
import { fileURLToPath } from "node:url";
import {
  acquireCheckLock,
  agentDenyRules,
  appSealFiles,
  byAcId,
  checkOnce,
  forAgent,
  guardPayload,
  HEADLESS_ENV,
  loadProject,
  markEdit,
  readCheckState,
  writeCheckState,
  type CheckDeps,
  type CheckReason,
  type CheckState,
  type Project,
} from "@holdback/core";
import { EXIT, ledgerLog, snapshot, type Ctx } from "./context.js";

/** A background check started by a hook. */
export type CheckWorker = { alive(): boolean };

export type HookDeps = {
  /** Kane, the app and its port, for the background check (`holdback hook check`). */
  check: CheckDeps;
  /** Starts a background check of `appDir` (default: a detached `holdback hook check` that outlives the hook). */
  startCheck: (appDir: string, reason: CheckReason) => CheckWorker;
  sleep: (ms: number) => Promise<void>;
  /** post-edit waits this long for more saves before it asks for a check. */
  debounceMs: number;
  pollMs: number;
  /** How long a hook waits for its check before it answers itself (below any timeout Claude Code may apply). */
  waitMs: number;
  /** The CLI's built entry (`dist/index.js`): the installed hook commands and the background check run it. */
  cliEntry: string;
};

export type HookOptions = { app?: string; reason?: string };

/** Hook exit code that blocks (PreToolUse, Stop) or wakes the agent with stderr (PostToolUse asyncRewake). */
const BLOCK = 2;
/** After this many consecutive refused stops over the same owed set, the next stop is handed to a human. */
export const STOP_BLOCK_CAP = 5;
/**
 * A hook waits at most this long for its check, then answers itself: below Claude Code's 600 s
 * default, so even a timeout clamped to the default never cancels a Stop hook without a decision.
 */
export const HOOK_WAIT_MS = 540_000;
const CONFIG = "holdback.config.json";
/** A background check waits this long for the one in flight before it gives up. */
const WORKER_LOCK_WAIT_MS = 60 * 60_000;

const HANDOFF = "Holdback: handing to a human — see `holdback status`";
const GATE_OPEN = "Holdback: gate open — Kane passes every criterion.";
const UNSEALED = "Holdback: nothing is sealed yet — run `holdback spec` to set up the criteria.";
const BUSY = "Holdback: busy — still verifying your latest changes with Kane. Wait for its verdict before you finish: stop again in a minute.";
const DIED = "Holdback: the check stopped before Kane gave a verdict, so your latest changes are not verified. Tell the human (details in `holdback status`).";
const EDIT_CHECKED = "Holdback: Kane checked the app after your last edit.";

const errText = (e: unknown) => (e instanceof Error ? e.message : String(e));
/** An error, fit for the agent: Holdback's folders and Kane's files are never named. */
const agentError = (p: Project | undefined, e: unknown) => (p ? forAgent(p, errText(e)) : errText(e));

export function defaultHookDeps(check: CheckDeps): HookDeps {
  const cliEntry = fileURLToPath(new URL("./index.js", import.meta.url));
  return {
    check,
    startCheck: spawnCheckWorker(cliEntry),
    sleep: (ms) => new Promise((r) => setTimeout(r, ms)),
    debounceMs: 5_000,
    pollMs: 500,
    waitMs: HOOK_WAIT_MS,
    cliEntry,
  };
}

/**
 * The background check runs in its own detached process, never inside the hook: Claude Code
 * cancels a hook at its timeout (and an async one at the end of a `claude -p` session), and a
 * Kane batch cut short would leave the recordings unanchored and the app running.
 */
export function spawnCheckWorker(cliEntry: string): HookDeps["startCheck"] {
  return (appDir, reason) => {
    let exited = false;
    const child = spawn(process.execPath, [cliEntry, "hook", "check", "--app", appDir, "--reason", reason], {
      cwd: appDir,
      detached: true,
      stdio: "ignore",
      windowsHide: true,
    });
    child.on("exit", () => void (exited = true));
    child.on("error", () => void (exited = true));
    child.unref();
    return { alive: () => !exited };
  };
}

type HookInput = Record<string, unknown>;

async function readInput(ctx: Ctx): Promise<HookInput> {
  let raw = "";
  for await (const chunk of ctx.stdin) raw += typeof chunk === "string" ? chunk : Buffer.from(chunk as Uint8Array).toString("utf8");
  const v: unknown = JSON.parse(raw);
  if (typeof v !== "object" || v === null || Array.isArray(v)) throw new Error("hook input is not a JSON object");
  return v as HookInput;
}

/**
 * The app a hook belongs to when the installed command does not name it (`--app`): the session's
 * project root (CLAUDE_PROJECT_DIR), else the input's cwd, else this process's; then up to the
 * nearest folder holding holdback.config.json. With none found it stays the start folder (a
 * deleted config then shows up as a changed seal, not a free pass).
 */
export function appDirOf(input: HookInput, env: NodeJS.ProcessEnv, fallback: string): string {
  const cwd = typeof input.cwd === "string" && input.cwd !== "" ? input.cwd : undefined;
  const start = path.resolve(env.CLAUDE_PROJECT_DIR || cwd || fallback);
  for (let dir = start; ; ) {
    if (existsSync(path.join(dir, CONFIG))) return dir;
    const up = path.dirname(dir);
    if (up === dir) return start;
    dir = up;
  }
}

/** The project: the `--app` the installer baked into the command, else found from the input. */
const projectOf = (ctx: Ctx, input: HookInput, o: HookOptions) => loadProject(o.app ? path.resolve(o.app) : appDirOf(input, ctx.deps.env, ctx.cwd));

const homeFile = (p: Project, name: string) => path.join(p.home, name);

/** Appends one line to a file under Holdback's home; never fails the hook. */
async function note(p: Project, file: string, line: string): Promise<void> {
  try {
    await mkdir(p.home, { recursive: true });
    await appendFile(homeFile(p, file), `${new Date().toISOString()} ${line.replace(/\s+/g, " ")}\n`, "utf8");
  } catch {
    /* a note must never change a decision */
  }
}

/** Waits until a check that started after `requestAt` has written its verdict. */
async function awaitVerdict(
  h: HookDeps,
  p: Project,
  requestAt: number,
  worker: CheckWorker,
  superseded?: () => Promise<boolean>,
): Promise<CheckState | "timeout" | "died" | "superseded"> {
  const deadline = Date.now() + h.waitMs;
  for (;;) {
    const st = await readCheckState(p.home);
    if (st && st.startedAt >= requestAt) return st;
    if (superseded && (await superseded())) return "superseded";
    if (!worker.alive()) {
      const last = await readCheckState(p.home); // it may have written just before it exited
      return last && last.startedAt >= requestAt ? last : "died";
    }
    if (Date.now() >= deadline) return "timeout";
    await h.sleep(h.pollMs);
  }
}

/** PreToolUse: the same guard the headless agent runs under. Exit 2 + reason denies; anything that goes wrong denies. */
async function guardHook(ctx: Ctx, o: HookOptions): Promise<number> {
  let p: Project | undefined;
  try {
    const input = await readInput(ctx);
    p = await projectOf(ctx, input, o);
    const d = guardPayload(input, { home: p.home, verifierDir: p.verifierDir });
    if (d.allow) return EXIT.ok;
    await note(p, "guard.log", `deny ${String(input.tool_name)}: ${d.reason}`);
    ctx.err(d.reason);
    return BLOCK;
  } catch (e) {
    ctx.err(`Holdback guard could not check this tool call, so it was blocked: ${agentError(p, e)}`);
    return BLOCK;
  }
}

/** The file an Edit/Write/MultiEdit/NotebookEdit call saved, when the input names one. */
function savedFile(input: HookInput): string | undefined {
  const ti = input.tool_input;
  if (typeof ti !== "object" || ti === null) return undefined;
  const f = (ti as Record<string, unknown>).file_path ?? (ti as Record<string, unknown>).notebook_path;
  return typeof f === "string" && f !== "" ? f : undefined;
}

/** Claude Code's own folder and Kane's copied screenshots: saving there changes nothing Kane checks. */
function outsideTheApp(appDir: string, file: string): boolean {
  const rel = path.relative(appDir, path.resolve(appDir, file)).split(path.sep).join("/").toLowerCase();
  return rel === ".claude" || rel.startsWith(".claude/") || rel === "kane-evidence" || rel.startsWith("kane-evidence/");
}

/**
 * PostToolUse (Edit|Write, asyncRewake): marks the save (`edit.at`), waits for a quiet moment (a
 * newer save takes over), asks for a background check and waits for its verdict. A failure wakes
 * the agent with the bug-report brief (exit 2); a pass, a newer save or a check still running ends
 * quietly: the Stop hook is the gate.
 */
async function postEditHook(ctx: Ctx, o: HookOptions): Promise<number> {
  const h = ctx.deps.hooks;
  let p: Project | undefined;
  try {
    const input = await readInput(ctx);
    p = await projectOf(ctx, input, o);
    const file = savedFile(input);
    if (file && outsideTheApp(p.appDir, file)) return EXIT.ok;
    // first, before anything can fail: no verdict from a check that began earlier stands any more
    await markEdit(p.home);
    const stamp = homeFile(p, "edit.stamp");
    const token = randomUUID();
    await writeFile(stamp, token, "utf8");
    const superseded = async () => (await readFile(stamp, "utf8").catch(() => "")) !== token;
    await h.sleep(h.debounceMs);
    if (await superseded()) return EXIT.ok;

    const requestAt = Date.now();
    const v = await awaitVerdict(h, p, requestAt, h.startCheck(p.appDir, "edit"), superseded);
    if (v === "superseded" || v === "timeout") return EXIT.ok;
    if (v === "died") {
      ctx.err(DIED);
      return BLOCK;
    }
    if (v.allowStop || v.status === "unchanged" || v.status === "unsealed") return EXIT.ok;
    ctx.err(v.status === "checked" ? `${EDIT_CHECKED}\n\n${v.brief.trimEnd()}` : v.brief.trimEnd());
    return BLOCK;
  } catch (e) {
    ctx.err(`Holdback could not check your last edit: ${agentError(p, e)}`);
    return BLOCK;
  }
}

type Blocks = { key: string; count: number };
const BLOCKS_FILE = "stop-blocks.json";

async function readBlocks(p: Project): Promise<Blocks | null> {
  try {
    const v = JSON.parse(await readFile(homeFile(p, BLOCKS_FILE), "utf8")) as Partial<Blocks>;
    return typeof v.key === "string" && typeof v.count === "number" ? { key: v.key, count: v.count } : null;
  } catch {
    return null;
  }
}

const clearBlocks = (p: Project) => rm(homeFile(p, BLOCKS_FILE), { force: true }).catch(() => {});

/**
 * Refuses the stop (exit 2, `message` to the agent) unless this is the 6th refusal in a row over
 * the same owed set (`key`): then the stop goes through and the human is told. It stays handed over
 * until the owed set changes, the gate opens or the human sends a prompt.
 */
async function refuseStop(ctx: Ctx, p: Project | undefined, key: string, message: string): Promise<number> {
  if (p) {
    const prev = await readBlocks(p);
    const count = prev && prev.key === key ? prev.count : 0;
    if (count >= STOP_BLOCK_CAP) {
      ctx.out(JSON.stringify({ systemMessage: HANDOFF }));
      return EXIT.ok;
    }
    try {
      await writeFile(homeFile(p, BLOCKS_FILE), JSON.stringify({ key, count: count + 1 }), "utf8");
    } catch {
      /* uncounted: Claude Code's own cap still ends a loop */
    }
  }
  ctx.err(message.trimEnd());
  return BLOCK;
}

/**
 * Stop: asks for a check of the app as it is now (Kane runs only when something changed since the
 * last one; a check in flight finishes first) and waits for the verdict. The gate open → exit 0;
 * otherwise exit 2 with the brief, the start failure, or the tamper/drift/error note. Fails closed
 * on every error, and when no verdict comes within the wait (the check keeps running).
 */
async function stopHook(ctx: Ctx, o: HookOptions): Promise<number> {
  const h = ctx.deps.hooks;
  let p: Project | undefined;
  try {
    const input = await readInput(ctx);
    p = await projectOf(ctx, input, o);
    const requestAt = Date.now();
    const v = await awaitVerdict(h, p, requestAt, h.startCheck(p.appDir, "stop"));
    if (v === "timeout" || v === "superseded") return await refuseStop(ctx, p, "busy", BUSY);
    if (v === "died") return await refuseStop(ctx, p, "died", DIED);
    if (v.status === "unsealed") {
      ctx.out(JSON.stringify({ systemMessage: UNSEALED }));
      return EXIT.ok;
    }
    if (v.allowStop) {
      await clearBlocks(p);
      ctx.out(JSON.stringify({ systemMessage: GATE_OPEN }));
      return EXIT.ok;
    }
    const key =
      v.status === "checked" || v.status === "unchanged" ? (v.appStartError !== undefined ? "app-down" : `owed:${[...v.owed].sort().join(",")}`) : v.status;
    return await refuseStop(ctx, p, key, v.brief);
  } catch (e) {
    return await refuseStop(ctx, p, "error", `Holdback could not check the app: ${agentError(p, e)}. Tell the human; your work is not verified.`);
  }
}

/** UserPromptSubmit: at most three lines on what is owed, added to the agent's context. Never blocks or fails the prompt. */
async function promptHook(ctx: Ctx, o: HookOptions): Promise<number> {
  try {
    const input = await readInput(ctx);
    const p = await projectOf(ctx, input, o);
    await clearBlocks(p); // a human is back: the agent gets its full count of refused stops again
    const s = await snapshot(p);
    const lines: string[] = [];
    if (s.tamper !== null) lines.push("Holdback: the gate is shut by a tamper — only a human can lift it (`holdback status`).");
    else if (!s.manifest || Object.keys(s.state.acs).length === 0) lines.push(UNSEALED);
    else {
      const regressed = [...s.gate.regressed].sort(byAcId).map((a) => a.id);
      const owed = [...regressed, ...[...s.gate.owed].sort(byAcId).map((a) => a.id)];
      const shown = owed.slice(0, 8).join(", ") + (owed.length > 8 ? `, +${owed.length - 8} more` : "");
      // a run that proved nothing shuts the gate too; which one, and why, is for the human (`holdback status`)
      const zero = s.gate.inconclusive.length > 0 ? "Holdback: 0 owed — the gate stays shut until Kane re-checks some criteria" : "Holdback: 0 owed — every criterion passes";
      lines.push(owed.length > 0 ? `Holdback: ${owed.length} owed (${shown})` : zero);
      if (regressed.length > 0) lines.push(`Regressed: ${regressed.join(", ")}`);
      if (s.specChanged.length > 0) lines.push(`The spec changed since the last seal (${s.specChanged.join(", ")}): a human runs \`holdback drift\`.`);
    }
    ctx.out(lines.slice(0, 3).join("\n"));
  } catch {
    /* nothing printed: the prompt goes through untouched */
  }
  return EXIT.ok;
}

/** `holdback hook check`: the background check the hooks start. One at a time per project (the check lock). */
async function checkWorker(ctx: Ctx, o: HookOptions): Promise<number> {
  if (!o.app || (o.reason !== "edit" && o.reason !== "stop")) {
    ctx.err("hook check needs --app <dir> and --reason edit|stop");
    return EXIT.error;
  }
  const reason: CheckReason = o.reason;
  const p = await loadProject(o.app);
  const lock = await acquireCheckLock(p.home, { waitMs: WORKER_LOCK_WAIT_MS });
  if (!lock) {
    await note(p, "check.log", `${reason}: gave up waiting for the check in flight`);
    return EXIT.error;
  }
  const startedAt = Date.now();
  try {
    const r = await checkOnce(p, ctx.deps.hooks.check, ledgerLog(p), { reason });
    const unsure = r.inconclusive?.length ? `; inconclusive: ${r.inconclusive.join("; ")}` : "";
    await note(p, "check.log", `${reason}: ${r.status}${r.ran.length > 0 ? ` (Kane ran ${r.ran.join(", ")})` : ""}, ${r.allowStop ? "gate open" : `${r.owed.length} owed`}${r.detail ? `: ${r.detail}` : ""}${unsure}`);
    return EXIT.ok;
  } catch (e) {
    // the hooks are waiting for a verdict: give them one that keeps the gate shut
    await note(p, "check.log", `${reason}: failed: ${errText(e)}`);
    const brief = `# Holdback — the check did not run\n\nHoldback could not check the app: ${agentError(p, e)}\nTell the human; Kane has not checked your latest changes.\n`;
    await writeCheckState(p.home, {
      status: "error",
      allowStop: false,
      ran: [],
      brief,
      tampered: false,
      owed: [],
      detail: errText(e),
      startedAt,
      finishedAt: Date.now(),
      reason,
      tree: null,
      ledger: null,
    }).catch(() => {});
    return EXIT.error;
  } finally {
    await lock.release();
  }
}

/** `holdback hook <name>`: one Claude Code hook. Every path answers with the hook's own exit code. */
export async function hookCmd(ctx: Ctx, name: string, o: HookOptions = {}): Promise<number> {
  // a headless `holdback run` turn (its agent process is marked) already checks with Kane and holds
  // the check lock: the interactive hooks the app may also have stand aside. The guard never does.
  if (ctx.deps.env[HEADLESS_ENV] && (name === "stop" || name === "post-edit" || name === "prompt")) return EXIT.ok;
  switch (name) {
    case "guard":
      return guardHook(ctx, o);
    case "post-edit":
      return postEditHook(ctx, o);
    case "stop":
      return stopHook(ctx, o);
    case "prompt":
      return promptHook(ctx, o);
    case "check":
      return checkWorker(ctx, o);
    default:
      ctx.err(`unknown hook: ${name} (guard, post-edit, stop or prompt)`);
      return BLOCK;
  }
}

// ---- installer: `holdback init --agent claude [--remove]` ----

type Json = Record<string, unknown>;
type HookEntry = Json & { command?: unknown };
type HookGroup = Json & { hooks?: HookEntry[] };

/**
 * `<home>/claude-install.json`: exactly what `init --agent claude` added to the settings file, so
 * a re-run replaces it and `--remove` takes out that and nothing else (an identical rule or hook
 * the human had before is never recorded).
 */
type InstallRecord = { settings: string; hooks: { event: string; command: string }[]; deny: string[]; blockReads: boolean };
const INSTALL_RECORD = "claude-install.json";

const SETTINGS = [".claude", "settings.json"];
const SKILL = [".claude", "skills", "holdback", "SKILL.md"];
const SKILL_HEAD = "---\nname: holdback\n";
/** App files the agent may read but never edit in this mode, beyond the sealed ones: its own hook settings. */
const CLAUDE_SETTINGS_FILES = [".claude/settings.json", ".claude/settings.local.json"];

const templateFile = (name: string) => fileURLToPath(new URL(`../templates/${name}`, import.meta.url));
const isObj = (v: unknown): v is Json => typeof v === "object" && v !== null && !Array.isArray(v);
const quote = (s: string) => `"${s}"`;

/** What `--agent claude` puts into `.claude/settings.json` for this project. */
async function ourSettings(p: Project, cliEntry: string): Promise<{ hooks: Record<string, HookGroup[]>; deny: string[] }> {
  const tpl = JSON.parse(await readFile(templateFile("settings.json"), "utf8")) as { hooks: Record<string, HookGroup[]> };
  const prefix = `${quote(process.execPath)} ${quote(cliEntry)}`;
  for (const groups of Object.values(tpl.hooks)) {
    for (const g of groups) {
      for (const hk of g.hooks ?? []) {
        // function replacements: a `$` in a path must never be read as a replacement pattern
        if (typeof hk.command === "string") hk.command = hk.command.replace("{{holdback}}", () => prefix).replace("{{app}}", () => quote(p.appDir));
      }
    }
  }
  const deny = agentDenyRules({ home: p.home, verifierDir: p.verifierDir }, { protect: { appDir: p.appDir, files: [...appSealFiles(p), ...CLAUDE_SETTINGS_FILES] } });
  return { hooks: tpl.hooks, deny };
}

class SettingsShape extends Error {}

/** Reads `.claude/settings.json` (an empty object when there is none); refuses anything it could not merge safely. */
async function readSettings(file: string): Promise<Json> {
  let raw: string;
  try {
    raw = await readFile(file, "utf8");
  } catch (e) {
    if ((e as NodeJS.ErrnoException).code === "ENOENT") return {};
    throw e;
  }
  let v: unknown;
  try {
    v = JSON.parse(raw);
  } catch (e) {
    throw new SettingsShape(`${file} is not valid JSON (${errText(e)})`);
  }
  if (!isObj(v)) throw new SettingsShape(`${file} is not a JSON object`);
  if (v.permissions !== undefined && !isObj(v.permissions)) throw new SettingsShape(`${file}: "permissions" is not an object`);
  if (isObj(v.permissions) && v.permissions.deny !== undefined && !Array.isArray(v.permissions.deny)) throw new SettingsShape(`${file}: "permissions.deny" is not a list`);
  if (v.hooks !== undefined && !isObj(v.hooks)) throw new SettingsShape(`${file}: "hooks" is not an object`);
  for (const [event, groups] of Object.entries(isObj(v.hooks) ? v.hooks : {})) {
    if (!Array.isArray(groups) || !groups.every((g) => isObj(g) && (g.hooks === undefined || Array.isArray(g.hooks)))) {
      throw new SettingsShape(`${file}: hooks.${event} is not a list of matcher groups`);
    }
  }
  return v;
}

async function readRecord(p: Project): Promise<InstallRecord | null> {
  try {
    const v = JSON.parse(await readFile(homeFile(p, INSTALL_RECORD), "utf8")) as Partial<InstallRecord>;
    if (!Array.isArray(v.hooks) || !Array.isArray(v.deny) || typeof v.blockReads !== "boolean" || typeof v.settings !== "string") return null;
    return v as InstallRecord;
  } catch {
    return null;
  }
}

/** The settings without what `record` says Holdback added; groups, events and blocks left empty by that go too. */
function takeOut(settings: Json, record: InstallRecord | null): Json {
  const out: Json = { ...settings };
  if (!record) return out;
  if (isObj(settings.hooks)) {
    const hooks: Json = {};
    for (const [event, groups] of Object.entries(settings.hooks)) {
      const ours = new Set(record.hooks.filter((h) => h.event === event).map((h) => h.command));
      const kept: HookGroup[] = [];
      for (const g of groups as HookGroup[]) {
        const had = g.hooks ?? [];
        const left = had.filter((hk) => typeof hk.command !== "string" || !ours.has(hk.command));
        if (left.length === had.length) kept.push(g);
        else if (left.length > 0) kept.push({ ...g, hooks: left });
      }
      if (kept.length > 0) hooks[event] = kept;
    }
    if (Object.keys(hooks).length > 0) out.hooks = hooks;
    else delete out.hooks;
  }
  if (isObj(settings.permissions)) {
    const perms: Json = { ...settings.permissions };
    if (Array.isArray(perms.deny)) {
      const deny = perms.deny.filter((r) => typeof r !== "string" || !record.deny.includes(r));
      if (deny.length > 0) perms.deny = deny;
      else delete perms.deny;
    }
    if (record.blockReads && perms.blockReadsOutsideWorkingDirectories === true) delete perms.blockReadsOutsideWorkingDirectories;
    if (Object.keys(perms).length > 0) out.permissions = perms;
    else delete out.permissions;
  }
  return out;
}

async function writeJson(file: string, v: unknown): Promise<void> {
  await mkdir(path.dirname(file), { recursive: true });
  await writeFile(file, JSON.stringify(v, null, 2) + "\n", "utf8");
}

/**
 * Merges Holdback's hooks (each command names this app with `--app`), deny rules and read boundary
 * into the app's `.claude/settings.json`, records what it added, and installs the skill. A re-run
 * first takes out what the last run recorded, so the deny rules follow the current config.
 */
export async function installClaudeHooks(ctx: Ctx): Promise<number> {
  const entry = ctx.deps.hooks.cliEntry;
  if (!existsSync(entry)) {
    // a hook command that cannot start lets every tool call through: never install one
    ctx.err(`Holdback's built CLI was not found at ${entry}: build it first (pnpm -r build), then run this again.`);
    return EXIT.error;
  }
  const p = await loadProject(ctx.cwd);
  // the hook commands put these paths inside double quotes for a shell: refuse what it would expand there
  for (const where of [process.execPath, entry, p.appDir]) {
    if (/[$`"\r\n]/.test(where)) {
      ctx.err(`Holdback cannot install hooks for a path that contains $, \`, " or a line break: ${where}. Move it to a plain path first.`);
      return EXIT.error;
    }
  }
  const file = path.join(p.appDir, ...SETTINGS);
  let current: Json;
  try {
    current = await readSettings(file);
  } catch (e) {
    ctx.err(`${errText(e)}. Holdback did not change it; fix it by hand and run this again.`);
    return EXIT.error;
  }
  const base = takeOut(current, await readRecord(p));
  const ours = await ourSettings(p, entry);
  const record: InstallRecord = { settings: file, hooks: [], deny: [], blockReads: false };

  const perms: Json = { ...(isObj(base.permissions) ? base.permissions : {}) };
  const deny = [...((perms.deny as unknown[] | undefined) ?? [])];
  for (const r of ours.deny) {
    if (deny.includes(r)) continue;
    deny.push(r);
    record.deny.push(r);
  }
  perms.deny = deny;
  if (perms.blockReadsOutsideWorkingDirectories !== true) {
    perms.blockReadsOutsideWorkingDirectories = true;
    record.blockReads = true;
  }
  const hooks: Json = { ...(isObj(base.hooks) ? base.hooks : {}) };
  for (const [event, groups] of Object.entries(ours.hooks)) {
    const present = new Set(((hooks[event] as HookGroup[] | undefined) ?? []).flatMap((g) => (g.hooks ?? []).map((hk) => hk.command)));
    const added: HookGroup[] = [];
    for (const g of groups) {
      const fresh = (g.hooks ?? []).filter((hk) => !present.has(hk.command));
      if (fresh.length === 0) continue;
      added.push({ ...g, hooks: fresh });
      for (const hk of fresh) record.hooks.push({ event, command: hk.command as string });
    }
    if (added.length > 0) hooks[event] = [...((hooks[event] as HookGroup[] | undefined) ?? []), ...added];
  }
  await writeJson(file, { ...base, permissions: perms, hooks });
  await writeJson(homeFile(p, INSTALL_RECORD), record);

  const skill = path.join(p.appDir, ...SKILL);
  const existing = await readFile(skill, "utf8").catch(() => null);
  if (existing === null || existing.startsWith(SKILL_HEAD)) {
    await mkdir(path.dirname(skill), { recursive: true });
    await writeFile(skill, await readFile(templateFile("skill.md"), "utf8"), "utf8");
  } else ctx.err(`warning: ${skill} is not Holdback's; left as it is`);

  ctx.out("Claude Code hooks installed in .claude/settings.json:");
  ctx.out("  guard      every tool call: keeps the agent out of Kane's tests and Holdback's files");
  ctx.out("  post-edit  every Edit/Write: Kane checks the app in the background and wakes the agent on a failure");
  ctx.out(`  stop       refuses "done" while a criterion is owed (after ${STOP_BLOCK_CAP} refusals in a row it hands over to you)`);
  ctx.out("  prompt     shows what is still owed with every prompt");
  ctx.out("Start Claude Code in this folder. `holdback init --agent claude --remove` takes them out again.");
  return EXIT.ok;
}

/** Takes out of the app's `.claude/` exactly what `init --agent claude` recorded adding, and Holdback's skill. */
export async function removeClaudeHooks(ctx: Ctx): Promise<number> {
  const p = await loadProject(ctx.cwd);
  const file = path.join(p.appDir, ...SETTINGS);
  let current: Json;
  try {
    current = await readSettings(file);
  } catch (e) {
    ctx.err(`${errText(e)}. Holdback did not change it; fix it by hand and run this again.`);
    return EXIT.error;
  }
  const record = await readRecord(p);
  if (!record) ctx.err("warning: Holdback has no record of what it added to .claude/settings.json; the settings are left as they are.");
  else if (existsSync(file)) await writeJson(file, takeOut(current, record));
  await rm(homeFile(p, INSTALL_RECORD), { force: true });
  const skill = path.join(p.appDir, ...SKILL);
  const existing = await readFile(skill, "utf8").catch(() => null);
  if (existing !== null && existing.startsWith(SKILL_HEAD)) {
    await rm(skill, { force: true });
    await rmdir(path.dirname(skill)).catch(() => {}); // only when empty
    await rmdir(path.dirname(path.dirname(skill))).catch(() => {});
  }
  ctx.out("Holdback's Claude Code hooks, deny rules and skill are removed from .claude/.");
  return EXIT.ok;
}
