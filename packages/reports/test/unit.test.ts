import { describe, expect, it } from "vitest";
import {
  type ChannelTotals, type CommentaryModel, allowedFor, buildReport, extractNumbers, formatDecimal, formatMoney,
  formatPercent, generateCommentary, roundRatio, templateCommentary, validateText,
} from "../src/index.ts";

describe("formatting", () => {
  it("formats numbers for English, Arabic with Western digits, and Arabic-Indic", () => {
    expect(formatDecimal("1234567.5", "en", "latn")).toBe("1,234,567.5");
    expect(formatDecimal("1234567.5", "ar", "latn")).toBe("1,234,567.5");
    expect(formatDecimal("1234567.5", "ar", "arab")).toBe("١٬٢٣٤٬٥٦٧٫٥");
    expect(formatDecimal("1234567.5", "en", "arab")).toBe("1,234,567.5"); // English always Western
    expect(formatMoney(33789n, "SAR", "en", "latn")).toBe("SAR 337.89");
    expect(formatMoney(33789n, "SAR", "ar", "latn")).toBe("337.89 ر.س");
    expect(formatMoney(33789n, "SAR", "ar", "arab")).toBe("٣٣٧٫٨٩ ر.س");
    expect(formatPercent("2.08", "ar", "arab")).toBe("٢٫٠٨٪");
  });

  it("rounds derived ratios half-up, exactly", () => {
    expect(roundRatio(635n * 100n, 30600n, 2)).toBe("2.08"); // 2.0751...
    expect(roundRatio(1n, 8n, 2)).toBe("0.13"); // 0.125 -> 0.13
    expect(roundRatio(1n, 3n, 2)).toBe("0.33");
    expect(roundRatio(2n, 3n, 0)).toBe("1");
    expect(() => roundRatio(1n, 0n, 2)).toThrow();
  });
});

describe("number extraction and validation", () => {
  it("normalises Arabic-Indic digits, Arabic separators and bidi marks", () => {
    expect(extractNumbers("أنفقت ١٬٢٣٤٫٥٠ ر.س و⁦635⁩ نقرة")).toEqual(["1234.50", "635"]);
    expect(extractNumbers("SAR 1,234.50 over 30,600 impressions")).toEqual(["1234.50", "30600"]);
    expect(extractNumbers("۱۲")).toEqual(["12"]);
  });

  const allowed = new Set(["337.89", "30600", "635", "2026", "1", "01"]);

  it("accepts text whose numbers all come from the input", () => {
    expect(validateText("Spend was SAR 337.89 with 30,600 impressions and 635 clicks on 1 January 2026.", allowed).ok).toBe(true);
    expect(validateText("بلغ الإنفاق ٣٣٧٫٨٩ ر.س مع ٣٠٬٦٠٠ ظهور.", allowed).ok).toBe(true);
  });

  it("rejects invented, rounded or reformatted numbers", () => {
    expect(validateText("Spend was about SAR 338.", allowed)).toMatchObject({ ok: false, violations: ["number not in input: 338"] });
    expect(validateText("Impressions reached 30.6K.", allowed).ok).toBe(false);
    expect(validateText("CTR rose 12%.", allowed).ok).toBe(false);
  });

  it("rejects numbers written as words, in both languages", () => {
    expect(validateText("Spend tripled across three campaigns.", allowed).ok).toBe(false);
    expect(validateText("ارتفعت النقرات إلى الضعف في ثلاثة أيام.", allowed).ok).toBe(false);
    expect(validateText("حققت الحملة نتائج جيدة يوم الثلاثاء.", allowed).ok).toBe(true); // "Tuesday" is not a number
  });
});

const tiktok: ChannelTotals = {
  scope: "tiktok", currency: "SAR", rows: 6, spendMinor: 33789n, impressions: 30600n, clicks: 635n,
  conversionsScaled: 290000n, rawPayloadIds: [1, 2], reconciliation: "ok",
};
const period = { from: "2026-01-01", to: "2026-01-03" };

