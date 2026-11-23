import { describe, expect, it } from "vitest";
import { safeNext } from "@/lib/safe-next";

describe("safeNext", () => {
  it("keeps paths inside GLIO", () => {
    expect(safeNext("/invite/abc")).toBe("/invite/abc");
    expect(safeNext("/w/1/c/2?p=7d")).toBe("/w/1/c/2?p=7d");
  });
  it("refuses anything that could leave the site", () => {
    for (const bad of ["https://evil.example", "//evil.example", "/\\evil.example", "evil", "", undefined, null, "/x\nLocation: y", "/" + "a".repeat(400)]) {
      expect(safeNext(bad)).toBe("/app");
    }
  });
});
