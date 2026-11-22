import { type ReportModel, buildReport, formatDecimal, formatMoney, formatPercent, loadChannelTotals, roundRatio, trimDecimal } from "@glio/reports";
import type { SqlExecutor } from "@glio/sync";
import type { Period } from "./delta";
import { previousPeriod } from "./delta";

/**
 * SERVER ONLY. The live dashboard for a client and period, computed from the
 * stored daily metrics with the SAME code that builds reports (loadChannelTotals
 * + buildReport), so the dashboard and a report for the same period agree.
 * Nothing is stored; a report snapshot is still the record of what was sent.
 * Callers check the user can see the client (under RLS) first.
 */

export type ChartMetric = "spend" | "impressions" | "clicks" | "conversions";
export const CHART_METRICS: ChartMetric[] = ["spend", "clicks", "impressions", "conversions"];

export interface DailyPoint {
  date: string;
  /** null = no stored data for that day (not zero). Spend in minor units. */
  value: string | null;
  display: { en: string; ar: string } | null;
}

export interface CampaignRow {
  platform: string;
  id: string;
  name: string | null;
  currency: string;
  spend: { en: string; ar: string } | null;
  spendShare: number | null; // 0..1, for the bar only
  impressions: { en: string; ar: string } | null;
  clicks: { en: string; ar: string } | null;
  ctr: { en: string; ar: string } | null;
  conversions: { en: string; ar: string } | null;
  cpa: { en: string; ar: string } | null;
}

export interface Overview {
  period: Period;
  previous: Period;
  report: ReportModel;
  previousReport: ReportModel;
  currency: string | null;
  daily: Record<ChartMetric, DailyPoint[]>;
  campaigns: CampaignRow[];
  hasData: boolean;
}

const both = (fn: (lang: "en" | "ar") => string) => ({ en: fn("en"), ar: fn("ar") });

function eachDay(from: string, to: string): string[] {
  const out: string[] = [];
  for (let d = new Date(`${from}T00:00:00Z`); d <= new Date(`${to}T00:00:00Z`); d.setUTCDate(d.getUTCDate() + 1)) {
    out.push(d.toISOString().slice(0, 10));
  }
  return out;
}

export async function loadOverview(db: SqlExecutor, clientId: string, period: Period): Promise<Overview> {
  const previous = previousPeriod(period);
  const [cur, prev] = await Promise.all([
    loadChannelTotals(db, clientId, period),
    loadChannelTotals(db, clientId, previous),
  ]);
  const report = buildReport({ period, ...cur, digits: "latn" });
  const previousReport = buildReport({ period: previous, ...prev, digits: "latn" });
  const currency = report.currency;

  const dailyRows = await db.query(
    `select date::text as date, currency, count(*)::int as n,
            count(spend_minor)::int as n_spend, sum(spend_minor)::text as spend,
            count(impressions)::int as n_impr, sum(impressions)::text as impressions,
            count(clicks)::int as n_clicks, sum(clicks)::text as clicks,
            count(conversions)::int as n_conv, sum(conversions)::text as conversions
     from public.metric_daily
     where client_id = $1 and level = 'campaign' and date between $2 and $3
     group by date, currency order by date`,
    [clientId, period.from, period.to],
  );
  const days = eachDay(period.from, period.to);
  const pick = (metric: ChartMetric): DailyPoint[] =>
    days.map((date) => {
      const rows = dailyRows.filter((r) => r.date === date && (metric !== "spend" || r.currency === currency));
      if (rows.length === 0 || (metric === "spend" && !currency)) return { date, value: null, display: null };
      const nKey = { spend: "n_spend", impressions: "n_impr", clicks: "n_clicks", conversions: "n_conv" }[metric];
      if (rows.some((r) => r[nKey] < r.n)) return { date, value: null, display: null }; // partly missing: don't guess
      const total = rows.reduce((s, r) => s + scaled(r[metric], metric), 0n);
      if (metric === "spend") return { date, value: String(total), display: both((l) => formatMoney(total, currency!, l, "latn")) };
      if (metric === "conversions") {
        const text = unscale(total);
        return { date, value: text, display: both((l) => formatDecimal(text, l, "latn")) };
      }
      return { date, value: String(total), display: both((l) => formatDecimal(String(total), l, "latn")) };
    });
  const daily = { spend: pick("spend"), impressions: pick("impressions"), clicks: pick("clicks"), conversions: pick("conversions") };

  const campaignRows = await db.query(
    `select platform, entity_id, max(entity_name) as name, currency, count(*)::int as n,
            count(spend_minor)::int as n_spend, sum(spend_minor)::text as spend,
            count(impressions)::int as n_impr, sum(impressions)::text as impressions,
            count(clicks)::int as n_clicks, sum(clicks)::text as clicks,
            count(conversions)::int as n_conv, sum(conversions)::text as conversions
     from public.metric_daily
     where client_id = $1 and level = 'campaign' and date between $2 and $3
     group by platform, entity_id, currency
     order by sum(spend_minor) desc nulls last, entity_id
     limit 50`,
    [clientId, period.from, period.to],
  );
  const totalSpend = campaignRows.reduce((s, r) => (r.n_spend === r.n ? s + BigInt(r.spend ?? "0") : s), 0n);
  const campaigns: CampaignRow[] = campaignRows.map((r) => {
    const full = (k: string) => r[k] === r.n;
    const spend = full("n_spend") ? BigInt(r.spend ?? "0") : null;
    const impressions = full("n_impr") ? BigInt(r.impressions ?? "0") : null;
    const clicks = full("n_clicks") ? BigInt(r.clicks ?? "0") : null;
    const conv = full("n_conv") ? scaled(r.conversions, "conversions") : null;
    return {
      platform: r.platform,
      id: r.entity_id,
      name: r.name,
      currency: r.currency,
      spend: spend === null ? null : both((l) => formatMoney(spend, r.currency, l, "latn")),
      spendShare: spend !== null && totalSpend > 0n && r.currency === currency ? Number((spend * 10000n) / totalSpend) / 10000 : null,
      impressions: impressions === null ? null : both((l) => formatDecimal(String(impressions), l, "latn")),
      clicks: clicks === null ? null : both((l) => formatDecimal(String(clicks), l, "latn")),
      ctr: clicks !== null && impressions ? both((l) => formatPercent(roundRatio(clicks * 100n, impressions, 2), l, "latn")) : null,
      conversions: conv === null ? null : both((l) => formatDecimal(unscale(conv), l, "latn")),
      cpa: spend !== null && conv ? both((l) => formatMoney(BigInt(roundRatio(spend * 10_000n, conv, 0)), r.currency, l, "latn")) : null,
    };
  });

  return { period, previous, report, previousReport, currency, daily, campaigns, hasData: dailyRows.length > 0 };
}

/** Conversions are numeric(20,4): keep them as integers x 10^4 for exact sums. */
function scaled(text: string | null, metric: ChartMetric): bigint {
  if (text === null) return 0n;
  if (metric !== "conversions") return BigInt(text);
  const [whole = "0", frac = ""] = text.split(".");
  return BigInt(whole + frac.padEnd(4, "0").slice(0, 4));
}
function unscale(v: bigint): string {
  return trimDecimal(`${v / 10_000n}.${(v % 10_000n).toString().padStart(4, "0")}`);
}
