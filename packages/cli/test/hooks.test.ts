import { execFileSync } from "node:child_process";
import { appendFileSync, existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { Readable } from "node:stream";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import {
  acquireCheckLock,
  AppStartError,
  appendEvent,
  appSealFiles,
  loadProject,
  posixAbs,
  readEvents,
  seal,
  type LedgerEvent,
  type Project,
  type TestRunResult,
} from "@holdback/core";
import { main, type HookDeps } from "../src/index.js";

const at = "2026-11-15T00:00:00.000Z";
const git = (cwd: string, ...args: string[]) => execFileSync("git", args, { cwd, encoding: "utf8" }).trim();
const saved = { ...process.env };
const HANDOFF = "Holdback: handing to a human — see `holdback status`";

let root: string;
let appDir: string;
let p: Project;
let T1: string;
let T2: string;
const log = (e: LedgerEvent) => appendEvent(p.ledgerFile, e);

beforeEach(() => {
  root = mkdtempSync(join(tmpdir(), "hb-hooks-"));
  process.env.HOLDBACK_HOME = join(root, "home");
  appDir = join(root, "app");
  mkdirSync(appDir);
});
afterEach(() => {
  if (saved.HOLDBACK_HOME === undefined) delete process.env.HOLDBACK_HOME;
  else process.env.HOLDBACK_HOME = saved.HOLDBACK_HOME;
  rmSync(root, { recursive: true, force: true });
});

/** An app repo, a verifier with t-1 (ac-1) and t-2 (ac-2), and a ledger with a design and (by default) a seal. */
async function fixture(opts: { seal?: boolean } = {}) {
  writeFileSync(join(appDir, "PRD.md"), "# Pantry\n\nSNAP households are eligible.\n");
  writeFileSync(join(appDir, "holdback.config.json"), "{}");
  writeFileSync(join(appDir, "app.js"), "// v0\n");
  git(appDir, "init", "-q");
  p = await loadProject(appDir);
  const tests = join(p.verifierDir, ".testmuai", "tests");
  mkdirSync(tests, { recursive: true });
  T1 = join(tests, "t1_test.md");
  T2 = join(tests, "t2_test.md");
  writeFileSync(T1, "# t1\n");
  writeFileSync(T2, "# t2\n");
  const ac = (id: string) => ({ id, text: `criterion ${id}`, useCase: "uc-1", cites: [{ source: "prd", anchor: "L3-L3", quote: "SNAP households are eligible." }], trust: "derived" as const });
  await log({
    at,
    t: "design",
    useCase: "uc-1",
    acs: [ac("ac-1"), ac("ac-2")],
    tests: [
      { id: "t-1", title: "one", file: ".testmuai/tests/t1_test.md", verifies: ["ac-1"] },
      { id: "t-2", title: "two", file: ".testmuai/tests/t2_test.md", verifies: ["ac-2"] },
    ],
    gaps: [],
    credits: 12,
  });
  if (opts.seal !== false) await log({ at, t: "seal", manifest: await seal(p.verifierDir, { appDir, files: appSealFiles(p) }) });
}

const result = (file: string, status: "passed" | "failed"): TestRunResult => ({
  testFile: file,
  testId: file.endsWith("t1_test.md") ? "t-1" : "t-2",
  status,
  steps: [],
  criteriaPassed: [],
  criteriaFailed: [],
  credits: 0,
  replayDecisions: 0,
  authorDecisions: 0,
  healTriggered: false,
  durationS: 1,
  ...(status === "failed" ? { failedStep: 2, failedStepText: "Open {{start_url}} and submit the form.", verdict: { bugTitle: "Limit off by one", observed: "Eligible." } } : {}),
});

/** What Kane says, per test file; and what the fake app does. */
const world = { failing: new Set<string>(), stuck: new Set<string>(), appUp: true, kaneCalls: [] as string[][], checks: 0 };

function hookDeps(over: Partial<HookDeps> = {}): HookDeps {
  const deps: HookDeps = {
    check: {
      port: async () => 4777,
      app: async (o) => {
        if (!world.appUp) throw new AppStartError("app exited before becoming ready", "Error: Cannot find module 'hono'");
        return { url: `http://127.0.0.1:${o.port}`, logs: () => "", stop: async () => {} };
      },
      tests: async (_cwd, files) => {
        world.kaneCalls.push(files.map((f) => (f.endsWith("t1_test.md") ? "t-1" : "t-2")));
        return files.map((f) => (world.stuck.has(f) ? { ...result(f, "passed"), status: "error" as const, reason: "timeout" } : result(f, world.failing.has(f) ? "failed" : "passed")));
      },
    },
    // the background check, run in this process: the same `holdback hook check` command, not awaited
    startCheck: (dir, reason) => {
      let done = false;
      world.checks++;
      void main(["hook", "check", "--app", dir, "--reason", reason], { cwd: dir, out: () => {}, err: () => {}, deps: { env: {}, hooks: deps } }).finally(() => (done = true));
      return { alive: () => !done };
    },
    sleep: (ms) => new Promise((r) => setTimeout(r, ms)),
    debounceMs: 40,
    pollMs: 10,
    waitMs: 30_000,
    cliEntry: join(root, "cli-dist-index.js"),
    ...over,
  };
  return deps;
}

type Out = { code: number; out: string; err: string };

async function hook(name: string, input: unknown, over: Partial<HookDeps> = {}, env: NodeJS.ProcessEnv = {}, args: string[] = []): Promise<Out> {
  const out: string[] = [];
  const err: string[] = [];
  const raw = typeof input === "string" ? input : JSON.stringify(input);
  const code = await main(["hook", name, ...args], {
    cwd: root, // the hooks find the project from the hook input, never from the process cwd
    out: (l) => out.push(l),
    err: (l) => err.push(l),
    stdin: Readable.from([raw]),
    deps: { env, hooks: hookDeps(over) },
  });
  return { code, out: out.join("\n"), err: err.join("\n") };
}

const base = () => ({ session_id: "s1", transcript_path: join(root, "t.jsonl"), cwd: appDir, permission_mode: "default" });
const pre = (tool_name: string, tool_input: Record<string, unknown>) => ({ ...base(), hook_event_name: "PreToolUse", tool_name, tool_input, tool_use_id: "tu1" });
const post = (file: string) => ({ ...base(), hook_event_name: "PostToolUse", tool_name: "Edit", tool_input: { file_path: join(appDir, file) }, tool_response: { success: true }, tool_use_id: "tu2" });
const stopIn = (active = false) => ({ ...base(), hook_event_name: "Stop", stop_hook_active: active, last_assistant_message: "Done." });
const promptIn = () => ({ ...base(), hook_event_name: "UserPromptSubmit", prompt: "keep going" });

beforeEach(() => {
  world.failing = new Set();
  world.stuck = new Set();
  world.appUp = true;
  world.kaneCalls = [];
  world.checks = 0;
});

describe("hook guard (PreToolUse)", () => {
  it("allows ordinary work and denies the verifier, the ledger, kane-cli and git writes with exit 2 and a reason", async () => {
    await fixture();
    expect(await hook("guard", pre("Edit", { file_path: join(appDir, "app.js"), old_string: "a", new_string: "b" }))).toEqual({ code: 0, out: "", err: "" });
    const files = await hook("guard", pre("Read", { file_path: join(p.verifierDir, ".testmuai", "tests", "t1_test.md") }));
    expect(files.code).toBe(2);
    expect(files.err).toContain("verification files are off limits");
    // this project's home, found from the hook input's cwd (a sub-folder of the app works too)
    mkdirSync(join(appDir, "src"));
    const ledger = await hook("guard", { ...pre("Bash", { command: `cat ${p.ledgerFile}` }), cwd: join(appDir, "src") });
    expect(ledger.code).toBe(2);
    expect((await hook("guard", pre("Bash", { command: "kane-cli run t1_test.md" }))).err).toContain("Do not invoke kane-cli");
    expect((await hook("guard", pre("Bash", { command: "git commit -am wip" }))).err).toContain("Holdback owns git history");
    expect((await hook("guard", pre("Bash", { command: "git status" }))).code).toBe(0);
    // denials are kept for the human, outside the ledger
    expect(readFileSync(join(p.home, "guard.log"), "utf8").trim().split("\n")).toHaveLength(4);
  });

  it("uses the app the installed command names (--app), wherever the session's cwd is", async () => {
    await fixture();
    const elsewhere = join(root, "elsewhere");
    mkdirSync(elsewhere);
    const read = { ...pre("Read", { file_path: join(p.home, "ledger.jsonl") }), cwd: elsewhere };
    expect((await hook("guard", read, {}, {}, ["--app", appDir])).code).toBe(2);
    // found from the input alone, "elsewhere" would be another project with another home
    expect((await hook("guard", read)).code).toBe(0);
  });

  it("prefers CLAUDE_PROJECT_DIR over the input's cwd", async () => {
    await fixture();
    const elsewhere = join(root, "elsewhere");
    mkdirSync(elsewhere);
    const r = await hook("guard", { ...pre("Read", { file_path: join(p.home, "ledger.jsonl") }), cwd: elsewhere }, {}, { CLAUDE_PROJECT_DIR: appDir });
    expect(r.code).toBe(2);
  });

  it("fails closed: unparseable input, a missing tool name or a crash deny the call", async () => {
    await fixture();
    for (const input of ["not json", "{}", JSON.stringify({ ...base(), tool_input: {} })]) {
      const r = await hook("guard", input);
      expect(r.code, input).toBe(2);
      expect(r.err).not.toBe("");
    }
  });
});

describe("hook post-edit (PostToolUse, asyncRewake)", { timeout: 120_000 }, () => {
  it("runs Kane after an edit and exits 2 with the bug-report brief when a criterion fails", async () => {
    await fixture();
    world.failing.add(T2);
    const r = await hook("post-edit", post("app.js"));
    expect(r.code).toBe(2);
    expect(r.err).toContain("Kane checked the app after your last edit");
    expect(r.err).toContain("# Holdback — 1 criterion still owed");
    expect(r.err).toContain("## ac-2 — criterion ac-2");
    expect(r.err).toContain("Kane ran: Open the app's start page and submit the form.");
    expect(r.err).toContain("Kane's diagnosis: Limit off by one");
    expect(r.err).not.toContain("t2_test.md");
    expect(world.kaneCalls).toEqual([["t-1", "t-2"]]);
    const runs = (await readEvents(p.ledgerFile)).filter((e) => e.t === "run");
    expect(runs).toMatchObject([{ kind: "build", turn: 1 }, { kind: "build", turn: 1 }]);
  });

  it("a Kane run that timed out twice is noted in check.log for the human, never in the agent's brief (R34)", async () => {
    await fixture();
    world.stuck.add(T2);
    const r = await hook("post-edit", post("app.js"));
    expect(r.code).toBe(2);
    expect(r.err).toContain("## ac-2 — criterion ac-2");
    expect(r.err).not.toMatch(/timeout|inconclusive/i);
    expect(world.kaneCalls).toEqual([["t-1", "t-2"], ["t-2"]]);
    const note = readFileSync(join(p.home, "check.log"), "utf8");
    expect(note).toMatch(/edit: checked \(Kane ran t-1, t-2\), 1 owed; inconclusive: t-2: timeout\n$/);
  });

  it("exits 0 quietly when every criterion passes", async () => {
    await fixture();
    expect(await hook("post-edit", post("app.js"))).toEqual({ code: 0, out: "", err: "" });
  });

  it("debounces a burst of saves: only the last one asks for a check", async () => {
    await fixture();
    world.failing.add(T2);
    const [first, second] = await Promise.all([hook("post-edit", post("app.js"), { debounceMs: 1_000 }), (async () => {
      await new Promise((r) => setTimeout(r, 100));
      return hook("post-edit", post("app.js"), { debounceMs: 1_000 });
    })()]);
    expect(first).toEqual({ code: 0, out: "", err: "" });
    expect(second.code).toBe(2);
    expect(world.checks).toBe(1);
    expect(world.kaneCalls).toHaveLength(1);
  });

  it("a save to a git-ignored file still invalidates the last verdict; a save under .claude/ asks for no check", async () => {
    await fixture();
    writeFileSync(join(appDir, ".gitignore"), ".env\n");
    expect((await hook("stop", stopIn())).code).toBe(0);
    expect(world.kaneCalls).toHaveLength(1);
    // the work-tree fingerprint cannot see .env; the save mark can
    writeFileSync(join(appDir, ".env"), "LIMIT=1\n");
    world.failing.add(T2);
    const r = await hook("post-edit", post(".env"));
    expect(r.code).toBe(2);
    expect(r.err).toContain("## ac-2");
    expect(world.kaneCalls).toEqual([["t-1", "t-2"], ["t-1", "t-2"]]); // nothing owed before: the passing ones replayed
    const checks = world.checks;
    expect(await hook("post-edit", post(join(".claude", "settings.local.json")))).toEqual({ code: 0, out: "", err: "" });
    expect(world.checks).toBe(checks);
  });

  it("wakes the agent with the app's start failure when the app does not boot", async () => {
    await fixture();
    world.appUp = false;
    const r = await hook("post-edit", post("app.js"));
    expect(r.code).toBe(2);
    expect(r.err).toContain("The app does not start");
    expect(r.err).toContain("Cannot find module 'hono'");
  });

  it("wakes the agent to hand a tamper to the human, and stays quiet before anything is sealed", async () => {
    await fixture();
    appendFileSync(T1, "forged\n");
    const r = await hook("post-edit", post("app.js"));
    expect(r.code).toBe(2);
    expect(r.err).toContain("Holdback's sealed verification files changed — a human must re-seal; ask the human to run `holdback status`.");
    rmSync(root, { recursive: true, force: true });
    mkdirSync(appDir, { recursive: true });
    await fixture({ seal: false });
    expect(await hook("post-edit", post("app.js"))).toEqual({ code: 0, out: "", err: "" });
  });
});

describe("hook stop (Stop)", { timeout: 180_000 }, () => {
  it("refuses to stop with the brief while a criterion is owed, and lets it stop once Kane passes everything", async () => {
    await fixture();
    world.failing.add(T2);
    const blocked = await hook("stop", stopIn());
    expect(blocked.code).toBe(2);
    expect(blocked.err).toContain("# Holdback — 1 criterion still owed");
    expect(blocked.err).toContain("## ac-2");
    expect(world.kaneCalls).toEqual([["t-1", "t-2"]]); // edits since the last check: Kane ran before the verdict

    // no change since: the verdict stands, Kane is not run again
    expect((await hook("stop", stopIn(true))).code).toBe(2);
    expect(world.kaneCalls).toHaveLength(1);

    // a fix the Edit/Write hook never saw (a shell write) still triggers a run at stop
    world.failing.clear();
    writeFileSync(join(appDir, "app.js"), "// fixed\n");
    const open = await hook("stop", stopIn());
    expect(open.code).toBe(0);
    expect(JSON.parse(open.out)).toEqual({ systemMessage: "Holdback: gate open — Kane passes every criterion." });
    expect(world.kaneCalls).toEqual([["t-1", "t-2"], ["t-2"], ["t-1"]]);
    const ends = (await readEvents(p.ledgerFile)).filter((e) => e.t === "turn.end");
    expect(ends).toMatchObject([{ n: 1, commit: "" }, { n: 2, commit: "", filesChanged: ["app.js"] }]);
  });

  it("hands over to a human on the 6th consecutive block with the same owed set, and starts counting again after a prompt", async () => {
    await fixture();
    world.failing.add(T2);
    for (let i = 1; i <= 5; i++) {
      const r = await hook("stop", stopIn(i > 1));
      expect(r.code, `block ${i}`).toBe(2);
      expect(r.err).toContain("## ac-2");
    }
    const sixth = await hook("stop", stopIn(true));
    expect(sixth.code).toBe(0);
    expect(JSON.parse(sixth.out)).toEqual({ systemMessage: HANDOFF });
    expect(sixth.err).toBe("");
    // still handed over until the human speaks
    expect((await hook("stop", stopIn(true))).code).toBe(0);
    expect((await hook("prompt", promptIn())).code).toBe(0);
    expect((await hook("stop", stopIn())).code).toBe(2);
  });

  it("a change in the owed set restarts the count", async () => {
    await fixture();
    world.failing.add(T1);
    world.failing.add(T2);
    for (let i = 0; i < 4; i++) expect((await hook("stop", stopIn())).code).toBe(2);
    world.failing.delete(T1);
    writeFileSync(join(appDir, "app.js"), "// half fixed\n");
    for (let i = 0; i < 5; i++) expect((await hook("stop", stopIn())).code).toBe(2);
    expect((await hook("stop", stopIn())).code).toBe(0);
  });

  it("fails closed on a tamper (exit 2, a message for a human), until the hand-off", async () => {
    await fixture();
    appendFileSync(T1, "forged\n");
    for (let i = 0; i < 5; i++) {
      const r = await hook("stop", stopIn());
      expect(r.code).toBe(2);
      expect(r.err).toContain("Holdback's sealed verification files changed — a human must re-seal; ask the human to run `holdback status`.");
    }
    expect(world.kaneCalls).toHaveLength(0);
    const r = await hook("stop", stopIn());
    expect(r.code).toBe(0);
    expect(JSON.parse(r.out).systemMessage).toBe(HANDOFF);
  });

  it("fails closed on a ledger it cannot read, and on input it cannot parse", async () => {
    await fixture();
    rmSync(p.ledgerFile);
    mkdirSync(p.ledgerFile);
    const r = await hook("stop", stopIn());
    expect(r.code).toBe(2);
    expect(r.err).toContain("Holdback could not check the app");
    expect((await hook("stop", "garbage")).code).toBe(2);
  });

  it("waits for a check in flight; when it runs past the wait, refuses to stop rather than guess", async () => {
    await fixture();
    const held = await acquireCheckLock(p.home, { waitMs: 0 });
    expect(held).not.toBeNull();
    const busy = await hook("stop", stopIn(), { waitMs: 400 });
    expect(busy.code).toBe(2);
    expect(busy.err).toContain("busy — still verifying");
    expect(world.kaneCalls).toHaveLength(0);
    // released while the next stop waits: that stop gets a real verdict
    const next = hook("stop", stopIn());
    await new Promise((r) => setTimeout(r, 200));
    await held!.release();
    expect((await next).code).toBe(0);
    expect(world.kaneCalls).toHaveLength(1);
  });

  it("refuses to stop when the background check dies without a verdict", async () => {
    await fixture();
    const r = await hook("stop", stopIn(), { startCheck: () => ({ alive: () => false }) });
    expect(r.code).toBe(2);
    expect(r.err).toContain("stopped before Kane gave a verdict");
  });

  it("lets the agent stop before anything is sealed, and says why", async () => {
    await fixture({ seal: false });
    const r = await hook("stop", stopIn());
    expect(r.code).toBe(0);
    expect(JSON.parse(r.out).systemMessage).toContain("nothing is sealed yet");
  });
});

describe("inside a headless turn (HOLDBACK_HEADLESS)", { timeout: 60_000 }, () => {
  it("stop, post-edit and prompt stand aside at once; the guard still denies", async () => {
    await fixture();
    world.failing.add(T2);
    const headless = { HOLDBACK_HEADLESS: "1" };
    for (const [name, input] of [["stop", stopIn()], ["post-edit", post("app.js")], ["prompt", promptIn()]] as const) {
      expect(await hook(name, input, {}, headless, ["--app", appDir]), name).toEqual({ code: 0, out: "", err: "" });
    }
    expect(world.checks).toBe(0);
    expect(world.kaneCalls).toHaveLength(0);
    const denied = await hook("guard", pre("Read", { file_path: join(p.verifierDir, ".testmuai", "tests", "t1_test.md") }), {}, headless, ["--app", appDir]);
    expect(denied.code).toBe(2);
    expect(denied.err).toContain("verification files are off limits");
  });
});

describe("hook prompt (UserPromptSubmit)", { timeout: 60_000 }, () => {
  it("prints what is owed in at most three lines", async () => {
    await fixture();
    await log({ at, t: "run", kind: "build", turn: 1, result: result(T1, "passed") });
    await log({ at, t: "run", kind: "build", turn: 2, result: result(T1, "failed") });
    const r = await hook("prompt", promptIn());
    expect(r.code).toBe(0);
    expect(r.err).toBe("");
    const lines = r.out.split("\n");
    expect(lines[0]).toBe("Holdback: 2 owed (ac-1, ac-2)");
    expect(lines[1]).toBe("Regressed: ac-1");
    expect(lines.length).toBeLessThanOrEqual(3);
  });

  it("says when the gate is open, shut by a tamper, or not set up — and never fails the prompt", async () => {
    await fixture();
    await log({ at, t: "run", kind: "build", turn: 1, result: result(T1, "passed") });
    await log({ at, t: "run", kind: "build", turn: 1, result: result(T2, "passed") });
    expect((await hook("prompt", promptIn())).out).toBe("Holdback: 0 owed — every criterion passes");
    await log({ at, t: "tamper", detail: "sealed files changed: x" });
    expect((await hook("prompt", promptIn())).out).toContain("shut by a tamper");
    expect(await hook("prompt", "garbage")).toEqual({ code: 0, out: "", err: "" });
    rmSync(p.ledgerFile);
    mkdirSync(p.ledgerFile);
    expect(await hook("prompt", promptIn())).toEqual({ code: 0, out: "", err: "" });
  });
});

describe("init --agent claude", { timeout: 60_000 }, () => {
  const settingsFile = () => join(appDir, ".claude", "settings.json");
  const init = async (args: string[], env: NodeJS.ProcessEnv = {}) => {
    const out: string[] = [];
    const err: string[] = [];
    const code = await main(["init", "--agent", "claude", ...args], { cwd: appDir, out: (l) => out.push(l), err: (l) => err.push(l), deps: { env, hooks: hookDeps() } });
    return { code, out: out.join("\n"), err: err.join("\n") };
  };
  const entry = () => join(root, "cli-dist-index.js");

  it("writes the four hooks, the deny rules and the read boundary into .claude/settings.json, plus the skill", async () => {
    writeFileSync(entry(), "// built cli\n");
    const r = await init([]);
    expect(r.code).toBe(0);
    expect(existsSync(join(appDir, "holdback.config.json"))).toBe(true);
    const s = JSON.parse(readFileSync(settingsFile(), "utf8"));
    const cmd = (name: string) => `"${process.execPath}" "${entry()}" hook ${name} --app "${appDir}"`;
    expect(s.hooks.PreToolUse).toEqual([{ matcher: "*", hooks: [{ type: "command", command: cmd("guard"), onFailure: "block" }] }]);
    expect(s.hooks.PostToolUse).toEqual([{ matcher: "Edit|Write|MultiEdit", hooks: [{ type: "command", command: cmd("post-edit"), asyncRewake: true, timeout: 900 }] }]);
    expect(s.hooks.Stop).toEqual([{ hooks: [{ type: "command", command: cmd("stop"), timeout: 900 }] }]);
    expect(s.hooks.UserPromptSubmit).toEqual([{ hooks: [{ type: "command", command: cmd("prompt") }] }]);
    p = await loadProject(appDir);
    const abs = posixAbs(appDir);
    expect(s.permissions.blockReadsOutsideWorkingDirectories).toBe(true);
    expect(s.permissions.deny).toEqual(
      expect.arrayContaining([
        "Read(~/.holdback/**)",
        `Read(${posixAbs(p.home)}/**)`,
        `Edit(${posixAbs(p.home)}/**)`,
        "Edit(./holdback.config.json)",
        `Edit(${abs}/holdback.config.json)`,
        "Edit(./PRD.md)",
        "Edit(./.git/**)",
        "Edit(./.claude/settings.json)",
        "Edit(./.claude/settings.local.json)",
      ]),
    );
    const skill = readFileSync(join(appDir, ".claude", "skills", "holdback", "SKILL.md"), "utf8");
    expect(skill.startsWith("---\nname: holdback\n")).toBe(true);
    expect(r.out).toContain(".claude/settings.json");
  });

  it("merges with what is there, is idempotent, and --remove takes out only Holdback's entries", async () => {
    writeFileSync(entry(), "// built cli\n");
    writeFileSync(join(appDir, "holdback.config.json"), '{"start":{"port":4000}}');
    mkdirSync(join(appDir, ".claude"));
    // the human already had one of Holdback's rules and the read boundary: --remove must leave both
    const mine = {
      model: "opus",
      permissions: { allow: ["Bash(npm test)"], deny: ["Read(./.env)", "Edit(./.git/**)"], blockReadsOutsideWorkingDirectories: true },
      hooks: {
        PostToolUse: [{ matcher: "Write", hooks: [{ type: "command", command: "prettier --write" }] }],
        Stop: [{ hooks: [{ type: "command", command: "say done" }] }],
      },
    };
    writeFileSync(settingsFile(), JSON.stringify(mine, null, 2));
    expect((await init([])).code).toBe(0);
    expect(readFileSync(join(appDir, "holdback.config.json"), "utf8")).toBe('{"start":{"port":4000}}'); // an existing config is kept
    const once = readFileSync(settingsFile(), "utf8");
    const s = JSON.parse(once);
    expect(s.model).toBe("opus");
    expect(s.permissions.allow).toEqual(["Bash(npm test)"]);
    expect(s.permissions.deny[0]).toBe("Read(./.env)");
    expect(s.hooks.PostToolUse[0]).toEqual(mine.hooks.PostToolUse[0]);
    expect(s.hooks.PostToolUse).toHaveLength(2);
    expect(s.hooks.Stop[0]).toEqual(mine.hooks.Stop[0]);
    expect(s.hooks.Stop).toHaveLength(2);

    expect(s.permissions.deny.filter((r: string) => r === "Edit(./.git/**)")).toHaveLength(1);

    expect((await init([])).code).toBe(0);
    expect(readFileSync(settingsFile(), "utf8")).toBe(once);

    // a re-run follows the config: the spec file's deny rule moves with it
    writeFileSync(join(appDir, "holdback.config.json"), '{"start":{"port":4000},"spec":["docs/SPEC.md"]}');
    expect((await init([])).code).toBe(0);
    const moved = JSON.parse(readFileSync(settingsFile(), "utf8")).permissions.deny as string[];
    expect(moved).toContain("Edit(./docs/SPEC.md)");
    expect(moved).not.toContain("Edit(./PRD.md)");

    const removed = await init(["--remove"]);
    expect(removed.code).toBe(0);
    expect(JSON.parse(readFileSync(settingsFile(), "utf8"))).toEqual(mine);
    expect(existsSync(join(appDir, ".claude", "skills", "holdback", "SKILL.md"))).toBe(false);
    expect(existsSync(join(appDir, "holdback.config.json"))).toBe(true);
  });

  it("refuses an app folder whose path a shell would expand inside double quotes", async () => {
    writeFileSync(entry(), "// built cli\n");
    const odd = join(root, "price$app");
    mkdirSync(odd);
    const err: string[] = [];
    const code = await main(["init", "--agent", "claude"], { cwd: odd, out: () => {}, err: (l) => err.push(l), deps: { env: {}, hooks: hookDeps() } });
    expect(code).toBe(1);
    expect(err.join("\n")).toContain("contains $, `, \" or a line break");
    expect(existsSync(join(odd, ".claude", "settings.json"))).toBe(false);
  });

  it("refuses a settings file it cannot parse, without touching it, and a CLI that is not built", async () => {
    writeFileSync(entry(), "// built cli\n");
    mkdirSync(join(appDir, ".claude"));
    writeFileSync(settingsFile(), "{ not json");
    const bad = await init([]);
    expect(bad.code).toBe(1);
    expect(bad.err).toContain("settings.json");
    expect(readFileSync(settingsFile(), "utf8")).toBe("{ not json");
    rmSync(entry());
    rmSync(settingsFile());
    const unbuilt = await init([]);
    expect(unbuilt.code).toBe(1);
    expect(unbuilt.err).toContain("build");
    expect(existsSync(settingsFile())).toBe(false);
  });

  it("the coding agent cannot take the hooks out (or re-seal) from inside Claude Code", async () => {
    writeFileSync(entry(), "// built cli\n");
    expect((await init([])).code).toBe(0);
    const before = readFileSync(settingsFile(), "utf8");
    const r = await init(["--remove"], { CLAUDECODE: "1" });
    expect(r.code).toBe(1);
    expect(r.err).toContain("your own terminal");
    expect(readFileSync(settingsFile(), "utf8")).toBe(before);
    for (const args of [["reseal", "--yes"], ["drift"], ["spec"], ["run"], ["watch"]]) {
      const err: string[] = [];
      const notCalled = async () => {
        throw new Error(`${args[0]} must not run`);
      };
      const code = await main(args, {
        cwd: appDir,
        out: () => {},
        err: (l) => err.push(l),
        deps: { env: { CLAUDECODE: "1" }, reseal: notCalled, runDrift: notCalled, runSpecStage: notCalled, runBuildLoop: notCalled, watchSpec: notCalled as never },
      });
      expect(code, args[0]).toBe(1);
      expect(err.join("\n")).toContain(`\`holdback ${args[0]}\` is for you, not the coding agent`);
    }
  });
});

describe("holdback status inside Claude Code", { timeout: 60_000 }, () => {
  it("prints the counts and the re-seal hint but never names a sealed file", async () => {
    await fixture();
    appendFileSync(T1, "forged\n");
    const run = async (env: NodeJS.ProcessEnv, args: string[]) => {
      const out: string[] = [];
      const err: string[] = [];
      const code = await main(args, { cwd: appDir, out: (l) => out.push(l), err: (l) => err.push(l), deps: { env } });
      return { code, out: out.join("\n"), err: err.join("\n") };
    };
    const human = await run({}, ["status"]);
    expect(human.err).toContain(".testmuai/tests/t1_test.md");
    for (const args of [["status"], ["status", "--json"], ["owed"]]) {
      const agent = await run({ CLAUDECODE: "1" }, args);
      expect(agent.code, args.join(" ")).toBe(2);
      expect(agent.err).toContain("TAMPER: sealed files changed: <verification file>");
      expect(agent.err).toContain("holdback reseal");
      expect(agent.out + agent.err).not.toMatch(/t1_test|testmuai/i);
      // nor Holdback's home, raw or JSON-escaped
      expect((agent.out + agent.err).toLowerCase()).not.toContain(p.home.toLowerCase());
      expect((agent.out + agent.err).toLowerCase()).not.toContain(JSON.stringify(p.home.toLowerCase()).slice(1, -1));
    }
    expect((await run({ CLAUDECODE: "1" }, ["status"])).out).toMatch(/Gate: closed \| owed 2/);
  });
});

describe("commands that write the ledger and the background check", { timeout: 60_000 }, () => {
  it("reseal waits for a check in flight, and fails with a clear error (changing nothing) when it does not finish", async () => {
    await fixture();
    const held = await acquireCheckLock(p.home, { waitMs: 0 });
    const out: string[] = [];
    const err: string[] = [];
    const reseal = (lockWaitMs: number) => main(["reseal", "--yes"], { cwd: appDir, out: (l) => out.push(l), err: (l) => err.push(l), deps: { env: {}, hooks: hookDeps(), lockWaitMs } });
    const seals = async () => (await readEvents(p.ledgerFile)).filter((e) => e.t === "seal").length;

    expect(await reseal(200)).toBe(1);
    expect(out.join("\n")).toContain("Waiting for Holdback's background check");
    expect(err.join("\n")).toContain("A background check is still running after 1 minute. Nothing was changed");
    expect(await seals()).toBe(1);

    const pending = reseal(20_000);
    await new Promise((r) => setTimeout(r, 200));
    await held!.release();
    expect(await pending).toBe(0);
    expect(await seals()).toBe(2);
  });
});
