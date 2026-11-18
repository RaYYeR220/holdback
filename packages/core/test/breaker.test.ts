import { mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { acKeywords, BreakerError, BreakerUnavailable, BudgetRefused, checkPatch, noOpReason, pickFiles, proposeMutant, PATCH_SCHEMA } from "../src/breaker/mutate.js";
import { Budget, estimateUsd, PRICES, REASONING_EFFORT, veniceChat, VeniceHttpError, VeniceOutputError, VeniceUnreachable, type VeniceChatOptions } from "../src/breaker/venice.js";
import type { AcState } from "../src/ledger/types.js";

/** Venice replies recorded live (the pilot) or from the rehearsal ledger. */
const VENICE_FX = join(dirname(fileURLToPath(import.meta.url)), "fixtures", "venice");

const AC3: AcState = {
  id: "ac-3",
  text: "For a one-person household without SNAP, monthly income of $2,462 is above the $2,461 limit and the result is “Not eligible.”",
  useCase: "uc-1",
  cites: [{ source: "prd", anchor: "L10-L10", quote: "A household is eligible when its monthly income is at or below the monthly limit for its size." }],
  tests: ["t-3"],
  status: "passing",
};

describe("Budget", () => {
  it("charges (in*pt + out*ct)/1e6 at the model's price and refuses past the cap", () => {
    expect(PRICES["deepseek-v4-flash"]).toEqual({ in: 0.138, out: 0.275 });
    expect(PRICES["qwen-3-8-flash"]).toEqual({ in: 0.14, out: 0.49 });
    const b = new Budget(2, 1.5);
    const usd = b.charge("deepseek-v4-flash", { prompt_tokens: 1_000_000, completion_tokens: 1_000_000 });
    expect(usd).toBeCloseTo(0.138 + 0.275, 12);
    expect(b.spent).toBeCloseTo(1.5 + 0.413, 12);
    expect(b.canSpend(0.087)).toBe(true); // exactly at the cap is allowed
    expect(b.canSpend(0.0871)).toBe(false);
    expect(new Budget(2, 2).canSpend(0)).toBe(true);
    expect(new Budget(2, 2).canSpend(1e-9)).toBe(false);
    expect(new Budget(1, 0).charge("qwen-3-8-flash", { prompt_tokens: 1000, completion_tokens: 500 })).toBeCloseTo((0.14 * 1000 + 0.49 * 500) / 1e6, 15);
  });

  it("never counts an unpriced model as free, and rejects a nonsense cap", () => {
    expect(() => new Budget(2, 0).charge("gpt-x", { prompt_tokens: 1, completion_tokens: 1 })).toThrow(/no price/);
    expect(() => estimateUsd("gpt-x", [{ role: "user", content: "hi" }])).toThrow(/no price/);
    expect(() => new Budget(Number.NaN, 0)).toThrow(/capUsd/);
    expect(() => new Budget(2, -1)).toThrow(/spend/);
  });

  it("estimates a call as prompt chars/4 at the input price plus 2048 tokens at the output price", () => {
    const messages = [
      { role: "system", content: "x".repeat(4000) },
      { role: "user", content: "y".repeat(4000) },
    ];
    expect(estimateUsd("deepseek-v4-flash", messages)).toBeCloseTo((2000 * 0.138 + 2048 * 0.275) / 1e6, 15);
  });
});

describe("veniceChat", () => {
  const opts: VeniceChatOptions = {
    model: "deepseek-v4-flash",
    messages: [{ role: "user", content: "Say hi as JSON." }],
    schema: PATCH_SCHEMA,
    apiKey: "sk-test-123",
  };
  const reply = (content: unknown, usage: unknown = { prompt_tokens: 12, completion_tokens: 7 }, status = 200) =>
    new Response(JSON.stringify({ choices: [{ message: { role: "assistant", content } }], usage }), { status });
  afterEach(() => vi.unstubAllGlobals());

  it("posts a strict json_schema request capped at 2048 tokens and returns the parsed reply and usage", async () => {
    const fetchMock = vi.fn(async (_url: string | URL | Request, _init?: RequestInit) => reply('{"patch":"p","rationale":"r"}'));
    vi.stubGlobal("fetch", fetchMock);
    const r = await veniceChat(opts);
    expect(r).toEqual({ json: { patch: "p", rationale: "r" }, usage: { prompt_tokens: 12, completion_tokens: 7 } });
    const [url, init] = fetchMock.mock.calls[0]!;
    expect(url).toBe("https://api.venice.ai/api/v1/chat/completions");
    expect(init!.method).toBe("POST");
    expect((init!.headers as Record<string, string>).Authorization).toBe("Bearer sk-test-123");
    const body = JSON.parse(String(init!.body));
    expect(body).toMatchObject({
      model: "deepseek-v4-flash",
      messages: opts.messages,
      max_tokens: 2048,
      response_format: { type: "json_schema", json_schema: { name: "patch", schema: PATCH_SCHEMA, strict: true } },
    });
  });

  it("turns deepseek-v4-flash's reasoning off and sends the call's own token cap; a model with no reasoning setting gets none", async () => {
    const bodies: Record<string, unknown>[] = [];
    vi.stubGlobal("fetch", async (_u: string | URL | Request, init?: RequestInit) => {
      bodies.push(JSON.parse(String(init!.body)) as Record<string, unknown>);
      return new Response(readFileSync(join(VENICE_FX, "pilot-reasoning-none.json"), "utf8"));
    });
    // the recorded pilot: reasoning off, a plain JSON reply, 39 completion tokens
    expect(await veniceChat(opts)).toEqual({ json: { answer: "395", why: expect.stringContaining("391") }, usage: { prompt_tokens: 128, completion_tokens: 39 } });
    await veniceChat({ ...opts, maxTokens: 4096 });
    await veniceChat({ ...opts, model: "qwen-3-8-flash" });
    expect(bodies.map((b) => [b.reasoning_effort, b.max_tokens])).toEqual([
      ["none", 2048],
      ["none", 4096],
      [undefined, 2048],
    ]);
    expect(REASONING_EFFORT).toEqual({ "deepseek-v4-flash": "none" });
  });

  it("marks a reply the token limit cut off, empty or truncated, as cut off, with its usage (recorded rehearsal replies)", async () => {
    for (const [fx, msg] of [
      ["rehearsal-cut-off.json", /no message content \(cut off at the 2048-token limit\)/],
      ["rehearsal-truncated-json.json", /not JSON \(cut off at the 2048-token limit\): \{/],
    ] as const) {
      vi.stubGlobal("fetch", async () => new Response(readFileSync(join(VENICE_FX, fx), "utf8")));
      const e = await veniceChat(opts).catch((x: unknown) => x);
      expect(e).toBeInstanceOf(VeniceOutputError);
      expect((e as VeniceOutputError).message).toMatch(msg);
      expect((e as VeniceOutputError).cutOff).toBe(true);
      expect((e as VeniceOutputError).usage.completion_tokens).toBe(2048);
    }
    // a reply that ended on its own but is not JSON: asking again with feedback may help, so it is not cut off
    vi.stubGlobal("fetch", async () => new Response(JSON.stringify({ choices: [{ message: { content: "Sure! Here is a patch." }, finish_reason: "stop" }], usage: { prompt_tokens: 1, completion_tokens: 6 } })));
    const e = await veniceChat(opts).catch((x: unknown) => x);
    expect((e as VeniceOutputError).cutOff).toBe(false);
  });

  it("reads JSON wrapped in a think block or a code fence", async () => {
    vi.stubGlobal("fetch", async () => reply('<think>hmm</think>\n```json\n{"patch":"x","rationale":"y"}\n```'));
    expect((await veniceChat(opts)).json).toEqual({ patch: "x", rationale: "y" });
  });

  it("charges a reply without usage as the worst case", async () => {
    vi.stubGlobal("fetch", async () => reply('{"patch":"x","rationale":"y"}', null));
    expect((await veniceChat(opts)).usage).toEqual({ prompt_tokens: Math.ceil("Say hi as JSON.".length / 4), completion_tokens: 2048 });
  });

  it("throws VeniceOutputError with the usage when a billed reply is not JSON", async () => {
    vi.stubGlobal("fetch", async () => reply("Sure! Here is a patch."));
    const e = await veniceChat(opts).catch((x: unknown) => x);
    expect(e).toBeInstanceOf(VeniceOutputError);
    expect((e as VeniceOutputError).usage).toEqual({ prompt_tokens: 12, completion_tokens: 7 });
  });

  it("throws on an HTTP error without echoing the key, and refuses without a key", async () => {
    vi.stubGlobal("fetch", async () => new Response('{"error":"Invalid API key"}', { status: 401, statusText: "Unauthorized" }));
    const e = (await veniceChat(opts).catch((x: unknown) => x)) as Error;
    expect(e).toBeInstanceOf(VeniceHttpError);
    expect((e as VeniceHttpError).status).toBe(401);
    expect(e.message).toMatch(/Venice 401/);
    expect(e.message).not.toContain("sk-test-123");
    const fetchMock = vi.fn();
    vi.stubGlobal("fetch", fetchMock);
    await expect(veniceChat({ ...opts, apiKey: "" })).rejects.toThrow(/VENICE_API_KEY/);
    expect(fetchMock).not.toHaveBeenCalled();
  });
});

describe("veniceChat outages", () => {
  const opts: VeniceChatOptions = { model: "deepseek-v4-flash", messages: [{ role: "user", content: "x".repeat(400) }], schema: PATCH_SCHEMA, apiKey: "k" };
  afterEach(() => vi.unstubAllGlobals());

  it("reports a request that got no answer (network failure or timeout) as VeniceUnreachable", async () => {
    vi.stubGlobal("fetch", async () => {
      throw new DOMException("The operation was aborted due to timeout", "TimeoutError");
    });
    const e = await veniceChat(opts).catch((x: unknown) => x);
    expect(e).toBeInstanceOf(VeniceUnreachable);
    expect((e as Error).message).toMatch(/timeout/);
  });

  it("charges a 200 whose body is not JSON as the worst case", async () => {
    vi.stubGlobal("fetch", async () => new Response("<html>gateway</html>", { status: 200 }));
    const e = await veniceChat(opts).catch((x: unknown) => x);
    expect(e).toBeInstanceOf(VeniceOutputError);
    expect((e as VeniceOutputError).usage).toEqual({ prompt_tokens: 100, completion_tokens: 2048 });
  });
});

describe("pickFiles", () => {
  let dir: string;
  beforeEach(() => {
    dir = mkdtempSync(join(tmpdir(), "hb-pick-"));
  });
  afterEach(() => rmSync(dir, { recursive: true, force: true }));
  const put = (rel: string, content: string | Buffer) => {
    mkdirSync(join(dir, rel, ".."), { recursive: true });
    writeFileSync(join(dir, rel), content);
  };

  it("takes numbers and quoted labels from the AC text as keywords", () => {
    expect(acKeywords(AC3.text).sort()).toEqual(["2461", "2462", "Not eligible"]);
    expect(acKeywords('Clicking "Book visit" for 3 people shows ‘Booked’ and $1,234.50.').sort()).toEqual(["1234.50", "Book visit", "Booked"]);
  });

  it("ranks a file containing 2461 and Not eligible first, then recently changed files, and skips noise", async () => {
    put("src/eligibility.js", "export const LIMITS = [0,2461,3301]; // not 12,461 or 2,461,000\nexport const verdict = (ok) => (ok ? 'Eligible.' : 'Not eligible.');\n");
    put("src/view.js", "export const label = 'Not eligible';\n");
    put("src/routes.js", "export const routes = [];\n");
    put("src/util.js", "export const id = (x) => x;\n");
    put("node_modules/lib/index.js", "2461 Not eligible 2462");
    put("package-lock.json", '{"x":"2461 Not eligible 2462"}');
    put("PRD.md", "2461 Not eligible 2462");
    put("notes.txt", "2461 Not eligible 2462");
    put(".env", "SECRET=2461 Not eligible 2462");
    put(".cache/x.js", "2461 Not eligible 2462");
    put("src/big.js", "// 2461 Not eligible 2462\n" + "x".repeat(41 * 1024));
    put("public/logo.png", Buffer.from([0x89, 0x50, 0x4e, 0x47, 0, 0, 0, 0x32, 0x34, 0x36, 0x31]));
    put("src/limits.json", '{"1": 2,461}'); // the comma-grouped form counts too
    const files = await pickFiles(dir, AC3, ["src/util.js", "src/routes.js"]);
    expect(files.map((f) => f.path)).toEqual(["src/eligibility.js", "src/limits.json", "src/view.js"]);
    expect(files[0]!.content).toContain("2461");

    // keyword ties break on how recently a file changed; zero-score files only when recently changed
    const tie = await pickFiles(dir, { ...AC3, text: "the result is “Not eligible.”" }, ["src/view.js", "src/util.js"]);
    expect(tie.map((f) => f.path)).toEqual(["src/view.js", "src/eligibility.js", "src/util.js"]);

    // a number inside a longer one does not count
    const limitOnly = await pickFiles(dir, { ...AC3, text: "the limit is $2,461" }, []);
    expect(limitOnly.map((f) => f.path)).toEqual(["src/eligibility.js", "src/limits.json"]);
  });

  it("leaves out excluded files and normalises line endings", async () => {
    put("server.js", "if (income > 2461) {\r\n  return 'Not eligible.';\r\n}\r\n");
    put("holdback.config.json", '{"note":"2461 Not eligible"}');
    const files = await pickFiles(dir, AC3, [], { exclude: ["holdback.config.json"] });
    expect(files).toEqual([{ path: "server.js", content: "if (income > 2461) {\n  return 'Not eligible.';\n}\n" }]);
  });
});

describe("checkPatch", () => {
  const ok = ["--- a/src/a.js", "+++ b/src/a.js", "@@ -1,2 +1,2 @@", " const x = 1;", "-const y = 2;", "+const y = 3;", ""].join("\n");

  it("accepts a small edit of a shown file and reports the strip level", () => {
    expect(checkPatch(ok, ["src/a.js"])).toEqual({ strip: 1, changed: 2 });
    const p0 = ok.replace("--- a/", "--- ").replace("+++ b/", "+++ ");
    expect(checkPatch(p0, ["src/a.js"])).toEqual({ strip: 0, changed: 2 });
    // a removed SQL comment ("-- x") is a changed line, not a header
    const sql = ["--- a/src/a.js", "+++ b/src/a.js", "@@ -1,2 +1,1 @@", " x", "--- old comment", ""].join("\n");
    expect(checkPatch(sql, ["src/a.js"])).toEqual({ strip: 1, changed: 1 });
  });

  it("refuses more than 30 changed lines, unknown files, new or deleted files, and non-diffs", () => {
    const big = ["--- a/src/a.js", "+++ b/src/a.js", "@@ -1,16 +1,16 @@", ...Array.from({ length: 16 }, (_, i) => `-l${i}`), ...Array.from({ length: 16 }, (_, i) => `+m${i}`), ""].join("\n");
    expect(checkPatch(big, ["src/a.js"])).toEqual({ error: "the patch changes 32 lines; the limit is 30" });
    expect(checkPatch(ok, ["src/b.js"])).toEqual({ error: "the patch touches files that were not shown: src/a.js" });
    expect(checkPatch(ok.replace("--- a/src/a.js", "--- /dev/null"), ["src/a.js"])).toEqual({ error: "the patch creates or deletes a file" });
    expect(checkPatch("just change the limit to 2462", ["src/a.js"])).toEqual({ error: "not a unified diff: no ---/+++ headers with @@ hunks" });
    expect(checkPatch(ok.replace("-const y = 2;\n+const y = 3;\n", ""), ["src/a.js"])).toEqual({ error: "the patch changes nothing" });
  });
});

const SLIP = {
  behaviour: "A one-person household earning one dollar above the limit is told it is eligible.",
  inputs: "household size 1, monthly income $2,462, SNAP unchecked",
  expected: "Not eligible. with the limit $2,461",
  observed: "Eligible. with the limit $2,461",
};

describe("proposeMutant", () => {
  const files =[{ path: "src/eligibility.js", content: "export const LIMIT = 2461;\n" }];
  const patch = "--- a/src/eligibility.js\n+++ b/src/eligibility.js\n@@ -1 +1 @@\n-export const LIMIT = 2461;\n+export const LIMIT = 2462;\n";

  it("asks for the smallest patch that violates exactly this AC, charges the budget and returns the patch", async () => {
    const calls: VeniceChatOptions[] = [];
    const budget = new Budget(2, 0.5);
    const r = await proposeMutant(AC3, files, {
      model: "deepseek-v4-flash",
      apiKey: "k",
      budget,
      chat: async (o) => {
        calls.push(o);
        return { json: { patch: patch.replace(/\n/g, "\r\n").trimEnd(), rationale: "Moves the limit up by one dollar.", ...SLIP }, usage: { prompt_tokens: 1000, completion_tokens: 200 } };
      },
    });
    const usd = (1000 * 0.138 + 200 * 0.275) / 1e6;
    // the breaker says in a user's terms what slips through: Kane (never the builder) is told it if the bug survives (R40)
    expect(r).toEqual({ patch, usd, rationale: "Moves the limit up by one dollar.", slip: SLIP });
    expect(budget.spent).toBeCloseTo(0.5 + usd, 15);
    expect(calls).toHaveLength(1);
    const c = calls[0]!;
    expect(c.model).toBe("deepseek-v4-flash");
    expect(c.apiKey).toBe("k");
    expect(c.schema).toEqual({
      type: "object",
      properties: {
        patch: { type: "string" },
        rationale: { type: "string" },
        behaviour: { type: "string" },
        inputs: { type: "string" },
        expected: { type: "string" },
        observed: { type: "string" },
      },
      required: ["patch", "rationale", "behaviour", "inputs", "expected", "observed"],
      additionalProperties: false,
    });
    const all = c.messages.map((m) => m.content).join("\n");
    expect(all).toContain("violate exactly");
    expect(all).toContain("still starts");
    expect(all).toContain("30 changed lines");
    expect(all).toContain(`AC ac-3: ${AC3.text}`);
    expect(all).toContain(AC3.cites[0]!.quote);
    expect(all).toContain('<file path="src/eligibility.js">\nexport const LIMIT = 2461;\n</file>');
    expect(all).toContain("what a user would see go wrong");
  });

  it("returns no description when the breaker left any part of it out or blank: the patch still stands", async () => {
    const r = await proposeMutant(AC3, files, {
      model: "deepseek-v4-flash",
      apiKey: "k",
      budget: new Budget(2, 0),
      chat: async () => ({ json: { patch, rationale: "r", ...SLIP, behaviour: " " }, usage: { prompt_tokens: 1, completion_tokens: 1 } }),
    });
    expect(r.slip).toBeUndefined();
    expect(r.patch).toBe(patch);
  });

  it("puts the previous patch and its error into a retry", async () => {
    let seen = "";
    await proposeMutant(AC3, files, {
      model: "deepseek-v4-flash",
      apiKey: "k",
      budget: new Budget(2, 0),
      retry: { patch: "--- broken", error: "error: corrupt patch at line 3" },
      chat: async (o) => {
        seen = o.messages.map((m) => m.content).join("\n");
        return { json: { patch, rationale: "r" }, usage: { prompt_tokens: 1, completion_tokens: 1 } };
      },
    });
    expect(seen).toContain("error: corrupt patch at line 3");
    expect(seen).toContain("--- broken");
  });

  it("refuses without calling Venice when the estimate would pass the cap", async () => {
    const chat = vi.fn();
    const budget = new Budget(2, 1.9995);
    const e = await proposeMutant(AC3, files, { model: "deepseek-v4-flash", apiKey: "k", budget, chat }).catch((x: unknown) => x);
    expect(e).toBeInstanceOf(BudgetRefused);
    expect((e as Error).message).toMatch(/cap/);
    expect(chat).not.toHaveBeenCalled();
    expect(budget.spent).toBe(1.9995);
  });

  it("throws BreakerUnavailable on an outage: charged at the worst case when the request may have been billed, else free", async () => {
    const budget = new Budget(2, 0);
    const unreachable = await proposeMutant(AC3, files, {
      model: "deepseek-v4-flash",
      apiKey: "k",
      budget,
      chat: async () => {
        throw new VeniceUnreachable("Venice unreachable: fetch failed");
      },
    }).catch((x: unknown) => x);
    expect(unreachable).toBeInstanceOf(BreakerUnavailable);
    const worst = budget.spent;
    expect((unreachable as BreakerUnavailable).usd).toBe(worst);
    expect(worst).toBeGreaterThan((2048 * 0.275) / 1e6);
    const http = await proposeMutant(AC3, files, {
      model: "deepseek-v4-flash",
      apiKey: "k",
      budget,
      chat: async () => {
        throw new VeniceHttpError("Venice 429 Too Many Requests: slow down", 429);
      },
    }).catch((x: unknown) => x);
    expect(http).toBeInstanceOf(BreakerUnavailable);
    expect((http as BreakerUnavailable).usd).toBe(0);
    expect(budget.spent).toBe(worst);
  });

  it("charges a billed reply that carries no usable patch and throws BreakerError with its cost", async () => {
    const budget = new Budget(2, 0);
    const noPatch = await proposeMutant(AC3, files, {
      model: "deepseek-v4-flash",
      apiKey: "k",
      budget,
      chat: async () => ({ json: { rationale: "no" }, usage: { prompt_tokens: 100, completion_tokens: 10 } }),
    }).catch((x: unknown) => x);
    expect(noPatch).toBeInstanceOf(BreakerError);
    expect((noPatch as BreakerError).usd).toBeCloseTo((100 * 0.138 + 10 * 0.275) / 1e6, 15);
    const notJson = await proposeMutant(AC3, files, {
      model: "deepseek-v4-flash",
      apiKey: "k",
      budget,
      chat: async () => {
        throw new VeniceOutputError("Venice reply is not JSON", { prompt_tokens: 100, completion_tokens: 10 });
      },
    }).catch((x: unknown) => x);
    expect(notJson).toBeInstanceOf(BreakerError);
    expect((notJson as BreakerError).cutOff).toBe(false);
    expect(budget.spent).toBeCloseTo((2 * (100 * 0.138 + 10 * 0.275)) / 1e6, 15);
    const cut = await proposeMutant(AC3, files, {
      model: "deepseek-v4-flash",
      apiKey: "k",
      budget,
      chat: async () => {
        throw new VeniceOutputError("Venice reply has no message content (cut off at the 2048-token limit)", { prompt_tokens: 1198, completion_tokens: 2048 }, true);
      },
    }).catch((x: unknown) => x);
    expect((cut as BreakerError).cutOff).toBe(true);
    expect((cut as BreakerError).usd).toBeCloseTo((1198 * 0.138 + 2048 * 0.275) / 1e6, 15);
  });

  it("sends a larger token cap when asked, and holds the budget to it", async () => {
    let seen: number | undefined;
    const ok = async (o: VeniceChatOptions) => {
      seen = o.maxTokens;
      return { json: { patch, rationale: "r" }, usage: { prompt_tokens: 1, completion_tokens: 1 } };
    };
    await proposeMutant(AC3, files, { model: "deepseek-v4-flash", apiKey: "k", budget: new Budget(2, 0), chat: ok, maxTokens: 4096 });
    expect(seen).toBe(4096);
    // affordable at 2048 completion tokens, not at 4096: refused before any call
    let prompt: { role: string; content: string }[] = [];
    await proposeMutant(AC3, files, {
      model: "deepseek-v4-flash",
      apiKey: "k",
      budget: new Budget(2, 0),
      chat: async (o) => {
        prompt = o.messages;
        return ok(o);
      },
    });
    const tight = new Budget(estimateUsd("deepseek-v4-flash", prompt, 2048) * 1.01, 0);
    const chat = vi.fn(ok);
    await expect(proposeMutant(AC3, files, { model: "deepseek-v4-flash", apiKey: "k", budget: tight, chat, maxTokens: 4096 })).rejects.toBeInstanceOf(BudgetRefused);
    expect(chat).not.toHaveBeenCalled();
  });
});

/** The planted bugs the live demo counted as survivors, and the rehearsal's real one (sanitized: no paths). */
type LiveSurvivor = { mutant: string; ac: { id: string; text: string; useCase: string; cites: AcState["cites"] }; patch: string };
const LIVE: LiveSurvivor[] = JSON.parse(readFileSync(join(dirname(fileURLToPath(import.meta.url)), "fixtures", "breaker", "survivors.json"), "utf8"));
const live = (id: string) => LIVE.find((s) => s.mutant === id)!;

describe("noOpReason", () => {
  const src = (path: string, content: string) => ({ path, content });

  it("refuses the demo's m-ac-53-1, whose one changed line is the line it replaces, before any file is read", () => {
    expect(noOpReason(live("m-ac-53-1").patch, [], [])).toMatch(/^every line it changes is the same line/);
  });

  it("passes every other live survivor on: each changes code (whether it breaks its criterion is the referee's call)", () => {
    for (const id of ["m-ac-20-1", "m-ac-36-1", "m-ac-26-1", "m-ac-37-1", "m-ac-27-1", "m-ac-4-1"]) expect(noOpReason(live(id).patch, [], []), id).toBeUndefined();
  });

  it("normalises whitespace inside a changed line; an indentation-significant file keeps its leading whitespace", () => {
    const p = (file: string, a: string, b: string) => [`--- a/${file}`, `+++ b/${file}`, "@@ -1,1 +1,1 @@", `-${a}`, `+${b}`, ""].join("\n");
    expect(noOpReason(p("src/a.js", "  const x  =  1;", "const x = 1;   "), [], [])).toBeDefined();
    expect(noOpReason(p("src/a.html", "<p>Not  eligible.</p>", "<p>Not eligible.</p>"), [], [])).toBeDefined();
    // a blank line added or removed changes nothing
    expect(noOpReason(["--- a/src/a.js", "+++ b/src/a.js", "@@ -1,1 +1,2 @@", "-const x = 1;", "+", "+const x = 1;", ""].join("\n"), [], [])).toBeDefined();
    // whitespace inside a quoted string is the page's text: kept
    expect(noOpReason(p("src/a.js", "const t = 'Not  eligible.';", "const t = 'Not eligible.';"), [], [])).toBeUndefined();
    expect(noOpReason(p("app.py", "    return 1", "return 1"), [], [])).toBeUndefined();
    expect(noOpReason(p("app.py", "    return 1", "    return 1  "), [], [])).toBeDefined();
    // a line moved inside a hunk is a change: blocks are compared where they stand
    const moved = ["--- a/src/a.js", "+++ b/src/a.js", "@@ -1,3 +1,3 @@", "-a();", " b();", "+a();", ""].join("\n");
    expect(noOpReason(moved, [], [])).toBeUndefined();
  });

  it("refuses a patch that leaves the file's token stream unchanged: a comment, or a line split in two", () => {
    const before = "export function check(size, income) {\n  return income <= LIMITS[size] ? 'Eligible.' : 'Not eligible.';\n}\n";
    const comment = before.replace("  return", "  // at or below the limit\n  return");
    const split = before.replace(" ? 'Eligible.'", "\n    ? 'Eligible.'");
    const patch = (after: string) => ["--- a/src/e.js", "+++ b/src/e.js", "@@ -1,3 +1,4 @@", ...before.split("\n").slice(0, 3).map((l) => `-${l}`), ...after.split("\n").slice(0, 4).map((l) => `+${l}`), ""].join("\n");
    expect(noOpReason(patch(comment), [src("src/e.js", before)], [src("src/e.js", comment)])).toMatch(/tokens/);
    expect(noOpReason(patch(split), [src("src/e.js", before)], [src("src/e.js", split)])).toMatch(/tokens/);
    // whitespace inside a string literal is the page's text: a change
    const spaced = before.replace("'Not eligible.'", "'Not  eligible.'");
    expect(noOpReason(patch(spaced), [src("src/e.js", before)], [src("src/e.js", spaced)])).toBeUndefined();
    // a real change, and a file whose tokens Holdback does not read, are never refused on tokens
    const real = before.replace("<=", "<");
    expect(noOpReason(patch(real), [src("src/e.js", before)], [src("src/e.js", real)])).toBeUndefined();
    const py = (s: string) => s.replace("src/e.js", "app.py");
    expect(noOpReason(py(patch(comment)), [src("app.py", before)], [src("app.py", comment)])).toBeUndefined();
  });
});
