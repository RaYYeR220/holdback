import { loadProject, type BuildResult, type FalsifyResult, type HumanIO, type Project } from "@holdback/core";
import { EXIT, explainFailure, humanView, ledgerLog, openHumanIO, parseKaneCap, refuseInsideClaudeCode, scrubAgentEnv, snapshot, withCheckLock, type Ctx } from "./context.js";
import { driftStop, inconclusiveLine, inconclusiveStop, kaneCreditsText, tamperMessage, unverifiedDrift } from "./messages.js";
import { reviewSpecChange, specMovedStop } from "./specchange.js";

export type RunOptions = {
  maxTurns?: string | number;
  /** `--no-falsify` sets this to false. */
  falsify?: boolean;
  /** Scripted answers and approvals (drift) instead of the terminal. */
  answers?: string;
  /** Answer in the browser dashboard (started in this process) instead of the terminal. */
  dashboard?: boolean;
  /** Dashboard port. */
  port?: string;
  /** `--kane-cap`: the project's Kane credit cap for this command, over `kane.capCredits`. */
  kaneCap?: string;
};

/** A falsify pass can send use cases back to the build loop; this many rounds is far more than it ever needs. */
const MAX_ROUNDS = 4;

/** Where a stopped run ended up, as an exit code (and the line that says why). */
type Stop = { code: number; why: string };

function buildStop(b: BuildResult): Stop {
  switch (b.reason) {
    case "tamper":
      return { code: EXIT.tamper, why: b.error ?? "" };
    case "aborted":
      return { code: EXIT.aborted, why: "stopped" };
    case "inconclusive":
      // Kane's to redo, not the agent's: more turns would not help
      return { code: EXIT.unfinished, why: inconclusiveStop(b.inconclusive ?? []) };
    case "budget":
      return { code: EXIT.unfinished, why: b.error ?? "Kane credit cap reached" };
    case "drift":
      // seen right after the agent's turn: the agent may have written it (R37)
      return { code: EXIT.unfinished, why: b.specChange?.duringAgentTurn ? unverifiedDrift(b.specChange.files) : driftStop(b.error) };
    case "max-turns":
      return { code: EXIT.error, why: `turn limit reached after ${b.turns} turn${b.turns === 1 ? "" : "s"}: some criteria are still owed (raise it with --max-turns or loop.maxTurns)` };
    default:
      return { code: EXIT.error, why: b.error ?? "the build loop failed" };
  }
}

function falsifyStop(f: FalsifyResult): Stop | undefined {
  switch (f.reason) {
    case "tamper":
      return { code: EXIT.tamper, why: f.error ?? "" };
    case "aborted":
      return { code: EXIT.aborted, why: "stopped" };
    case "error":
      return { code: EXIT.error, why: f.error ?? "falsify failed" };
    case "drift":
      // the spec moved while Kane evolved the tests: nothing was sealed, and its origin is unverified (N-I2)
      return { code: EXIT.unfinished, why: f.specChange?.duringAgentTurn ? unverifiedDrift(f.specChange.files) : driftStop(f.error) };
    case "kane-budget":
      return { code: EXIT.unfinished, why: f.error ?? "Kane credit cap reached" };
    default:
      return undefined;
  }
}

