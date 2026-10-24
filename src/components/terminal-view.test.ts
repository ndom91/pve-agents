import { describe, expect, it } from "vitest";

import { withCtrl } from "./terminal-view";

describe("the touch key row's Ctrl", () => {
  it("turns a letter into its control character, whichever case was typed", () => {
    expect(withCtrl("c")).toBe("\x03");
    expect(withCtrl("C")).toBe("\x03");
  });

  it("gives Ctrl-[ as escape, the way a hardware keyboard does", () => {
    expect(withCtrl("[")).toBe("\x1b");
  });

  it("sends a key with no control form unchanged rather than dropping it", () => {
    expect(withCtrl("1")).toBe("1");
  });

  it("leaves a multi-character input alone, so a paste is never mangled", () => {
    expect(withCtrl("ls -la")).toBe("ls -la");
  });
});
