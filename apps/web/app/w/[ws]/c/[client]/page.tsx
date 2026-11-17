import { notFound } from "next/navigation";
import { addDays, todayIn } from "@glio/core";
import type { ReportModel } from "@glio/reports";
import { ReportView } from "@/components/ReportView";
import { clientAccess } from "@/lib/authz";
import { env } from "@/lib/env";
import { ERROR_HINTS } from "@/lib/errors";
import { getDict } from "@/lib/i18n";
import { generateReport, loadDemoData } from "./actions";

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
      {(q.e === "report" || q.e === "demo") && (
        <p className="notice error" role="alert">
          {q.e === "report" ? t.reportError : t.demoError}{" "}
          {q.code && ERROR_HINTS[q.code] ? ERROR_HINTS[q.code]![lang] : null}{" "}
          {q.code && <code className="num">({q.code})</code>}
        </p>
      )}

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
