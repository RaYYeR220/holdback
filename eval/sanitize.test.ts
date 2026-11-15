import os from "node:os";
import { describe, expect, it } from "vitest";
import { homeForms, sanitize } from "../scripts/sanitize.mjs";

const WIN = String.raw`C:\Users\someone`;

describe("sanitize", () => {
  it("replaces a Windows home in its raw, forward-slash and JSON-escaped forms", () => {
    const text = [
      JSON.stringify({ screenshot_path: String.raw`C:\Users\someone\.testmuai\a.png` }),
      "cwd C:/Users/someone/app",
      String.raw`raw C:\Users\someone\app`,
    ].join("\n");
    expect(sanitize(text, WIN)).toBe([String.raw`{"screenshot_path":"~\\.testmuai\\a.png"}`, "cwd ~/app", String.raw`raw ~\app`].join("\n"));
  });

  it("collapses temp dirs and share links", () => {
    const text = String.raw`{"p":"C:\\Users\\someone\\AppData\\Local\\Temp\\v16-run\\s.png","u":"https://test-manager.lambdatest.com/share/abc?x=1"}`;
    expect(sanitize(text, WIN)).toBe(String.raw`{"p":"<tmp>\\v16-run\\s.png","u":"<share-url>"}`);
  });

  it("handles a POSIX home and ignores an empty one", () => {
    expect(sanitize("/home/someone/app and /home/someone", "/home/someone/")).toBe("~/app and ~");
    expect(homeForms("")).toEqual([]);
    expect(sanitize("C:/Users/someone", "")).toBe("C:/Users/someone");
  });

  it("defaults to this user's home, read at run time", () => {
    expect(sanitize(`${os.homedir()}/x`)).toBe("~/x");
  });
});
