import type { CampaignRow } from "@/lib/dashboard";

export interface CampaignTableProps {
  rows: CampaignRow[];
  lang: "ar" | "en";
  labels: { campaign: string; spend: string; share: string; impressions: string; clicks: string; ctr: string; conversions: string; cpa: string; none: string };
}

/** Campaigns for the period, by spend, with a share-of-spend bar (single hue, magnitude only). */
export function CampaignTable({ rows, lang, labels }: CampaignTableProps) {
  const cell = (v: { en: string; ar: string } | null) => (v ? <span className="num">{v[lang]}</span> : <span className="muted">—</span>);
  return (
    <div className="table-wrap">
      <table className="data-table">
        <thead>
          <tr>
            <th scope="col">{labels.campaign}</th>
            <th scope="col" className="n">{labels.spend}</th>
            <th scope="col" className="share-col">{labels.share}</th>
            <th scope="col" className="n">{labels.impressions}</th>
            <th scope="col" className="n">{labels.clicks}</th>
            <th scope="col" className="n">{labels.ctr}</th>
            <th scope="col" className="n">{labels.conversions}</th>
            <th scope="col" className="n">{labels.cpa}</th>
          </tr>
        </thead>
        <tbody>
          {rows.length === 0 && (
            <tr><td colSpan={8} className="muted">{labels.none}</td></tr>
          )}
          {rows.map((r) => (
            <tr key={`${r.platform}:${r.id}:${r.currency}`}>
              <th scope="row">
                <span className="campaign-name">{r.name ?? r.id}</span>
                <span className="campaign-id" dir="ltr">{r.platform} · {r.id}</span>
              </th>
              <td className="n">{cell(r.spend)}</td>
              <td className="share-col">
                {r.spendShare !== null && (
                  <span className="share" title={`${(r.spendShare * 100).toFixed(1)}%`}>
                    <span className="share-bar" style={{ inlineSize: `${Math.max(2, r.spendShare * 100)}%` }} />
                    <span className="share-text num">{(r.spendShare * 100).toFixed(1)}%</span>
                  </span>
                )}
              </td>
              <td className="n">{cell(r.impressions)}</td>
              <td className="n">{cell(r.clicks)}</td>
              <td className="n">{cell(r.ctr)}</td>
              <td className="n">{cell(r.conversions)}</td>
              <td className="n">{cell(r.cpa)}</td>
            </tr>
          ))}
        </tbody>
      </table>
    </div>
  );
}
