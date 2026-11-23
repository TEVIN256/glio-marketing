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

interface EvidenceLike {
  rule?: string; window?: { from: string; to: string }; currency?: string; spend_minor?: string; conversions?: string;
  cpa_minor?: string; client_cpa_minor?: string; current_budget_minor?: string; new_budget_minor?: string; limited_by_guardrail?: boolean;
}

/**
 * The reason shown for a request. GLIO suggestions are written here in the
 * reader's language from the stored evidence (numbers from platform data);
 * human proposals show the reason the person typed.
 */
export function describeReason(r: { reason: string | null; payload: Record<string, unknown> | null }, lang: Lang, t: Dict): string | null {
  const e = r.payload?.evidence as EvidenceLike | undefined;
  if (!e?.rule || !e.currency || !e.window || !e.spend_minor) return r.reason;
  const m = (v?: string) => (v ? formatMoney(BigInt(v), e.currency!, lang, "latn") : "");
  const vars: Record<string, string> = {
    from: e.window.from, to: e.window.to, spend: m(e.spend_minor), conv: e.conversions ?? "0",
    cpa: m(e.cpa_minor), clientCpa: m(e.client_cpa_minor), current: m(e.current_budget_minor), next: m(e.new_budget_minor),
  };
  const template = { pause_no_conversions: t.sgPause, cut_budget_high_cpa: t.sgCut, raise_budget_low_cpa: t.sgRaise }[e.rule as "pause_no_conversions"];
  if (!template) return r.reason;
  const text = template.replace(/\{(\w+)\}/g, (_, k: string) => vars[k] ?? "");
  return e.limited_by_guardrail ? `${text} ${t.sgLimited}` : text;
}

export const isSuggestion = (r: { requested_by_agent: string | null }) => Boolean(r.requested_by_agent?.startsWith("glio-"));
