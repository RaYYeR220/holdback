import path from "node:path";
import { parseArgs } from "node:util";
import { recordArmC, runArm } from "./run-arm.ts";
import { defaultEvalHome, scoreApp } from "./score.ts";

const USAGE = `usage:
  arm A|B --model <id> --prd <PRD.md> --stack <STACK.md> [--out <dir>]
  arm C <appDir> [--turns n] [--agent-usd n] [--breaker-usd n] [--wall-min n] [--kane-credits n] [--claimed-done] [--model id]
  score <A|B|C> <appDir>`;

const { values, positionals } = parseArgs({
  allowPositionals: true,
  options: {
    model: { type: "string" },
    prd: { type: "string" },
    stack: { type: "string" },
    out: { type: "string" },
    turns: { type: "string" },
    "agent-usd": { type: "string" },
    "breaker-usd": { type: "string" },
    "wall-min": { type: "string" },
    "kane-credits": { type: "string" },
    "claimed-done": { type: "boolean" },
  },
});
const [cmd, armArg, dir] = positionals;
const num = (v: string | undefined) => (v === undefined ? undefined : Number(v));

async function main(): Promise<void> {
  if (cmd === "arm" && (armArg === "A" || armArg === "B")) {
    if (!values.model || !values.prd || !values.stack) throw new Error(`--model, --prd and --stack are required\n${USAGE}`);
    const out = values.out ?? path.join(defaultEvalHome(), `arm-${armArg.toLowerCase()}`);
    console.log(JSON.stringify(await runArm(armArg, { outDir: out, prdPath: values.prd, stackPath: values.stack, model: values.model }), null, 2));
  } else if (cmd === "arm" && armArg === "C" && dir) {
    const run = await recordArmC(dir, {
      turns: num(values.turns),
      agentUsd: num(values["agent-usd"]),
      breakerUsd: num(values["breaker-usd"]),
      wallMin: num(values["wall-min"]),
      kaneCredits: num(values["kane-credits"]),
      claimedDone: values["claimed-done"],
      model: values.model,
    });
    console.log(JSON.stringify(run, null, 2));
  } else if (cmd === "score" && (armArg === "A" || armArg === "B" || armArg === "C")) {
    if (!dir) throw new Error(USAGE);
    const s = await scoreApp(dir, armArg);
    console.log(`${armArg}: ${s.examPassed}/${s.examTotal} passed (${s.inconclusive} inconclusive), exam day ${s.today}`);
  } else {
    throw new Error(USAGE);
  }
}

main().catch((e) => {
  console.error(e instanceof Error ? e.message : String(e));
  process.exit(1);
});
