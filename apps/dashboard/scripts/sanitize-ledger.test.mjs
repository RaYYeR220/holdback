// node --test scripts/sanitize-ledger.test.mjs  (no dashboard build needed)
import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import { mkdtempSync, mkdirSync, readFileSync, writeFileSync } from "node:fs";
import os from "node:os";
import path from "node:path";
import test from "node:test";
import { fileURLToPath } from "node:url";

const script = path.join(path.dirname(fileURLToPath(import.meta.url)), "sanitize-ledger.mjs");
const home = os.homedir();
const user = os.userInfo().username;
const bs = home; // C:\Users\<name> on Windows
const fwd = home.replaceAll("\\", "/");
const dbl = home.replaceAll("\\", "\\\\");

function run(events) {
  const root = mkdtempSync(path.join(os.tmpdir(), "hb-san-"));
  const proj = path.join(root, "hbhome", "abc123");
  mkdirSync(proj, { recursive: true });
  const src = path.join(proj, "ledger.jsonl");
  writeFileSync(src, events.map((e) => JSON.stringify(e)).join("\n") + "\n");
  const out = path.join(root, "out");
  const r = spawnSync(process.execPath, [script, src, out], { encoding: "utf8" });
  return { r, out };
}

test("home paths quoted mid-sentence in free text become ~, the username becomes user", () => {
  const swapDrive = home[0] === home[0].toUpperCase() ? home[0].toLowerCase() + home.slice(1) : home[0].toUpperCase() + home.slice(1);
  const { r, out } = run([
    { t: "mutant", id: "m1", title: `crash reading ${bs}\\.holdback\\abc123\\data\\x.json for ${user}` },
    { t: "run", turn: 1, result: { testId: "t-1", status: "failed", reason: `Failed: "${dbl}\\\\.holdback\\\\abc123\\\\shot.png" not found; also ${fwd}/Desktop/app and ${swapDrive}\\Temp-like` } },
    { t: "evolve", because: `%USERPROFILE%\\.holdback\\abc123 was empty (see ${fwd}/.holdback/abc123/ledger.jsonl)` },
    { t: "run", turn: 1, result: { verdict: "see https://automation.lambdatest.com/public/share/abc and https://example.com/x?token=SECRET123&a=1" } },
  ]);
  assert.equal(r.status, 0, r.stderr);
  const text = readFileSync(path.join(out, "ledger.jsonl"), "utf8");
  const ev = text.trim().split("\n").map((l) => JSON.parse(l));
  assert.equal(ev[0].title, "crash reading ~/.holdback\\abc123\\data\\x.json for user");
  assert.match(ev[1].result.reason, /^Failed: "~\/\.holdback/);
  assert.ok(ev[1].result.reason.includes("also ~/Desktop/app"));
  assert.ok(ev[2].because.startsWith("~/.holdback"));
  assert.ok(ev[2].because.includes("(see ~/.holdback/abc123/ledger.jsonl)"));
  assert.ok(ev[3].result.verdict.includes("[share link removed]"));
  assert.ok(ev[3].result.verdict.includes("token=[removed]"));
  assert.ok(!ev[3].result.verdict.includes("SECRET123"));
  for (const bad of [user, fwd, home, dbl, "USERPROFILE", "SECRET123", "lambdatest"]) assert.ok(!text.toLowerCase().includes(bad.toLowerCase()), `leaked ${bad}`);
});

test("refuses to write anything when a leak survives (fail-closed)", () => {
  // an 8.3-style or otherwise unrecognised form of the home dir that the rewriter cannot know about
  const { r, out } = run([{ t: "mutant", id: "m1", title: "AppData is mentioned here" }]);
  assert.notEqual(r.status, 0);
  assert.match(r.stderr, /personal data left/);
  assert.throws(() => readFileSync(path.join(out, "ledger.jsonl")));
});
