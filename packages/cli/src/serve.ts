import path from "node:path";
import { DEFAULT_PORT, loadProject } from "@holdback/core";
import { dashboardUrl, EXIT, parsePort, refuseInsideClaudeCode, type Ctx } from "./context.js";

/** `holdback serve`: the local dashboard on 127.0.0.1 until Ctrl-C. Human-only: it can answer Kane's questions. */
export async function serveCmd(ctx: Ctx, o: { port?: string; static?: string }): Promise<number> {
  if (refuseInsideClaudeCode(ctx, "holdback serve")) return EXIT.error;
  let port: number;
  try {
    port = parsePort(o.port, DEFAULT_PORT);
  } catch (e) {
    ctx.err(`error: ${(e as Error).message}`);
    return EXIT.error;
  }
  const p = await loadProject(ctx.cwd);
  const staticDir = o.static === undefined ? undefined : path.resolve(ctx.cwd, o.static);
  const sig = ctx.signals();
  let srv: Awaited<ReturnType<Ctx["deps"]["serve"]>>;
  try {
    srv = await ctx.deps.serve(p, { port, staticDir });
  } catch (e) {
    sig.dispose();
    const code = (e as NodeJS.ErrnoException).code;
    ctx.err(code === "EADDRINUSE" ? `error: port ${port} is already in use (try --port)` : `error: ${e instanceof Error ? e.message : String(e)}`);
    return EXIT.error;
  }
  ctx.out(`Holdback dashboard: ${dashboardUrl(srv, staticDir !== undefined)}${staticDir ? "" : "  (API only: pass --static <dir> to serve a dashboard build)"}`);
  ctx.out(`API token (header x-holdback-token): ${srv.token}`);
  ctx.out("Ctrl-C to stop.");
  try {
    if (!sig.signal.aborted) await new Promise<void>((res) => sig.signal.addEventListener("abort", () => res(), { once: true }));
  } finally {
    sig.dispose();
    await srv.close();
  }
  return EXIT.ok;
}
