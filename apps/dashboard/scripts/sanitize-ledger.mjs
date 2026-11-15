// Turns a recorded Holdback ledger into a replay fixture anyone may see:
//   node scripts/sanitize-ledger.mjs <ledger.jsonl> <outDir> [--holdback-home <dir>]
// writes <outDir>/ledger.jsonl and <outDir>/artifacts/*.png (Kane's screenshots the ledger names).
// Home paths become ~, the Holdback home becomes ~/.holdback, Kane's evidence packs and share links are
// dropped, screenshots point at artifacts/. Every field is rewritten as data, never as text, and the
// output is refused if anything personal is left. Events are kept as they are otherwise.
import { copyFileSync, existsSync, mkdirSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import os from "node:os";
import path from "node:path";

const args = process.argv.slice(2);
const flag = (name) => {
  const i = args.indexOf(name);
  if (i < 0) return undefined;
  const v = args[i + 1];
  args.splice(i, 2);
  return v;
};
const hbHomeArg = flag("--holdback-home");
const [src, outDir] = args;
if (!src || !outDir) {
  console.error("usage: node scripts/sanitize-ledger.mjs <ledger.jsonl> <outDir> [--holdback-home <dir>]");
  process.exit(1);
}

const home = os.homedir();
// the ledger sits at <HOLDBACK_HOME>/<project id>/ledger.jsonl
const hbHome = path.resolve(hbHomeArg ?? path.dirname(path.dirname(path.resolve(src))));
const user = os.userInfo().username;

const norm = (p) => p.replaceAll("\\", "/");
const startsWithPath = (s, prefix) => norm(s).toLowerCase().startsWith(norm(prefix).toLowerCase() + "/");
const SHARE = /https?:\/\/[^\s"')]*(lambdatest|testmu)[^\s"')]*/gi;
const TEMP = /[A-Za-z]:[\\/][^\s"]*?[\\/](AppData[\\/]Local[\\/]Temp|Temp)[\\/][^\s"]*/g;

/** One string as the fixture shows it. */
function clean(s) {
  let out = s;
  if (startsWithPath(out, hbHome)) out = "~/.holdback/" + norm(out).slice(norm(hbHome).length + 1);
  else if (startsWithPath(out, home)) out = "~/" + norm(out).slice(norm(home).length + 1);
  out = out.replace(SHARE, "[share link removed]").replace(TEMP, "[temp path removed]");
  return out;
}

function deep(v) {
  if (typeof v === "string") return clean(v);
  if (Array.isArray(v)) return v.map(deep);
  if (v && typeof v === "object") return Object.fromEntries(Object.entries(v).map(([k, x]) => [k, deep(x)]));
  return v;
}

const safeName = (s) => s.replace(/[^A-Za-z0-9._-]+/g, "-");
const artDir = path.join(outDir, "artifacts");
rmSync(artDir, { recursive: true, force: true });
mkdirSync(artDir, { recursive: true });

let copied = 0;
let missing = 0;
const lines = [];
for (const raw of readFileSync(src, "utf8").split("\n")) {
  const line = raw.trim();
  if (!line) continue;
  let e;
  try {
    e = JSON.parse(line);
  } catch {
    continue; // a torn line: the reducer skips it too
  }
  if (e && e.t === "run" && e.result && typeof e.result === "object") {
    const r = e.result;
    delete r.evidencePack; // Kane's own session pack: a tool path, not evidence the page can show
    if (typeof r.screenshot === "string") {
      const from = r.screenshot;
      const tag = e.mutantId ? e.mutantId : `turn-${e.turn ?? "x"}-${r.testId ?? "test"}`;
      const name = safeName(`${tag}-${path.basename(norm(from))}`);
      if (existsSync(from)) {
        copyFileSync(from, path.join(artDir, name));
        r.screenshot = `artifacts/${name}`;
        copied++;
      } else {
        delete r.screenshot;
        missing++;
      }
    }
  }
  lines.push(JSON.stringify(deep(e)));
}

const text = lines.join("\n") + "\n";
const leaks = [user, norm(home), home, "AppData", "lambdatest.com", "\\Users\\", "/Users/"].filter((x) => x && text.toLowerCase().includes(x.toLowerCase()));
if (leaks.length > 0) throw new Error(`personal data left in the fixture: ${leaks.join(", ")}`);
mkdirSync(outDir, { recursive: true });
writeFileSync(path.join(outDir, "ledger.jsonl"), text);
console.log(`${path.join(outDir, "ledger.jsonl")}: ${lines.length} events, ${copied} screenshots copied${missing ? `, ${missing} missing (dropped)` : ""}`);
