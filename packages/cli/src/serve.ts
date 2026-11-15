import { EXIT, type Ctx } from "./context.js";

export function serveCmd(ctx: Ctx): number {
  ctx.err("`holdback serve` is not available yet.");
  return EXIT.error;
}
