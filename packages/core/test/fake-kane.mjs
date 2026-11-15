// Fake kane-cli for tests. Env: FAKE_KANE_PID_FILE, FAKE_KANE_FIXTURE, FAKE_KANE_ARGV_LOG, FAKE_KANE_EXIT, FAKE_KANE_HANG.
import { appendFileSync, readFileSync, writeFileSync } from "node:fs";

const log = process.env.FAKE_KANE_ARGV_LOG;
if (log) appendFileSync(log, JSON.stringify(process.argv.slice(2)) + "\n");

if (process.env.FAKE_KANE_PID_FILE) writeFileSync(process.env.FAKE_KANE_PID_FILE, String(process.pid));

const fixture = process.env.FAKE_KANE_FIXTURE;
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