describe("buildReport", () => {
  const report = buildReport({ period, channels: [tiktok], total: null, digits: "latn" });
  const fig = (id: string) => report.figures.find((f) => f.id === id)!;

  it("computes base and derived figures with exact values and displays", () => {
    expect(fig("tiktok.spend")).toMatchObject({ status: "value", value: { kind: "money", minor: "33789", currency: "SAR" }, display: { en: "SAR 337.89", ar: "337.89 ر.س" } });
    expect(fig("tiktok.conversions").display).toEqual({ en: "29", ar: "29" });
    expect(fig("tiktok.ctr")).toMatchObject({ value: { numerator: "635", denominator: "30600" }, display: { en: "2.08%" } });
    expect(fig("tiktok.cpc").display!.en).toBe("SAR 0.53"); // 33789 / 635 = 53.21 halalas -> 53
    expect(fig("tiktok.cpa").display!.en).toBe("SAR 11.65"); // 33789 / 29 = 1165.14 -> 1165
    expect(fig("tiktok.spend").rawPayloadIds).toEqual([1, 2]);
  });

  it("says 'not provided' instead of inventing values", () => {
    // No purchase value synced (older rows or the platform sent none): both say so, nothing is guessed.
    expect(fig("tiktok.purchase_value")).toMatchObject({ status: "not_provided", reason: "Not provided by platform" });
    expect(fig("tiktok.roas")).toMatchObject({ status: "not_provided", reason: "Depends on a figure not provided by platform" });
    const r = buildReport({ period, channels: [{ ...tiktok, conversionsScaled: null }], total: null, digits: "latn" });
    expect(r.figures.find((f) => f.id === "tiktok.conversions")).toMatchObject({ status: "not_provided" });
    expect(r.figures.find((f) => f.id === "tiktok.cpa")).toMatchObject({ status: "not_provided" });
    const zero = buildReport({ period, channels: [{ ...tiktok, clicks: 0n }], total: null, digits: "latn" });
    expect(zero.figures.find((f) => f.id === "tiktok.cpc")).toMatchObject({ status: "not_applicable", reason: "No clicks" });
  });
});

describe("purchase value and ROAS", () => {
  const withValue = { ...tiktok, purchaseValueMinor: 386070n }; // SAR 3,860.70 on SAR 337.89 spend
  const r = buildReport({ period, channels: [withValue], total: null, digits: "latn" });
  const f = (id: string) => r.figures.find((x) => x.id === id);

  it("purchase value is money; ROAS = value / spend, exact numerator and denominator, display rounded half-up", () => {
    expect(f("tiktok.purchase_value")).toMatchObject({ status: "value", value: { kind: "money", minor: "386070", currency: "SAR" } });
    expect(f("tiktok.purchase_value")!.display!.en).toBe("SAR 3,860.70");
    expect(f("tiktok.roas")).toMatchObject({
      status: "value", value: { kind: "ratio", numerator: "386070", denominator: "33789", unit: "multiple", display: "11.43" },
      display: { en: "11.43", ar: "11.43" },
    });
  });

  it("no spend → ROAS not applicable; some days without a value → not provided; mixed currencies → not applicable", () => {
    const noSpend = buildReport({ period, channels: [{ ...withValue, spendMinor: 0n }], total: null, digits: "latn" });
    expect(noSpend.figures.find((x) => x.id === "tiktok.roas")).toMatchObject({ status: "not_applicable", reason: "No spend" });
    const partial = buildReport({ period, channels: [{ ...withValue, purchaseValueMinor: "partial" }], total: null, digits: "latn" });
    expect(partial.figures.find((x) => x.id === "tiktok.purchase_value")).toMatchObject({ status: "not_provided" });
    expect(partial.figures.find((x) => x.id === "tiktok.roas")).toMatchObject({ status: "not_provided" });
    const mixed = buildReport({ period, channels: [{ ...withValue, currency: null }], total: null, digits: "latn" });
    expect(mixed.figures.find((x) => x.id === "tiktok.roas")).toMatchObject({ status: "not_applicable" });
  });

  it("the automatic summary includes them, and the validator accepts their numbers", async () => {
    const out = await generateCommentary(null, r);
    expect(out.en).toContain("purchase value SAR 3,860.70");
    expect(out.en).toContain("return on ad spend 11.43");
    expect(out.en).not.toContain("Not available");
  });
});

