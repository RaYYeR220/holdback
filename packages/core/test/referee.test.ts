import { readFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { describe, expect, it, vi } from "vitest";
import { BreakerError, BreakerUnavailable, BudgetRefused } from "../src/breaker/mutate.js";
import { REFEREE_FIELD_MAX, REFEREE_MAX_TOKENS, REFEREE_SCHEMA, refereeMutant, refereeNote } from "../src/breaker/referee.js";
import { Budget, VeniceOutputError, VeniceUnreachable, type VeniceChatOptions } from "../src/breaker/venice.js";
import type { AcState } from "../src/ledger/types.js";

const here = dirname(fileURLToPath(import.meta.url));
type LiveSurvivor = { mutant: string; ac: { id: string; text: string; useCase: string; cites: AcState["cites"] }; patch: string; slip: { behaviour: string } | null };
const LIVE: LiveSurvivor[] = JSON.parse(readFileSync(join(here, "fixtures", "breaker", "survivors.json"), "utf8"));
const live = (id: string) => LIVE.find((s) => s.mutant === id)!;
const acOf = (s: LiveSurvivor): AcState => ({ ...s.ac, tests: ["t-1"], status: "passing" });

const MODEL = "deepseek-v4-flash";
const usage = { prompt_tokens: 900, completion_tokens: 120 };
const USD = (900 * 0.138 + 120 * 0.275) / 1e6;
const answer = (json: unknown) => vi.fn(async (_o: VeniceChatOptions) => ({ json, usage }));
const opts = (chat: ReturnType<typeof answer>, budget = new Budget(1, 0)) => ({ model: MODEL, apiKey: "k", budget, chat });

describe("refereeMutant", () => {
  it("asks once, at temperature 0 with its own schema, from the criterion, its spec quotes and the patch alone: never the breaker's account or the source", async () => {
    const s = live("m-ac-20-1");
    const chat = answer({ verdict: "no-change", input: "", expected: "", observed: "", reason: "digits already holds the same value." });
    await refereeMutant(acOf(s), s.patch, opts(chat));
    expect(chat).toHaveBeenCalledTimes(1);
    const o = chat.mock.calls[0]![0];
    expect(o).toMatchObject({ model: MODEL, apiKey: "k", temperature: 0, schema: REFEREE_SCHEMA, schemaName: "referee", maxTokens: REFEREE_MAX_TOKENS });
    expect(o.messages[0]!.content).toMatch(/^You are the referee/);
    const user = o.messages[1]!.content;
    expect(user).toContain(`AC ac-20: ${s.ac.text}`);
    for (const c of s.ac.cites) expect(user).toContain(`Spec quote (${c.source} ${c.anchor}): "${c.quote}"`);
    expect(user).toContain(s.patch);
    expect(user).not.toContain(s.slip!.behaviour);
  });

  it("confirms a survivor only with a concrete input whose expected and observed results differ, and charges the call", async () => {
    const s = live("m-ac-4-1");
    const budget = new Budget(1, 0);
    const f = await refereeMutant(
      acOf(s),
      s.patch,
      opts(answer({ verdict: "violates", input: "Household size 1, monthly income $2,000, SNAP unchecked", expected: "Monthly limit: $2,461", observed: "Monthly limit: $2,460", reason: "BASE[0] is the size-1 limit." }), budget),
    );
    expect(f).toEqual({ confirmed: true, call: "violates", input: "Household size 1, monthly income $2,000, SNAP unchecked", expected: "Monthly limit: $2,461", observed: "Monthly limit: $2,460", reason: "BASE[0] is the size-1 limit.", usd: expect.closeTo(USD, 12), model: MODEL });
    expect(budget.spent).toBeCloseTo(USD, 12);
    expect(refereeNote(f)).toBeUndefined();
  });

  it("rejects off target and no-change calls in the referee's own words; a 'violates' without an input, or with nothing different to see, is not confirmed either", async () => {
    const s = live("m-ac-27-1");
    const run = async (json: unknown) => refereeMutant(acOf(s), s.patch, opts(answer(json)));
    const off = await run({ verdict: "off-target", input: "", expected: "", observed: "", reason: "A zero income is never above the limit." });
    expect(off).toMatchObject({ confirmed: false, call: "off-target" });
    expect(refereeNote(off)).toBe("off target: A zero income is never above the limit.");
    const none = await run({ verdict: "no-change", input: "", expected: "", observed: "", reason: "The added key is overwritten." });
    expect(refereeNote(none)).toBe("no observable change: The added key is overwritten.");
    const noInput = await run({ verdict: "violates", input: " ", expected: "Not eligible.", observed: "Eligible.", reason: "r" });
    expect(noInput.confirmed).toBe(false);
    expect(refereeNote(noInput)).toBe("off target: the referee named no input where it breaks this criterion");
    const same = await run({ verdict: "violates", input: "size 1, $600 weekly", expected: "Not eligible.", observed: " not  eligible. ", reason: "r" });
    expect(same.confirmed).toBe(false);
    expect(refereeNote(same)).toBe("no observable change: the referee's expected and observed results are the same");
  });

  it("the live pilot's replies: the demo's m-ac-53-1 (a line replaced with itself) rejected, the rehearsal's m-ac-4-1 (size-1 limit $2,461 to $2,460) confirmed", async () => {
    const pilot: { mutant: string; reply: unknown; usage: typeof usage }[] = JSON.parse(readFileSync(join(here, "fixtures", "venice", "referee-pilot.json"), "utf8"));
    const judge = async (id: string) => {
      const p = pilot.find((x) => x.mutant === id)!;
      const s = live(id);
      return refereeMutant(acOf(s), s.patch, { model: MODEL, apiKey: "k", budget: new Budget(1, 0), chat: async () => ({ json: p.reply, usage: p.usage }) });
    };
    const noop = await judge("m-ac-53-1");
    expect(noop).toMatchObject({ confirmed: false, call: "no-change" });
    expect(refereeNote(noop)).toMatch(/^no observable change: /);
    const real = await judge("m-ac-4-1");
    expect(real).toMatchObject({ confirmed: true, call: "violates", input: "household size 1", expected: "$2,461", observed: "$2,460" });
    // both calls together: well under a cent
    expect(noop.usd + real.usd).toBeLessThan(0.001);
  });

  it("holds its reply to the schema: anything else is a paid reply with no verdict, never confirmed", async () => {
    const s = live("m-ac-26-1");
    for (const json of [null, "violates", { verdict: "yes", input: "", expected: "", observed: "", reason: "" }, { verdict: "violates", input: 1, expected: "", observed: "", reason: "" }]) {
      const e = await refereeMutant(acOf(s), s.patch, opts(answer(json))).catch((x: unknown) => x);
      expect(e).toBeInstanceOf(BreakerError);
      expect((e as BreakerError).usd).toBeCloseTo(USD, 12);
    }
  });

  it("caps every field it keeps and escapes control characters: its text is data, never instructions", async () => {
    const s = live("m-ac-36-1");
    const long = `${"word ".repeat(100)}end`;
    const f = await refereeMutant(acOf(s), s.patch, opts(answer({ verdict: "violates", input: `a\u001b[31m\nb`, expected: long, observed: "Not eligible.", reason: long })));
    expect(f.input).toBe("a\\x1b[31m b");
    for (const v of [f.expected, f.reason]) {
      expect(v.length).toBeLessThanOrEqual(REFEREE_FIELD_MAX);
      expect(v.endsWith("…")).toBe(true);
    }
  });

  it("is held to the USD cap like the breaker: refused before any call, an outage charged at the worst case, a cut-off reply charged", async () => {
    const s = live("m-ac-37-1");
    const chat = answer({});
    await expect(refereeMutant(acOf(s), s.patch, opts(chat, new Budget(0.00001, 0)))).rejects.toBeInstanceOf(BudgetRefused);
    expect(chat).not.toHaveBeenCalled();
    const down = vi.fn(async () => {
      throw new VeniceUnreachable("timeout");
    });
    const e = await refereeMutant(acOf(s), s.patch, { model: MODEL, apiKey: "k", budget: new Budget(1, 0), chat: down }).catch((x: unknown) => x);
    expect(e).toBeInstanceOf(BreakerUnavailable);
    expect((e as BreakerUnavailable).usd).toBeGreaterThan(0);
    const cut = vi.fn(async () => {
      throw new VeniceOutputError("cut off", usage, true);
    });
    const c = await refereeMutant(acOf(s), s.patch, { model: MODEL, apiKey: "k", budget: new Budget(1, 0), chat: cut }).catch((x: unknown) => x);
    expect(c).toBeInstanceOf(BreakerError);
    expect((c as BreakerError).usd).toBeCloseTo(USD, 12);
  });
});
