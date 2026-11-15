import { access, writeFile } from "node:fs/promises";
import path from "node:path";
import { loadProject } from "@holdback/core";
import { EXIT, explainFailure, insideClaudeCode, type Ctx } from "./context.js";
import { installClaudeHooks, removeClaudeHooks } from "./hooks.js";
import { HUMAN_ONLY } from "./messages.js";

export type InitOptions = {
  spec?: string[];
  url?: string[];
  start?: string;
  port?: string | number;
  force?: boolean;
  /** `claude`: also install the Claude Code hooks for interactive mode. */
  agent?: string;
  /** With `agent`: take the hooks out instead. */
  remove?: boolean;
};

const CONFIG = "holdback.config.json";

const exists = (f: string) =>
  access(f).then(
    () => true,
    () => false,
  );

/**
 * Writes `holdback.config.json` and creates the verifier folder under `~/.holdback/<id>/`.
 * `--agent claude` also merges the Claude Code hooks into `.claude/settings.json` (an existing
 * config is kept unless `--force`); `--agent claude --remove` only takes them out.
 */
export async function initCmd(ctx: Ctx, o: InitOptions): Promise<number> {
  if (o.agent !== undefined && o.agent !== "claude") {
    ctx.err(`--agent supports claude only, got ${o.agent}`);
    return EXIT.error;
  }
  if (o.remove && o.agent === undefined) {
    ctx.err("--remove goes with --agent claude");
    return EXIT.error;
  }
  const file = path.join(ctx.cwd, CONFIG);
  if (o.agent !== undefined) {
    try {
      if (o.remove) {
        if (insideClaudeCode(ctx)) {
          ctx.err(HUMAN_ONLY("holdback init --agent claude --remove"));
          return EXIT.error;
        }
        return await removeClaudeHooks(ctx);
      }
      if (!(await exists(file)) || o.force) {
        const code = await writeConfig(ctx, o);
        if (code !== EXIT.ok) return code;
      } else ctx.out(`${CONFIG} already exists: keeping it`);
      return await installClaudeHooks(ctx);
    } catch (e) {
      return await explainFailure(ctx, e);
    }
  }
  if ((await exists(file)) && !o.force) {
    ctx.err(`${CONFIG} already exists here (use --force to overwrite it)`);
    return EXIT.error;
  }
  return writeConfig(ctx, o);
}

async function writeConfig(ctx: Ctx, o: InitOptions): Promise<number> {
  const file = path.join(ctx.cwd, CONFIG);
  const port = o.port === undefined ? undefined : Number(o.port);
  if (port !== undefined && !(Number.isInteger(port) && port > 0 && port < 65536)) {
    ctx.err(`--port must be a number between 1 and 65535, got ${String(o.port)}`);
    return EXIT.error;
  }
  const hadConfig = await exists(file);

  try {
    // with --force the old config is still read here: a broken one must not block the overwrite
    const p = await loadProject(ctx.cwd).catch(async (e) => {
      if (!o.force) throw e;
      await writeFile(file, "{}\n", "utf8");
      return loadProject(ctx.cwd);
    });
    // --force keeps what the old config said unless a flag says otherwise
    const urls = o.url ?? p.config.specUrls;
    // only links, no file: nothing to copy from the app folder
    const spec = o.spec && o.spec.length > 0 ? o.spec : !hadConfig && urls.length > 0 ? [] : p.config.spec;
    const config = {
      ...p.config,
      spec,
      specUrls: urls,
      start: { ...p.config.start, ...(o.start !== undefined ? { cmd: o.start } : {}), ...(port !== undefined ? { port } : {}) },
    };
    await writeFile(file, JSON.stringify(config, null, 2) + "\n", "utf8");

    ctx.out(`Wrote ${CONFIG}`);
    ctx.out(`Verifier folder (kept outside your repo): ${p.verifierDir}`);
    for (const rel of spec) if (!(await exists(path.join(ctx.cwd, rel)))) ctx.err(`warning: ${rel} does not exist yet`);
    ctx.out(`Next: write your spec${spec[0] ? ` in ${spec[0]}` : ""}, then run \`holdback spec\`.`);
    return EXIT.ok;
  } catch (e) {
    return await explainFailure(ctx, e);
  }
}
