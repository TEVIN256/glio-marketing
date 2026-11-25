import { proposeChange } from "@/app/(app)/w/[ws]/approvals/actions";
import type { CampaignRow } from "@/lib/dashboard";

export interface ProposeLabels {
  actions: string; propose: string; pause: string; enable: string; budget: string; newBudget: string; reason: string; pending: string;
}

export interface CampaignTableProps {
  rows: CampaignRow[];
  lang: "ar" | "en";
  labels: { campaign: string; spend: string; share: string; impressions: string; clicks: string; ctr: string; conversions: string; cpa: string; purchaseValue: string; roas: string; none: string };
  /** Set when the viewer may propose changes (owners, managers, analysts). */
  propose?: { ws: string; client: string; pending: Set<string>; labels: ProposeLabels };
}

/** Campaigns for the period, by spend, with a share-of-spend bar (single hue, magnitude only). */
export function CampaignTable({ rows, lang, labels, propose }: CampaignTableProps) {
  const cell = (v: { en: string; ar: string } | null) => (v ? <span className="num">{v[lang]}</span> : <span className="muted">—</span>);
  return (
    <div className="table-wrap">
      <table className="data-table">
        <thead>
          <tr>
            <th scope="col">{labels.campaign}</th>
            <th scope="col" className="n">{labels.spend}</th>
            <th scope="col" className="share-col">{labels.share}</th>
            <th scope="col" className="n">{labels.purchaseValue}</th>
            <th scope="col" className="n">{labels.roas}</th>
            <th scope="col" className="n">{labels.conversions}</th>
            <th scope="col" className="n">{labels.cpa}</th>
            <th scope="col" className="n">{labels.clicks}</th>
            <th scope="col" className="n">{labels.ctr}</th>
            <th scope="col" className="n">{labels.impressions}</th>
            {propose && <th scope="col"><span className="sr-only">{propose.labels.actions}</span></th>}
          </tr>
        </thead>
        <tbody>
          {rows.length === 0 && (
            <tr><td colSpan={propose ? 11 : 10} className="muted">{labels.none}</td></tr>
          )}
          {rows.map((r) => (
            <tr key={`${r.platform}:${r.id}:${r.currency}`}>
              <th scope="row">
                <span className="campaign-name">{r.name ?? r.id}</span>
                <span className="campaign-id" dir="ltr">{r.platform} · {r.id}</span>
                {propose?.pending.has(`${r.adAccountId}:${r.id}`) && <span className="badge drift">{propose.labels.pending}</span>}
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
              <td className="n">{cell(r.purchaseValue)}</td>
              <td className="n">{cell(r.roas)}</td>
              <td className="n">{cell(r.conversions)}</td>
              <td className="n">{cell(r.cpa)}</td>
              <td className="n">{cell(r.clicks)}</td>
              <td className="n">{cell(r.ctr)}</td>
              <td className="n">{cell(r.impressions)}</td>
              {propose && (
                <td className="n">
                  <details className="row-menu">
                    <summary className="button secondary">{propose.labels.propose}</summary>
                    <form className="row-menu-panel" action={proposeChange}>
                      <input type="hidden" name="ws" value={propose.ws} />
                      <input type="hidden" name="client" value={propose.client} />
                      <input type="hidden" name="ad_account" value={r.adAccountId} />
                      <input type="hidden" name="campaign_id" value={r.id} />
                      <input type="hidden" name="campaign_name" value={r.name ?? ""} />
                      <label htmlFor={`reason-${r.id}`}>{propose.labels.reason}</label>
                      <input id={`reason-${r.id}`} name="reason" maxLength={1000} />
                      <div className="row-menu-buttons">
                        <button type="submit" name="kind" value="campaign.pause" className="secondary">{propose.labels.pause}</button>
                        <button type="submit" name="kind" value="campaign.enable" className="secondary">{propose.labels.enable}</button>
                      </div>
                      <label htmlFor={`budget-${r.id}`}>{propose.labels.newBudget} <span className="muted">({r.currency})</span></label>
                      <div className="row-menu-buttons">
                        <input id={`budget-${r.id}`} name="budget" inputMode="decimal" dir="ltr" placeholder="150.00" />
                        <button type="submit" name="kind" value="campaign.budget">{propose.labels.budget}</button>
                      </div>
                    </form>
                  </details>
                </td>
              )}
            </tr>
          ))}
        </tbody>
      </table>
    </div>
  );
}
