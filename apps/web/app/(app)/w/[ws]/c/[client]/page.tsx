import { notFound } from "next/navigation";
import { DEMO_EXTERNAL_ID } from "@glio/connectors";
import { minorUnitDigits, todayIn } from "@glio/core";
import { type Figure, METRIC_LABELS, METRIC_ORDER, type MetricId } from "@glio/reports";
import { CampaignTable } from "@/components/app/CampaignTable";
import { DateRange } from "@/components/app/DateRange";
import { Kpi } from "@/components/app/Kpi";
import { PageHeader } from "@/components/app/PageHeader";
import { TrendChart } from "@/components/app/TrendChart";
import { shortDate } from "@/lib/short-date";
import { type SyncRunRow, accountSyncs, connectionState, riyadhDateTime } from "@/lib/sync-status";
import { isolateNumbers } from "@/components/ReportView";
import { clientAccess } from "@/lib/authz";
import { CHART_METRICS, type ChartMetric, loadOverview } from "@/lib/dashboard";
import { type Period, type PresetKey, PRESET_KEYS, figureDelta, matchPreset, presetPeriod } from "@/lib/delta";
import { env } from "@/lib/env";
import { ERROR_HINTS, hintFor } from "@/lib/errors";
import { getDict } from "@/lib/i18n";
import { serverDb } from "@/lib/server-db";
import { connectTikTok, deleteClient, generateReport, loadDemoData, saveReportSchedule, sendReportNow, syncTikTok } from "./actions";
import { saveGuardrails, saveSuggestionSettings } from "../../approvals/actions";
import { formatMoney, minorToDecimalForInput } from "@/lib/money-display";

