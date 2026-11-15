// Usage: node scripts/sanitize.mjs <srcDir> <destDir>
// Copies *.ndjson files, stripping the local home path and share URLs.
import { mkdirSync, readdirSync, readFileSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { fileURLToPath } from "node:url";

const HOME_JSON = "C:\\\\Users\\\\user"; // as it appears inside JSON strings
const HOME_FWD = "C:/Users/user";
const HOME_RAW = "C:\\Users\\user";

const SEP = "(?:\\\\\\\\|\\\\|/)"; // JSON-escaped backslash, backslash or slash
const TMP_RE = new RegExp(
  `~${SEP}AppData${SEP}Local${SEP}Temp${SEP}(?:claude${SEP}[0-9a-f]+${SEP}[0-9a-f-]+${SEP}scratchpad${SEP})?`,
  "gi",
);

export function sanitize(text) {
  return text
    .replaceAll(HOME_JSON, "~")
    .replaceAll(HOME_FWD, "~")
    .replaceAll(HOME_RAW, "~")
    // Session temp dirs (incl. tool scratchpad ids) collapse to <tmp>, any slash/escape style.
    .replace(TMP_RE, (m) => "<tmp>" + (m.endsWith("\\\\") ? "\\\\" : m.slice(-1)))
    .replace(/https:\/\/test-manager\.lambdatest\.com\/[^"\s]*/g, "<share-url>");
}

if (process.argv[1] && fileURLToPath(import.meta.url) === process.argv[1]) {
  const [src, dest] = process.argv.slice(2);
  if (!src || !dest) {
    console.error("usage: sanitize.mjs <srcDir> <destDir>");
    process.exit(2);
  }
  mkdirSync(dest, { recursive: true });
  for (const f of readdirSync(src).filter((n) => n.endsWith(".ndjson"))) {
    writeFileSync(join(dest, f), sanitize(readFileSync(join(src, f), "utf8")));
    console.log("sanitized", f);
  }
}
