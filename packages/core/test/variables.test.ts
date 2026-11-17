import { mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import type { HumanIO, VariableAsk } from "../src/loop/human.js";
import { emptyVariables, fillVariables, suggestValues, VariablesMissing } from "../src/loop/variables.js";
import { lintImports } from "../src/loop/imports.js";
import type { EventBody } from "../src/ledger/vouched.js";

const here = dirname(fileURLToPath(import.meta.url));
const fx = (n: string) => join(here, "fixtures", "kane", n);
let root: string;
let verifier: string;
let tests: string;

beforeEach(() => {
  root = mkdtempSync(join(tmpdir(), "holdback-vars-"));
  verifier = join(root, "verifier");
  tests = join(verifier, ".testmuai", "tests");
  mkdirSync(tests, { recursive: true });
  mkdirSync(join(verifier, ".testmuai", "variables"), { recursive: true });
});
afterEach(() => rmSync(root, { recursive: true, force: true }));

const varsFile = () => join(verifier, ".testmuai", "variables", "assurance.json");
const declared = () => JSON.parse(readFileSync(varsFile(), "utf8")) as Record<string, { value: string; secret: boolean; description: string }>;
const testFile = (name: string, id: string, body: string) => {
  const file = join(tests, name);
  writeFileSync(file, `---\nassurance:\n  id: ${id}\n---\n# ${id}\n\n## Step 1 @verifies ac-1\n\n${body}\n`);
  return { id, file };
};
const io = (values: HumanIO["values"]): HumanIO => ({ answer: async () => ({}), approve: async (items) => items.map((i) => i.ref), values });

describe("suggestValues (the second live run's empty variables)", () => {
  it("phones get distinct 215555 numbers, a formatted sibling the same digits, nine digits nine, a name a name; never a secret", () => {
    const doc = JSON.parse(readFileSync(fx("variables-declared-empty.json"), "utf8")) as Record<string, { value: string; secret: boolean; description: string }>;
    const vars = Object.entries(doc)
      .filter(([, v]) => v.value === "")
      .map(([name, v]) => ({ name, description: v.description, secret: v.secret }));
    const s = suggestValues(vars, { start_url: doc.start_url!.value });
    expect(Object.fromEntries(Object.entries(s).map(([k, v]) => [k, v.suggested]))).toEqual({
      primary_phone: "2155550101",
      primary_phone_formatted: "(215) 555-0101",
      proxy_name: "Maria Lopez",
      slot_phone_1: "2155550102",
      slot_phone_2: "2155550103",
      slot_phone_3: "2155550104",
      slot_phone_4: "2155550105",
      slot_phone_5: "2155550106",
      slot_phone_6: "2155550107",
      slot_phone_7: "2155550108",
      invalid_phone: "215555010",
      spare_phone: "2155550110",
    });
    expect(s.primary_phone_formatted!.sameAs).toBe("primary_phone");
    // deterministic: the same declarations give the same values
    expect(suggestValues(vars, { start_url: doc.start_url!.value })).toEqual(s);
  });

  it("skips numbers already in use, keeps a formatted sibling on a filled one's digits, and only names a placeholder for anything else", () => {
    const s = suggestValues(
      [
        { name: "home_phone_formatted", description: "Same digits as home_phone in another permitted punctuation.", secret: false },
        { name: "work_phone", description: "Unused ten-digit phone.", secret: false },
        { name: "guest_name", description: "A visitor's name.", secret: false },
        { name: "second_guest_name", description: "Another visitor's name.", secret: false },
        { name: "coupon", description: "A coupon code the shop accepts.", secret: false },
        { name: "api_token", description: "Token for the phone gateway.", secret: true },
      ],
      { home_phone: "215-555-0101", other: "2155550102" },
    );
    expect(s.home_phone_formatted).toMatchObject({ suggested: "(215) 555-0101", sameAs: "home_phone" });
    expect(s.work_phone!.suggested).toBe("2155550103");
    expect([s.guest_name!.suggested, s.second_guest_name!.suggested]).toEqual(["Maria Lopez", "James Carter"]);
    expect(s.coupon).toEqual({ placeholder: "<coupon>" });
    expect(s.api_token).toEqual({});
  });
});

describe("emptyVariables", () => {
  it("lists the declared variables an approved test (or a test it imports) types with no value, and never one only a turned-down test uses", async () => {
    writeFileSync(varsFile(), readFileSync(fx("variables-declared-empty.json")));
    const t1 = testFile("book_test.md", "t-1", "At {{start_url}}, enter {{primary_phone}} and {{ proxy_name }}; expect 'Your visit: {chosen date}'.");
    const t2 = testFile("again_test.md", "t-2", "@import ./book_test.md\n\nEnter {{primary_phone_formatted}}.");
    testFile("full_test.md", "t-9", "Fill {{slot_phone_1}}.");
    const asks = await emptyVariables(verifier, [t2]);
    expect(asks.map((a) => a.name)).toEqual(["primary_phone", "primary_phone_formatted", "proxy_name"]);
    expect(asks[0]).toMatchObject({ suggested: "2155550101", secret: false, usedBy: ["t-2"] });
    expect(asks[1]).toMatchObject({ suggested: "(215) 555-0101", sameAs: "primary_phone" });
    expect((await emptyVariables(verifier, [t1, t2])).find((a) => a.name === "primary_phone")!.usedBy).toEqual(["t-1", "t-2"]);
    // start_url is filled; slot_phone_1 is used by t-9 alone, which is not approved
    expect((await emptyVariables(verifier, [t1])).map((a) => a.name)).toEqual(["primary_phone", "proxy_name"]);
  });

  it("a variables file Kane wrote that is not JSON stops the stage: its variables cannot be checked", async () => {
    writeFileSync(varsFile(), "{ nope");
    const t1 = testFile("a_test.md", "t-1", "{{x}}");
    await expect(emptyVariables(verifier, [t1])).rejects.toThrow(/assurance\.json/);
  });
});

describe("fillVariables (the variables gate)", () => {
  it("asks the human, writes what they give, and logs the names only", async () => {
    writeFileSync(varsFile(), readFileSync(fx("variables-declared-empty.json")));
    const t1 = testFile("book_test.md", "t-1", "At {{start_url}}, enter {{primary_phone}}, {{primary_phone_formatted}} and {{proxy_name}}.");
    const asked: VariableAsk[][] = [];
    const events: EventBody[] = [];
    await fillVariables(
      verifier,
      [t1],
      io(async (asks) => (asked.push(asks), { primary_phone: "2155550101", primary_phone_formatted: "(215) 555-0101", proxy_name: "Ana Ruiz" })),
      async (e) => void events.push(e),
    );
    expect(asked).toHaveLength(1);
    const doc = declared();
    expect([doc.primary_phone!.value, doc.primary_phone_formatted!.value, doc.proxy_name!.value]).toEqual(["2155550101", "(215) 555-0101", "Ana Ruiz"]);
    expect(doc.primary_phone!.description).toContain("ten-digit"); // the rest of Kane's declaration stays
    expect(doc.slot_phone_1!.value).toBe(""); // no approved test uses it
    expect(events).toEqual([{ t: "spec.variables", names: ["primary_phone", "primary_phone_formatted", "proxy_name"], filledBy: "human" }]);
    expect(JSON.stringify(events)).not.toContain("Ana Ruiz");
  });

  it("asks nothing when every referenced variable has a value", async () => {
    writeFileSync(varsFile(), JSON.stringify({ start_url: { value: "http://127.0.0.1:3000/", secret: false, description: "" } }));
    const t1 = testFile("a_test.md", "t-1", "At {{start_url}}.");
    const events: EventBody[] = [];
    await fillVariables(verifier, [t1], io(async () => Promise.reject(new Error("must not ask"))), async (e) => void events.push(e));
    expect(events).toEqual([]);
  });

  it("a variable left empty stops the stage before the seal, names it, and keeps what the human did fill", async () => {
    writeFileSync(varsFile(), readFileSync(fx("variables-declared-empty.json")));
    const t1 = testFile("a_test.md", "t-1", "{{primary_phone}} {{proxy_name}} {{spare_phone}}");
    const events: EventBody[] = [];
    const err = await fillVariables(verifier, [t1], io(async () => ({ primary_phone: "2155550101", proxy_name: "  " })), async (e) => void events.push(e)).then(
      () => null,
      (e: unknown) => e as Error,
    );
    expect(err).toBeInstanceOf(VariablesMissing);
    expect(err?.name).toBe("VariablesMissing");
    expect(err?.message).toMatch(/proxy_name, spare_phone/);
    expect(err?.message).toContain("holdback spec");
    expect(declared().primary_phone!.value).toBe("2155550101");
    expect(declared().proxy_name!.value).toBe("");
    expect(events).toEqual([{ t: "spec.variables", names: ["primary_phone"], filledBy: "human" }]);
  });

  it("a secret is asked with no suggestion, and its value is never on the ledger", async () => {
    writeFileSync(varsFile(), JSON.stringify({ login_password: { value: "", secret: true, description: "Password of the test account." } }, null, 2));
    const t1 = testFile("a_test.md", "t-1", "Sign in with {{login_password}}.");
    let asked: VariableAsk[] = [];
    const events: EventBody[] = [];
    await fillVariables(verifier, [t1], io(async (asks) => ((asked = asks), { login_password: "hunter2" })), async (e) => void events.push(e));
    expect(asked).toEqual([{ name: "login_password", description: "Password of the test account.", secret: true, usedBy: ["t-1"] }]);
    expect(declared().login_password).toMatchObject({ value: "hunter2", secret: true });
    expect(JSON.stringify(events)).not.toContain("hunter2");
  });
});

describe("lintImports (Kane 0.10.4 on Windows)", () => {
  it("rewrites an @import of an absolute path after ./ to the file next to it, line endings kept", async () => {
    writeFileSync(join(tests, "book-an-available-visit-and-confirm-proxy-and-schedule_test.md"), "---\nassurance:\n  id: t-1\n---\n# Book\n");
    const broken = readFileSync(fx("import-absolute-windows_test.md"), "utf8");
    writeFileSync(join(tests, "prevent_test.md"), broken);
    writeFileSync(join(tests, "unix_test.md"), "---\nassurance:\n  id: t-3\n---\r\n# Unix\r\n\r\n@import .//home/dev/.holdback/x/verifier/.testmuai/tests/book-an-available-visit-and-confirm-proxy-and-schedule_test.md\r\n");
    const r = await lintImports(verifier);
    expect(r.broken).toEqual([]);
    expect(r.repaired).toEqual([
      {
        file: ".testmuai/tests/prevent_test.md",
        test: "t-2",
        line: 12,
        from: "@import ./C:\\Users\\dev\\.holdback\\0123456789ab\\verifier\\.testmuai\\tests\\book-an-available-visit-and-confirm-proxy-and-schedule_test.md",
        to: "@import ./book-an-available-visit-and-confirm-proxy-and-schedule_test.md",
      },
      {
        file: ".testmuai/tests/unix_test.md",
        test: "t-3",
        line: 7,
        from: "@import .//home/dev/.holdback/x/verifier/.testmuai/tests/book-an-available-visit-and-confirm-proxy-and-schedule_test.md",
        to: "@import ./book-an-available-visit-and-confirm-proxy-and-schedule_test.md",
      },
    ]);
    const fixed = readFileSync(join(tests, "prevent_test.md"), "utf8");
    expect(fixed).toBe(broken.replace(/@import \.\/C:\\.*\\(book-[^\\\n]*_test\.md)/, "@import ./$1"));
    expect(readFileSync(join(tests, "unix_test.md"), "utf8")).toContain("\r\n@import ./book-an-available-visit-and-confirm-proxy-and-schedule_test.md\r\n");
    // a second pass finds nothing to do
    expect(await lintImports(verifier)).toEqual({ repaired: [], broken: [] });
  });

  it("flags an import it cannot resolve, and leaves the file as Kane wrote it", async () => {
    const text = "---\nassurance:\n  id: t-4\n---\n# Gone\n\n@import ./C:\\elsewhere\\missing_test.md\n@import ./also-missing_test.md\n@import ./ok_test.md\n";
    writeFileSync(join(tests, "gone_test.md"), text);
    writeFileSync(join(tests, "ok_test.md"), "# ok\n");
    const r = await lintImports(verifier);
    expect(r.repaired).toEqual([]);
    expect(r.broken).toEqual([
      { file: ".testmuai/tests/gone_test.md", test: "t-4", line: 7, target: "./C:\\elsewhere\\missing_test.md" },
      { file: ".testmuai/tests/gone_test.md", test: "t-4", line: 8, target: "./also-missing_test.md" },
    ]);
    expect(readFileSync(join(tests, "gone_test.md"), "utf8")).toBe(text);
  });

  it("no tests folder: nothing to lint", async () => {
    rmSync(tests, { recursive: true });
    expect(await lintImports(verifier)).toEqual({ repaired: [], broken: [] });
  });
});
