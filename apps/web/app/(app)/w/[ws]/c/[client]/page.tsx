import { notFound } from "next/navigation";
import { DEMO_EXTERNAL_ID } from "@glio/connectors";
import { minorUnitDigits, todayIn } from "@glio/core";
import { type Figure, METRIC_LABELS, type MetricId } from "@glio/reports";
import { CampaignTable } from "@/components/app/CampaignTable";
import { DateRange } from "@/components/app/DateRange";
import { Kpi } from "@/components/app/Kpi";
import { PageHeader } from "@/components/app/PageHeader";
import { TrendChart, shortDate } from "@/components/app/TrendChart";
import { isolateNumbers } from "@/components/ReportView";
import { clientAccess } from "@/lib/authz";
import { CHART_METRICS, type ChartMetric, loadOverview } from "@/lib/dashboard";
import { type Period, type PresetKey, PRESET_KEYS, figureDelta, matchPreset, presetPeriod } from "@/lib/delta";
import { env } from "@/lib/env";
import { ERROR_HINTS } from "@/lib/errors";
import { getDict } from "@/lib/i18n";
import { serverDb } from "@/lib/server-db";
import { connectTikTok, generateReport, loadDemoData, saveReportSchedule, sendReportNow, syncTikTok } from "./actions";

const ISO = /^\d{4}-\d{2}-\d{2}$/;
const KPI_ORDER: MetricId[] = ["spend", "impressions", "clicks", "conversions", "ctr", "cpc", "cpa", "roas"];
const fill = (text: string, n: string | number | undefined) => text.replace("{n}", String(Number(n) || 0));

