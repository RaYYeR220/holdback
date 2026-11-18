import { readFileSync } from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { describe, expect, it } from "vitest";
import { codeOf, summarize, type Case } from "./run.ts";

const HERE = path.dirname(fileURLToPath(import.meta.url));
const CASES: Case[] = JSON.parse(readFileSync(path.join(HERE, "cases.json"), "utf8")).cases;

describe("the referee's labelled cases", () => {
  it("each pantry patch applies to the app it was planted in, kept under code/; the rehearsal's app is not kept", async () => {
    for (const c of CASES) {
      const code = await codeOf(c);
      if (c.id === "m-ac-4-1") expect(code).toEqual([]);
      else {
        expect(c.code, c.id).toBe("pantry-aad35d5");
        expect(code.map((f) => f.path), c.id).toEqual(["src/server.js"]);
      }
    }
  });

  it("m-ac-19-1, which the GLM referee confirmed live, is labelled no violation of ac-19: the proxy column's default is '', never undefined", async () => {
    const c = CASES.find((x) => x.id === "m-ac-19-1")!;
    expect(c).toMatchObject({ label: false, truth: "off-target", ac: { id: "ac-19" }, live: { model: "z-ai-glm-5-3-flash", confirmed: true } });
    const [f] = await codeOf(c);
    expect(f!.after).toContain("proxy TEXT NOT NULL DEFAULT '',");
    expect(f!.after).toContain("const proxy = form.proxy.trim();");
    expect(f!.after).toContain("{ date: v.visit_date, time: v.visit_time, proxy: v.proxy }");
    expect(f!.after).toContain("if (booked.proxy === undefined) lines.push(`Proxy: ${booked.proxy}`);");
    expect(CASES.filter((x) => x.label)).toHaveLength(5);
    expect(CASES).toHaveLength(13);
  });

  it("a call with no usable answer counts as not confirmed, as in falsify", () => {
    const s = summarize("m", [
      { case: "a", rep: 1, label: true, confirmed: true, usd: 0.001 },
      { case: "b", rep: 1, label: false, confirmed: true, usd: 0.001 },
      { case: "c", rep: 1, label: true, confirmed: null, error: "x", usd: 0.002 },
      { case: "d", rep: 1, label: false, confirmed: false, usd: 0.001 },
    ]);
    expect(s).toEqual({ model: "m", n: 4, right: 2, falseConfirms: 1, falseRejects: 1, errors: 1, usd: expect.closeTo(0.005, 12) });
  });
});
