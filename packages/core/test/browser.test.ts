import { readFileSync } from "node:fs";
import { builtinModules } from "node:module";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { describe, expect, it } from "vitest";
import * as browser from "../src/browser.js";
import * as core from "../src/index.js";

const SRC = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "../src");
const builtins = new Set(builtinModules);

/** The value imports of one module: `import type` and `export type` lines are erased and never load. */
function valueImports(file: string): string[] {
  const text = readFileSync(file, "utf8");
  const out: string[] = [];
  const re = /^\s*(import|export)\s+(?!type\b)[^;]*?\bfrom\s+["']([^"']+)["']|^\s*import\s+["']([^"']+)["']/gm;
  for (const m of text.matchAll(re)) out.push((m[2] ?? m[3])!);
  return out;
}

/** Every module `entry` loads at run time, transitively. */
function graph(entry: string): { files: string[]; external: string[] } {
  const seen = new Set<string>();
  const external = new Set<string>();
  const walk = (file: string) => {
    if (seen.has(file)) return;
    seen.add(file);
    for (const spec of valueImports(file)) {
      if (!spec.startsWith(".")) {
        external.add(spec);
        continue;
      }
      walk(path.resolve(path.dirname(file), spec.replace(/\.js$/, ".ts")));
    }
  };
  walk(entry);
  return { files: [...seen].map((f) => path.relative(SRC, f).replaceAll("\\", "/")).sort(), external: [...external].sort() };
}

describe("@holdback/core/browser", () => {
  it("loads no node module and no package, only the pure ledger files", () => {
    const g = graph(path.join(SRC, "browser.ts"));
    expect(g.external).toEqual([]);
    expect(g.external.filter((s) => s.startsWith("node:") || builtins.has(s))).toEqual([]);
    expect(g.files).toEqual(["browser.ts", "kane/outcome.ts", "ledger/credits.ts", "ledger/gate.ts", "ledger/parse.ts", "ledger/reduce.ts", "ledger/retired.ts", "ledger/verdict.ts"]);
  });

  it("exports the same functions as the node entry", () => {
    expect(browser.reduce).toBe(core.reduce);
    expect(browser.gate).toBe(core.gate);
    expect(browser.parseEvents).toBe(core.parseEvents);
    expect(browser.eventCredits).toBe(core.eventCredits);
    expect(browser.notAnAppFailure).toBe(core.notAnAppFailure);
    expect(browser.verdict).toBe(core.verdict);
    expect(browser.retiredTests).toBe(core.retiredTests);
  });
});