export default async function ClientDashboard({
  params, searchParams,
}: { params: Promise<{ ws: string; client: string }>; searchParams: Promise<Record<string, string | undefined>> }) {
  const { ws, client } = await params;
  const q = await searchParams;
  const { lang, t } = await getDict();
  const access = await clientAccess(ws, client);
  if (!access.canView || !access.client) notFound();
  const { supabase, user } = access;

  // Period: a preset (?p=30d), or a custom range (?from&to); default last 30 complete days (Riyadh).
  const today = todayIn("Asia/Riyadh");
  const preset = PRESET_KEYS.includes(q.p as PresetKey) ? (q.p as PresetKey) : null;
  const custom = ISO.test(q.from ?? "") && ISO.test(q.to ?? "") && q.to! >= q.from! ? { from: q.from!, to: q.to! } : null;
  const period: Period = preset ? presetPeriod(preset, today) : custom ?? presetPeriod("30d", today);
  const activePreset = matchPreset(period, today);
  const metric: ChartMetric = CHART_METRICS.includes(q.m as ChartMetric) ? (q.m as ChartMetric) : "spend";
  const base = `/w/${ws}/c/${client}`;
  const keepRange: Record<string, string> = activePreset ? { p: activePreset } : { from: period.from, to: period.to };

  const [overview, { data: workspace }, { data: snapshots }, { data: tiktokRows }, { data: schedule }, { data: recentDeliveries }] = await Promise.all([
    // Server read AFTER the RLS check above (clientAccess).
    loadOverview(serverDb(), client, period),
    supabase.from("workspaces").select("name").eq("id", ws).maybeSingle(),
    supabase.from("report_snapshots").select("id, date_from, date_to, created_at, commentary_id").eq("client_id", client)
      .order("created_at", { ascending: false }).limit(6),
    supabase.from("ad_accounts").select("id, name, external_id, currency, status").eq("client_id", client).eq("platform", "tiktok").order("created_at"),
    supabase.from("report_schedules").select("frequency, send_weekday, language, recipients").eq("client_id", client).maybeSingle(),
    supabase.from("report_deliveries").select("id, recipient, status, period_from, period_to, created_at, error_code")
      .eq("client_id", client).order("created_at", { ascending: false }).limit(5),
  ]);
  const latest = snapshots?.[0];
  const { data: commentary } = latest
    ? await supabase.from("ai_commentary").select("text_ar, text_en, source").eq("id", latest.commentary_id).maybeSingle()
    : { data: null };

  await supabase.from("audit_log").insert({
    workspace_id: ws, actor_kind: "user", actor_user_id: user.id, action: "client.viewed", entity_type: "client", entity_id: client,
  });

  const tiktokAccounts = (tiktokRows ?? []).filter((a) => a.external_id !== DEMO_EXTERNAL_ID);
  const statusLabel: Record<string, string> = { active: t.statusActive, pending: t.statusPending, disconnected: t.statusDisconnected, error: t.statusError };
  const freqLabel: Record<string, string> = { off: t.freqOff, weekly: t.freqWeekly, monthly: t.freqMonthly };
  const weekdays = [7, 1, 2, 3, 4, 5, 6] as const;
  const days = overview.daily.spend.length;

  // Tiles: the combined total when there are several channels, else the one channel.
  const { report, previousReport } = overview;
  const scope = report.figures.some((f) => f.scope === "total") ? "total" : report.channels[0]?.scope;
  const fig = (r: typeof report, m: MetricId): Figure | undefined => r.figures.find((f) => f.scope === scope && f.metric === m);
  const recon = report.channels.map((c) => c.reconciliation);
  const reconState = recon.includes("drift") ? "drift" : recon.length === 0 ? null : recon.every((r) => r === "ok") ? "ok" : "other";

  // Chart series for the chosen metric. Money is plotted in major units; tooltips show the exact text.
  const digits = overview.currency ? minorUnitDigits(overview.currency) : 0;
  const points = overview.daily[metric].map((p) => ({
    date: p.date,
    value: p.value === null ? null : metric === "spend" ? Number(p.value) / 10 ** digits : Number(p.value),
    label: p.display ? p.display[lang] : null,
  }));
  const metricTabs = CHART_METRICS.filter((m) => m !== "spend" || overview.currency);

  const notices = (
    <>
      {q.e === "forbidden" && <p className="notice error" role="alert">{t.notAllowed}</p>}
      {q.e === "period" && <p className="notice error" role="alert">{t.periodError}</p>}
      {q.e === "recipients" && <p className="notice error" role="alert">{t.emailRecipientsError}</p>}
      {(q.e === "report" || q.e === "demo" || q.e === "tiktok" || q.e === "sync" || q.e === "email") && (
        <p className="notice error" role="alert">
          {{ report: t.reportError, demo: t.demoError, tiktok: t.tiktokError, sync: t.syncError, email: t.emailError }[q.e]}{" "}
          {q.code && ERROR_HINTS[q.code] ? ERROR_HINTS[q.code]![lang] : null}{" "}
          {q.code && <code className="num">({q.code})</code>}
        </p>
      )}
      {q.tt === "connected" && (
        <p className="notice" role="status">{fill(t.tiktokConnected, q.n)} {Number(q.c) > 0 && fill(t.tiktokConflicts, q.c)}</p>
      )}
      {q.tt === "synced" && <p className="notice" role="status">{t.tiktokSynced}</p>}
      {q.mail === "saved" && <p className="notice" role="status">{t.emailSaved}</p>}
      {q.mail === "sent" && (
        <p className={Number(q.f) > 0 ? "notice warn" : "notice"} role="status">
          {fill(t.emailSent, q.n)} {Number(q.f) > 0 && fill(t.emailFailed, q.f)}{" "}
          {Number(q.f) > 0 && q.code && ERROR_HINTS[q.code] ? ERROR_HINTS[q.code]![lang] : null}
        </p>
      )}
    </>
  );

  return (
    <div className="page">
      <PageHeader
        crumbs={[{ href: "/app", label: t.workspaces }, { href: `/w/${ws}`, label: workspace?.name ?? t.clients }]}
        title={access.client.name}
        subtitle={
          <>
            <span className="num">{period.from} → {period.to}</span>
            {reconState && (
              <span className={`badge ${reconState === "ok" ? "ok" : reconState === "drift" ? "drift" : "other"}`}>
                {reconState === "ok" ? t.reconOk : reconState === "drift" ? t.reconDrift : t.reconUnchecked}
              </span>
            )}
          </>
        }
        actions={access.canGenerate && (
          <form className="header-actions" action={generateReport}>
            <input type="hidden" name="ws" value={ws} />
            <input type="hidden" name="client" value={client} />
            <input type="hidden" name="from" value={period.from} />
            <input type="hidden" name="to" value={period.to} />
            {access.canManage && tiktokAccounts.some((a) => a.status === "active") && (
              <button className="secondary" type="submit" formAction={syncTikTok}>{t.tiktokSync}</button>
            )}
            {env.demoMode() && access.canManage && (
              <button className="secondary" type="submit" formAction={loadDemoData} title={t.demoNote}>{t.demoData}</button>
            )}
            {access.canManage && (
              <button className="secondary" type="submit" formAction={sendReportNow}>{t.emailSendNow}</button>
            )}
            <button type="submit">{t.generateReport}</button>
          </form>
        )}
      />
      {notices}

      <DateRange
        basePath={base}
        period={period}
        active={activePreset}
        keep={metric === "spend" ? {} : { m: metric }}
        labels={{ "7d": t.p7d, "14d": t.p14d, "30d": t.p30d, "90d": t.p90d, mtd: t.pmtd, lastm: t.plastm, custom: t.customRange, from: t.from, to: t.to, apply: t.apply }}
      />

      {!overview.hasData && (
        <section className="empty-state">
          <h2>{t.noDataPeriod}</h2>
          <p className="muted">{t.noDataHint}</p>
        </section>
      )}

      <section className="kpi-grid" aria-label={t.overview}>
        {KPI_ORDER.map((m) => (
          <Kpi
            key={m}
            label={METRIC_LABELS[m][lang]}
            figure={fig(report, m)}
            delta={figureDelta(fig(report, m), fig(previousReport, m))}
            lang={lang}
            comparedTo={fill(t.vsPrevious, days)}
            missingLabel={fig(report, m)?.status === "not_applicable" ? t.notApplicable : t.notProvided}
          />
        ))}
      </section>

      <section className="card chart-card" aria-labelledby="trend-h">
        <div className="card-head">
          <h2 id="trend-h">{t.trendTitle}</h2>
          <nav className="tabs" aria-label={t.trendTitle}>
            {metricTabs.map((m) => (
              <a key={m} href={`${base}?${new URLSearchParams({ ...keepRange, ...(m === "spend" ? {} : { m }) })}`}
                 className={m === metric ? "tab active" : "tab"} aria-current={m === metric ? "true" : undefined}>
                {METRIC_LABELS[m][lang]}
              </a>
            ))}
          </nav>
        </div>
        <TrendChart
          points={points}
          lang={lang}
          title={`${METRIC_LABELS[metric][lang]} · ${period.from} → ${period.to}`}
          noDataLabel={t.noDataDay}
          unit={metric === "spend" && overview.currency ? (lang === "ar" ? "ر.س" : overview.currency) : ""}
        />
        <details className="table-toggle">
          <summary>{t.showTable}</summary>
          <div className="table-wrap">
            <table className="data-table compact">
              <thead><tr><th scope="col">{t.date}</th><th scope="col" className="n">{METRIC_LABELS[metric][lang]}</th></tr></thead>
              <tbody>
                {overview.daily[metric].map((p) => (
                  <tr key={p.date}>
                    <td><span className="num">{p.date}</span> <span className="muted">· {shortDate(p.date, lang)}</span></td>
                    <td className="n">{p.display ? <span className="num">{p.display[lang]}</span> : <span className="muted">{t.noDataDay}</span>}</td>
                  </tr>
                ))}
              </tbody>
            </table>
          </div>
        </details>
        <p className="fine-print">{t.liveNote}</p>
      </section>

      <section className="card" aria-labelledby="campaigns-h">
        <div className="card-head"><h2 id="campaigns-h">{t.campaigns}</h2></div>
        <CampaignTable
          rows={overview.campaigns}
          lang={lang}
          labels={{
            campaign: t.campaign, spend: METRIC_LABELS.spend[lang], share: t.shareOfSpend, impressions: METRIC_LABELS.impressions[lang],
            clicks: METRIC_LABELS.clicks[lang], ctr: METRIC_LABELS.ctr[lang], conversions: METRIC_LABELS.conversions[lang],
            cpa: METRIC_LABELS.cpa[lang], none: t.noCampaigns,
          }}
        />
      </section>

      <div className="grid-2">
        <section className="card stack" aria-labelledby="reports-h">
          <div className="card-head"><h2 id="reports-h">{t.reportActions}</h2></div>
          {latest && commentary ? (
            <>
              <div className="report-latest">
                <div className="muted">{t.latestReport} · <span className="num">{latest.date_from} → {latest.date_to}</span></div>
                <p className="commentary clamp">{isolateNumbers(lang === "ar" ? commentary.text_ar : commentary.text_en)}</p>
                <a className="button" href={`${base}/r/${latest.id}`}>{t.viewReport}</a>
              </div>
              {snapshots && snapshots.length > 1 && (
                <ul className="list">
                  {snapshots.slice(1).map((s) => (
                    <li key={s.id}>
                      <a href={`${base}/r/${s.id}`}><span className="num">{s.date_from} → {s.date_to}</span></a>
                      <span className="muted"> · {t.createdAt} <span className="num">{new Date(s.created_at).toISOString().slice(0, 16).replace("T", " ")}</span></span>
                    </li>
                  ))}
                </ul>
              )}
            </>
          ) : (
            <p className="muted">{t.noReports}</p>
          )}
        </section>

        <section className="card stack" aria-labelledby="tiktok-h">
          <div className="card-head"><h2 id="tiktok-h">{t.tiktokTitle}</h2></div>
          {tiktokAccounts.length > 0 ? (
            <ul className="list">
              {tiktokAccounts.map((a) => (
                <li key={a.id} className="account-row">
                  <span>
                    <span className="campaign-name">{a.name ?? a.external_id}</span>
                    <span className="campaign-id" dir="ltr">{a.external_id}{a.currency ? ` · ${a.currency}` : ""}</span>
                  </span>
                  <span className={`badge ${a.status === "active" ? "ok" : a.status === "error" ? "drift" : "other"}`}>{statusLabel[a.status] ?? a.status}</span>
                </li>
              ))}
            </ul>
          ) : (
            <p className="muted">{t.tiktokNone}</p>
          )}
          {access.canManage && (env.tiktokConfigured() ? (
            <form action={connectTikTok}>
              <input type="hidden" name="ws" value={ws} />
              <input type="hidden" name="client" value={client} />
              <button type="submit" className={tiktokAccounts.length > 0 ? "secondary" : undefined}>
                {tiktokAccounts.length > 0 ? t.tiktokReconnect : t.tiktokConnect}
              </button>
            </form>
          ) : (
            <p className="notice">{t.tiktokPending}</p>
          ))}
        </section>
      </div>

      <section id="email" className="card stack" aria-labelledby="email-h">
        <div className="card-head">
          <h2 id="email-h">{t.emailTitle}</h2>
          <span className="muted">
            {schedule && (schedule.recipients as string[]).length > 0
              ? t.emailScheduleLine.replace("{f}", freqLabel[schedule.frequency] ?? schedule.frequency).replace("{n}", String((schedule.recipients as string[]).length))
              : t.emailNoSchedule}
          </span>
        </div>
        {access.canManage && (
          <>
            {!env.emailConfigured() && <p className="notice warn">{t.emailNotConfigured}</p>}
            <form className="email-form" action={saveReportSchedule}>
              <input type="hidden" name="ws" value={ws} />
              <input type="hidden" name="client" value={client} />
              <div className="email-recipients">
                <label htmlFor="recipients">{t.emailRecipients}</label>
                <textarea id="recipients" name="recipients" rows={4} dir="ltr" aria-describedby="recipients-hint"
                  defaultValue={((schedule?.recipients as string[] | undefined) ?? []).join("\n")} />
                <div id="recipients-hint" className="muted">{t.emailRecipientsHint}</div>
              </div>
              <div className="email-options">
                <div>
                  <label htmlFor="frequency">{t.emailFrequency}</label>
                  <select id="frequency" name="frequency" defaultValue={schedule?.frequency ?? "off"}>
                    <option value="off">{t.freqOff}</option>
                    <option value="weekly">{t.freqWeekly}</option>
                    <option value="monthly">{t.freqMonthly}</option>
                  </select>
                </div>
                <div>
                  <label htmlFor="weekday">{t.emailWeekday}</label>
                  <select id="weekday" name="weekday" defaultValue={String(schedule?.send_weekday ?? 7)}>
                    {weekdays.map((d) => <option key={d} value={d}>{t[`weekday${d}`]}</option>)}
                  </select>
                </div>
                <div>
                  <label htmlFor="language">{t.emailLanguage}</label>
                  <select id="language" name="language" defaultValue={schedule?.language ?? "ar"}>
                    <option value="ar">{t.langAr}</option>
                    <option value="en">{t.langEn}</option>
                  </select>
                </div>
                <button type="submit">{t.save}</button>
              </div>
            </form>
            <p className="fine-print">{t.emailSendNowHint}</p>
          </>
        )}
        {recentDeliveries && recentDeliveries.length > 0 && (
          <div className="table-wrap">
            <table className="data-table compact">
              <caption className="sr-only">{t.emailHistory}</caption>
              <tbody>
                {recentDeliveries.map((d) => (
                  <tr key={d.id}>
                    <td dir="ltr">{d.recipient}</td>
                    <td><span className="num">{d.period_from} → {d.period_to}</span></td>
                    <td>
                      <span className={`badge ${d.status === "sent" ? "ok" : "drift"}`}>
                        {d.status === "sent" ? t.deliverySent : `${t.deliveryFailed}${d.error_code ? ` (${d.error_code})` : ""}`}
                      </span>
                    </td>
                    <td className="n"><span className="num muted">{new Date(d.created_at).toISOString().slice(0, 16).replace("T", " ")}</span></td>
                  </tr>
                ))}
              </tbody>
            </table>
          </div>
        )}
      </section>
    </div>
  );
}
