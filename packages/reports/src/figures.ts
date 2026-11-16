import { type Digits, formatDecimal, formatMoney, formatPercent, roundRatio, trimDecimal } from "./format.ts";

/**
 * A report is a list of FIGURES. Every figure has a stable id, an exact
 * value (or an explicit reason it has none), its display text in English and
 * Arabic, and the raw platform payloads it was computed from.
 *
 * Base metrics (spend, impressions, clicks, conversions) are sums of stored
 * daily rows. Derived metrics (CTR, CPC, CPA) are computed here from exact
 * integers; only their DISPLAY is rounded (half-up), and the exact numerator
 * and denominator are kept in the figure.
 */

export type MetricId = "spend" | "impressions" | "clicks" | "conversions" | "ctr" | "cpc" | "cpa" | "roas";
export type FigureStatus = "value" | "not_provided" | "not_applicable";

export type FigureValue =
  | { kind: "money"; minor: string; currency: string }
  | { kind: "count"; value: string }
  | { kind: "decimal"; value: string }
  | { kind: "ratio"; numerator: string; denominator: string; unit: "percent" | "money_minor"; currency?: string; display: string };

export interface Figure {
  id: string; // e.g. "tiktok.spend", "total.ctr"
  scope: string; // platform id or "total"
  metric: MetricId;
  status: FigureStatus;
  value?: FigureValue;
  display?: { en: string; ar: string };
  reason?: string; // why there is no value
  rawPayloadIds: number[];
}

/** Sums for one platform (or the total) as loaded from metric_daily. */
export interface ChannelTotals {
  scope: string;
  currency: string | null; // null when channels with different currencies are combined
  rows: number;
  spendMinor: bigint | null | "partial";
  impressions: bigint | null | "partial";
  clicks: bigint | null | "partial";
  conversionsScaled: bigint | null | "partial"; // conversions x 10^4
  rawPayloadIds: number[];
  reconciliation: "ok" | "drift" | "not_comparable" | "unchecked";
}

export interface ReportModel {
  version: 1;
  period: { from: string; to: string };
  currency: string | null;
  digits: Digits;
  channels: Array<{ scope: string; currency: string | null; reconciliation: ChannelTotals["reconciliation"] }>;
  figures: Figure[];
}

export const METRIC_LABELS: Record<MetricId, { en: string; ar: string }> = {
  spend: { en: "Spend", ar: "الإنفاق" },
  impressions: { en: "Impressions", ar: "مرات الظهور" },
  clicks: { en: "Clicks", ar: "النقرات" },
  conversions: { en: "Conversions", ar: "التحويلات" },
  ctr: { en: "Click-through rate", ar: "نسبة النقر إلى الظهور" },
  cpc: { en: "Cost per click", ar: "تكلفة النقرة" },
  cpa: { en: "Cost per conversion", ar: "تكلفة التحويل" },
  roas: { en: "Return on ad spend", ar: "العائد على الإنفاق الإعلاني" },
};

export const SCOPE_LABELS: Record<string, { en: string; ar: string }> = {
  total: { en: "All channels", ar: "جميع القنوات" },
  tiktok: { en: "TikTok", ar: "تيك توك" },
  snapchat: { en: "Snapchat", ar: "سناب شات" },
  meta: { en: "Meta", ar: "ميتا" },
  google_ads: { en: "Google Ads", ar: "إعلانات جوجل" },
  google_business_profile: { en: "Google Business Profile", ar: "ملف جوجل التجاري" },
};

const CONV_SCALE = 10_000n;

