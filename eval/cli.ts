import path from "node:path";
import { parseArgs } from "node:util";
import { registerPrd, DEFAULT_RESULTS_DIR } from "./prd.ts";
import { recordArmC, runArm } from "./run-arm.ts";
import { defaultEvalHome, parseMinCredits, scoreApp } from "./score.ts";

const USAGE = `usage (run the arms one after another, never at the same time):
  register-prd --prd <PRD.md> --stack <STACK.md> --model <id>      right after the spec stage, before C's build
  arm A|B --model <id> --prd <PRD.md> --stack <STACK.md> [--out <dir>]
  arm C <appDir>                                                    numbers come from the Holdback ledger (set HOLDBACK_HOME as it ran)
  score <A|B|C> <appDir> [--min-credits n] [--parallel n]`;

const { values, positionals } = parseArgs({
  allowPositionals: true,
  options: {
    model: { type: "string" },
    prd: { type: "string" },
    stack: { type: "string" },
    out: { type: "string" },
    "min-credits": { type: "string" },
    parallel: { type: "string" },
  },
});
const [cmd, armArg, dir] = positionals;
// pnpm runs scripts from the package dir: relative paths mean relative to where the user typed the command
const base = process.env.INIT_CWD ?? process.cwd();
const abs = (p: string) => path.resolve(base, p);

/** How many exam tests Kane runs at once (default 2); 1 keeps Kane sessions from racing each other. */
function parallelOf(v: string): number {
  const n = Number(v);
  if (!Number.isInteger(n) || n < 1) throw new Error(`--parallel must be a whole number of at least 1, got ${v}`);
  return n;
}

async function main(): Promise<void> {
  if (cmd === "register-prd") {
    if (!values.model || !values.prd || !values.stack) throw new Error(`--model, --prd and --stack are required\n${USAGE}`);
    console.log(JSON.stringify(await registerPrd(abs(values.prd), abs(values.stack), values.model, DEFAULT_RESULTS_DIR), null, 2));
  } else if (cmd === "arm" && (armArg === "A" || armArg === "B")) {
    if (!values.model || !values.prd || !values.stack) throw new Error(`--model, --prd and --stack are required\n${USAGE}`);
    const out = values.out ? abs(values.out) : path.join(defaultEvalHome(), `arm-${armArg.toLowerCase()}`);
    console.log(JSON.stringify(await runArm(armArg, { outDir: out, prdPath: abs(values.prd), stackPath: abs(values.stack), model: values.model }), null, 2));
  } else if (cmd === "arm" && armArg === "C" && dir) {
    console.log(JSON.stringify(await recordArmC(abs(dir)), null, 2));
  } else if (cmd === "score" && (armArg === "A" || armArg === "B" || armArg === "C") && dir) {
    const s = await scoreApp(abs(dir), armArg, { minCredits: parseMinCredits(values["min-credits"]), ...(values.parallel !== undefined ? { parallel: parallelOf(values.parallel) } : {}) });
    console.log(`${armArg}: ${s.examPassed}/${s.examTotal} passed (${s.inconclusive} inconclusive)${s.appFailure ? `, ${s.appFailure}` : ""}, exam day ${s.today}`);
  } else {
    throw new Error(USAGE);
  }
}

main().catch((e) => {
  console.error(e instanceof Error ? e.message : String(e));
  process.exit(1);
});
