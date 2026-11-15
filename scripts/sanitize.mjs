// Usage: node scripts/sanitize.mjs <srcDir> <destDir>
// Copies *.ndjson files, stripping the local home path and share URLs.
// The home path is read at run time (os.homedir()), never written into this file.
import { mkdirSync, readdirSync, readFileSync, writeFileSync } from "node:fs";
import os from "node:os";
import { join } from "node:path";
import { fileURLToPath } from "node:url";

const SEP = "(?:\\\\\\\\|\\\\|/)"; // JSON-escaped backslash, backslash or slash
const TMP_RE = new RegExp(
  `~${SEP}AppData${SEP}Local${SEP}Temp${SEP}(?:claude${SEP}[0-9a-f]+${SEP}[0-9a-f-]+${SEP}scratchpad${SEP})?`,
  "gi",
);

const escapeRe = (s) => s.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");

/**
 * The forms `home` takes in Kane's output: as it is, with forward slashes, and with its backslashes
 * escaped as inside a JSON string. Longest first, so the JSON form is replaced before the raw one.
 */
export function homeForms(home) {
  const raw = home.replace(/[\\/]+$/, "");
  if (!raw) return [];
  const forms = new Set([raw.replace(/\\/g, "\\\\"), raw, raw.replace(/\\/g, "/")]);
  return [...forms].sort((a, b) => b.length - a.length);
}

/** Replaces `home` (default: this user's home) with `~`, temp dirs with `<tmp>` and Test Manager links with `<share-url>`. */
export function sanitize(text, home = os.homedir()) {
  let out = text;
  for (const form of homeForms(home)) out = out.replace(new RegExp(escapeRe(form), "g"), "~");
  return (
    out
      // Session temp dirs (incl. tool scratchpad ids) collapse to <tmp>, any slash/escape style.
      .replace(TMP_RE, (m) => "<tmp>" + (m.endsWith("\\\\") ? "\\\\" : m.slice(-1)))
      .replace(/https:\/\/test-manager\.lambdatest\.com\/[^"\s]*/g, "<share-url>")
  );
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
