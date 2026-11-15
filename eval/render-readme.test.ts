import { mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { END, START, renderReadme } from "../scripts/render-readme.mjs";

let tmp: string;
let readme: string;
let summary: string;
beforeEach(() => {
  tmp = mkdtempSync(path.join(tmpdir(), "holdback-readme-"));
  readme = path.join(tmp, "README.md");
  summary = path.join(tmp, "summary.json");
  writeFileSync(readme, `# Holdback\n\nIntro.\n\n## Results\n\n${START}\nold\n${END}\n\nTail.\n`);
});
afterEach(() => rmSync(tmp, { recursive: true, force: true }));

const SUMMARY = {
  A: { examPassed: 17, examTotal: 22, inconclusive: 0, claimedDone: true, turns: 88, kaneCredits: 0, agentUsd: 6.5, breakerUsd: 0, wallMin: 31.4 },
  C: { examPassed: 21, examTotal: 22, inconclusive: 1, claimedDone: true, turns: 120, kaneCredits: 1340.5, agentUsd: 9.25, breakerUsd: 0.4, wallMin: 75 },
};

describe("render-readme", () => {
  it("writes 'Results pending.' without a summary", () => {
    const out = renderReadme(readme, summary);
    expect(out).toContain(`${START}\nResults pending.\n${END}`);
    expect(out).toContain("Tail.");
  });

  it("fills the table and one sentence from the summary, leaving the rest of the README alone", () => {
    writeFileSync(summary, JSON.stringify(SUMMARY));
    const out = renderReadme(readme, summary);
    expect(out).toContain("| A: Claude Code alone | 17/22 | 0 | yes | 88 | 0.0 | $6.50 | $0.00 | 31.4 |");
    expect(out).toContain("| C: Holdback | 21/22 | 1 | yes | 120 | 1340.5 | $9.25 | $0.40 | 75.0 |");
    expect(out).not.toContain("B: Claude Code");
    expect(out).toContain("A 17/22, C 21/22");
    expect(out.startsWith("# Holdback\n\nIntro.\n\n## Results\n\n")).toBe(true);
    expect(out.endsWith(`${END}\n\nTail.\n`)).toBe(true);
    expect(out).not.toContain(`${START}\nold\n`);
  });

  it("is idempotent", () => {
    writeFileSync(summary, JSON.stringify(SUMMARY));
    const first = renderReadme(readme, summary);
    const second = renderReadme(readme, summary);
    expect(second).toBe(first);
    expect(readFileSync(readme, "utf8")).toBe(first);
  });

  it("shows an unreadable credit figure as n/a", () => {
    writeFileSync(summary, JSON.stringify({ B: { ...SUMMARY.A, kaneCredits: null } }));
    expect(renderReadme(readme, summary)).toMatch(/\| B: .* \| n\/a \|/);
  });

  it("refuses a README without the markers", () => {
    writeFileSync(readme, "# Holdback\n");
    expect(() => renderReadme(readme, summary)).toThrow(/markers/);
  });
});
