import { notFound } from "next/navigation";
import { DEMO_EXTERNAL_ID } from "@glio/connectors";
import { addDays, todayIn } from "@glio/core";
import type { ReportModel } from "@glio/reports";
import { ReportView } from "@/components/ReportView";
import { clientAccess } from "@/lib/authz";
import { env } from "@/lib/env";
import { ERROR_HINTS } from "@/lib/errors";
import { getDict } from "@/lib/i18n";
import { connectTikTok, generateReport, loadDemoData, syncTikTok } from "./actions";

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
      {(q.e === "report" || q.e === "demo" || q.e === "tiktok" || q.e === "sync") && (
        <p className="notice error" role="alert">
          {{ report: t.reportError, demo: t.demoError, tiktok: t.tiktokError, sync: t.syncError }[q.e]}{" "}
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