/** Prints the summary; true when the gate is open and nothing is owed, vacuous or without a spec. */
async function summary(ctx: Ctx, p: Project, turns: number, falsified: FalsifyResult | undefined): Promise<boolean> {
  const s = await snapshot(p);
  const count = (...st: string[]) => Object.values(s.state.acs).filter((a) => st.includes(a.status)).length;
  const regressed = count("regressed");
  ctx.out("");
  ctx.out(`Gate: ${s.gate.allowStop ? "open" : "closed"}`);
  ctx.out(
    `Criteria: ${count("owed", "regressed")} owed${regressed > 0 ? ` (${regressed} regressed)` : ""}, ${count("passing")} passing, ${count("proved")} proved, ${count("vacuous")} vacuous, ${count("needs-spec")} needs-spec${count("rejected") > 0 ? `, ${count("rejected")} rejected` : ""}`,
  );
  ctx.out(`Turns this run: ${turns} (turn ${s.state.turn} overall)`);
  ctx.out(`Kane credits: ${kaneCreditsText(s.state)}`);
  const unsure = inconclusiveLine(s.state.inconclusive);
  if (unsure) ctx.out(unsure);
  ctx.out(`Breaker spend: $${s.state.breakerUsd.toFixed(4)} of $${p.config.breaker.capUsd}`);
  if (falsified && falsified.skipped.length > 0) ctx.out(`Not attacked (breaker budget): ${falsified.skipped.join(", ")}`);
  if (count("vacuous") > 0) ctx.out("Vacuous means a planted bug in that criterion's code got past its tests: the criterion proves nothing yet.");
  return s.gate.allowStop && Object.keys(s.state.acs).length > 0 && count("vacuous", "needs-spec", "owed", "regressed") === 0;
}

/** What a caller of the pipeline (`watch`) hears about besides the exit code. */
export type PipelineEvents = {
  /** `watch`: a spec change not known to be the human's may go ahead on their yes in the terminal (R38); `run` stops instead. */
  allowUnverified?: boolean;
  /**
   * The spec changed: the pass stopped for a human to re-plan it (`holdback drift`). `duringAgentTurn`:
   * Holdback first saw it while the coding agent was working, so its origin is unverified (R37).
   */
  drifted?: (duringAgentTurn: boolean) => void;
};

/**
 * One pass of `holdback run`: drift check, build loop, falsify, and back to the build loop while
 * falsify re-opens work. Holds the check lock throughout, so the Claude Code hooks' background
 * check never races it on the ledger. Returns the exit code; never throws.
 */
export async function runPipeline(ctx: Ctx, p: Project, io: HumanIO, signal: AbortSignal, o: RunOptions, on: PipelineEvents = {}): Promise<number> {
  try {
    return await withCheckLock(ctx, p, () => pipeline(ctx, p, io, signal, o, on));
  } catch (e) {
    return await explainFailure(ctx, e, p);
  }
}

