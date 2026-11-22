import { notFound } from "next/navigation";
import { METRIC_LABELS, type ReportModel, SCOPE_LABELS } from "@glio/reports";
import { PageHeader } from "@/components/app/PageHeader";
import { getDict } from "@/lib/i18n";
import { requireUser } from "@/lib/supabase/server";

/**
 * Provenance of one figure: its exact stored value and the original platform
 * responses it was computed from. Everything here is read as the signed-in
 * user, so row-level security decides what can be shown.
 */
export default async function FigurePage({
  params,
}: { params: Promise<{ ws: string; client: string; snapshot: string; figure: string }> }) {
  const { ws, client, snapshot, figure } = await params;
  const figureId = decodeURIComponent(figure);
  const { lang, t } = await getDict();
  const { supabase } = await requireUser();

  const { data: s } = await supabase.from("report_snapshots").select("id, report").eq("id", snapshot).eq("client_id", client).maybeSingle();
  if (!s) notFound();
  const f = (s.report as ReportModel).figures.find((x) => x.id === figureId);
  if (!f) notFound();

  const { data: raws } = await supabase
    .from("raw_platform_payloads")
    .select("id, platform, endpoint, request_params, payload, payload_sha256, fetched_at")
    .in("id", f.rawPayloadIds)
    .order("id");

  const label = `${SCOPE_LABELS[f.scope]?.[lang] ?? f.scope}: ${METRIC_LABELS[f.metric][lang]}`;
  return (
    <div className="page">
      <PageHeader
        crumbs={[{ href: `/w/${ws}/c/${client}`, label: t.dashboard }, { href: `/w/${ws}/c/${client}/r/${snapshot}`, label: t.reports }]}
        title={<>{t.figureDetail}: {label}</>}
      />

      <section className="card figure-hero">
        <div className="kpi-value">{f.display ? <span className="num">{f.display[lang]}</span> : f.status === "not_provided" ? t.notProvided : t.notApplicable}</div>
        <dl className="kv">
          <dt>{t.shownAs}</dt>
          <dd>{f.display ? <span className="num">{f.display[lang]}</span> : f.status === "not_provided" ? t.notProvided : t.notApplicable}</dd>
          <dt>{t.exactValue}</dt>
          <dd><code className="num">{JSON.stringify(f.value ?? { status: f.status, reason: f.reason })}</code></dd>
          <dt>{t.computedFrom}</dt>
          <dd>{t.rawPayloads}: <span className="num">{f.rawPayloadIds.length}</span></dd>
        </dl>
      </section>

      <h2 className="section-title">{t.rawPayloads}</h2>
      {(raws ?? []).map((r) => (
        <section key={r.id} className="card stack">
          <dl className="kv">
            <dt>{t.source}</dt>
            <dd><code className="num">{r.platform} {r.endpoint}</code></dd>
            <dt>{t.fetchedAt}</dt>
            <dd><span className="num">{new Date(r.fetched_at).toISOString()}</span></dd>
            <dt>{t.fingerprint}</dt>
            <dd><code className="num">{r.payload_sha256}</code></dd>
          </dl>
          <pre className="payload" tabIndex={0} aria-label={`${t.rawPayloads} #${r.id}`}>{JSON.stringify(r.payload, null, 2)}</pre>
        </section>
      ))}
    </div>
  );
}