export function buildReport(args: {
  period: { from: string; to: string };
  channels: ChannelTotals[];
  total: ChannelTotals | null;
  digits: Digits;
}): ReportModel {
  const { digits } = args;
  const figures: Figure[] = [];
  const all = args.total ? [...args.channels, args.total] : args.channels;

  for (const c of all) {
    const fig = (metric: MetricId, rest: Omit<Figure, "id" | "scope" | "metric" | "rawPayloadIds">): Figure => ({
      id: `${c.scope}.${metric}`, scope: c.scope, metric, rawPayloadIds: c.rawPayloadIds, ...rest,
    });
    const missing = (metric: MetricId, v: unknown): Figure | null =>
      v === null ? fig(metric, { status: "not_provided", reason: "Not provided by platform" })
      : v === "partial" ? fig(metric, { status: "not_provided", reason: "Not provided by platform for some days" })
      : null;

    // Base metrics
    figures.push(
      missing("spend", c.spendMinor) ??
        (c.currency === null
          ? fig("spend", { status: "not_applicable", reason: "Channels use different currencies" })
          : fig("spend", {
              status: "value",
              value: { kind: "money", minor: String(c.spendMinor), currency: c.currency },
              display: {
                en: formatMoney(c.spendMinor as bigint, c.currency, "en", digits),
                ar: formatMoney(c.spendMinor as bigint, c.currency, "ar", digits),
              },
            })),
    );
    for (const metric of ["impressions", "clicks"] as const) {
      const v = c[metric];
      figures.push(
        missing(metric, v) ??
          fig(metric, {
            status: "value",
            value: { kind: "count", value: String(v) },
            display: { en: formatDecimal(String(v), "en", digits), ar: formatDecimal(String(v), "ar", digits) },
          }),
      );
    }
    const conv = c.conversionsScaled;
    const convText = typeof conv === "bigint" ? trimDecimal(`${conv / CONV_SCALE}.${(conv % CONV_SCALE).toString().padStart(4, "0")}`) : "";
    figures.push(
      missing("conversions", conv) ??
        fig("conversions", {
          status: "value",
          value: { kind: "decimal", value: convText },
          display: { en: formatDecimal(convText, "en", digits), ar: formatDecimal(convText, "ar", digits) },
        }),
    );

    // Derived metrics
    const ratio = (
      metric: MetricId,
      num: bigint | null | "partial",
      den: bigint | null | "partial",
      compute: (n: bigint, d: bigint) => FigureValue & { kind: "ratio" },
      zeroReason: string,
    ): Figure => {
      if (typeof num !== "bigint" || typeof den !== "bigint") {
        return fig(metric, { status: "not_provided", reason: "Depends on a figure not provided by platform" });
      }
      if (den === 0n) return fig(metric, { status: "not_applicable", reason: zeroReason });
      const value = compute(num, den);
      return fig(metric, { status: "value", value, display: displayRatio(value, digits) });
    };

    figures.push(
      ratio("ctr", c.clicks, c.impressions, (n, d) => ({
        kind: "ratio", numerator: String(n), denominator: String(d), unit: "percent", display: roundRatio(n * 100n, d, 2),
      }), "No impressions"),
    );
    figures.push(
      c.currency === null
        ? fig("cpc", { status: "not_applicable", reason: "Channels use different currencies" })
        : ratio("cpc", c.spendMinor, c.clicks, (n, d) => ({
            kind: "ratio", numerator: String(n), denominator: String(d), unit: "money_minor", currency: c.currency!, display: roundRatio(n, d, 0),
          }), "No clicks"),
    );
    figures.push(
      c.currency === null
        ? fig("cpa", { status: "not_applicable", reason: "Channels use different currencies" })
        : ratio("cpa", typeof c.spendMinor === "bigint" ? c.spendMinor * CONV_SCALE : c.spendMinor, c.conversionsScaled, (n, d) => ({
            kind: "ratio", numerator: String(n), denominator: String(d), unit: "money_minor", currency: c.currency!, display: roundRatio(n, d, 0),
          }), "No conversions"),
    );
    // Revenue isn't connected in Stage 1 (Salla/Zid/GA4 come later).
    figures.push(fig("roas", { status: "not_provided", reason: "Revenue source not connected" }));
  }

  return {
    version: 1,
    period: args.period,
    currency: args.total?.currency ?? args.channels[0]?.currency ?? null,
    digits,
    channels: args.channels.map((c) => ({ scope: c.scope, currency: c.currency, reconciliation: c.reconciliation })),
    figures,
  };
}

function displayRatio(v: FigureValue & { kind: "ratio" }, digits: Digits): { en: string; ar: string } {
  if (v.unit === "percent") return { en: formatPercent(v.display, "en", digits), ar: formatPercent(v.display, "ar", digits) };
  const minor = BigInt(v.display);
  return { en: formatMoney(minor, v.currency!, "en", digits), ar: formatMoney(minor, v.currency!, "ar", digits) };
}
