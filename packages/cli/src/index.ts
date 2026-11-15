#!/usr/bin/env node
import { realpathSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { VERSION } from "@holdback/core";
import { Command, CommanderError } from "commander";
import { cleanCmd } from "./clean.js";
import { defaultCtx, EXIT, explainFailure, type Ctx, type CtxOverrides } from "./context.js";
import { driftCmd } from "./drift.js";
import { hookCmd } from "./hooks.js";
import { initCmd } from "./init.js";
import { HELP_FOOTER } from "./messages.js";
import { owedCmd } from "./owed.js";
import { resealCmd } from "./reseal.js";
import { runCmd } from "./run.js";
import { serveCmd } from "./serve.js";
import { specCmd } from "./spec.js";
import { statusCmd } from "./status.js";
import { watchCmd } from "./watch.js";

export { EXIT, installSignals, scrubAgentEnv, type Ctx, type CtxOverrides, type Deps } from "./context.js";
export { STOP_BLOCK_CAP, type CheckWorker, type HookDeps } from "./hooks.js";

const collect = (v: string, prev: string[] = []) => [...prev, v];

/** Runs the CLI for `argv` (without the node and script entries) and returns the exit code. */
export async function main(argv: string[], over: CtxOverrides = {}): Promise<number> {
  const base = defaultCtx();
  const ctx: Ctx = { ...base, ...over, deps: { ...base.deps, ...over.deps } };
  let code: number = EXIT.ok;
  const act =
    <A extends unknown[]>(fn: (...a: A) => Promise<number> | number) =>
    async (...a: A) => {
      try {
        code = await fn(...a);
      } catch (e) {
        code = await explainFailure(ctx, e);
      }
    };

  // commander's own text (help, usage errors) goes through the same output as everything else
  const output = {
    writeOut: (s: string) => ctx.out(s.replace(/\n$/, "")),
    writeErr: (s: string) => ctx.err(s.replace(/\n$/, "")),
  };
  const program = new Command("holdback")
    .description("Makes a coding agent build only what Kane proves, in a real browser, from your spec.")
    .version(VERSION)
    .exitOverride()
    .configureOutput(output)
    .addHelpText("after", HELP_FOOTER);

  program
    .command("init")
    .description("Write holdback.config.json and create the verifier folder")
    .option("--spec <file>", "spec file in this folder (repeatable; default PRD.md)", collect)
    .option("--url <url>", "spec link for Kane to read (repeatable)", collect)
    .option("--start <cmd>", "command that starts your app")
    .option("--port <n>", "port the app listens on")
    .option("--force", "overwrite an existing holdback.config.json")
    .option("--agent <agent>", "also install the hooks for an interactive coding agent session (claude)")
    .option("--remove", "with --agent: take the hooks out again")
    .action(act((o) => initCmd(ctx, o)));

  program
    .command("spec")
    .description("Have Kane design acceptance criteria from the spec, then approve and seal them")
    .action(act(() => specCmd(ctx)));

  program
    .command("run")
    .description("Build until Kane proves every criterion, then falsify the proven ones")
    .option("--max-turns <n>", "highest turn number allowed (turns are numbered across runs)")
    .option("--no-falsify", "skip the planted-bug pass")
    .action(act((o) => runCmd(ctx, o)));

  program
    .command("drift")
    .description("Apply a spec edit made after the last seal")
    .action(act(() => driftCmd(ctx)));

  program
    .command("watch")
    .description("Watch the spec files; on every edit run drift, then the run loop")
    .option("--max-turns <n>", "highest turn number allowed (turns are numbered across runs)")
    .option("--no-falsify", "skip the planted-bug pass")
    .action(act((o) => watchCmd(ctx, o)));

  program
    .command("status")
    .description("Show every criterion and whether the gate is open")
    .option("--json", "print the reduced state as JSON")
    .action(act((o) => statusCmd(ctx, o)));

  program
    .command("owed")
    .description("Print what the coding agent is told is still owed")
    .action(act(() => owedCmd(ctx)));

  program
    .command("reseal")
    .description("Accept the files on disk as the new sealed state (lifts a tamper)")
    .option("--yes", "do not ask for confirmation")
    .action(act((o) => resealCmd(ctx, o)));

  program
    .command("clean")
    .description("Remove leftover mutant and bisect worktrees (never delete them by hand)")
    .action(act(() => cleanCmd(ctx)));

  program
    .command("hook")
    .description("Claude Code hook entry point (installed by `holdback init --agent claude`)")
    .argument("<name>", "guard | post-edit | stop | prompt")
    .option("--app <dir>", "the app folder (background check only)")
    .option("--reason <reason>", "edit | stop (background check only)")
    .action(act((name: string, o: { app?: string; reason?: string }) => hookCmd(ctx, name, o)));

  program
    .command("serve")
    .description("Local dashboard (coming soon)")
    .action(act(() => serveCmd(ctx)));

  for (const c of program.commands) c.exitOverride().configureOutput(output);

  try {
    await program.parseAsync(argv, { from: "user" });
  } catch (e) {
    if (e instanceof CommanderError) return e.exitCode;
    return await explainFailure(ctx, e);
  }
  return code;
}

function isEntry(): boolean {
  const entry = process.argv[1];
  if (!entry) return false;
  try {
    return realpathSync.native(entry) === realpathSync.native(fileURLToPath(import.meta.url));
  } catch {
    return false;
  }
}

if (isEntry()) {
  const args = process.argv.slice(2);
  main(args).then(
    (c) => {
      process.exitCode = c;
      // a Claude Code hook must answer, not linger: a Stop hook killed at its timeout lets the agent stop
      if (args[0] === "hook") setTimeout(() => process.exit(c), 2_000).unref();
    },
    (e) => {
      console.error(e instanceof Error ? e.message : String(e));
      process.exitCode = EXIT.error;
    },
  );
}
