import { existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import {
  END,
  START,
  checkDemo,
  emptyDemo,
  fillMarkers,
  readInputs,
  renderDemo,
  renderDemoStatus,
  renderDocs,
  renderExam,
  renderExamStatus,
  renderFalsified,
  renderHeadline,
  renderReadme,
} from "../scripts/render-readme.mjs";

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

describe("render-readme footnotes", () => {
  it("notes the spec split, an app failure, assurance calls, exhausted retries and unmeasured figures", () => {
    const base = { examPassed: 0, examTotal: 22, inconclusive: 0, claimedDone: false, turns: 5, kaneCredits: 1, agentUsd: 1, breakerUsd: 0, wallMin: 2, stopReason: "done" };
    writeFileSync(
      summary,
      JSON.stringify({
        A: { ...base, stopReason: "transient-exhausted", appFailure: "app did not boot: exited" },
        B: { ...base, assuranceCallsUsed: 2 },
        C: { ...base, specCredits: 40, specMinutes: 5, kaneUnmeasured: 1, turnsWithoutCost: 2, turns: null, agentUsd: null },
      }),
    );
    const out = renderReadme(readme, summary);
    expect(out).toContain("- A: the app could not be installed or started, so it scores 0 of 22 (app did not boot: exited).");
    expect(out).toContain("- A: the build stopped after repeated API errors");
    expect(out).toContain("- B: the agent ran 2 Kane assurance commands");
    expect(out).toContain(
      "- C: build credits and wall minutes count from its first build turn to its last ledger event, planted bugs included and stops between runs included; its spec stage is not in them (40.0 credits, 5.0 minutes).",
    );
    expect(out).toContain("- C: 1 Kane batch had no balance reading");
    expect(out).toContain("- C: 2 loop turns did not report agent cost");
    expect(renderReadme(readme, summary)).toBe(out);
  });

  it("adds no notes when there is nothing to note", () => {
    writeFileSync(summary, JSON.stringify(SUMMARY));
    expect(renderReadme(readme, summary)).not.toContain("\n- ");
  });
});

describe("render-readme parts", () => {
  const DEMO = {
    _readme: "x",
    links: { landing: "https://example.test/", video: null, replay: "https://example.test/replay/" },
    recorded: { ledger: "examples/recorded-run/ledger.jsonl" },
    spec: { questions: 3, criteria: 14, tests: 5, noTest: 2 },
    build: { turns: 4, bugReports: 2, greenFirst: 9, greenLast: 12, gateOpen: true },
    falsify: { planted: 6, caught: 5, survived: 1, survivedNoChange: 1, survivedOtherRule: 0, invalid: 0, breakerUsd: 0.0123 },
    evolve: { evolved: 1, paused: 0, minted: 1, retired: 2 },
    drift: { reopened: 2 },
    spend: { kaneCredits: 812.25, agentUsd: null, agentMin: 12.5, kaneRunMin: 48 },
  };
  const DOC = [
    "<!-- headline:start -->old<!-- headline:end -->",
    "",
    "| Exam | <!-- exam-status:start -->old<!-- exam-status:end --> |",
    "| Demo | <!-- demo-status:start -->old<!-- demo-status:end --> |",
    "",
    "<!-- links:start -->old<!-- links:end -->",
    "",
    "<!-- demo:start -->",
    "old",
    "<!-- demo:end -->",
    "",
    "Again: <!-- links:start --><!-- links:end -->",
    "",
  ].join("\n");

  it("renders every part as pending without inputs, inline parts staying inline", () => {
    const out = fillMarkers(DOC, readInputs(path.join(tmp, "none.json"), path.join(tmp, "none-demo.json")));
    expect(out).toContain("<!-- headline:start -->Exam pending: Holdback's build and Claude Code alone have not been scored yet");
    expect(out).toContain("| Exam | <!-- exam-status:start -->NOT-CLAIMED (pending)<!-- exam-status:end --> |");
    expect(out).toContain("| Demo | <!-- demo-status:start -->NOT-CLAIMED (pending)<!-- demo-status:end --> |");
    expect(out).toContain("<!-- links:start -->Landing page: pending · Demo video: pending · Dashboard replay: pending<!-- links:end -->");
    expect(out).toContain("Again: <!-- links:start -->Landing page: pending");
    expect(out).toContain("<!-- demo:start -->\nDemo run pending: nothing from it is claimed yet.\n<!-- demo:end -->");
    expect(out).not.toMatch(/>old<|\nold\n/);
  });

  it("fills the exam sentence only once both compared arms are scored, B when it is, and says a tie is one", () => {
    expect(renderExam({ C: SUMMARY.C })).toMatch(/^Exam pending/);
    expect(renderExam(SUMMARY)).toBe("On a held-out 22-case exam, Holdback's build passed 21/22; Claude Code alone passed 17/22.");
    expect(renderExam({ ...SUMMARY, B: { ...SUMMARY.A, examPassed: 18 } })).toBe(
      "On a held-out 22-case exam, Holdback's build passed 21/22; Claude Code alone passed 17/22, and with its own Kane checks 18/22.",
    );
    const tie = { A: { ...SUMMARY.A, examPassed: 22 }, B: { ...SUMMARY.A, examPassed: 22 }, C: { ...SUMMARY.C, examPassed: 22 } };
    expect(renderExam(tie)).toBe(
      "On the held-out 22-case exam the builds tied: Holdback's build, Claude Code alone and Claude Code with its own Kane checks each passed 22/22.",
    );
    expect(renderExamStatus(SUMMARY)).toBe("VERIFIED-LIVE");
    expect(renderExamStatus({ A: SUMMARY.A })).toBe("NOT-CLAIMED (pending)");
  });

  it("leads the headline with what the planted bugs found once the demo run is recorded, the exam after it", () => {
    const demo = checkDemo(DEMO);
    expect(renderFalsified(emptyDemo())).toBeNull();
    expect(renderFalsified(demo)).toBe(
      "Holdback planted a bug against each of the 6 criteria Kane's tests passed on a real app. Kane's replays could judge 6 of them and caught 5, each on two replays; none of the 1 that got past them broke the criterion it was planted against (1 changed no behaviour, 0 broke a different rule).",
    );
    expect(renderHeadline(SUMMARY, demo)).toBe(`${renderFalsified(demo)} ${renderExam(SUMMARY)}`);
    expect(renderHeadline({}, demo)).toBe(renderFalsified(demo));
    expect(renderHeadline(SUMMARY, emptyDemo())).toBe(renderExam(SUMMARY));
    // without the split of the survivors, it only counts them
    const plain = checkDemo({ ...DEMO, falsify: { ...DEMO.falsify, survivedNoChange: null } });
    expect(renderFalsified(plain)?.endsWith("caught 5, each on two replays; 1 got past them.")).toBe(true);
  });

  it("fills links, the demo table and its tag from the demo record", () => {
    const demo = path.join(tmp, "demo-run.json");
    writeFileSync(demo, JSON.stringify(DEMO));
    const out = fillMarkers(DOC, readInputs(summary, demo));
    expect(out).toContain("[Landing page](https://example.test/) · Demo video: pending · [Dashboard replay](https://example.test/replay/)");
    expect(out).toContain("| Demo | <!-- demo-status:start -->VERIFIED-LIVE<!-- demo-status:end --> |");
    expect(out).toContain("| Recorded demo run ([ledger](examples/recorded-run/ledger.jsonl)) | |");
    expect(out).toContain("| Planted bugs Kane caught | 5 of 6 |");
    expect(out).toContain("| Planted bugs that got past their criterion's tests | 1 (1 changed no behaviour, 0 broke a different rule) |");
    expect(out).toContain("| Criteria green when the build stopped | 12 of 14 |");
    expect(out).toContain("| Gate at the end | open |");
    expect(out).toContain("| Kane credits, by balance | 812.3 |");
    expect(out).toContain("| Kane test-run minutes | 48.0 |");
    expect(out).toContain("| Breaker cost | $0.0123 |");
    // a figure not recorded leaves its row out
    expect(out).not.toContain("| Agent cost |");
  });

  it("keeps the demo pending while its ledger is not in the repo, whatever else is filled", () => {
    const d = checkDemo({ ...DEMO, recorded: { ledger: null } });
    expect(renderDemo(d)).toBe("Demo run pending: nothing from it is claimed yet.");
    expect(renderDemoStatus(d)).toBe("NOT-CLAIMED (pending)");
  });

  it("refuses demo figures of the wrong form and unknown keys", () => {
    expect(() => checkDemo({ ...DEMO, spec: { ...DEMO.spec, criteria: "about 14" } })).toThrow(/spec\.criteria/);
    expect(() => checkDemo({ ...DEMO, spec: { ...DEMO.spec, criteria: 14.5 } })).toThrow(/spec\.criteria/);
    expect(() => checkDemo({ ...DEMO, falsify: { ...DEMO.falsify, breakerUsd: -1 } })).toThrow(/breakerUsd/);
    expect(() => checkDemo({ ...DEMO, links: { ...DEMO.links, video: "http://example.test/" } })).toThrow(/links\.video/);
    expect(() => checkDemo({ ...DEMO, recorded: { ledger: "../outside.jsonl" } })).toThrow(/recorded\.ledger/);
    expect(() => checkDemo({ ...DEMO, recorded: { ledger: "C:/run/ledger.jsonl" } })).toThrow(/recorded\.ledger/);
    expect(() => checkDemo({ ...DEMO, spec: { ...DEMO.spec, critera: 3 } })).toThrow(/unknown figure "spec\.critera"/);
    expect(() => checkDemo({ ...DEMO, extra: {} })).toThrow(/unknown section "extra"/);
  });

  it("refuses a start marker without its end", () => {
    expect(() => fillMarkers("<!-- links:start --> no end", readInputs(summary))).toThrow(/links:end/);
  });

  it("is idempotent over a whole docs folder, and leaves a missing optional doc alone", () => {
    mkdirSync(path.join(tmp, "eval", "results"), { recursive: true });
    mkdirSync(path.join(tmp, "docs"));
    writeFileSync(path.join(tmp, "eval", "results", "summary.json"), JSON.stringify(SUMMARY));
    writeFileSync(path.join(tmp, "docs", "demo-run.json"), JSON.stringify(DEMO));
    writeFileSync(path.join(tmp, "JUDGES.md"), DOC);
    expect(renderDocs(tmp)).toEqual(["README.md", "JUDGES.md"]);
    const readmeOnce = readFileSync(readme, "utf8");
    const judgesOnce = readFileSync(path.join(tmp, "JUDGES.md"), "utf8");
    expect(judgesOnce).toContain("Holdback's build passed 21/22");
    expect(readmeOnce).toContain("| C: Holdback | 21/22 |");
    renderDocs(tmp);
    expect(readFileSync(readme, "utf8")).toBe(readmeOnce);
    expect(readFileSync(path.join(tmp, "JUDGES.md"), "utf8")).toBe(judgesOnce);
    expect(existsSync(path.join(tmp, "CLAIMS.md"))).toBe(false);
  });

  it("checks the committed demo record: every figure of its form, its ledger in the repo", () => {
    const root = path.join(import.meta.dirname, "..");
    const committed = checkDemo(JSON.parse(readFileSync(path.join(root, "docs", "demo-run.json"), "utf8")));
    expect(committed.recorded.ledger).not.toBeNull();
    expect(existsSync(path.join(root, committed.recorded.ledger!))).toBe(true);
    const f = committed.falsify;
    expect(f.caught! + f.survived! + f.invalid!).toBe(f.planted);
    expect(f.survivedNoChange! + f.survivedOtherRule!).toBe(f.survived);
  });
});
