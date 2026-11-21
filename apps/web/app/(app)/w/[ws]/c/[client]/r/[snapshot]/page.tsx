import { notFound } from "next/navigation";
import type { ReportModel } from "@glio/reports";
import { ReportView } from "@/components/ReportView";
import { getDict } from "@/lib/i18n";
import { requireUser } from "@/lib/supabase/server";

/** A stored report exactly as it was generated (and as the client saw it). */
export default async function SnapshotPage({ params }: { params: Promise<{ ws: string; client: string; snapshot: string }> }) {
  const { ws, client, snapshot } = await params;
  const { lang, t } = await getDict();
  const { supabase } = await requireUser();

  const { data: s } = await supabase
    .from("report_snapshots")
    .select("id, date_from, date_to, report, report_sha256, commentary_id, created_at")
    .eq("id", snapshot).eq("client_id", client).maybeSingle();
  if (!s) notFound();
  const { data: c } = await supabase.from("ai_commentary").select("text_ar, text_en, source").eq("id", s.commentary_id).maybeSingle();
  if (!c) notFound();

  return (
    <div className="stack">
      <p><a href={`/w/${ws}/c/${client}`}>← {t.dashboard}</a></p>
      <h1><span className="num">{s.date_from} → {s.date_to}</span></h1>
      <p className="muted">
        {t.fingerprint}: <code className="num">{String(s.report_sha256).slice(0, 16)}…</code>
      </p>
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
