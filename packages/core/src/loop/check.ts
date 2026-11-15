import { randomUUID } from "node:crypto";
import { mkdir, open, readFile, rename, rm, stat, utimes, writeFile } from "node:fs/promises";
import path from "node:path";
import { freePort } from "../app.js";
import { changedFiles, worktreeTree } from "../git.js";
import { gate } from "../ledger/gate.js";
import { reduce } from "../ledger/reduce.js";
import type { LedgerEvent, LedgerState } from "../ledger/types.js";
import type { LedgerMark } from "../ledger/vouched.js";
import type { Project } from "../project.js";
import { appSealKey, checkSeal, isAppKeyOf } from "../seal.js";
import { tamperMarker } from "../tamper.js";
import { blameOf } from "./bisect.js";
import { buildBrief, byAcId } from "./brief.js";
import { EVIDENCE_DIR, filesOf, lastSeal, testFileMap, VerifySession, type BuildDeps, type SessionStop } from "./build.js";

type Log = (e: LedgerEvent) => Promise<void>;
type Gate = ReturnType<typeof gate>;

/** `edit`: the agent saved a file. `stop`: the agent says it is done (closes the interactive turn). */
export type CheckReason = "edit" | "stop";
/**
 * `checked`: Kane ran against the work tree as it is now. `unchanged`: nothing changed since the
 * last check, whose verdict stands. Everything else checked nothing and keeps the gate shut.
 */
export type CheckStatus = "checked" | "unchanged" | "unsealed" | "drift" | "tamper" | "aborted" | "error";

export type CheckDeps = Pick<BuildDeps, "tests" | "app" | "balance"> & {
  /** The port the app is started on for the check. Default: a free one (the agent may run its own server on the configured port). */
  port?: () => Promise<number>;
};

export type CheckOptions = { reason: CheckReason; signal?: AbortSignal };

export type CheckResult = {
  status: CheckStatus;
  /** The stop decision: the gate is open, nothing is tampered, and the app started for the work tree Kane checked. */
  allowStop: boolean;
  /** The gate as the ledger has it after the check. */
  gate: Gate;
  /** Test ids Kane ran in this check. */
  ran: string[];
  /** What the agent is told while `allowStop` is false: the bug-report brief, or why nothing could be checked. */
  brief: string;
  /** A tamper is on record or was just found: only a human re-seal reopens the gate. */
  tampered: boolean;
  /** Owed criterion ids, regressed ones first. */
  owed: string[];
  detail?: string;
  /** The app did not start for this work tree: no criterion could be checked. */
  appStartError?: string;
  /**
   * The tests whose latest run proved nothing (`<test>: <why>`), which keep the gate shut until Kane
   * runs them conclusively: their criteria kept their status. For the human (check.json, check.log,
   * `holdback status`) and the Stop hook's hand-off, never the agent's brief.
   */
  inconclusive?: string[];
};

/** `<home>/check.json`: the latest check's verdict and what it was for. Written last, in one rename. */
export type CheckState = Omit<CheckResult, "gate"> & {
  startedAt: number;
  finishedAt: number;
  reason: CheckReason;
  /** The work-tree fingerprint (`worktreeTree`) the verdict is for; null when it could not be taken. */
  tree: string | null;
  /** The ledger as this check left it: a write by anyone else (re-seal, drift, a headless run) means "check again". */
  ledger: LedgerMark | null;
  /** While an interactive turn is open: the work tree it started from (its `turn.end` lists what changed). */
  turnBase?: string | null;
};

export const CHECK_STATE = "check.json";
export const CHECK_LOCK = "check.lock";
/**
 * `<home>/edit.at`: when the agent last saved a file through Claude Code (Edit/Write), in ms. A
 * verdict from a check that began before it no longer stands, even when the save touched a
 * git-ignored file (`.env`) that the work-tree fingerprint cannot see.
 */
export const EDIT_MARK = "edit.at";
/** The private git index the work-tree fingerprint is built in. */
const CHECK_INDEX = "check.index";
/** Never part of the fingerprint: Claude Code's own folder and Kane's copied screenshots. */
const FINGERPRINT_EXCLUDE = [".claude", EVIDENCE_DIR];

