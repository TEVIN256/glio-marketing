import { formatMoney } from "@glio/reports";
import type { Dict, Lang } from "./i18n";

/** Plain-language description of an approval request and of campaign states, for the UI. */

export interface ApprovalRow {
  id: string;
  kind: string;
  payload: Record<string, unknown> | null;
  target_name: string | null;
  target_id: string | null;
}

export function describeChange(r: ApprovalRow, currency: string | null, lang: Lang, t: Dict): string {
  const name = r.target_name || r.target_id || "?";
  if (r.kind === "campaign.pause") return t.kindPause.replace("{c}", name);
  if (r.kind === "campaign.enable") return t.kindEnable.replace("{c}", name);
  if (r.kind === "campaign.budget") {
    const minor = String(r.payload?.budget_minor ?? "");
    const b = currency && /^\d+$/.test(minor) ? formatMoney(BigInt(minor), currency, lang, "latn") : minor;
    return t.kindBudget.replace("{c}", name).replace("{b}", b);
  }
  return r.kind;
}

export interface StateLike { status?: string | null; budgetMinor?: string | null }

/** "On · SAR 150.00" */
export function describeState(s: StateLike | null, currency: string | null, lang: Lang, t: Dict): string {
  if (!s) return "—";
  const parts: string[] = [];
  if (s.status === "ENABLE") parts.push(t.statusOn);
  if (s.status === "DISABLE") parts.push(t.statusOff);
  if (s.budgetMinor && currency) parts.push(formatMoney(BigInt(s.budgetMinor), currency, lang, "latn"));
  return parts.join(" · ") || "—";
}
