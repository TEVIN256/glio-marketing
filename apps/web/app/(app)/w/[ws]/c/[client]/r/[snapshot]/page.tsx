import { cookies } from "next/headers";
import { notFound } from "next/navigation";
import type { ReportModel } from "@glio/reports";
import { PageHeader } from "@/components/app/PageHeader";
import { PrintButton } from "@/components/app/PrintButton";
import { ReportView } from "@/components/ReportView";
import { clientAccess } from "@/lib/authz";
import { getDict } from "@/lib/i18n";
import { SHARE_LINK_COOKIE } from "@/lib/invite-token";
import { createShareLink, revokeShareLink } from "./actions";
import { requireUser } from "@/lib/supabase/server";
import { type ViewRow, summarizeViews } from "@/lib/report-views";
import { serverDb } from "@/lib/server-db";

/** Audit entries read for the viewers list (most recent first). */
const VIEWS_LIMIT = 1000;

/** A stored report exactly as it was generated (and as the client saw it). */
export default async function SnapshotPage({
  params, searchParams,
}: { params: Promise<{ ws: string; client: string; snapshot: string }>; searchParams: Promise<Record<string, string | undefined>> }) {
  const { ws, client, snapshot } = await params;
  const q = await searchParams;
  const { lang, t } = await getDict();
  const { supabase, user } = await requireUser();

  const [{ data: s }, { data: clientRow }, { data: workspace }] = await Promise.all([
    supabase.from("report_snapshots").select("id, date_from, date_to, report, report_sha256, commentary_id, created_at")
      .eq("id", snapshot).eq("client_id", client).maybeSingle(),
    supabase.from("clients").select("name").eq("id", client).maybeSingle(),
    supabase.from("workspaces").select("name").eq("id", ws).maybeSingle(),
  ]);
  if (!s) notFound();
  const { data: c } = await supabase.from("ai_commentary").select("text_ar, text_en, source").eq("id", s.commentary_id).maybeSingle();
  if (!c) notFound();
  const access = await clientAccess(ws, client);
  await supabase.from("audit_log").insert({
    workspace_id: ws, actor_kind: "user", actor_user_id: user.id, action: "report.viewed",
    entity_type: "report_snapshot", entity_id: snapshot, metadata: { client_id: client },
  });
  const { data: shares } = await supabase.from("report_shares")
    .select("id, created_at, expires_at, revoked_at, view_count, last_viewed_at, created_by_label")
    .eq("snapshot_id", snapshot).order("created_at", { ascending: false }).limit(20);
  const newLink = access.canManage ? (await cookies()).get(SHARE_LINK_COOKIE)?.value : undefined;
  // Who viewed this report: owners/managers only (the audit log's RLS enforces the same).
  const { data: viewRows } = access.canManage
    ? await supabase.from("audit_log").select("created_at, actor_kind, actor_user_id, action, metadata")
      .eq("workspace_id", ws).eq("entity_type", "report_snapshot").eq("entity_id", snapshot)
      .in("action", ["report.viewed", "report.share_viewed"]).order("id", { ascending: false }).limit(VIEWS_LIMIT)
    : { data: null };
  const viewers = summarizeViews((viewRows ?? []) as ViewRow[]);
  const memberIds = viewers.filter((v) => v.kind === "member").map((v) => v.id);
  const emails = new Map<string, string>(memberIds.length
    ? (await serverDb().query("select id, email from auth.users where id = any($1::uuid[])", [memberIds])).map((r) => [r.id, r.email])
    : []);
  const shareById = new Map((shares ?? []).map((sh) => [sh.id as string, sh]));
  const fmt = (iso: string) => new Date(iso).toISOString().slice(0, 16).replace("T", " ");
  const now = Date.now();

  return (
    <div className="page report-page">
      <PageHeader
        crumbs={[
          { href: "/app", label: t.workspaces },
          { href: `/w/${ws}`, label: workspace?.name ?? t.clients },
          { href: `/w/${ws}/c/${client}`, label: clientRow?.name ?? t.dashboard },
        ]}
        title={<>{clientRow?.name ?? t.reports} · <span className="num">{s.date_from} → {s.date_to}</span></>}
        subtitle={
          <>
            {t.reportSub} <span className="muted">· {t.createdAt} <span className="num">{new Date(s.created_at).toISOString().slice(0, 16).replace("T", " ")}</span>
            {" "}· {t.fingerprint} <code className="num">{String(s.report_sha256).slice(0, 12)}…</code></span>
          </>
        }
        actions={<PrintButton label={t.printReport} />}
      />
      <ReportView
        report={s.report as ReportModel}
        commentary={{ ar: c.text_ar, en: c.text_en, source: c.source }}
        lang={lang}
        t={t}
        figureHref={(id) => `/w/${ws}/c/${client}/r/${s.id}/f/${encodeURIComponent(id)}`}
      />

      <section id="share" className="card stack no-print" aria-labelledby="share-h">
        <div className="card-head"><h2 id="share-h">{t.shareTitle}</h2></div>
        <p className="muted" style={{ margin: 0 }}>{t.shareSub}</p>
        {q.e === "forbidden" && <p className="notice error" role="alert">{t.notAllowed}</p>}
        {q.e === "share" && <p className="notice error" role="alert">{t.shareError}</p>}
        {q.revoked && <p className="notice" role="status">{t.shareRevokedDone}</p>}
        {q.shared && newLink && (
          <div className="notice" role="status">
            <p style={{ margin: 0 }}>{t.shareCreated}</p>
            <input className="invite-link" readOnly value={newLink} dir="ltr" aria-label={t.shareTitle} />
          </div>
        )}
        {access.canManage && (
          <form className="invite-form" action={createShareLink}>
            <input type="hidden" name="ws" value={ws} />
            <input type="hidden" name="client" value={client} />
            <input type="hidden" name="snapshot" value={s.id} />
            <div>
              <label htmlFor="share-days">{t.shareValidFor}</label>
              <select id="share-days" name="days" defaultValue="30">
                <option value="7">{t.shareDays.replace("{n}", "7")}</option>
                <option value="30">{t.shareDays.replace("{n}", "30")}</option>
                <option value="90">{t.shareDays.replace("{n}", "90")}</option>
              </select>
            </div>
            <button type="submit">{t.shareCreate}</button>
          </form>
        )}
        {shares && shares.length > 0 && (
          <div className="table-wrap">
            <table className="data-table compact">
              <thead>
                <tr><th scope="col">{t.createdAt}</th><th scope="col">{t.shareExpires}</th><th scope="col">{t.shareViews}</th><th scope="col">{t.statusCol}</th><th scope="col"><span className="sr-only">{t.actions}</span></th></tr>
              </thead>
              <tbody>
                {shares.map((sh) => {
                  const active = !sh.revoked_at && new Date(sh.expires_at).getTime() > now;
                  return (
                    <tr key={sh.id}>
                      <td><span className="num">{fmt(sh.created_at)}</span>{sh.created_by_label === "report-email" && <span className="muted"> · {t.shareFromEmail}</span>}</td>
                      <td><span className="num">{fmt(sh.expires_at)}</span></td>
                      <td>
                        <span className="num">{sh.view_count}</span>
                        {sh.last_viewed_at && <span className="muted"> · {t.shareLastViewed} <span className="num">{fmt(sh.last_viewed_at)}</span></span>}
                      </td>
                      <td><span className={`badge ${active ? "ok" : "other"}`}>{sh.revoked_at ? t.shareRevoked : active ? t.shareActive : t.inviteExpired}</span></td>
                      <td className="n">
                        {active && access.canManage && (
                          <form action={revokeShareLink}>
                            <input type="hidden" name="ws" value={ws} />
                            <input type="hidden" name="client" value={client} />
                            <input type="hidden" name="snapshot" value={s.id} />
                            <input type="hidden" name="id" value={sh.id} />
                            <button type="submit" className="secondary">{t.shareRevoke}</button>
                          </form>
                        )}
                      </td>
                    </tr>
                  );
                })}
              </tbody>
            </table>
          </div>
        )}
      </section>

      {access.canManage && (
        <section id="viewers" className="card stack no-print" aria-labelledby="viewers-h">
          <div className="card-head">
            <h2 id="viewers-h">{t.viewersTitle}</h2>
            <a className="link-button" href={`/w/${ws}/activity?c=${client}&k=views`}>{t.viewersAll}</a>
          </div>
          <p className="muted" style={{ margin: 0 }}>{t.viewersSub}</p>
          {viewers.length === 0 ? (
            <p className="muted">{t.viewersNone}</p>
          ) : (
            <div className="table-wrap">
              <table className="data-table compact">
                <thead>
                  <tr><th scope="col">{t.viewersWho}</th><th scope="col" className="n">{t.viewersCount}</th>
                    <th scope="col">{t.viewersFirst}</th><th scope="col">{t.viewersLast}</th></tr>
                </thead>
                <tbody>
                  {viewers.map((v) => {
                    const sh = v.kind === "share" ? shareById.get(v.id) : undefined;
                    return (
                      <tr key={`${v.kind}:${v.id}`}>
                        <td>
                          {v.kind === "member" ? (
                            <><bdi dir="ltr">{emails.get(v.id) ?? t.activityFormerMember}</bdi>{v.id === user.id && <span className="muted"> · {t.viewersYou}</span>}</>
                          ) : (
                            <>
                              {t.viewersShareLink}
                              {sh && <span className="muted"> · {t.createdAt} <span className="num">{fmt(sh.created_at)}</span>
                                {sh.created_by_label === "report-email" && <> · {t.shareFromEmail}</>}</span>}
                            </>
                          )}
                        </td>
                        <td className="n"><span className="num">{v.views}</span></td>
                        <td><span className="num">{fmt(v.first)}</span></td>
                        <td><span className="num">{fmt(v.last)}</span></td>
                      </tr>
                    );
                  })}
                </tbody>
              </table>
            </div>
          )}
          {(viewRows?.length ?? 0) >= VIEWS_LIMIT && <p className="fine-print">{t.viewersLimited.replace("{n}", String(VIEWS_LIMIT))}</p>}
        </section>
      )}
    </div>
  );
}
