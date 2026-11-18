import { readFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { describe, expect, it } from "vitest";
import { changedLines, codeForReferee, patchInMemory, quotedIn, REFEREE_CODE_TOKENS } from "../src/breaker/context.js";

const here = dirname(fileURLToPath(import.meta.url));
const EVAL = join(here, "..", "..", "..", "eval", "referee");
/** The pantry app's src/server.js at aad35d5, the commit every pantry case was planted on. */
const PANTRY = readFileSync(join(EVAL, "code", "pantry-aad35d5", "src", "server.js"), "utf8");
type Case = { id: string; patch: string; code?: string };
const CASES: Case[] = JSON.parse(readFileSync(join(EVAL, "cases.json"), "utf8")).cases;
const patchOf = (id: string) => CASES.find((c) => c.id === id)!.patch;
const pantry = [{ path: "src/server.js", content: PANTRY }];

describe("patchInMemory", () => {
  it("applies every pantry case's patch to the app at aad35d5, finding each hunk by its lines, not its line numbers", () => {
    const pantryCases = CASES.filter((c) => c.code === "pantry-aad35d5");
    expect(pantryCases.length).toBeGreaterThanOrEqual(12);
    for (const c of pantryCases) {
      const out = patchInMemory(pantry, c.patch);
      expect(out, c.id).toHaveLength(1);
      expect(out![0]!.before).toBe(PANTRY);
      // m-ac-53-1 replaces a line with the same line
      if (c.id === "m-ac-53-1") expect(out![0]!.after).toBe(PANTRY);
      else expect(out![0]!.after, c.id).not.toBe(PANTRY);
      for (const l of c.patch.split("\n").filter((x) => x.startsWith("+") && !x.startsWith("+++"))) expect(out![0]!.after, c.id).toContain(l.slice(1));
    }
    // m-ac-19-1's hunk says line 278; the line is 262 in this build
    const m19 = patchInMemory(pantry, patchOf("m-ac-19-1"))![0]!;
    expect(m19.after.split("\n")[261]).toBe("    if (booked.proxy === undefined) lines.push(`Proxy: ${booked.proxy}`);");
    expect(m19.after.split("\n")).toHaveLength(PANTRY.split("\n").length);
  });

  it("is undefined when a hunk's lines are not in the file, or the file is not given", () => {
    const moved = patchOf("m-ac-19-1").replace(" if (booked) {", " if (booked && ok) {");
    expect(patchInMemory(pantry, moved)).toBeUndefined();
    expect(patchInMemory([], patchOf("m-ac-19-1"))).toBeUndefined();
    expect(patchInMemory(pantry, "not a diff")).toBeUndefined();
  });

  it("applies a hunk whose lines differ from the file's only in whitespace, as git apply --ignore-whitespace does, keeping the file's own context lines", () => {
    const src = "a();\nif (x) {\n    y();\n}\n";
    const patch = ["--- a/f.js", "+++ b/f.js", "@@ -2,3 +2,3 @@", " if (x)  {", "-  y();", "+  z();", " }", ""].join("\n");
    expect(patchInMemory([{ path: "f.js", content: src }], patch)).toEqual([{ path: "f.js", before: src, after: "a();\nif (x) {\n  z();\n}\n" }]);
  });
});

describe("changedLines", () => {
  it("names the lines a patch removes and adds, and the line next to a change that only adds or only removes", () => {
    const before = ["a", "b", "c", "d", "e"].join("\n");
    expect(changedLines(before, ["a", "B", "c", "d", "e"].join("\n"))).toEqual({ before: [1], after: [1] });
    expect(changedLines(before, ["a", "b", "x", "c", "d", "e"].join("\n"))).toEqual({ before: [1], after: [2] });
    expect(changedLines(before, ["a", "c", "d", "e"].join("\n"))).toEqual({ before: [1], after: [0] });
    expect(changedLines(before, ["A", "b", "c", "d", "E"].join("\n"))).toEqual({ before: [0, 4], after: [0, 4] });
  });
});

describe("codeForReferee", () => {
  const m19 = () => patchInMemory(pantry, patchOf("m-ac-19-1"))!;

  it("shows the whole file before and after the change while both fit in about 12k tokens; the quote is checked against the code after", () => {
    const code = m19();
    expect((code[0]!.before.length + code[0]!.after.length) / 4).toBeLessThan(REFEREE_CODE_TOKENS);
    const shown = codeForReferee(code, patchOf("m-ac-19-1"));
    expect(shown.whole).toBe(true);
    expect(shown.text).toContain(PANTRY);
    expect(shown.text).toContain(code[0]!.after);
    expect(shown.text.indexOf("before the change")).toBeLessThan(shown.text.indexOf("after the change"));
    expect(shown.after).toBe(code[0]!.after);
  });

  it("over the cap, shows the code around each change and the definitions the changed lines use (the schema's default among them), not the rest", () => {
    const code = m19();
    const shown = codeForReferee(code, patchOf("m-ac-19-1"), 2_500);
    expect(shown.whole).toBe(false);
    expect(shown.text.length / 4).toBeLessThanOrEqual(2_500 + 200);
    for (const side of [shown.text.split("after the change")[0]!, shown.text.split("after the change")[1]!]) {
      // the enclosing function, whole
      expect(side).toContain("function bookingPage(checkId, form = {}, errors = [], booked = null) {");
      expect(side).toContain('<input type="text" id="proxy" name="proxy" value="${esc(form.proxy)}">');
      // what `proxy` is: the column and its default, the row the confirmation reads, the form field
      expect(side).toContain("proxy TEXT NOT NULL DEFAULT '',");
      expect(side).toContain("{ date: v.visit_date, time: v.visit_time, proxy: v.proxy }");
      expect(side).toContain("const proxy = form.proxy.trim();");
      // not the eligibility rules or the volunteer list
      expect(side).not.toContain("function evaluate(form)");
      expect(side).not.toContain("function volunteerPage()");
    }
    expect(shown.text).toMatch(/\[lines \d+-\d+\]/);
    expect(shown.after).toContain("if (booked.proxy === undefined) lines.push(`Proxy: ${booked.proxy}`);");
    expect(shown.after).toContain("proxy TEXT NOT NULL DEFAULT '',");
    expect(shown.after).not.toContain("function evaluate(form)");
  });

  it("reads statements by indentation where brackets do not mark them (Python): the function around the change and the constant it uses", () => {
    const filler = Array.from({ length: 200 }, (_, i) => `def f${i}():\n    return ${i}\n`);
    const before = ["LIMIT = 10", "", "def check(n):", "    if n > LIMIT:", "        return 'no'", "    return 'yes'", "", "def other():", "    return LIMIT", "", ...filler].join("\n");
    const after = before.replace("    if n > LIMIT:", "    if n >= LIMIT:");
    const shown = codeForReferee([{ path: "app.py", before, after }], "", 100);
    expect(shown.whole).toBe(false);
    expect(shown.after).toContain("LIMIT = 10");
    expect(shown.after).toContain("def check(n):\n    if n >= LIMIT:\n        return 'no'\n    return 'yes'");
    expect(shown.after).not.toContain("def other():");
    expect(shown.text).toContain("[lines 3-6]");
  });

  it("without the file (the code moved since the bug was planted), says so and checks the quote against the patch's own lines after the change", () => {
    const patch = patchOf("m-ac-19-1");
    const shown = codeForReferee([], patch);
    expect(shown.whole).toBe(false);
    expect(shown.text).toMatch(/not available/);
    expect(shown.after).toContain("if (booked.proxy === undefined) lines.push(`Proxy: ${booked.proxy}`);");
    expect(shown.after).toContain("const lines = ['Visit booked.', `Your visit: ${fmtDate(booked.date)} at ${booked.time}.`];");
    expect(shown.after).not.toContain("if (booked.proxy) lines.push");
  });
});

describe("quotedIn", () => {
  const after = "function f(a) {\n  if (a.proxy === undefined)   lines.push(`Proxy: ${a.proxy}`);\n  return lines;\n}\n";

  it("finds a line of the code as quoted, whitespace runs aside, a pair of backticks or quotes around it, or a diff's + in front", () => {
    expect(quotedIn("if (a.proxy === undefined) lines.push(`Proxy: ${a.proxy}`);", after)).toBe(true);
    expect(quotedIn("  if (a.proxy === undefined)\tlines.push(`Proxy: ${a.proxy}`);  ", after)).toBe(true);
    expect(quotedIn("`if (a.proxy === undefined) lines.push(`Proxy: ${a.proxy}`);`", after)).toBe(true);
    expect(quotedIn("+  if (a.proxy === undefined) lines.push(`Proxy: ${a.proxy}`);", after)).toBe(true);
  });

  it("refuses a line that is not in it, a paraphrase, an empty quote or one too short to show anything", () => {
    expect(quotedIn("lines.push('Proxy: undefined');", after)).toBe(false);
    expect(quotedIn("if (a.proxy == undefined) lines.push(`Proxy: ${a.proxy}`);", after)).toBe(false);
    expect(quotedIn("", after)).toBe(false);
    expect(quotedIn("}", after)).toBe(false);
    expect(quotedIn("return", after)).toBe(false);
  });
});
