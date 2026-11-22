import { notFound } from "next/navigation";
import { DEMO_EXTERNAL_ID } from "@glio/connectors";
import { addDays, todayIn } from "@glio/core";
import type { ReportModel } from "@glio/reports";
import { ReportView } from "@/components/ReportView";
import { clientAccess } from "@/lib/authz";
import { env } from "@/lib/env";
import { ERROR_HINTS } from "@/lib/errors";
import { getDict } from "@/lib/i18n";
import { connectTikTok, generateReport, loadDemoData, saveReportSchedule, sendReportNow, syncTikTok } from "./actions";

const fill = (text: string, n: string | undefined) => text.replace("{n}", String(Number(n) || 0));

export default async function ClientDashboard({
  params, searchParams,
}: { params: Promise<{ ws: string; client: string }>; searchParams: Promise<Record<string, string | undefined>> }) {
  const { ws, client } = await params;
  const q = await searchParams;
  const { lang, t } = await getDict();
  const access = await clientAccess(ws, client);
  if (!access.canView || !access.client) notFound();
  const { supabase, user } = access;

  // Default period: the last 30 complete days in Riyadh time.
  const yesterday = addDays(todayIn("Asia/Riyadh"), -1);
  const to = /^\d{4}-\d{2}-\d{2}$/.test(q.to ?? "") ? q.to! : yesterday;
  const from = /^\d{4}-\d{2}-\d{2}$/.test(q.from ?? "") ? q.from! : addDays(to, -29);

  const { data: snapshots } = await supabase
    .from("report_snapshots")
    .select("id, date_from, date_to, created_at, report, commentary_id")
    .eq("client_id", client)
    .order("created_at", { ascending: false })
    .limit(20);
  const latest = snapshots?.[0];
  const { data: tiktokRows } = await supabase
    .from("ad_accounts")
    .select("id, name, external_id, currency, status")
    .eq("client_id", client)
    .eq("platform", "tiktok")
    .order("created_at");
  const tiktokAccounts = (tiktokRows ?? []).filter((a) => a.external_id !== DEMO_EXTERNAL_ID);
  const { data: schedule } = await supabase
    .from("report_schedules").select("frequency, send_weekday, language, recipients").eq("client_id", client).maybeSingle();
  const { data: recentDeliveries } = await supabase
    .from("report_deliveries").select("id, recipient, status, period_from, period_to, created_at, error_code")
    .eq("client_id", client).order("created_at", { ascending: false }).limit(5);
  const freqLabel: Record<string, string> = { off: t.freqOff, weekly: t.freqWeekly, monthly: t.freqMonthly };
  const weekdays = [7, 1, 2, 3, 4, 5, 6] as const; // Sunday first (Saudi week)
  const statusLabel: Record<string, string> = {
    active: t.statusActive, pending: t.statusPending, disconnected: t.statusDisconnected, error: t.statusError,
  };
  const { data: commentary } = latest
    ? await supabase.from("ai_commentary").select("text_ar, text_en, source").eq("id", latest.commentary_id).maybeSingle()
    : { data: null };

  // Record the view in the audit log (as the user, so RLS checks membership).
  await supabase.from("audit_log").insert({
    workspace_id: ws, actor_kind: "user", actor_user_id: user.id, action: "client.viewed", entity_type: "client", entity_id: client,
  });

  return (
    <div className="stack">
      <p><a href={`/w/${ws}`}>← {t.clients}</a></p>
      <h1>{access.client.name}: {t.dashboard}</h1>
      {q.e === "forbidden" && <p className="notice error" role="alert">{t.notAllowed}</p>}
      {q.e === "period" && <p className="notice error" role="alert">{t.periodError}</p>}
      {(q.e === "report" || q.e === "demo" || q.e === "tiktok" || q.e === "sync" || q.e === "email") && (
        <p className="notice error" role="alert">
          {{ report: t.reportError, demo: t.demoError, tiktok: t.tiktokError, sync: t.syncError, email: t.emailError }[q.e]}{" "}
          {q.code && ERROR_HINTS[q.code] ? ERROR_HINTS[q.code]![lang] : null}{" "}
          {q.code && <code className="num">({q.code})</code>}
        </p>
      )}

      {q.tt === "connected" && (
        <p className="notice" role="status">
          {fill(t.tiktokConnected, q.n)} {Number(q.c) > 0 && fill(t.tiktokConflicts, q.c)}
        </p>
      )}
      {q.tt === "synced" && <p className="notice" role="status">{t.tiktokSynced}</p>}
      {q.e === "recipients" && <p className="notice error" role="alert">{t.emailRecipientsError}</p>}
      {q.mail === "saved" && <p className="notice" role="status">{t.emailSaved}</p>}
      {q.mail === "sent" && (
        <p className={Number(q.f) > 0 ? "notice warn" : "notice"} role="status">
          {fill(t.emailSent, q.n)} {Number(q.f) > 0 && fill(t.emailFailed, q.f)}{" "}
          {Number(q.f) > 0 && q.code && ERROR_HINTS[q.code] ? ERROR_HINTS[q.code]![lang] : null}
        </p>
      )}

      <section className="card stack" aria-labelledby="tiktok-h">
        <h2 id="tiktok-h" style={{ marginBlock: 0 }}>{t.tiktokTitle}</h2>
        {tiktokAccounts.length > 0 ? (
          <ul className="list">
            {tiktokAccounts.map((a) => (
              <li key={a.id}>
                {a.name ?? a.external_id} <span className="muted num">({a.external_id})</span>
                {a.currency && <span className="muted"> · <span className="num">{a.currency}</span></span>}
                <span className="muted"> · {statusLabel[a.status] ?? a.status}</span>
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
          <p className="muted">{t.tiktokPending}</p>
        ))}
      </section>

      {access.canGenerate && (
        <form className="card row" action={generateReport}>
          <input type="hidden" name="ws" value={ws} />
          <input type="hidden" name="client" value={client} />
          <div>
            <label htmlFor="from">{t.from}</label>
            <input id="from" name="from" type="date" defaultValue={from} required dir="ltr" />
          </div>
          <div>
            <label htmlFor="to">{t.to}</label>
            <input id="to" name="to" type="date" defaultValue={to} required dir="ltr" />
          </div>
          <button type="submit">{t.generateReport}</button>
          {access.canManage && tiktokAccounts.some((a) => a.status === "active") && (
            <button className="secondary" type="submit" formAction={syncTikTok}>{t.tiktokSync}</button>
          )}
          {env.demoMode() && access.canManage && (
            <button className="secondary" type="submit" formAction={loadDemoData} title={t.demoNote}>{t.demoData}</button>
          )}
        </form>
      )}

      <section id="email" className="card stack" aria-labelledby="email-h">
        <h2 id="email-h" style={{ marginBlock: 0 }}>{t.emailTitle}</h2>
        <p className="muted">
          {schedule && (schedule.recipients as string[]).length > 0
            ? t.emailScheduleLine.replace("{f}", freqLabel[schedule.frequency] ?? schedule.frequency).replace("{n}", String((schedule.recipients as string[]).length))
            : t.emailNoSchedule}
        </p>
        {access.canManage && (
          <>
            {!env.emailConfigured() && <p className="notice warn">{t.emailNotConfigured}</p>}
            <form className="stack" action={saveReportSchedule}>
              <input type="hidden" name="ws" value={ws} />
              <input type="hidden" name="client" value={client} />
              <div>
                <label htmlFor="recipients">{t.emailRecipients}</label>
                <textarea
                  id="recipients" name="recipients" rows={3} dir="ltr" aria-describedby="recipients-hint"
                  defaultValue={((schedule?.recipients as string[] | undefined) ?? []).join("\n")}
                  style={{ width: "100%", font: "inherit", padding: "9px 12px", borderRadius: 8, border: "1px solid #9aa4ad" }}
                />
                <div id="recipients-hint" className="muted">{t.emailRecipientsHint}</div>
              </div>
              <div className="row">
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
              </div>
              <div className="row">
                <button type="submit">{t.save}</button>
              </div>
            </form>
            <form action={sendReportNow}>
              <input type="hidden" name="ws" value={ws} />
              <input type="hidden" name="client" value={client} />
              <input type="hidden" name="from" value={from} />
              <input type="hidden" name="to" value={to} />
              <button className="secondary" type="submit">
                {t.emailSendNow} <span className="num">({from} → {to})</span>
              </button>
            </form>
          </>
        )}
        {recentDeliveries && recentDeliveries.length > 0 && (
          <>
            <h3 style={{ marginBlockEnd: 0 }}>{t.emailHistory}</h3>
            <ul className="list">
              {recentDeliveries.map((d) => (
                <li key={d.id}>
                  <span dir="ltr">{d.recipient}</span>{" "}
                  <span className="muted">
                    · <span className="num">{d.period_from} → {d.period_to}</span> ·{" "}
                    {d.status === "sent" ? t.deliverySent : `${t.deliveryFailed} (${d.error_code ?? "?"})`} ·{" "}
                    <span className="num">{new Date(d.created_at).toISOString().slice(0, 16).replace("T", " ")}</span>
                  </span>
                </li>
              ))}
            </ul>
          </>
        )}
      </section>

      {latest && commentary ? (
        <>
          <h2>
            {t.latestReport}: <span className="num">{latest.date_from} → {latest.date_to}</span>
          </h2>
          <ReportView
            report={latest.report as ReportModel}
            commentary={{ ar: commentary.text_ar, en: commentary.text_en, source: commentary.source }}
            lang={lang}
            t={t}
            figureHref={(id) => `/w/${ws}/c/${client}/r/${latest.id}/f/${encodeURIComponent(id)}`}
          />
        </>
      ) : (
        <p className="muted">{t.noReports}</p>
      )}

      {snapshots && snapshots.length > 1 && (
        <>
          <h2>{t.reports}</h2>
          <ul className="list card">
            {snapshots.map((s) => (
              <li key={s.id}>
                <a href={`/w/${ws}/c/${client}/r/${s.id}`}><span className="num">{s.date_from} → {s.date_to}</span></a>{" "}
                <span className="muted">· {t.createdAt} <span className="num">{new Date(s.created_at).toISOString().slice(0, 16).replace("T", " ")}</span></span>
              </li>
            ))}
          </ul>
        </>
      )}
    </div>
  );
}
