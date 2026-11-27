import { type Figure, METRIC_ORDER, type MetricId, type ReportModel, metricLabel } from "@glio/reports";
import { METRIC_LABELS, SCOPE_LABELS } from "@glio/reports";
import type { Dict, Lang } from "@/lib/i18n";

/**
 * Presentational view of a stored report snapshot: the summary and every
 * figure. Each figure with a value links to its provenance page, where the
 * raw platform responses behind it are shown. Renders the snapshot exactly as
 * stored; it computes nothing.
 */

const ORDER: MetricId[] = METRIC_ORDER;

/**
 * Wrap every number, date or amount in the commentary in a direction-isolated
 * span, so Arabic text flow can't reorder it (e.g. 2026-10-16 showing as
 * 16-10-2026). Covers Western and Arabic-Indic digits with their separators.
 */
const NUMBERISH = /([0-9٠-٩۰-۹](?:[0-9٠-٩۰-۹.,٫٬:\/\-%٪]*[0-9٠-٩۰-۹%٪])?)/g;
export function isolateNumbers(text: string): React.ReactNode[] {
  return text.split(NUMBERISH).map((part, i) => (i % 2 === 1 ? <span key={i} className="num">{part}</span> : part));
}

export interface ReportViewProps {
  report: ReportModel;
  commentary: { ar: string; en: string; source: "llm" | "template" };
  lang: Lang;
  t: Dict;
  /** Link from each figure to its provenance page; omit for read-only shared views. */
  figureHref?: (figureId: string) => string;
}

export function ReportView({ report, commentary, lang, t, figureHref }: ReportViewProps) {
  const scopes = [...report.channels.map((c) => c.scope), ...(report.figures.some((f) => f.scope === "total") ? ["total"] : [])];
  const recon = (scope: string) => report.channels.find((c) => c.scope === scope)?.reconciliation;

  return (
    <div className="page">
      <section className="card stack summary-card" aria-labelledby="summary-h">
        <h2 id="summary-h" style={{ marginBlockStart: 0 }}>{t.summary}</h2>
        <p className="commentary" lang={lang}>{isolateNumbers(lang === "ar" ? commentary.ar : commentary.en)}</p>
        <p className="muted">{commentary.source === "llm" ? t.summaryByAi : t.summaryByTemplate}</p>
      </section>

      {scopes.map((scope) => {
        const figures = ORDER.map((m) => report.figures.find((f) => f.scope === scope && f.metric === m)).filter(
          (f): f is Figure => Boolean(f),
        );
        const status = recon(scope);
        return (
          <section key={scope} className="channel" aria-labelledby={`h-${scope}`}>
            <div className="channel-head">
              <h2 id={`h-${scope}`} style={{ margin: 0 }}>{SCOPE_LABELS[scope]?.[lang] ?? scope}</h2>
              {status && (
                <span className={`badge ${status === "ok" ? "ok" : status === "drift" ? "drift" : "other"}`}>
                  {status === "ok" ? t.reconOk : status === "drift" ? t.reconDrift : status === "not_comparable" ? t.reconNotComparable : t.reconUnchecked}
                </span>
              )}
            </div>
            <div className="figures">
              {figures.map((f) => {
                const label = metricLabel(f.metric, lang, report.valueSources);
                if (f.status !== "value" || !f.display) {
                  return (
                    <div key={f.id} className="figure" data-figure={f.id}>
                      <div className="figure-label">{label}</div>
                      <div className="figure-missing">{f.status === "not_provided" ? t.notProvided : t.notApplicable}</div>
                    </div>
                  );
                }
                if (!figureHref) {
                  return (
                    <div key={f.id} className="figure" data-figure={f.id}>
                      <div className="figure-label">{label}</div>
                      <div className="figure-value"><span className="num">{f.display[lang]}</span></div>
                    </div>
                  );
                }
                return (
                  <a key={f.id} className="figure" href={figureHref(f.id)} data-figure={f.id} aria-label={`${label}: ${f.display[lang]}. ${t.viewSource}`}>
                    <div className="figure-label">{label}</div>
                    <div className="figure-value"><span className="num">{f.display[lang]}</span></div>
                    <div className="figure-source">{t.viewSource}</div>
                  </a>
                );
              })}
            </div>
          </section>
        );
      })}
    </div>
  );
}
