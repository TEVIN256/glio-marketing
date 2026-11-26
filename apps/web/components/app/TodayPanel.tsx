import type { HourMetric, TodayView } from "@/lib/today";
import { HOUR_METRICS } from "@/lib/today";
import { hintFor } from "@/lib/errors";
import { riyadhDateTime } from "@/lib/sync-status";
import { AutoRefresh } from "./AutoRefresh";

type T = Record<string, string>;

/** "Today so far": provisional, refreshed at most every 10 minutes (ADR-033). Server component. */
export function TodayPanel({ view, metric, lang, t, hrefFor, refresh }: {
  view: TodayView;
  metric: HourMetric;
  lang: "ar" | "en";
  t: T;
  /** Link that keeps the page as it is and switches the hourly chart's metric. */
  hrefFor: (m: HourMetric) => string;
  /** The refresh form's action and hidden fields. */
  refresh: { action: (formData: FormData) => Promise<void>; fields: Record<string, string> };
}) {
  const tiles: Array<[string, { en: string; ar: string } | null]> = [
    [t.todaySpend, view.totals.spend], [t.todayPurchaseValue, view.totals.purchaseValue], [t.todayRoas, view.totals.roas],
    [t.todayConversions, view.totals.conversions], [t.todayClicks, view.totals.clicks],
  ];
  const metricLabel: Record<HourMetric, string> = { spend: t.todaySpend, clicks: t.todayClicks, conversions: t.todayConversions };
  const updated = view.updatedAt ? riyadhDateTime(view.updatedAt).slice(11) : null;

  return (
    <section id="today" className="card stack today-card" aria-labelledby="today-h">
      <AutoRefresh minutes={10} />
      <div className="card-head">
        <h2 id="today-h">{t.todayTitle} <span className="badge other">{t.todayProvisional}</span></h2>
        <form action={refresh.action} className="today-refresh">
          {Object.entries(refresh.fields).map(([k, v]) => <input key={k} type="hidden" name={k} value={v} />)}
          <span className="muted small">
            {updated ? <>{t.todayUpdated} <span className="num">{updated}</span> {t.todayRiyadh}</> : t.todayNotYet}
          </span>
          <button type="submit" className="secondary">{t.todayRefresh}</button>
        </form>
      </div>
      {view.failure && (
        <p className="notice warn" role="status">
          {t.todayFailed} {hintFor(view.failure.code, lang)} <code className="num">({view.failure.code})</code>
        </p>
      )}
      <div className="today-tiles">
        {tiles.map(([label, v]) => (
          <div key={label} className="today-tile">
            <div className="kpi-label">{label}</div>
            {v ? <div className="today-value"><span className="num">{v[lang]}</span></div> : <div className="kpi-missing">{t.todayNone}</div>}
          </div>
        ))}
      </div>

      <div className="today-chart-head">
        <h3>{t.todayByHour}</h3>
        <nav className="tabs" aria-label={t.todayByHour}>
          {HOUR_METRICS.map((m) => (
            <a key={m} href={hrefFor(m)} className={m === metric ? "tab active" : "tab"} aria-current={m === metric ? "true" : undefined}>{metricLabel[m]}</a>
          ))}
        </nav>
      </div>
      <HourlyChart today={view.hourly[metric].today} yesterday={view.hourly[metric].yesterday}
        labels={{ today: t.todayLegendToday, yesterday: t.todayLegendYesterday, none: t.todayNoHours }}
        title={`${metricLabel[metric]} · ${t.todayByHour}`} />
      <p className="fine-print">{t.todayNote.replace("{tz}", view.timezone)}</p>

      {view.campaigns.length > 0 && (
        <details className="today-campaigns">
          <summary>{t.todayByCampaign} <span className="muted">({view.campaigns.length})</span></summary>
          <div className="table-wrap">
            <table className="data-table compact">
              <thead>
                <tr>
                  <th scope="col">{t.campaign}</th>
                  <th scope="col" className="n">{t.todaySpend}</th>
                  <th scope="col" className="n">{t.todayPurchaseValue}</th>
                  <th scope="col" className="n">{t.todayRoas}</th>
                  <th scope="col" className="n">{t.todayConversions}</th>
                  <th scope="col" className="n">{t.todayClicks}</th>
                </tr>
              </thead>
              <tbody>
                {view.campaigns.map((c) => (
                  <tr key={c.id}>
                    <th scope="row"><span className="campaign-name">{c.name ?? c.id}</span></th>
                    {[c.spend, c.purchaseValue, c.roas, c.conversions, c.clicks].map((v, i) => (
                      <td key={i} className="n">{v ? <span className="num">{v[lang]}</span> : <span className="muted">—</span>}</td>
                    ))}
                  </tr>
                ))}
              </tbody>
            </table>
          </div>
        </details>
      )}
    </section>
  );
}

function compact(v: number): string {
  if (v >= 1_000_000) return `${+(v / 1_000_000).toFixed(1)}M`;
  if (v >= 1000) return `${+(v / 1000).toFixed(1)}K`;
  return `${+v.toFixed(v < 10 ? 1 : 0)}`;
}

/** 24 hours left to right (also in Arabic: a time axis), today solid, yesterday faint and dashed. */
function HourlyChart({ today, yesterday, labels, title }: {
  today: Array<number | null>; yesterday: Array<number | null>;
  labels: { today: string; yesterday: string; none: string }; title: string;
}) {
  const W = 720, H = 180, L = 44, R = 10, TOP = 10, B = 24;
  const values = [...today, ...yesterday].filter((v): v is number => v !== null);
  if (values.length === 0) return <p className="muted">{labels.none}</p>;
  const max = Math.max(...values, 1);
  const x = (h: number) => L + (h * (W - L - R)) / 23;
  const y = (v: number) => TOP + (H - TOP - B) * (1 - v / max);
  const path = (s: Array<number | null>) => s.map((v, h) => (v === null ? "" : `${s[h - 1] == null ? "M" : "L"}${x(h).toFixed(1)},${y(v).toFixed(1)}`)).join(" ");
  const lastToday = today.reduce<number>((last, v, h) => (v === null ? last : h), -1);
  const area = lastToday >= 0 && today.slice(0, lastToday + 1).every((v) => v !== null)
    ? `${path(today)} L${x(lastToday).toFixed(1)},${y(0).toFixed(1)} L${x(0).toFixed(1)},${y(0).toFixed(1)} Z` : "";
  return (
    <figure className="hourly-chart" dir="ltr">
      <svg viewBox={`0 0 ${W} ${H}`} role="img" aria-label={title} preserveAspectRatio="none">
        {[0, 0.5, 1].map((f) => (
          <g key={f}>
            <line x1={L} x2={W - R} y1={y(max * f)} y2={y(max * f)} className="grid" />
            <text x={L - 6} y={y(max * f) + 4} textAnchor="end" className="tick">{compact(max * f)}</text>
          </g>
        ))}
        {[0, 3, 6, 9, 12, 15, 18, 21].map((h) => (
          <text key={h} x={x(h)} y={H - 6} textAnchor="middle" className="tick">{String(h).padStart(2, "0")}:00</text>
        ))}
        <path d={path(yesterday)} className="line-yesterday" />
        {area && <path d={area} className="area-today" />}
        <path d={path(today)} className="line-today" />
      </svg>
      <figcaption className="legend">
        <span className="key today" /> {labels.today} <span className="key yesterday" /> {labels.yesterday}
      </figcaption>
    </figure>
  );
}
