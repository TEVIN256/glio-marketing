import { describe, expect, it } from "vitest";
import {
  MoneyError, addDays, canonicalJson, daysInclusive, decimalToMinor, minorToDecimalString,
  sha256OfJson, splitWindows, todayIn,
} from "../src/index.ts";

describe("decimalToMinor: exact, never rounds", () => {
  it.each([
    ["12.34", "SAR", 1234n],
    ["12.3", "SAR", 1230n],
    ["12", "SAR", 1200n],
    ["0", "SAR", 0n],
    ["0.00", "SAR", 0n],
    ["12.340", "SAR", 1234n], // trailing zeros are not extra precision
    ["1.234", "KWD", 1234n],
    ["100", "JPY", 100n],
    ["99999999999.99", "SAR", 9999999999999n],
  ])("%s %s -> %s", (value, currency, expected) => {
    expect(decimalToMinor(value, currency)).toBe(expected);
  });

  it("accepts plain numbers without exponent", () => {
    expect(decimalToMinor(12.34, "SAR")).toBe(1234n);
  });

  it.each([
    ["12.345", "SAR"], // would need rounding
    ["100.5", "JPY"],
    ["-1", "SAR"],
    ["1e3", "SAR"],
    ["12,34", "SAR"],
    ["", "SAR"],
    ["abc", "SAR"],
  ])("rejects %s %s", (value, currency) => {
    expect(() => decimalToMinor(value, currency)).toThrow(MoneyError);
  });

  it("rejects exponent numbers and unknown currencies", () => {
    expect(() => decimalToMinor(1e21, "SAR")).toThrow(MoneyError);
    expect(() => decimalToMinor("1", "XXX")).toThrow(/Unknown currency/);
  });

  it("round-trips for display", () => {
    expect(minorToDecimalString(1234n, "SAR")).toBe("12.34");
    expect(minorToDecimalString(5n, "SAR")).toBe("0.05");
    expect(minorToDecimalString(1234n, "KWD")).toBe("1.234");
    expect(minorToDecimalString(100n, "JPY")).toBe("100");
  });
});

describe("canonical hashing", () => {
  it("ignores key order but not values", () => {
    const a = { b: 1, a: { y: [1, { q: 2, p: 1 }], x: "s" } };
    const b = { a: { x: "s", y: [1, { p: 1, q: 2 }] }, b: 1 };
    expect(canonicalJson(a)).toBe(canonicalJson(b));
    expect(sha256OfJson(a)).toBe(sha256OfJson(b));
    expect(sha256OfJson(a)).toMatch(/^[0-9a-f]{64}$/);
    expect(sha256OfJson({ ...b, b: 2 })).not.toBe(sha256OfJson(b));
  });
});

describe("dates (UTC arithmetic)", () => {
  it("adds days across month and leap-year boundaries", () => {
    expect(addDays("2026-01-31", 1)).toBe("2026-02-01");
    expect(addDays("2028-02-28", 1)).toBe("2028-02-29");
    expect(addDays("2026-03-01", -1)).toBe("2026-02-28");
    expect(daysInclusive("2026-01-01", "2026-01-31")).toBe(31);
  });

  it("splits a backfill range into windows", () => {
    expect(splitWindows("2026-01-01", "2026-03-05", 30)).toEqual([
      { from: "2026-01-01", to: "2026-01-30" },
      { from: "2026-01-31", to: "2026-03-01" },
      { from: "2026-03-02", to: "2026-03-05" },
    ]);
    expect(splitWindows("2026-01-01", "2026-01-01", 30)).toEqual([{ from: "2026-01-01", to: "2026-01-01" }]);
    expect(() => splitWindows("2026-02-01", "2026-01-01", 30)).toThrow();
    expect(() => splitWindows("2026-02-30", "2026-03-01", 30)).toThrow();
  });

  it("knows today's date in Riyadh, not UTC", () => {
    // 22:30 UTC on 1 Jan is already 2 Jan in Riyadh (UTC+3)
    expect(todayIn("Asia/Riyadh", new Date("2026-01-01T22:30:00Z"))).toBe("2026-01-02");
  });
});
