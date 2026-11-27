import { after } from "next/server";
import { DEMO_EXTERNAL_ID, TikTokConnector } from "@glio/connectors";
import { addDays, minorUnitDigits, todayIn } from "@glio/core";
import { formatDecimal, formatMoney, roundRatio, trimDecimal } from "@glio/reports";
import { INTRADAY_MIN_INTERVAL_MINUTES, type SqlExecutor, VaultSecretStore, clientValueSources, refreshIntraday } from "@glio/sync";

/**
 * SERVER ONLY. "Today so far" for a client page (ADR-033): refreshes TikTok's
 * provisional figures for today when they are older than 10 minutes (and
 * yesterday's hours once a day, for comparison), then reads them back. Callers
 * check the user's access first. Provisional data never reaches reports.
 */

export type HourMetric = "spend" | "clicks" | "conversions";
export const HOUR_METRICS: HourMetric[] = ["spend", "clicks", "conversions"];
type Both = { en: string; ar: string };

export interface TodayCampaign {
  id: string;
  name: string | null;
  spend: Both | null;
  purchaseValue: Both | null;
  roas: Both | null;
  conversions: Both | null;
  clicks: Both | null;
}

export interface TodayView {
  day: string;
  timezone: string;
  /** The hour now in progress (account time zone): its figures are still growing. */
  currentHour: number;
  /** Last successful refresh of today (ISO), or null if never. */
  updatedAt: string | null;
  /** The latest refresh failed after the last success. */
  failure: { code: string; at: string } | null;
  currency: string | null;
  totals: { spend: Both | null; purchaseValue: Both | null; roas: Both | null; conversions: Both | null; clicks: Both | null };
  /** Per hour 0-23, plotted values (money in major units); null = no data (yet). */
  hourly: Record<HourMetric, { today: Array<number | null>; yesterday: Array<number | null> }>;
  campaigns: TodayCampaign[];
}

const both = (fn: (l: "en" | "ar") => string): Both => ({ en: fn("en"), ar: fn("ar") });
const SCALE = 10_000n;
function scaled(text: string | null): bigint {
  if (text === null) return 0n;
  const [w = "0", f = ""] = text.split(".");
  return BigInt(w + f.padEnd(4, "0").slice(0, 4));
}
const unscale = (v: bigint) => trimDecimal(`${v / SCALE}.${(v % SCALE).toString().padStart(4, "0")}`);

function validZone(tz: string | null): string {
  if (!tz) return "Asia/Riyadh";
  try {
    new Intl.DateTimeFormat("en-CA", { timeZone: tz });
    return tz;
  } catch {
    return "Asia/Riyadh";
  }
}

/** Minutes since midnight in a time zone (a refresh of "yesterday" older than this was taken before the day ended). */
function minutesSinceMidnight(tz: string, now = new Date()): number {
  const p = new Intl.DateTimeFormat("en-GB", { timeZone: tz, hour: "2-digit", minute: "2-digit", hourCycle: "h23" }).formatToParts(now);
  const get = (t: string) => Number(p.find((x) => x.type === t)?.value ?? 0);
  return get("hour") * 60 + get("minute");
}

async function refreshAll(db: SqlExecutor, accounts: Array<{ id: string }>, day: string, tz: string, force: boolean) {
  const deps = { db, connector: new TikTokConnector(), secrets: new VaultSecretStore(db), retry: { attempts: 2 } };
  const sinceMidnight = Math.max(1, minutesSinceMidnight(tz));
  await Promise.all(accounts.map(async (a) => {
    const t = await refreshIntraday(deps, { adAccountId: a.id, day, grains: ["day", "hour"], minIntervalMinutes: force ? 1 : INTRADAY_MIN_INTERVAL_MINUTES });
    const y = await refreshIntraday(deps, { adAccountId: a.id, day: addDays(day, -1), grains: ["hour"], minIntervalMinutes: sinceMidnight });
    for (const r of [t, y]) {
      if (r.status === "failed") console.error(JSON.stringify({ event: "intraday_refresh_failed", account: a.id, code: r.errorCode }));
    }
  }));
}

