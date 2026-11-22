import { describe, expect, it } from "vitest";
import type { Figure } from "@glio/reports";
import { figureDelta, matchPreset, presetPeriod, previousPeriod } from "@/lib/delta";

const money = (minor: string, metric: Figure["metric"] = "spend"): Figure => ({
  id: `tiktok.${metric}`, scope: "tiktok", metric, status: "value", rawPayloadIds: [], value: { kind: "money", minor, currency: "SAR" },
});
const count = (value: string, metric: Figure["metric"]): Figure => ({
  id: `tiktok.${metric}`, scope: "tiktok", metric, status: "value", rawPayloadIds: [], value: { kind: "count", value },
});
const ratio = (n: string, d: string, metric: Figure["metric"]): Figure => ({
  id: `tiktok.${metric}`, scope: "tiktok", metric, status: "value", rawPayloadIds: [],
  value: { kind: "ratio", numerator: n, denominator: d, unit: "money_minor", currency: "SAR", display: "0" },
});

describe("figureDelta", () => {
  it("computes the exact change, rounded half-up to one decimal", () => {
    expect(figureDelta(money("11240"), money("10000"))).toEqual({ percent: "12.4", direction: "up", tone: "neutral" });
    expect(figureDelta(count("970", "clicks"), count("1000", "clicks"))).toEqual({ percent: "3.0", direction: "down", tone: "bad" });
    expect(figureDelta(count("1001", "clicks"), count("1000", "clicks"))).toEqual({ percent: "0.1", direction: "up", tone: "good" });
  });

  it("knows that a higher cost per conversion is bad", () => {
    expect(figureDelta(ratio("1200", "10", "cpa"), ratio("1000", "10", "cpa"))).toMatchObject({ direction: "up", tone: "bad" });
    expect(figureDelta(ratio("900", "10", "cpa"), ratio("1000", "10", "cpa"))).toMatchObject({ direction: "down", tone: "good" });
  });

  it("returns nothing without both values or when the previous value is zero", () => {
    expect(figureDelta(money("100"), undefined)).toBeNull();
    expect(figureDelta(money("100"), money("0"))).toBeNull();
    expect(figureDelta({ ...money("100"), status: "not_provided", value: undefined }, money("100"))).toBeNull();
  });

  it("treats a tiny change as flat", () => {
    expect(figureDelta(count("100000", "impressions"), count("100001", "impressions"))).toMatchObject({ direction: "flat", tone: "neutral", percent: "0.0" });
  });
});

describe("periods", () => {
  it("previous period has the same length, right before", () => {
    expect(previousPeriod({ from: "2026-11-01", to: "2026-11-30" })).toEqual({ from: "2026-10-02", to: "2026-10-31" });
  });
  it("presets end yesterday; months are calendar months", () => {
    expect(presetPeriod("7d", "2026-11-22")).toEqual({ from: "2026-11-15", to: "2026-11-21" });
    expect(presetPeriod("30d", "2026-11-22")).toEqual({ from: "2026-10-23", to: "2026-11-21" });
    expect(presetPeriod("mtd", "2026-11-22")).toEqual({ from: "2026-11-01", to: "2026-11-21" });
    expect(presetPeriod("mtd", "2026-11-01")).toEqual({ from: "2026-11-01", to: "2026-11-01" });
    expect(presetPeriod("lastm", "2026-03-10")).toEqual({ from: "2026-02-01", to: "2026-02-28" });
    expect(matchPreset({ from: "2026-11-15", to: "2026-11-21" }, "2026-11-22")).toBe("7d");
    expect(matchPreset({ from: "2026-11-14", to: "2026-11-21" }, "2026-11-22")).toBeNull();
  });
});