const ISO = /^\d{4}-\d{2}-\d{2}$/;
const KPI_ORDER: MetricId[] = METRIC_ORDER;
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
  const requestedMetric: ChartMetric = CHART_METRICS.includes(q.m as ChartMetric) ? (q.m as ChartMetric) : "spend";
  const base = `/w/${ws}/c/${client}`;
  const keepRange: Record<string, string> = activePreset ? { p: activePreset } : { from: period.from, to: period.to };

  const [overview, { data: workspace }, { data: snapshots }, { data: tiktokRows }, { data: schedule }, { data: recentDeliveries }, { data: pendingRows }, { data: guardrails }, { data: sgSettings }, { data: unsubscribedRows }, { data: runRows }] = await Promise.all([
    // Server read AFTER the RLS check above (clientAccess).
    loadOverview(serverDb(), client, period),
    supabase.from("workspaces").select("name").eq("id", ws).maybeSingle(),
    supabase.from("report_snapshots").select("id, date_from, date_to, created_at, commentary_id").eq("client_id", client)
      .order("created_at", { ascending: false }).limit(6),
    supabase.from("ad_accounts").select("id, name, external_id, currency, status").eq("client_id", client).eq("platform", "tiktok").order("created_at"),
    supabase.from("report_schedules").select("frequency, send_weekday, language, recipients").eq("client_id", client).maybeSingle(),
    supabase.from("report_deliveries").select("id, recipient, status, period_from, period_to, created_at, error_code")
      .eq("client_id", client).order("created_at", { ascending: false }).limit(5),
    supabase.from("approval_requests").select("ad_account_id, target_id, expires_at").eq("client_id", client).eq("status", "pending"),
    supabase.from("client_guardrails").select("max_daily_budget_minor, max_budget_increase_pct").eq("client_id", client).maybeSingle(),
    supabase.from("suggestion_settings")
      .select("enabled, pause_min_spend_major, high_cpa_pct, low_cpa_pct, min_conversions_for_cut, min_conversions_for_raise, step_pct")
      .eq("client_id", client).maybeSingle(),
    supabase.from("report_unsubscribes").select("email, unsubscribed_at").eq("client_id", client).order("unsubscribed_at", { ascending: false }),
    supabase.from("sync_runs").select("ad_account_id, status, started_at, finished_at, error_code")
      .eq("client_id", client).order("started_at", { ascending: false }).limit(50),
  ]);
  const sg = sgSettings ?? {
    enabled: true, pause_min_spend_major: 300, high_cpa_pct: 150, low_cpa_pct: 70,
    min_conversions_for_cut: 3, min_conversions_for_raise: 10, step_pct: 20,
  };
  const pendingKeys = new Set((pendingRows ?? [])
    .filter((p) => !p.expires_at || new Date(p.expires_at).getTime() > Date.now())
    .map((p) => `${p.ad_account_id}:${p.target_id}`));
  const guardCurrency = overview.currency ?? tiktokRows?.[0]?.currency ?? "SAR";
  const latest = snapshots?.[0];
  const { data: commentary } = latest
    ? await supabase.from("ai_commentary").select("text_ar, text_en, source").eq("id", latest.commentary_id).maybeSingle()
    : { data: null };

  await supabase.from("audit_log").insert({
    workspace_id: ws, actor_kind: "user", actor_user_id: user.id, action: "client.viewed", entity_type: "client", entity_id: client,
  });

  const tiktokAccounts = (tiktokRows ?? []).filter((a) => a.external_id !== DEMO_EXTERNAL_ID);
  const syncs = accountSyncs(tiktokAccounts, (runRows ?? []) as SyncRunRow[]);
  // A figure missing only for some days (e.g. synced before GLIO fetched it): say so, and that a sync fills it in.
  const partial = (metric: MetricId) => Boolean(fig(overview.report, metric)?.reason?.includes("for some days"));
  const someDaysMissing = (m: MetricId) =>
    fig(overview.report, m)?.status === "not_provided" && (partial(m) || (m === "roas" && partial("purchase_value")) || (m === "cpa" && partial("conversions")));
  const state = connectionState(tiktokAccounts, syncs, overview.hasData);
  const lastSuccess = [...syncs.values()].map((s) => s.lastSucceededAt).filter((x): x is string => Boolean(x)).sort().at(-1) ?? null;
  const canSync = access.canManage && tiktokAccounts.some((a) => a.status === "active");
  // Sync button for the empty states: syncs the period on screen.
  const syncForm = (label: string, primary: boolean) => (
    <form action={syncTikTok}>
      <input type="hidden" name="ws" value={ws} />
      <input type="hidden" name="client" value={client} />
      <input type="hidden" name="from" value={period.from} />
      <input type="hidden" name="to" value={period.to} />
      <button type="submit" className={primary ? undefined : "secondary"}>{label}</button>
    </form>
  );
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

  // Spend can't be charted across different currencies: then the first other metric is shown.
  const metricTabs = CHART_METRICS.filter((m) => m !== "spend" || overview.currency);
  const metric: ChartMetric = metricTabs.includes(requestedMetric) ? requestedMetric : metricTabs[0]!;

  // Chart series for the chosen metric. Money is plotted in major units; tooltips show the exact text.
  const digits = overview.currency ? minorUnitDigits(overview.currency) : 0;
  const points = overview.daily[metric].map((p) => ({
    date: p.date,
    value: p.value === null ? null : metric === "spend" ? Number(p.value) / 10 ** digits : Number(p.value),
    label: p.display ? p.display[lang] : null,
  }));

  const notices = (
    <>
      {q.e === "forbidden" && <p className="notice error" role="alert">{t.notAllowed}</p>}
      {q.e === "delete_confirm" && <p className="notice error" role="alert">{t.deleteClientConfirmError}</p>}
      {q.e === "delete" && (
        <p className="notice error" role="alert">{t.deleteClientError} {q.code && <code className="num">({q.code})</code>}</p>
      )}
      {q.e === "period" && <p className="notice error" role="alert">{t.periodError}</p>}
      {q.e === "recipients" && <p className="notice error" role="alert">{t.emailRecipientsError}</p>}
      {(q.e === "report" || q.e === "demo" || q.e === "tiktok" || q.e === "sync" || q.e === "email") && (
        <p className="notice error" role="alert">
          {{ report: t.reportError, demo: t.demoError, tiktok: t.tiktokError, sync: t.syncError, email: t.emailError }[q.e]}{" "}
          {hintFor(q.code, lang)}{" "}
          {q.code && <code className="num">({q.code})</code>}
        </p>
      )}
      {q.tt === "connected" && (
        <p className={q.s && q.s !== "ok" && q.s !== "none" ? "notice warn" : "notice"} role="status">
          {fill(t.tiktokConnected, q.n)} {Number(q.c) > 0 && fill(t.tiktokConflicts, q.c)}{" "}
          {q.s === "ok" && t.tiktokFirstSyncOk}
          {q.s && q.s !== "ok" && q.s !== "none" && (
            <>
              {t.tiktokFirstSyncFailed} {hintFor(q.s, lang)} <code className="num">({q.s})</code>
            </>
          )}
        </p>
      )}
      {q.tt === "synced" && <p className="notice" role="status">{t.tiktokSynced}</p>}
      {q.ap === "requested" && (
        <p className="notice" role="status">{t.apResult_requested} <a href={`/w/${ws}/approvals`}>{t.navApprovals}</a></p>
      )}
      {q.ap === "guardrails" && <p className="notice" role="status">{t.guardrailsSaved}</p>}
      {q.ap === "sg_settings" && <p className="notice" role="status">{t.sgSettingsSaved}</p>}
      {q.e === "sg_settings" && <p className="notice error" role="alert">{t.sgSettingsInvalid}</p>}
      {q.e === "budget" && <p className="notice error" role="alert">{t.budgetInvalid}</p>}
      {q.e === "approval" && (
        <p className="notice error" role="alert">
          {t.apError} {q.code && ERROR_HINTS[q.code] ? ERROR_HINTS[q.code]![lang] : null} {q.code && <code className="num">({q.code})</code>}
        </p>
      )}
      {q.mail === "saved" && <p className="notice" role="status">{t.emailSaved}</p>}
      {q.mail === "sent" && (
        <p className={Number(q.f) > 0 ? "notice warn" : "notice"} role="status">
          {fill(t.emailSent, q.n)} {Number(q.f) > 0 && fill(t.emailFailed, q.f)} {Number(q.u) > 0 && fill(t.emailSkippedUnsub, q.u)}{" "}
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

      {state === "no_account" && (
        <section className="empty-state">
          <h2>{t.noDataPeriod}</h2>
          <p className="muted">{t.noDataHintConnect}{env.demoMode() ? ` ${t.noDataHintDemo}` : ""}</p>
          {access.canManage && (
            <div className="empty-actions">
              {env.tiktokConfigured() && (
                <form action={connectTikTok}>
                  <input type="hidden" name="ws" value={ws} />
                  <input type="hidden" name="client" value={client} />
                  <button type="submit">{t.tiktokConnect}</button>
                </form>
              )}
              {env.demoMode() && (
                <form action={loadDemoData}>
                  <input type="hidden" name="ws" value={ws} />
                  <input type="hidden" name="client" value={client} />
                  <input type="hidden" name="from" value={period.from} />
                  <input type="hidden" name="to" value={period.to} />
                  <button type="submit" className={env.tiktokConfigured() ? "secondary" : undefined}>{t.demoData}</button>
                </form>
              )}
            </div>
          )}
        </section>
      )}
      {state === "never_synced" && (
        <section className="empty-state">
          <h2>{t.neverSyncedTitle}</h2>
          <p className="muted">{t.neverSyncedHint}</p>
          {canSync && <div className="empty-actions">{syncForm(t.syncThisPeriod, true)}</div>}
        </section>
      )}
      {state === "no_activity" && (
        <section className="empty-state">
          <h2>{t.noActivityTitle}</h2>
          <p className="muted">
            {t.noActivityHint}{" "}
            {lastSuccess && <>{t.lastSynced} <span className="num">{riyadhDateTime(lastSuccess)}</span>.</>}
          </p>
          {canSync && <div className="empty-actions">{syncForm(t.syncThisPeriod, false)}</div>}
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
            missingLabel={!overview.hasData ? t.noDataDay : fig(report, m)?.status === "not_applicable" ? t.notApplicable
              : someDaysMissing(m) ? t.notProvidedSomeDays : t.notProvided}
          />
        ))}
      </section>

      {overview.hasData && (<>
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

      <section id="campaigns" className="card" aria-labelledby="campaigns-h">
        <div className="card-head"><h2 id="campaigns-h">{t.campaigns}</h2></div>
        <CampaignTable
          rows={overview.campaigns}
          lang={lang}
          labels={{
            campaign: t.campaign, spend: METRIC_LABELS.spend[lang], share: t.shareOfSpend, impressions: METRIC_LABELS.impressions[lang],
            clicks: METRIC_LABELS.clicks[lang], ctr: METRIC_LABELS.ctr[lang], conversions: METRIC_LABELS.conversions[lang],
            cpa: METRIC_LABELS.cpa[lang], purchaseValue: METRIC_LABELS.purchase_value[lang], roas: t.roasShort, none: t.noCampaigns,
          }}
          propose={access.canGenerate ? {
            ws, client, pending: pendingKeys,
            labels: {
              actions: t.actions, propose: t.proposeShort, pause: t.proposePause, enable: t.proposeEnable, budget: t.proposeBudget,
              newBudget: t.newDailyBudget, reason: t.reasonPlaceholder, pending: t.pendingBadge,
            },
          } : undefined}
        />
      </section>
      </>)}

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
                  <span className="account-sync">
                    <span className={`badge ${a.status === "active" ? "ok" : a.status === "error" ? "drift" : "other"}`}>{statusLabel[a.status] ?? a.status}</span>
                    <AccountSyncLine sync={syncs.get(a.id)} t={t} lang={lang} />
                  </span>
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

      <section id="guardrails" className="card stack" aria-labelledby="guardrails-h">
        <div className="card-head">
          <h2 id="guardrails-h">{t.guardrailsTitle}</h2>
          <span className="muted">{access.role === "owner" ? t.guardrailsSub : t.ownerOnly}</span>
        </div>
        {access.role === "owner" ? (
          <form className="guardrails-form" action={saveGuardrails}>
            <input type="hidden" name="ws" value={ws} />
            <input type="hidden" name="client" value={client} />
            <input type="hidden" name="currency" value={guardCurrency} />
            <div>
              <label htmlFor="max_daily_budget">{t.maxDailyBudget} <span className="muted">({guardCurrency})</span></label>
              <input id="max_daily_budget" name="max_daily_budget" inputMode="decimal" dir="ltr" placeholder={t.noLimit}
                defaultValue={guardrails?.max_daily_budget_minor ? minorToDecimalForInput(String(guardrails.max_daily_budget_minor), guardCurrency) : ""} />
            </div>
            <div>
              <label htmlFor="max_increase_pct">{t.maxIncrease}</label>
              <input id="max_increase_pct" name="max_increase_pct" type="number" min={1} max={1000} dir="ltr"
                defaultValue={guardrails?.max_budget_increase_pct ?? 50} />
            </div>
            <button type="submit">{t.save}</button>
          </form>
        ) : (
          <dl className="kv">
            <dt>{t.maxDailyBudget}</dt>
            <dd>{guardrails?.max_daily_budget_minor ? <span className="num">{formatMoney(String(guardrails.max_daily_budget_minor), guardCurrency, lang)}</span> : t.noLimit}</dd>
            <dt>{t.maxIncrease}</dt>
            <dd><span className="num">{guardrails?.max_budget_increase_pct ?? 50}%</span></dd>
          </dl>
        )}
      </section>

      <section id="suggestions" className="card stack" aria-labelledby="sg-h">
        <div className="card-head">
          <h2 id="sg-h">✦ {t.sgSettingsTitle}</h2>
          <span className={`badge ${sg.enabled ? "ok" : "other"}`}>{sg.enabled ? t.sgOn : t.sgOff}</span>
        </div>
        <p className="muted" style={{ margin: 0 }}>{t.sgSettingsSub}</p>
        {access.canManage ? (
          <form className="sg-form" action={saveSuggestionSettings}>
            <input type="hidden" name="ws" value={ws} />
            <input type="hidden" name="client" value={client} />
            <label className="sg-toggle"><input type="checkbox" name="enabled" defaultChecked={sg.enabled} /> {t.sgEnabled}</label>
            <div className="sg-grid">
              <div>
                <label htmlFor="sg-pause">{t.sgPauseLabel} <span className="muted">({guardCurrency})</span></label>
                <input id="sg-pause" name="pause_min_spend_major" type="number" min={10} max={1000000} dir="ltr" defaultValue={sg.pause_min_spend_major} />
              </div>
              <div>
                <label htmlFor="sg-high">{t.sgHighLabel}</label>
                <input id="sg-high" name="high_cpa_pct" type="number" min={110} max={500} dir="ltr" defaultValue={sg.high_cpa_pct} />
              </div>
              <div>
                <label htmlFor="sg-low">{t.sgLowLabel}</label>
                <input id="sg-low" name="low_cpa_pct" type="number" min={10} max={95} dir="ltr" defaultValue={sg.low_cpa_pct} />
              </div>
              <div>
                <label htmlFor="sg-step">{t.sgStepLabel}</label>
                <input id="sg-step" name="step_pct" type="number" min={5} max={50} dir="ltr" defaultValue={sg.step_pct} />
              </div>
              <div>
                <label htmlFor="sg-mincut">{t.sgMinCutLabel}</label>
                <input id="sg-mincut" name="min_conversions_for_cut" type="number" min={1} max={1000} dir="ltr" defaultValue={sg.min_conversions_for_cut} />
              </div>
              <div>
                <label htmlFor="sg-minraise">{t.sgMinRaiseLabel}</label>
                <input id="sg-minraise" name="min_conversions_for_raise" type="number" min={1} max={1000} dir="ltr" defaultValue={sg.min_conversions_for_raise} />
              </div>
            </div>
            <div><button type="submit">{t.save}</button></div>
          </form>
        ) : (
          <dl className="kv">
            <dt>{t.sgPauseLabel}</dt><dd><span className="num">{sg.pause_min_spend_major}</span> {guardCurrency}</dd>
            <dt>{t.sgHighLabel}</dt><dd><span className="num">{sg.high_cpa_pct}%</span></dd>
            <dt>{t.sgLowLabel}</dt><dd><span className="num">{sg.low_cpa_pct}%</span></dd>
            <dt>{t.sgStepLabel}</dt><dd><span className="num">{sg.step_pct}%</span></dd>
            <dt>{t.sgMinCutLabel}</dt><dd><span className="num">{sg.min_conversions_for_cut}</span></dd>
            <dt>{t.sgMinRaiseLabel}</dt><dd><span className="num">{sg.min_conversions_for_raise}</span></dd>
          </dl>
        )}
      </section>

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
        {unsubscribedRows && unsubscribedRows.length > 0 && (
          <div className="notice" role="note">
            <p style={{ margin: 0 }}>{t.emailUnsubscribedList}</p>
            <ul className="unsub-list">
              {unsubscribedRows.map((u) => (
                <li key={u.email}>
                  <bdi dir="ltr">{u.email}</bdi> <span className="num muted">{new Date(u.unsubscribed_at).toISOString().slice(0, 10)}</span>
                </li>
              ))}
            </ul>
          </div>
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

      {access.role === "owner" && (
        <section id="delete" className="card stack danger-card no-print" aria-labelledby="delete-h">
          <h2 id="delete-h">{t.deleteClientTitle}</h2>
          <p>{t.deleteClientText}</p>
          <p className="muted">{t.deleteClientKept}</p>
          <form action={deleteClient} className="delete-form">
            <input type="hidden" name="ws" value={ws} />
            <input type="hidden" name="client" value={client} />
            <label htmlFor="delete-confirm">{t.deleteClientConfirm} <strong><bdi>{access.client?.name}</bdi></strong></label>
            <input id="delete-confirm" name="confirm" required autoComplete="off" />
            <button type="submit" className="danger">{t.deleteClientButton}</button>
          </form>
        </section>
      )}
    </div>
  );
}

/** "Last synced …", or the last failure with its hint, under each connected account. */
function AccountSyncLine({ sync, t, lang }: {
  sync: ReturnType<typeof accountSyncs> extends Map<string, infer V> ? V | undefined : never;
  t: Record<string, string>;
  lang: "ar" | "en";
}) {
  if (!sync?.last) return <span className="muted small">{t.notSyncedYet}</span>;
  const failed = sync.last.status === "failed";
  return (
    <span className={`small ${failed ? "sync-failed" : "muted"}`}>
      {failed ? (
        <>
          {t.lastSyncFailed} <span className="num">{riyadhDateTime(sync.last.started_at)}</span>
          {sync.last.error_code && <> · {hintFor(sync.last.error_code, lang) ?? <code className="num">{sync.last.error_code}</code>}</>}
        </>
      ) : sync.last.status === "running" ? (
        <>{t.syncRunning}</>
      ) : (
        <>{t.lastSynced} <span className="num">{riyadhDateTime(sync.lastSucceededAt ?? sync.last.started_at)}</span></>
      )}
    </span>
  );
}
