import { loadProject } from "@holdback/core";
import { EXIT, refuseInsideClaudeCode, type Ctx } from "./context.js";
import { runPipeline, type RunOptions } from "./run.js";

/** Watches the spec files: every edit goes through drift and then the run loop, until Ctrl-C. */
export async function watchCmd(ctx: Ctx, o: RunOptions): Promise<number> {
  if (refuseInsideClaudeCode(ctx, "holdback watch")) return EXIT.error;
  const p = await loadProject(ctx.cwd);
  const io = ctx.deps.humanIO();
  const sig = ctx.signals();
  let code: number = EXIT.ok;
  let running = false;
  let pending = false;
  let idle: Promise<void> = Promise.resolve();
  let finish!: () => void;
  const finished = new Promise<void>((res) => (finish = res));
  const fail = (c: number) => {
    code = c;
    finish();
  };

  const pass = async () => {
    do {
      pending = false;
      ctx.out("spec changed: checking for drift, then building");
      const c = await runPipeline(ctx, p, io, sig.signal, o);
      if (c === EXIT.tamper || c === EXIT.aborted) return fail(c);
    } while (pending && !sig.signal.aborted);
  };
  const onChange = () => {
    if (running) {
      pending = true;
      return;
    }
    running = true;
    idle = pass().finally(() => void (running = false));
  };

  let stopWatching: () => void = () => {};
  try {
    stopWatching = ctx.deps.watchSpec(p, onChange, {
      onError: (e) => {
        ctx.err(`error: the spec watcher stopped: ${e.message}`);
        fail(EXIT.error);
      },
    });
    ctx.out(`Watching ${p.config.spec.join(", ") || "the spec"}. Edit it to re-open work. Ctrl-C to stop.`);
    sig.signal.addEventListener("abort", () => finish(), { once: true });
    if (sig.signal.aborted) finish();
    await finished;
    return sig.signal.aborted && code === EXIT.ok ? EXIT.aborted : code;
  } finally {
    stopWatching();
    await idle.catch(() => {});
    sig.dispose();
    io.close();
  }
}
