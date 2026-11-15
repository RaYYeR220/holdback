// Fake kane-cli for the exam scorer. `testmd run <file> ...`: the outcome comes from FAKE_EXAM_OUTCOMES
// (JSON, test file name -> "pass" | "fail" | "env"; default pass). FAKE_EXAM_LOG: append {cwd, argv} per call.
import { appendFileSync } from "node:fs";
import path from "node:path";

const argv = process.argv.slice(2);
if (process.env.FAKE_EXAM_LOG) appendFileSync(process.env.FAKE_EXAM_LOG, JSON.stringify({ cwd: process.cwd(), argv }) + "\n");
const file = path.basename(argv[2] ?? "");
const outcome = JSON.parse(process.env.FAKE_EXAM_OUTCOMES ?? "{}")[file] ?? "pass";
const out = (o) => console.log(JSON.stringify(o));

out({ type: "test_md_step_end", step_index: 1, status: "passed", duration_s: 1 });
if (outcome === "pass") {
  out({ type: "test_md_step_end", step_index: 2, status: "passed", duration_s: 1 });
  out({ type: "run_end", status: "passed", credits_consumed: 0.5 });
  out({ type: "test_md_done", overall_status: "passed" });
} else {
  out({ type: "test_md_step_end", step_index: 2, status: "failed", duration_s: 1 });
  out({
    type: "run_end",
    status: "failed",
    credits_consumed: 0.5,
    verdict: { bug_title: outcome === "env" ? "Browser crashed" : "Wrong result shown", family: outcome === "env" ? "environment_issue" : "application_issue" },
  });
  out({ type: "test_md_done", overall_status: "failed" });
}
