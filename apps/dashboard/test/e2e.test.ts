import { appendFileSync, mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import os from "node:os";
import path from "node:path";
import { chromium, type Browser, type Page } from "playwright";
import { afterAll, beforeAll, describe, expect, inject, it } from "vitest";
import { loadProject, parseEvents, serve, type LedgerEvent } from "@holdback/core";
import { fixtureText, staticServer } from "./helpers";

let browser: Browser;
beforeAll(async () => {
  browser = await chromium.launch();
});
afterAll(async () => {
  await browser?.close();
});

/** Waits until the board is up and every image has loaded (or failed). */
async function ready(page: Page) {
  await page.waitForSelector("[data-testid=board]");
  await page.evaluate(async () => {
    const wait = (i: HTMLImageElement) => (i.complete ? null : new Promise((r) => (i.addEventListener("load", r), i.addEventListener("error", r))));
    await Promise.all([...document.images].map(wait));
  });
}

const colCount = (page: Page, key: string) => page.locator(`[data-col="${key}"] article.ac`).count();

describe("REPLAY: the static build renders the recorded run", () => {
  let site: Awaited<ReturnType<typeof staticServer>>;
  beforeAll(async () => {
    site = await staticServer(inject("replayDir"));
  });
  afterAll(() => site?.close());

  it("shows the gate, every criterion in its column, Kane's screenshots and the loop", async () => {
    const page = await browser.newPage({ viewport: { width: 1440, height: 900 } });
    const errors: string[] = [];
    page.on("pageerror", (e) => errors.push(e.message));
    const api: string[] = [];
    page.on("request", (r) => r.url().includes("/api/") && api.push(r.url()));
    await page.goto(site.url);
    await ready(page);

    // the pantry demo run: the verdict's parts are long, the pill keeps them on one line
    await expect(page.locator("[data-testid=gate]").textContent()).resolves.toMatch(/Held back.*19 owed.*3\/58 proved/);
    await expect(page.locator("h1").textContent()).resolves.toBe("Held back.");
    expect(await page.locator("article.ac").count()).toBe(58);
    expect([await colCount(page, "owed"), await colCount(page, "passing"), await colCount(page, "proved"), await colCount(page, "vacuous"), await colCount(page, "needs-spec")]).toEqual([19, 13, 3, 0, 23]);
    // the proved card carries the catch: Kane's words, the screenshot, the planted line
    const ac30 = page.locator("[data-ac=ac-30]");
    await expect(ac30.locator(".saw").textContent()).resolves.toBe("Income counted: $36,000 per year.");
    await expect(ac30.locator(".d-add").textContent()).resolves.toContain("incomeCents * 24");
    const shots = await page.$$eval(".thumb img", (imgs) => imgs.map((i) => (i as HTMLImageElement).naturalWidth));
    expect(shots.length).toBeGreaterThanOrEqual(3);
    expect(shots.every((w) => w === 1920)).toBe(true);
    await expect(page.locator(".seg h3").allTextContents()).resolves.toEqual(["Spec", ...Array.from({ length: 10 }, (_, i) => `Turn ${i + 1}`)]);
    // the scored exam, read from eval/results/summary.json at build time
    const exam = (await page.locator("#exam").textContent()) ?? "";
    expect(exam.match(/22\/22/g)).toHaveLength(3);
    expect(exam).toContain("did not claim done");
    expect(api).toEqual([]);
    expect(errors).toEqual([]);
    // the lightbox opens the full screenshot
    await ac30.locator(".thumb").click();
    await expect(page.locator("dialog.lightbox[open] img").getAttribute("src")).resolves.toBe("./artifacts/m-ac-30-3-step_003.png");
    await page.close();
  });

  it("has no horizontal scroll at 390, 1440 or 1920", async () => {
    for (const width of [390, 1440, 1920]) {
      const page = await browser.newPage({ viewport: { width, height: 900 } });
      await page.goto(site.url);
      await ready(page);
      expect(await page.evaluate(() => document.documentElement.scrollWidth)).toBe(width);
      await page.close();
    }
  });
});

describe("LIVE: the build `holdback serve` serves, against the real server", () => {
  let tmp: string;
  let prevHome: string | undefined;
  let srv: Awaited<ReturnType<typeof serve>>;
  let ledger: string;
  let base: string;

  beforeAll(async () => {
    tmp = mkdtempSync(path.join(os.tmpdir(), "hb-dash-live-"));
    prevHome = process.env.HOLDBACK_HOME;
    process.env.HOLDBACK_HOME = path.join(tmp, "home");
    const app = path.join(tmp, "app");
    mkdirSync(app, { recursive: true });
    const p = await loadProject(app);
    ledger = p.ledgerFile;
    // the fixture minus its seal: this throwaway project has none of the sealed files to hold it to
    writeFileSync(ledger, fixtureText().split("\n").filter((l) => !l.includes('"t":"seal"')).join("\n"));
    srv = await serve(p, { port: 0, staticDir: inject("liveDir"), pollMs: 50 });
    base = `http://127.0.0.1:${srv.port}/`;
  });
  afterAll(async () => {
    await srv?.close();
    if (prevHome === undefined) delete process.env.HOLDBACK_HOME;
    else process.env.HOLDBACK_HOME = prevHome;
    rmSync(tmp, { recursive: true, force: true });
  });

  it("without a token: a clear message and not one API request", async () => {
    const page = await browser.newPage();
    const api: string[] = [];
    page.on("request", (r) => r.url().includes("/api/") && api.push(r.url()));
    await page.goto(base);
    await page.waitForSelector("[data-testid=blocked]");
    await expect(page.locator("h1").textContent()).resolves.toBe("This dashboard needs its token.");
    await page.waitForTimeout(300);
    expect(api).toEqual([]);
    await page.close();
  });

  it("with a wrong token: says the server refused it", async () => {
    const page = await browser.newPage();
    await page.goto(`${base}#token=${"0".repeat(48)}`);
    await page.waitForSelector("[data-testid=blocked]");
    await expect(page.locator("h1").textContent()).resolves.toBe("The server refused this token.");
    await page.close();
  });

  it("with the token: the board from /api/state, new ledger lines over SSE, and a question answered in the page", async () => {
    const page = await browser.newPage({ viewport: { width: 1440, height: 900 } });
    await page.goto(`${base}#token=${srv.token}`);
    await ready(page);
    await expect(page.locator("[data-testid=gate]").textContent()).resolves.toMatch(/Held back.*5 owed/);
    expect(await page.locator("article.ac").count()).toBe(11);
    await page.waitForSelector(".mode-live.st-open");
    // screenshots come through /api/artifact only for allowed folders: the fixture's relative paths show none
    expect(await page.locator(".thumb img").count()).toBe(0);

    // the recorded turn 2 never ended, hours ago: not "running"
    await expect(page.locator(".row-agent .pill-open").textContent()).resolves.toBe("no end on record");

    // a new turn lands in the ledger: the page shows it without a reload
    appendFileSync(ledger, JSON.stringify({ at: new Date().toISOString(), t: "turn.start", n: 3, owed: ["ac-1"] } satisfies LedgerEvent) + "\n");
    await page.waitForSelector(".seg h3:text-is('Turn 3')");
    await expect(page.locator(".row-agent .pill-run").last().textContent()).resolves.toBe("running");

    // Kane pauses on its own questions from the recorded run: the human answers in the page
    const paused = parseEvents(fixtureText()).find((e) => e.t === "spec.paused");
    if (paused?.t !== "spec.paused") throw new Error("fixture has no spec.paused");
    const answered = srv.human.answer(paused.questions);
    await page.waitForSelector("[data-testid=human]");
    await expect(page.locator(".inbox").textContent()).resolves.toBe("1 waiting for you");
    await page.getByLabel("Block invalid").check();
    await page.getByRole("button", { name: "Send answers to Kane" }).click();
    await expect(answered).resolves.toEqual({ q1: "Keep unspecified", q2: "Block invalid" });
    await page.waitForSelector("[data-testid=human]", { state: "detached" });

    // an approval: untick one, approve the rest
    const approved = srv.human.approve([
      { ref: "t-1", title: "Income above limit returns Not eligible without SNAP", kind: "test", note: "Holdback repaired a broken import Kane wrote (line 12): @import ./C:\\x\\t0_test.md -> @import ./t0_test.md" },
      { ref: "t-2", title: "SNAP overrides above-limit income", kind: "test" },
    ]);
    await page.waitForSelector("[data-testid=human]");
    await expect(page.locator(".appr-note").allTextContents()).resolves.toEqual(["Holdback repaired a broken import Kane wrote (line 12): @import ./C:\\x\\t0_test.md -> @import ./t0_test.md"]);
    await page.locator("label", { hasText: "SNAP overrides above-limit income" }).locator("input").uncheck();
    await page.getByRole("button", { name: "Approve 1 of 2" }).click();
    await expect(approved).resolves.toEqual(["t-1"]);
    await page.waitForSelector("[data-testid=human]", { state: "detached" });

    // test variables Kane left empty: Holdback's suggestion is filled in, a secret is typed, never suggested
    const filled = srv.human.values([
      { name: "primary_phone", description: "Unused ten-digit household test phone.", secret: false, suggested: "2155550101", usedBy: ["t-1"] },
      { name: "login_password", description: "Password of the test account.", secret: true, usedBy: ["t-2"] },
    ]);
    await page.waitForSelector("[data-testid=human]");
    await expect(page.locator("#human-h").textContent()).resolves.toBe("Kane's tests need values");
    await expect(page.getByLabel("primary_phone").inputValue()).resolves.toBe("2155550101");
    await expect(page.getByLabel("login_password").getAttribute("type")).resolves.toBe("password");
    expect(await page.getByRole("button", { name: "Save 2 values" }).isDisabled()).toBe(true);
    await page.getByLabel("login_password").fill("hunter2");
    await page.getByRole("button", { name: "Save 2 values" }).click();
    await expect(filled).resolves.toEqual({ primary_phone: "2155550101", login_password: "hunter2" });
    await page.close();
  });
});