async function pipeline(caller: Ctx, p: Project, io: HumanIO, signal: AbortSignal, o: RunOptions, on: PipelineEvents): Promise<number> {
  // stop reasons carry an agent's stderr, Kane's verdicts and the spec diff
  const ctx = humanView(caller);
  const log = ledgerLog(p);
  let turns = 0;
  let falsified: FalsifyResult | undefined;
  try {
    const kaneCap = parseKaneCap(o.kaneCap);
    const capped = kaneCap === undefined ? {} : { kaneCap };
    let maxTurnsOverride: number | undefined;
    if (o.maxTurns !== undefined) {
      maxTurnsOverride = Number(o.maxTurns);
      if (!Number.isInteger(maxTurnsOverride) || maxTurnsOverride < 0) {
        ctx.err(`--max-turns must be a whole number, got ${String(o.maxTurns)}`);
        return EXIT.error;
      }
    }

    // the breaker's key is checked now, not after a whole build (M3)
    if (o.falsify !== false && !(ctx.deps.falsifyDeps.apiKey ?? ctx.deps.env.VENICE_API_KEY)) {
      ctx.err("VENICE_API_KEY is not set: the falsify stage needs it for the breaker (Venice API). Set it, or run with --no-falsify.");
      return EXIT.error;
    }

    const before = await snapshot(p);
    if (before.tamper !== null) {
      ctx.err(before.tamper);
      return EXIT.tamper;
    }
    if (!before.manifest) {
      ctx.err("Nothing is sealed yet: run `holdback spec` first.");
      return EXIT.error;
    }

    // the spec was edited after the last seal: Kane re-plans with the human before anything is built
    if (before.specChanged.length > 0) {
      ctx.out("spec changed since the last seal — running drift");
      // the diff first; one not known to be the human's stops `run` (exit 3) and, in `watch`, waits
      // for the human's yes in the terminal (R37, R38); a logged write at the spec is a tamper
      const review = await reviewSpecChange(ctx, p, { allowUnverified: on.allowUnverified === true });
      if ("stop" in review) return review.stop;
      // Kane re-plans, and the seal holds, the spec bytes whose diff was just shown (N-I2)
      const d = await ctx.deps.runDrift(p, io, log, {
        balance: ctx.deps.balance,
        warn: ctx.err,
        ...capped,
        reviewed: review.reviewed ?? {},
        ...(review.confirmed ? { confirmed: true } : {}),
      });
      if (d.changed && !d.applied && d.specMoved) return specMovedStop(ctx, d.specMoved, d.reason);
      if (d.changed && !d.applied) {
        ctx.err(`Spec change not applied: ${d.reason}`);
        ctx.err("Nothing was built. Fix or revert the spec edit, then run `holdback drift` or `holdback run` again.");
        return EXIT.error;
      }
    }

    const buildDeps = scrubAgentEnv(ctx.deps.buildDeps);
    // R40: Kane evolves a use case at most twice in a run, whichever falsify pass asks
    const evolves = new Map<string, number>();
    let stop: Stop | undefined;
    for (let round = 1; ; round++) {
      if (round > MAX_ROUNDS) {
        stop = { code: EXIT.error, why: "falsify kept re-opening criteria; stopped after several rounds" };
        break;
      }
      const b = await ctx.deps.runBuildLoop(p, buildDeps, log, { signal, ...capped, ...(maxTurnsOverride !== undefined ? { maxTurnsOverride } : {}) });
      turns += b.turns;
      if (b.reason !== "gate-open") {
        stop = buildStop(b);
        if (b.reason === "drift") on.drifted?.(b.specChange?.duringAgentTurn === true);
        break;
      }
      if (o.falsify === false) break;
      ctx.out("Gate open: falsifying the passing criteria with planted bugs");
      const f = await ctx.deps.runFalsify(p, ctx.deps.falsifyDeps, io, log, { signal, warn: ctx.err, evolves, ...capped });
      falsified = f;
      stop = falsifyStop(f);
      if (f.reason === "drift") on.drifted?.(f.specChange?.duringAgentTurn === true);
      if (stop) break;
      if (f.redesigned.length > 0) {
        ctx.out(`Kane evolved the tests of ${f.redesigned.join(", ")} after a planted bug got past them: building again`);
        // what Kane was told is the target of its hidden new test: the human's own output and the dashboard only (I-4)
        for (const e of f.evolved ?? []) ctx.out(`  ${e.uc}${e.followUp ? " (follow-up)" : ""}, Kane was told: ${e.because}`);
        continue;
      }
      // the closing replay against the real build can leave criteria owed or regressed: that is the
      // agent's to fix (only vacuous, needs-spec or inconclusive ones stay for the human)
      const g = (await snapshot(p)).gate;
      const open = [...g.regressed, ...g.owed].map((a) => a.id);
      if (open.length === 0) break;
      ctx.out(`Falsify's replay of the real build left ${open.join(", ")} owed: building again`);
    }

    if (stop?.code === EXIT.tamper) {
      const after = await snapshot(p);
      ctx.err(after.tamper ?? tamperMessage(stop.why || "sealed files changed"));
    } else if (stop) ctx.err(stop.why);
    const green = await summary(ctx, p, turns, falsified);
    if (stop) return stop.code;
    if (!green) ctx.err("Finished, but the gate is not fully green: see the counts above.");
    return green ? EXIT.ok : EXIT.unfinished;
  } catch (e) {
    return await explainFailure(ctx, e, p);
  }
}

export async function runCmd(ctx: Ctx, o: RunOptions): Promise<number> {
  if (refuseInsideClaudeCode(ctx, "holdback run")) return EXIT.error;
  const p = await loadProject(ctx.cwd);
  const io = await openHumanIO(ctx, p, o.answers, o);
  const sig = ctx.signals();
  try {
    return await runPipeline(ctx, p, io, sig.signal, o);
  } finally {
    sig.dispose();
    io.close();
  }
}
