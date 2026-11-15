// Fake kane-cli for tests. Env: FAKE_KANE_PID_FILE, FAKE_KANE_FIXTURE, FAKE_KANE_ARGV_LOG, FAKE_KANE_EXIT, FAKE_KANE_HANG, FAKE_KANE_SEQUENCE.
// FAKE_KANE_SEQUENCE=<file>: one fixture path per line, call N prints line N ("-" or a missing line prints nothing).
// The call counter lives in <file>.count. Overrides FAKE_KANE_FIXTURE.
import { appendFileSync, readFileSync, writeFileSync } from "node:fs";

const log = process.env.FAKE_KANE_ARGV_LOG;
if (log) appendFileSync(log, JSON.stringify(process.argv.slice(2)) + "\n");

if (process.env.FAKE_KANE_PID_FILE) writeFileSync(process.env.FAKE_KANE_PID_FILE, String(process.pid));

let fixture = process.env.FAKE_KANE_FIXTURE;
const seq = process.env.FAKE_KANE_SEQUENCE;
if (seq) {
  let n = 0;
  try {
    n = Number(readFileSync(seq + ".count", "utf8"));
  } catch {}
  writeFileSync(seq + ".count", String(n + 1));
  const pick = (readFileSync(seq, "utf8").split(/\r?\n/)[n] ?? "").trim();
  fixture = pick && pick !== "-" ? pick : undefined;
}
if (fixture) {
  for (const line of readFileSync(fixture, "utf8").split("\n")) {
    if (line.length > 0) process.stdout.write(line + "\n");
  }
}

if (process.env.FAKE_KANE_HANG === "1") {
  setInterval(() => {}, 1000);
} else {
  process.exitCode = Number(process.env.FAKE_KANE_EXIT ?? 0);
}
