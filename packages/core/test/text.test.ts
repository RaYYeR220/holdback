import { PassThrough } from "node:stream";
import { describe, expect, it } from "vitest";
import { CliHumanIO } from "../src/loop/human.js";
import { escapeControls } from "../src/text.js";

describe("escapeControls (R38, addendum 3)", () => {
  it("shows C0/C1 controls as \\xNN and Unicode format characters as \\uXXXX, keeping tabs and newlines", () => {
    expect(escapeControls("a\tb\nc\u0000\u001b[31m\u009b")).toBe("a\tb\nc\\x00\\x1b[31m\\x9b");
    const bidi = "؜‎‏‪‫‬‭‮⁦⁧⁨⁩";
    expect(escapeControls(`x${bidi}y`)).toBe("x\\u061C\\u200E\\u200F\\u202A\\u202B\\u202C\\u202D\\u202E\\u2066\\u2067\\u2068\\u2069y");
    expect(escapeControls("zero​‌‍width﻿")).toBe("zero\\u200B\\u200C\\u200Dwidth\\uFEFF");
    expect(escapeControls("Eligible. “quoted” — ok, ü")).toBe("Eligible. “quoted” — ok, ü");
  });

  it("the terminal human IO escapes Kane's questions and the items it asks to approve", async () => {
    const input = new PassThrough();
    const output = new PassThrough();
    let shown = "";
    output.on("data", (c) => (shown += String(c)));
    const io = new CliHumanIO(input, output);
    input.write("\n\n");
    await io.answer([{ id: "q1", text: "Limit‮?", risk: "low", rationale: "\u001b[2J", options: [{ label: "Yes​" }], recommendedIndex: 0, allowFreeText: false }]);
    await io.approve([{ ref: "ac-1", kind: "ac", title: "Eligible\u001b]0;owned\u0007" }]);
    io.close();
    expect(shown).toContain("Limit\\u202E?");
    expect(shown).toContain("\\x1b[2J");
    expect(shown).toContain("Yes\\u200B");
    expect(shown).toContain("Eligible\\x1b]0;owned\\x07");
    expect(/[\u0000-\u0008\u000b-\u001f\u007f-\u009f]|\p{Cf}/u.test(shown)).toBe(false);
  });
});
