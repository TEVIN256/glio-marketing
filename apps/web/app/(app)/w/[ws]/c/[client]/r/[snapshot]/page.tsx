import { notFound } from "next/navigation";
import type { ReportModel } from "@glio/reports";
import { PageHeader } from "@/components/app/PageHeader";
import { PrintButton } from "@/components/app/PrintButton";
import { ReportView } from "@/components/ReportView";
import { getDict } from "@/lib/i18n";
import { requireUser } from "@/lib/supabase/server";

/** A stored report exactly as it was generated (and as the client saw it). */
export default async function SnapshotPage({ params }: { params: Promise<{ ws: string; client: string; snapshot: string }> }) {
  const { ws, client, snapshot } = await params;
  const { lang, t } = await getDict();
  const { supabase } = await requireUser();

  const [{ data: s }, { data: clientRow }, { data: workspace }] = await Promise.all([
    supabase.from("report_snapshots").select("id, date_from, date_to, report, report_sha256, commentary_id, created_at")
      .eq("id", snapshot).eq("client_id", client).maybeSingle(),
    supabase.from("clients").select("name").eq("id", client).maybeSingle(),
    supabase.from("workspaces").select("name").eq("id", ws).maybeSingle(),
  ]);
  if (!s) notFound();
  const { data: c } = await supabase.from("ai_commentary").select("text_ar, text_en, source").eq("id", s.commentary_id).maybeSingle();
  if (!c) notFound();

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
    </div>
  );
}