const errText = (e: unknown) => (e instanceof Error ? e.message : String(e));
const oneLine = (t: string) => t.replace(/\s+/g, " ").trim();
const sleep = (ms: number) => new Promise<void>((r) => setTimeout(r, ms));

/** Never names what changed (Kane's tests the agent must not learn about): the detail goes to check.json, check.log and `holdback status`. */
const TAMPER_BRIEF = [
  "# Holdback — the gate is shut",
  "",
  "Holdback's sealed verification files changed — a human must re-seal; ask the human to run `holdback status`.",
  "Nothing Kane checked since counts. Stop here and tell the human what you were doing; do not undo it, re-seal or work around it yourself.",
  "",
].join("\n");
const DRIFT_BRIEF = (files: string[]) =>
  [
    "# Holdback — the spec changed",
    "",
    `The spec changed since its criteria were sealed (${files.join(", ")}). Kane re-plans the criteria with a human before it checks anything again.`,
    "Stop here and ask the human to run `holdback drift`.",
    "",
  ].join("\n");
const UNSEALED_BRIEF = ["# Holdback — nothing sealed yet", "", "This app has no sealed criteria yet. A human sets them up with `holdback spec`.", ""].join("\n");
const ERROR_BRIEF = (detail: string) =>
  ["# Holdback — the check did not run", "", `Holdback could not check the app: ${oneLine(detail)}`, "Tell the human; Kane has not checked your latest changes.", ""].join("\n");
const ABORTED_BRIEF = ["# Holdback — the check was stopped", "", "The check stopped before Kane ran. Your latest changes are not checked yet.", ""].join("\n");

const escapeRe = (s: string) => s.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");

/**
 * Text fit for the agent: Holdback's home and verifier folders, and anything under a `.testmuai`
 * or `.holdback` folder (Kane's tests and variables), are never named, in any slash style or case.
 */