describe("generateCommentary", () => {
  const report = buildReport({ period, channels: [tiktok], total: null, digits: "latn" });
  const model = (outputs: Array<{ ar: string; en: string } | Error>): CommentaryModel & { calls: string[] } => {
    const calls: string[] = [];
    return {
      name: "test-model",
      calls,
      async generate({ system }) {
        calls.push(system);
        const next = outputs.shift();
        if (!next) throw new Error("no more outputs");
        if (next instanceof Error) throw next;
        return next;
      },
    };
  };
  const good = {
    ar: "خلال الفترة أنفقت حملات تيك توك 337.89 ر.س وحققت 30,600 ظهور و635 نقرة و29 تحويل.",
    en: "TikTok spend was SAR 337.89, with 30,600 impressions, 635 clicks and 29 conversions.",
  };

  it("accepts valid model output on the first attempt and states missing metrics", async () => {
    const r = await generateCommentary(model([good]), report);
    expect(r.source).toBe("llm");
    expect(r.attempts).toHaveLength(1);
    expect(r.en).toContain(good.en);
    expect(r.en).toContain("Not available in this report: purchase value, return on ad spend.");
    expect(r.ar).toContain("غير متوفر في هذا التقرير");
  });

  it("retries once with a stricter instruction naming the bad numbers", async () => {
    const m = model([{ ...good, en: "Spend grew 12% to SAR 337.89." }, good]);
    const r = await generateCommentary(m, report);
    expect(r.source).toBe("llm");
    expect(r.attempts.map((a) => [a.kind, a.ok])).toEqual([["llm", false], ["llm_strict", true]]);
    expect(r.attempts[0]!.violations).toEqual(["en: number not in input: 12"]);
    expect(m.calls[1]).toContain("number not in input: 12");
  });

  it("falls back to the template after two failures, and logs every attempt", async () => {
    const bad = { ...good, ar: "ارتفع الإنفاق بنسبة 15٪." };
    const r = await generateCommentary(model([bad, bad]), report);
    expect(r.source).toBe("template");
    expect(r.attempts.map((a) => a.kind)).toEqual(["llm", "llm_strict", "template"]);
    expect(r.attempts[0]!.output).toEqual(bad); // rejected output kept for audit
  });

  it("falls back to the template when the model errors or isn't configured", async () => {
    const r = await generateCommentary(model([new Error("overloaded"), new Error("overloaded")]), report);
    expect(r.source).toBe("template");
    expect(r.attempts[0]!.error).toContain("overloaded");
    const none = await generateCommentary(null, report);
    expect(none).toMatchObject({ source: "template", model: null });
  });

  it("the template itself passes validation, in both digit styles", () => {
    for (const digits of ["latn", "arab"] as const) {
      const rep = buildReport({ period, channels: [tiktok], total: null, digits });
      const t = templateCommentary(rep);
      expect(validateText(t.ar, allowedFor(rep))).toEqual({ ok: true, violations: [] });
      expect(validateText(t.en, allowedFor(rep))).toEqual({ ok: true, violations: [] });
    }
    expect(templateCommentary(buildReport({ period, channels: [tiktok], total: null, digits: "arab" })).ar).toContain("٣٣٧٫٨٩ ر.س");
  });

  it("the model only ever sees figures, never raw payload ids or anything else", async () => {
    const r = await generateCommentary(model([good]), report);
    expect(JSON.stringify(r.input)).not.toMatch(/rawPayload|raw_payload|token|secret/i);
    expect(Object.keys(r.input).sort()).toEqual(["channels", "figures", "period"]);
  });
});

import { combine, metricLabel } from "../src/index.ts";
describe("purchase value from several sources", () => {
  it("adds the selected sources; one missing makes it not provided, one partial makes it partial", () => {
    expect(combine([100n, 250n])).toBe(350n);
    expect(combine([100n, null])).toBeNull();
    expect(combine([100n, "partial"])).toBe("partial");
    expect(combine([null, "partial"])).toBeNull();
  });

  it("names the sources in the label only when it is more than website purchases", () => {
    expect(metricLabel("purchase_value", "en")).toBe(metricLabel("purchase_value", "en", ["website"]));
    expect(metricLabel("purchase_value", "en", ["website", "shop"])).toBe("Purchase value (website + TikTok Shop)");
    expect(metricLabel("purchase_value", "ar", ["app"])).toContain("التطبيق");
    expect(metricLabel("spend", "en", ["website", "app"])).toBe("Spend");
  });
});