/** Null when the client has no connected (non-demo) TikTok account. */
export async function loadToday(db: SqlExecutor, clientId: string, opts: { refresh: boolean; force?: boolean }): Promise<TodayView | null> {
  const accounts = await db.query(
    `select id, timezone from public.ad_accounts
     where client_id = $1 and platform = 'tiktok' and status = 'active' and external_id <> $2 order by created_at`,
    [clientId, DEMO_EXTERNAL_ID],
  );
  if (accounts.length === 0) return null;
  const timezone = validZone(accounts[0]!.timezone as string | null);
  const day = todayIn(timezone);

  if (opts.refresh) {
    // Never hold the page for long: after 8 s show what is stored and let the refresh finish in the background.
    const work = refreshAll(db, accounts as Array<{ id: string }>, day, timezone, Boolean(opts.force)).catch((err) =>
      console.error(JSON.stringify({ event: "intraday_refresh_failed", error: String(err).slice(0, 200) })));
    const finished = await Promise.race([work.then(() => true), new Promise<boolean>((r) => setTimeout(() => r(false), 8000))]);
    if (!finished) after(() => work);
  }

  const [runs, dayRows, hourRows] = await Promise.all([
    db.query(
      `select status, error_code, coalesce(finished_at, started_at) as at from public.sync_runs
       where client_id = $1 and kind = 'intraday' and date_from = $2 order by started_at desc limit 20`,
      [clientId, day],
    ),
    db.query(
      `select entity_id, max(entity_name) as name, currency,
              sum(spend_minor)::text as spend, count(spend_minor)::int as n_spend,
              sum(purchase_value_minor)::text as web_value, count(purchase_value_minor)::int as n_web,
              sum(app_purchase_value_minor)::text as app_value, count(app_purchase_value_minor)::int as n_app,
              sum(shop_revenue_minor)::text as shop_value, count(shop_revenue_minor)::int as n_shop,
              sum(conversions)::text as conv, count(conversions)::int as n_conv,
              sum(clicks)::text as clicks, count(clicks)::int as n_clicks, count(*)::int as n
       from public.metric_intraday where client_id = $1 and day = $2 and grain = 'day'
       group by entity_id, currency order by sum(spend_minor) desc nulls last, entity_id`,
      [clientId, day],
    ),
    db.query(
      `select day::text as day, hour, currency, sum(spend_minor)::text as spend, sum(clicks)::text as clicks, sum(conversions)::text as conv
       from public.metric_intraday where client_id = $1 and day in ($2::date, $3::date) and grain = 'hour'
       group by day, hour, currency`,
      [clientId, day, addDays(day, -1)],
    ),
  ]);

  const lastOk = runs.find((r) => r.status === "succeeded");
  const latest = runs.find((r) => r.status !== "running");
  const failure = latest && latest.status === "failed" && (!lastOk || new Date(latest.at) > new Date(lastOk.at))
    ? { code: String(latest.error_code ?? "UNKNOWN"), at: new Date(latest.at).toISOString() } : null;

  const currencies = [...new Set(dayRows.map((r) => r.currency as string))];
  const currency = currencies.length === 1 ? currencies[0]! : null;
  const money = (v: bigint, cur: string) => both((l) => formatMoney(v, cur, l, "latn"));
  const count = (v: bigint) => both((l) => formatDecimal(String(v), l, "latn"));

  // Purchase value = the client's chosen sources; computed per row so the totals below follow the same rule.
  const sources = await clientValueSources(db, clientId);
  for (const r of dayRows) {
    const parts = sources.map((s) => {
      const [sum, n] = s === "app" ? [r.app_value, r.n_app] : s === "shop" ? [r.shop_value, r.n_shop] : [r.web_value, r.n_web];
      return n === r.n ? BigInt((sum as string) ?? "0") : null;
    });
    r.n_value = parts.some((p) => p === null) ? 0 : r.n;
    r.value = parts.some((p) => p === null) ? null : String(parts.reduce<bigint>((a, b) => a + (b as bigint), 0n));
  }
  const campaigns: TodayCampaign[] = dayRows.map((r) => {
    const spend = r.n_spend === r.n ? BigInt(r.spend ?? "0") : null;
    const value = r.n_value === r.n ? BigInt(r.value ?? "0") : null;
    return {
      id: r.entity_id, name: r.name,
      spend: spend === null ? null : money(spend, r.currency),
      purchaseValue: value === null ? null : money(value, r.currency),
      roas: spend && value !== null ? both((l) => formatDecimal(roundRatio(value, spend, 2), l, "latn")) : null,
      conversions: r.n_conv === r.n ? both((l) => formatDecimal(unscale(scaled(r.conv)), l, "latn")) : null,
      clicks: r.n_clicks === r.n ? count(BigInt(r.clicks ?? "0")) : null,
    };
  });

  const sum = (pick: (r: Record<string, unknown>) => bigint | null): bigint | null => {
    let total = 0n;
    for (const r of dayRows) {
      const v = pick(r);
      if (v === null) return null;
      total += v;
    }
    return dayRows.length ? total : null;
  };
  const spend = currency ? sum((r) => (r.n_spend === r.n ? BigInt((r.spend as string) ?? "0") : null)) : null;
  const value = currency ? sum((r) => (r.n_value === r.n ? BigInt((r.value as string) ?? "0") : null)) : null;
  const conv = sum((r) => (r.n_conv === r.n ? scaled(r.conv as string | null) : null));
  const clicks = sum((r) => (r.n_clicks === r.n ? BigInt((r.clicks as string) ?? "0") : null));

  const digits = currency ? minorUnitDigits(currency) : 2;
  const series = (d: string, metric: HourMetric): Array<number | null> => {
    const rows = hourRows.filter((r) => r.day === d && (metric !== "spend" || r.currency === currency));
    if (rows.length === 0) return Array(24).fill(null);
    const last = Math.max(...rows.map((r) => Number(r.hour)));
    return Array.from({ length: 24 }, (_, h) => {
      if (h > last) return null; // not reported yet
      const v = rows.filter((r) => Number(r.hour) === h).reduce((s, r) => {
        const raw = r[metric === "conversions" ? "conv" : metric] as string | null;
        return s + (metric === "spend" ? Number(raw ?? 0) / 10 ** digits : Number(raw ?? 0));
      }, 0);
      return v; // an hour TikTok didn't report before a later one had no activity
    });
  };
  const hourly = Object.fromEntries(HOUR_METRICS.map((m) => [m, { today: series(day, m), yesterday: series(addDays(day, -1), m) }])) as TodayView["hourly"];

  return {
    day, timezone, currentHour: Math.floor(minutesSinceMidnight(timezone) / 60), updatedAt: lastOk ? new Date(lastOk.at).toISOString() : null, failure, currency,
    totals: {
      spend: spend === null ? null : money(spend, currency!),
      purchaseValue: value === null ? null : money(value, currency!),
      roas: spend && value !== null ? both((l) => formatDecimal(roundRatio(value, spend, 2), l, "latn")) : null,
      conversions: conv === null ? null : both((l) => formatDecimal(unscale(conv), l, "latn")),
      clicks: clicks === null ? null : count(clicks),
    },
    hourly, campaigns,
  };
}
