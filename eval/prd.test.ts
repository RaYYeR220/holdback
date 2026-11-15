import { copyFileSync, cpSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { PrdChanged, assertPrdRegistered, registerPrd, registeredStackHash, verifiedExamFiles, verifyInputs, sha256 } from "./prd.ts";
import { MODEL, PRD, STACK } from "./test/helpers.ts";

const here = path.dirname(fileURLToPath(import.meta.url));
let tmp: string;
let results: string;
beforeEach(() => {
  tmp = mkdtempSync(path.join(tmpdir(), "holdback-prd-"));
  results = path.join(tmp, "results");
});
afterEach(() => rmSync(tmp, { recursive: true, force: true }));

describe("registerPrd", () => {
  it("records the PRD, the dependent lines, the STACK and the model", async () => {
    const rec = await registerPrd(PRD, STACK, MODEL, results);
    expect(rec.dependentLinesSha256).toBe("cf71451e27c5cebebdead56688f96a467f6dcc412404f01666a57c97aa3c85d0");
    expect(rec.stackSha256).toBe(await registeredStackHash());
    expect(rec.model).toBe(MODEL);
    expect(rec.prdSha256).toBe(sha256(readFileSync(PRD)));
    expect(JSON.parse(readFileSync(path.join(results, "prd-final.json"), "utf8"))).toEqual(rec);
  });

  it("accepts appended Clarifications, which fall outside the registered lines", async () => {
    const prd = path.join(tmp, "PRD.md");
    writeFileSync(prd, readFileSync(PRD, "utf8") + "\n## Clarifications\n\n61. Kane asked something.\n");
    await expect(registerPrd(prd, STACK, MODEL, results)).resolves.toBeTruthy();
  });

  it("is a no-op for the same inputs and refuses different ones", async () => {
    const first = await registerPrd(PRD, STACK, MODEL, results);
    expect(await registerPrd(PRD, STACK, MODEL, results)).toEqual(first);
    await expect(registerPrd(PRD, STACK, "other-model", results)).rejects.toThrow(/different PRD, STACK or model/);
  });

  it("refuses a PRD whose exam-dependent lines changed", async () => {
    const prd = path.join(tmp, "PRD.md");
    writeFileSync(prd, readFileSync(PRD, "utf8").replace("Not eligible.", "Not eligible!"));
    await expect(registerPrd(prd, STACK, MODEL, results)).rejects.toThrow(/exam depends on changed/);
  });

  it("refuses a STACK that is not the registered one, and a missing model", async () => {
    const stack = path.join(tmp, "STACK.md");
    writeFileSync(stack, "other\n");
    await expect(registerPrd(PRD, stack, MODEL, results)).rejects.toThrow(/registered STACK\.md/);
    await expect(registerPrd(PRD, STACK, " ", results)).rejects.toThrow(/model is required/);
  });
});

describe("verifyInputs / assertPrdRegistered", () => {
  it("passes for the registered inputs and names what differs otherwise", async () => {
    const rec = await registerPrd(PRD, STACK, MODEL, results);
    await expect(verifyInputs(results, { prdSha256: rec.prdSha256, stackSha256: rec.stackSha256, model: MODEL }, "arm A")).resolves.toEqual(rec);
    await expect(verifyInputs(results, { prdSha256: "x", stackSha256: "y", model: undefined }, "arm A")).rejects.toThrow(/PRD\.md, STACK\.md, model/);
  });
  it("refuses a registration whose PRD copy was edited", async () => {
    await registerPrd(PRD, STACK, MODEL, results);
    writeFileSync(path.join(results, "prd-final.md"), "edited");
    await expect(assertPrdRegistered(results)).rejects.toBeInstanceOf(PrdChanged);
  });
});

describe("verifiedExamFiles", () => {
  it("accepts the 22 registered files, also with CRLF line endings", async () => {
    expect(await verifiedExamFiles(path.join(here, "exam"))).toHaveLength(22);
    const dir = path.join(tmp, "exam");
    cpSync(path.join(here, "exam"), dir, { recursive: true });
    const f = path.join(dir, "e-01-one-person-at-monthly-limit_test.md");
    writeFileSync(f, readFileSync(f, "utf8").replace(/\n/g, "\r\n"));
    expect(await verifiedExamFiles(dir)).toHaveLength(22);
  });
  it("refuses an extra file", async () => {
    const dir = path.join(tmp, "exam");
    cpSync(path.join(here, "exam"), dir, { recursive: true });
    copyFileSync(path.join(dir, "e-01-one-person-at-monthly-limit_test.md"), path.join(dir, "e-23-extra_test.md"));
    await expect(verifiedExamFiles(dir)).rejects.toThrow(/extra: e-23-extra_test\.md/);
  });
});