export function forAgent(p: Pick<Project, "home" | "verifierDir">, text: string): string {
  let out = text;
  for (const dir of [p.home, p.verifierDir]) {
    const parts = dir.split(/[\\/]+/).filter((x) => x !== "");
    if (parts.length === 0) continue;
    out = out.replace(new RegExp(`${parts.map(escapeRe).join("[\\\\/]+")}[^\\s"'\`),;]*`, "gi"), "<holdback>");
  }
  return out.replace(/[^\s"'`(]*\.(testmuai|holdback)[\\/][^\s"'`),;]*/gi, "<verification file>");
}

/** Owed criterion ids, regressed ones first (the brief's order). */
function owedIds(state: LedgerState): string[] {
  const g = gate(state);
  return [...[...g.regressed].sort(byAcId), ...[...g.owed].sort(byAcId)].map((a) => a.id);
}

/** The interactive turn still open: the last `turn.start` with no `turn.end` after it. */
function openTurn(events: LedgerEvent[]): { n: number; at: string } | undefined {
  for (let i = events.length - 1; i >= 0; i--) {
    const e = events[i]!;
    if (e.t === "turn.end") return undefined;
    if (e.t === "turn.start") return { n: e.n, at: e.at };
  }
  return undefined;
}

const sameMark = (a: LedgerMark | null | undefined, b: LedgerMark | undefined) => !!a && !!b && a.size === b.size && a.sha256 === b.sha256;

/**
 * One check of the app as it is now, for Claude Code's hooks (interactive mode): the same
 * preflight, Kane batches, seal checks and vouched ledger as the headless build loop, without an
 * agent turn or a commit (the human owns git in this mode).
 *
 * Preflight: a tamper on record, a changed seal, Kane's recordings or the repo's git config moved
 * since the last `recordings` event. A changed spec file alone is drift (a human re-plans it), not
 * a tamper. Then, unless neither the work tree (tracked and untracked, non-ignored files) nor the
 * ledger changed since the last check, the app starts on a free port and Kane runs the tests of the
 * owed and regressed criteria, then replays the passing ones when nothing is owed any more. Runs are
 * logged as `run{kind:"build"}` under the open interactive turn: the first check after a stop opens
 * one (`turn.start`), a `stop` check closes it (`turn.end`, empty commit).
 *
 * The verdict is also written to `<home>/check.json`. Run it under `acquireCheckLock`: two checks
 * must never drive Kane or append to the ledger at once. `log` must append to `p.ledgerFile`.
 */
export async function checkOnce(p: Project, deps: CheckDeps, log: Log, opts: CheckOptions): Promise<CheckResult> {
  const startedAt = Date.now();
  const s = new VerifySession(p, deps, log, "check");
  const last = await readCheckState(p.home);
  let tree: string | null = null;
  /** The work tree the open turn started from; undefined while no turn is open. */
  let turnBase: string | null | undefined;

  const closed = (status: CheckStatus, brief: string, detail?: string): CheckResult => {
    const state = reduce(s.events);
    return {
      status,
      allowStop: false,
      gate: gate(state),
      ran: [],
      brief,
      tampered: status === "tamper",
      owed: owedIds(state),
      ...(detail !== undefined ? { detail } : {}),
    };
  };
  const tamper = async (): Promise<CheckResult> => {
    let detail: string | null;
    try {
      detail = await tamperMarker(p);
    } catch (e) {
      detail = `tamper marker unreadable: ${errText(e)}`;
    }
    const logged = s.events.findLast((e) => e.t === "tamper");
    detail ??= logged?.t === "tamper" ? logged.detail : "the ledger records a tamper";
    return closed("tamper", TAMPER_BRIEF, detail);
  };
  const stopFor = async (r: SessionStop): Promise<CheckResult> => {
    if (r.reason === "tamper") return tamper();
    if (r.reason === "unsealed") return closed("unsealed", UNSEALED_BRIEF, r.error);
    return closed("error", ERROR_BRIEF(forAgent(p, r.error ?? "unknown error")), r.error);
  };
  const verdict = (status: "checked" | "unchanged", ran: string[], appStartError: string | undefined): CheckResult => {
    const state = reduce(s.events);
    const g = gate(state);
    const inconclusive = g.inconclusive.map((u) => `${u.test}: ${u.reason}`);
    return {
      status,
      allowStop: g.allowStop && appStartError === undefined,
      gate: g,
      ran,
      brief: buildBrief(state, { appStartError, notes: p.config.agentNotes, screenshot: s.screenshot, broke: blameOf(s.events) }),
      tampered: false,
      owed: owedIds(state),
      ...(appStartError !== undefined ? { appStartError } : {}),
      ...(inconclusive.length > 0 ? { inconclusive } : {}),
    };
  };
  /** Closes the open turn with what changed in the work tree since it started. */
  const endTurn = async (turn: { n: number; at: string }, appUp: boolean) => {
    let filesChanged: string[] = [];
    if (turnBase && tree && turnBase !== tree) filesChanged = await changedFiles(p.appDir, turnBase, tree, s.gitOpts).catch(() => []);
    const durationMs = Math.max(0, Date.now() - Date.parse(turn.at)) || 0;
    await s.emit({ t: "turn.end", n: turn.n, commit: "", filesChanged, durationMs, appUp, agentExit: 0 });
    turnBase = undefined;
  };

  const run = async (): Promise<CheckResult> => {
    const start = await s.open();
    if (start) return stopFor(start);
    // a spec file edited after the seal, and nothing else: drift for a human to apply, not a tamper
    // keys compared through the seal's own normaliser: `./PRD.md` in the config is `app:PRD.md`
    const bad = await checkSeal(p.verifierDir, lastSeal(s.events)!, p.appDir);
    if (bad.length > 0 && bad.every((k) => p.config.spec.some((f) => isAppKeyOf(k, f)))) {
      const files = bad.map((k) => appSealKey(k).slice("app:".length));
      return closed("drift", DRIFT_BRIEF(files), `spec changed since the last seal: ${files.join(", ")}`);
    }
    const fresh = await s.refresh();
    if (!("state" in fresh)) return stopFor(fresh);
    // only now (git config checked above) may git run in the repo
    tree = await worktreeTree(p.appDir, path.join(p.home, CHECK_INDEX), s.gitOpts, FINGERPRINT_EXCLUDE);
    let turn = openTurn(s.events);
    turnBase = turn ? (last?.turnBase ?? null) : undefined;

    // a save through Claude Code after the last check began counts too: it may have touched a git-ignored file
    const editAt = await readEditAt(p.home);
    const g = gate(fresh.state);
    const owed = [...[...g.regressed].sort(byAcId), ...[...g.owed].sort(byAcId)];
    const fileOf = testFileMap(s.events, p.verifierDir);
    const owedFiles = filesOf(owed, fileOf);
    // a test whose latest run proved nothing must run again, so no verdict stands when this check
    // would run it: with nothing owed (the replay takes it) or as one of the owed tests. Next to other
    // owed work it waits for the replay; re-running the owed batch meanwhile would only cost credits
    const rerunsUnsure = g.inconclusive.some((u) => owed.length === 0 || owedFiles.includes(fileOf.get(u.test) ?? ""));
    const stands =
      last !== null &&
      (last.status === "checked" || last.status === "unchanged") &&
      !rerunsUnsure &&
      last.tree === tree &&
      sameMark(last.ledger, s.mark) &&
      last.startedAt > editAt;
    if (stands) {
      if (opts.reason === "stop" && turn) await endTurn(turn, last.appStartError === undefined);
      return verdict("unchanged", [], last.appStartError);
    }
    if (opts.signal?.aborted) return closed("aborted", ABORTED_BRIEF);

    s.assertSealed(owedFiles);
    if (!turn) {
      turnBase = last?.tree ?? null;
      await s.emit({ t: "turn.start", n: fresh.state.turn + 1, owed: owed.map((a) => a.id) });
      turn = openTurn(s.events)!;
    }

    const appStartError = await s.startApp(await (deps.port ?? freePort)(), `check-turn-${turn.n}`);
    let ran: string[] = [];
    if (appStartError === undefined) {
      const v = await s.verify(turn.n, owedFiles, fileOf, false);
      if (v.tampered) return tamper();
      const idOf = new Map([...fileOf].map(([id, f]) => [f, id]));
      ran = [...v.ran].map((f) => idOf.get(f) ?? f);
    }
    // the app is down: Kane's recordings as they are now are what the next check holds them to
    if (s.kaneWindow) await s.closeKaneWindow();
    if (opts.reason === "stop") await endTurn(turn, appStartError === undefined);
    return verdict("checked", ran, appStartError);
  };

  let result: CheckResult;
  try {
    result = await run();
    const exit = result.status === "tamper" ? "tamper" : result.status === "error" ? "error" : "ok";
    if (await s.settle(exit)) result = await tamper();
  } catch (e) {
    result = (await s.settle("error", e)) ? await tamper() : closed("error", ERROR_BRIEF(forAgent(p, errText(e))), errText(e));
  } finally {
    await s.stopApp().catch(() => {});
  }
  const { gate: _gate, ...summary } = result;
  await writeCheckState(p.home, {
    ...summary,
    startedAt,
    finishedAt: Date.now(),
    reason: opts.reason,
    tree,
    ledger: s.mark ?? null,
    ...(openTurn(s.events) && turnBase !== undefined ? { turnBase } : {}),
  });
  return result;
}

/** Records an agent save (`EDIT_MARK`). */
export async function markEdit(home: string, at: number = Date.now()): Promise<void> {
  await mkdir(home, { recursive: true });
  await writeFile(path.join(home, EDIT_MARK), String(at), "utf8");
}

/** The last agent save, in ms: 0 when there was none; a mark that cannot be read counts as a save after every check. */
export async function readEditAt(home: string): Promise<number> {
  let raw: string;
  try {
    raw = (await readFile(path.join(home, EDIT_MARK), "utf8")).trim();
  } catch (e) {
    return (e as NodeJS.ErrnoException).code === "ENOENT" ? 0 : Number.POSITIVE_INFINITY;
  }
  const at = Number(raw);
  return raw !== "" && Number.isFinite(at) ? at : Number.POSITIVE_INFINITY;
}

function isCheckState(v: unknown): v is CheckState {
  if (!v || typeof v !== "object") return false;
  const o = v as Record<string, unknown>;
  return typeof o.startedAt === "number" && typeof o.status === "string" && typeof o.allowStop === "boolean" && typeof o.brief === "string" && Array.isArray(o.owed);
}

/** The latest check's verdict, or null when there is none (or it cannot be read: then the next check runs Kane). */
export async function readCheckState(home: string): Promise<CheckState | null> {
  try {
    const v: unknown = JSON.parse(await readFile(path.join(home, CHECK_STATE), "utf8"));
    return isCheckState(v) ? v : null;
  } catch {
    return null;
  }
}

/** Replaces `<home>/check.json` in one rename (retried: on Windows a reader holding the file makes it fail for a moment). */
export async function writeCheckState(home: string, state: CheckState): Promise<void> {
  await mkdir(home, { recursive: true });
  const file = path.join(home, CHECK_STATE);
  const tmp = `${file}.${process.pid}.${randomUUID().slice(0, 8)}.tmp`;
  await writeFile(tmp, JSON.stringify(state, null, 2) + "\n", "utf8");
  for (let i = 0; ; i++) {
    try {
      await rename(tmp, file);
      return;
    } catch (e) {
      const code = (e as NodeJS.ErrnoException).code;
      if (i >= 20 || (code !== "EPERM" && code !== "EBUSY" && code !== "EACCES")) {
        await rm(tmp, { force: true }).catch(() => {});
        throw e;
      }
      await sleep(25 * (i + 1));
    }
  }
}

export type CheckLock = { release(): Promise<void> };

export type LockOptions = {
  /** How long to wait for a check in flight to finish. */
  waitMs: number;
  pollMs?: number;
  /** A lock whose holder is gone, or untouched this long, is taken over. Default 20 minutes. */
  staleMs?: number;
  /** Polled while waiting: true gives up (null). */
  giveUp?: () => boolean | Promise<boolean>;
};

const LOCK_STALE_MS = 20 * 60_000;
/** The holder touches the lock this often, so a long Kane batch never looks stale. */
const LOCK_HEARTBEAT_MS = 60_000;

function alive(pid: number): boolean {
  try {
    process.kill(pid, 0);
    return true;
  } catch (e) {
    return (e as NodeJS.ErrnoException).code === "EPERM";
  }
}

async function lockIsStale(file: string, staleMs: number): Promise<boolean> {
  let mtime: number;
  let raw: string;
  try {
    mtime = (await stat(file)).mtimeMs;
    raw = await readFile(file, "utf8");
  } catch {
    return false; // gone (or unreadable for a moment): just try again
  }
  if (Date.now() - mtime > staleMs) return true;
  try {
    const pid = (JSON.parse(raw) as { pid?: unknown }).pid;
    return typeof pid === "number" && !alive(pid);
  } catch {
    return false; // being written right now
  }
}

/**
 * `<home>/check.lock`, created atomically: one check at a time drives Kane and appends to the
 * ledger (hooks run as separate processes). Waits up to `waitMs` for a check in flight; a lock
 * whose process is gone, or that nobody touched for `staleMs`, is taken over. Null when the wait
 * ran out or `giveUp` said so.
 */
export async function acquireCheckLock(home: string, opts: LockOptions): Promise<CheckLock | null> {
  await mkdir(home, { recursive: true });
  const file = path.join(home, CHECK_LOCK);
  const token = randomUUID();
  const deadline = Date.now() + opts.waitMs;
  for (;;) {
    try {
      const fh = await open(file, "wx");
      try {
        await fh.writeFile(JSON.stringify({ pid: process.pid, token, at: new Date().toISOString() }), "utf8");
      } finally {
        await fh.close();
      }
      const beat = setInterval(() => {
        const now = new Date();
        void utimes(file, now, now).catch(() => {});
      }, LOCK_HEARTBEAT_MS);
      beat.unref();
      let released = false;
      return {
        release: async () => {
          if (released) return;
          released = true;
          clearInterval(beat);
          // only our own lock goes: a stale-lock takeover may have replaced it meanwhile
          const raw = await readFile(file, "utf8").catch(() => "");
          if (raw.includes(token)) await rm(file, { force: true });
        },
      };
    } catch (e) {
      if ((e as NodeJS.ErrnoException).code !== "EEXIST") throw e;
    }
    if (await lockIsStale(file, opts.staleMs ?? LOCK_STALE_MS)) {
      await rm(file, { force: true }).catch(() => {});
      continue;
    }
    if (Date.now() >= deadline) return null;
    if (opts.giveUp && (await opts.giveUp())) return null;
    await sleep(opts.pollMs ?? 500);
  }
}
