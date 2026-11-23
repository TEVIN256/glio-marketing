import { addDays, minorToDecimalString, minorUnitDigits } from "@glio/core";
import { type ExecutorDeps, campaignAccess } from "./approvals.ts";

/**
 * GLIO suggestions (rules v1). Reads each client's stored daily campaign
 * metrics and PROPOSES changes as approval requests from the agent
 * "glio-rules/v1". It never executes anything: every suggestion waits for an
 * owner or manager on the Approvals screen, and runs through the same executor
 * and guardrails as a human proposal.
 *
 * Every number in a suggestion comes from stored platform data (metric_daily)
 * or the campaign's current state read from the platform, and is kept in
 * payload.evidence so the reason can be shown (and checked) in any language.
 * All comparisons use exact integer arithmetic.
 */

export const RULES_AGENT = "glio-rules/v1";
export const LOOKBACK_DAYS = 7;
/** Don't suggest again for a campaign within this many days of a decision on a suggestion for it. */
export const COOLDOWN_DAYS = 7;
export const SUGGESTION_TTL_HOURS = 72;

export interface RuleSettings {
  /** Minimum spend in the window, in major units of the account currency, before judging a campaign. */
  minSpendMajor: number;
  /** "No conversions": pause after this much spend with zero conversions. */
  pauseMinSpendMajor: number;
  /** High CPA: campaign CPA >= this x client CPA (as a percentage, 150 = 1.5x). */
  highCpaPct: number;
  /** Winner: campaign CPA <= this x client CPA (70 = 0.7x). */
  lowCpaPct: number;
  minConversionsForCut: number;
  minConversionsForRaise: number;
  /** Budget step for cut/raise, percent of the current daily budget. */
  stepPct: number;
}

export const DEFAULT_RULES: RuleSettings = {
  minSpendMajor: 100,
  pauseMinSpendMajor: 300,
  highCpaPct: 150,
  lowCpaPct: 70,
  minConversionsForCut: 3,
  minConversionsForRaise: 10,
  stepPct: 20,
};

export type RuleId = "pause_no_conversions" | "cut_budget_high_cpa" | "raise_budget_low_cpa";

export interface Evidence {
  rule: RuleId;
  version: 1;
  window: { from: string; to: string };
  currency: string;
  spend_minor: string;
  conversions: string; // decimal text, exact
  cpa_minor?: string; // rounded to a whole minor unit, display only
  client_cpa_minor?: string;
  current_budget_minor?: string;
  new_budget_minor?: string;
  limited_by_guardrail?: boolean;
  thresholds: Record<string, number>;
}

export interface SuggestionOutcome {
  clientId: string;
  created: Array<{ id: string; rule: RuleId; campaignId: string }>;
  skipped: Array<{ campaignId: string; reason: string }>;
}

const SCALE = 10_000n; // conversions are numeric(…,4): handled as integers x 10^4

const unscale = (v: bigint) => {
  const s = `${v / SCALE}.${(v % SCALE).toString().padStart(4, "0")}`;
  return s.replace(/0+$/, "").replace(/\.$/, "");
};
const scaled = (text: string | null): bigint => {
  if (text === null) return 0n;
  const [w = "0", f = ""] = text.split(".");
  return BigInt(w + f.padEnd(4, "0").slice(0, 4));
};
/** Minor units in one major unit (SAR 1 = 100 halalas). */
const unit = (currency: string) => 10n ** BigInt(minorUnitDigits(currency));
/** Round down to whole major units (budgets like SAR 120.00, not 119.47). */
const roundDownToMajor = (minor: bigint, currency: string) => (minor / unit(currency)) * unit(currency);
const divRound = (n: bigint, d: bigint) => (n * 2n + d) / (2n * d);

function englishReason(e: Evidence): string {
  const m = (v?: string) => (v === undefined ? "" : `${e.currency} ${minorToDecimalString(BigInt(v), e.currency)}`);
  const w = `${e.window.from} to ${e.window.to}`;
  if (e.rule === "pause_no_conversions") return `Spent ${m(e.spend_minor)} from ${w} with no conversions.`;
  if (e.rule === "cut_budget_high_cpa") {
    return `Cost per conversion ${m(e.cpa_minor)} vs the client's ${m(e.client_cpa_minor)} (${w}); lower the daily budget from ${m(e.current_budget_minor)} to ${m(e.new_budget_minor)}.`;
  }
  return `Cost per conversion ${m(e.cpa_minor)} vs the client's ${m(e.client_cpa_minor)} (${w}); raise the daily budget from ${m(e.current_budget_minor)} to ${m(e.new_budget_minor)}.`;
}

interface CampaignStats {
  adAccountId: string;
  campaignId: string;
  name: string | null;
  currency: string;
  spend: bigint;
  conv: bigint; // x 10^4
}

/**
 * Generate suggestions for one client from the last LOOKBACK_DAYS complete days
 * ending `yesterday`. Returns what was created and why other campaigns were skipped.
 */
export async function suggestForClient(
  deps: ExecutorDeps,
  args: { clientId: string; yesterday: string; settings?: RuleSettings },
): Promise<SuggestionOutcome> {
  const s = args.settings ?? DEFAULT_RULES;
  const window = { from: addDays(args.yesterday, -(LOOKBACK_DAYS - 1)), to: args.yesterday };
  const out: SuggestionOutcome = { clientId: args.clientId, created: [], skipped: [] };

  const [client] = await deps.db.query("select id, workspace_id from public.clients where id = $1", [args.clientId]);
  if (!client) return out;

  // Per-campaign totals; a campaign with any day missing spend or conversions is not judged (no guessing).
  const rows = await deps.db.query(
    `select m.ad_account_id, m.entity_id, max(m.entity_name) as name, m.currency, count(*)::int as n,
            count(m.spend_minor)::int as n_spend, coalesce(sum(m.spend_minor), 0)::text as spend,
            count(m.conversions)::int as n_conv, coalesce(sum(m.conversions), 0)::text as conv
     from public.metric_daily m
     join public.ad_accounts a on a.id = m.ad_account_id and a.status = 'active'
     where m.client_id = $1 and m.level = 'campaign' and m.date between $2 and $3
     group by m.ad_account_id, m.entity_id, m.currency`,
    [args.clientId, window.from, window.to],
  );
  const stats: CampaignStats[] = [];
  for (const r of rows) {
    if (r.n_spend < r.n || r.n_conv < r.n) {
      out.skipped.push({ campaignId: r.entity_id, reason: "incomplete_data" });
      continue;
    }
    stats.push({ adAccountId: r.ad_account_id, campaignId: r.entity_id, name: r.name, currency: r.currency, spend: BigInt(r.spend), conv: scaled(r.conv) });
  }

  // Campaigns with an open request, or a recent decision on a suggestion: leave them alone.
  const busy = new Set(
    (await deps.db.query(
      `select ad_account_id, target_id from public.approval_requests
       where client_id = $1 and (
         status in ('pending', 'approved', 'executing')
         or (requested_by_agent is not null and coalesce(executed_at, decided_at, created_at) > now() - ($2 || ' days')::interval)
       )`,
      [args.clientId, String(COOLDOWN_DAYS)],
    )).map((r) => `${r.ad_account_id}:${r.target_id}`),
  );
  const [guard] = await deps.db.query(
    "select max_daily_budget_minor::text as max, max_budget_increase_pct as pct from public.client_guardrails where client_id = $1",
    [args.clientId],
  );
  const maxIncreasePct = BigInt(guard?.pct ?? 50);
  const maxDaily = guard?.max ? BigInt(guard.max) : null;

  for (const currency of new Set(stats.map((c) => c.currency))) {
    const group = stats.filter((c) => c.currency === currency);
    const totalSpend = group.reduce((a, c) => a + c.spend, 0n);
    const totalConv = group.reduce((a, c) => a + c.conv, 0n);
    const minSpend = BigInt(s.minSpendMajor) * unit(currency);
    const pauseMin = BigInt(s.pauseMinSpendMajor) * unit(currency);
    // CPA comparisons need at least two campaigns with conversions, else "the client's CPA" is just this campaign's.
    const withConv = group.filter((c) => c.conv > 0n).length;
    const clientCpa = totalConv > 0n ? divRound(totalSpend * SCALE, totalConv) : null;

    for (const c of group) {
      const key = `${c.adAccountId}:${c.campaignId}`;
      if (busy.has(key)) { out.skipped.push({ campaignId: c.campaignId, reason: "open_or_recent_request" }); continue; }

      let rule: RuleId | null = null;
      if (c.conv === 0n && c.spend >= pauseMin) rule = "pause_no_conversions";
      else if (withConv >= 2 && totalConv > 0n && c.spend >= minSpend && c.conv > 0n) {
        // c.spend/c.conv  vs  pct/100 * totalSpend/totalConv, cross-multiplied (all positive).
        const lhs = c.spend * totalConv * 100n;
        if (c.conv >= BigInt(s.minConversionsForCut) * SCALE && lhs >= BigInt(s.highCpaPct) * totalSpend * c.conv) rule = "cut_budget_high_cpa";
        else if (c.conv >= BigInt(s.minConversionsForRaise) * SCALE && lhs <= BigInt(s.lowCpaPct) * totalSpend * c.conv) rule = "raise_budget_low_cpa";
      }
      if (!rule) continue;

      // Current state from the platform (or the demo account's last known state).
      let state;
      try {
        const { writer, target } = await campaignAccess(deps, c.adAccountId, c.campaignId);
        state = await writer.getCampaign(target);
      } catch {
        out.skipped.push({ campaignId: c.campaignId, reason: "state_unavailable" });
        continue;
      }
      if (state.status !== "ENABLE") { out.skipped.push({ campaignId: c.campaignId, reason: "not_running" }); continue; }

      const evidence: Evidence = {
        rule, version: 1, window, currency, spend_minor: String(c.spend), conversions: unscale(c.conv),
        thresholds: rule === "pause_no_conversions"
          ? { min_spend_major: s.pauseMinSpendMajor }
          : rule === "cut_budget_high_cpa"
            ? { high_cpa_pct: s.highCpaPct, min_conversions: s.minConversionsForCut, step_pct: s.stepPct }
            : { low_cpa_pct: s.lowCpaPct, min_conversions: s.minConversionsForRaise, step_pct: s.stepPct, max_increase_pct: Number(maxIncreasePct) },
      };
      let kind = "campaign.pause";
      const payload: Record<string, unknown> = {};

      if (rule !== "pause_no_conversions") {
        if (state.budgetMinor === null) { out.skipped.push({ campaignId: c.campaignId, reason: "no_daily_budget" }); continue; }
        const current = BigInt(state.budgetMinor);
        let next: bigint;
        if (rule === "cut_budget_high_cpa") {
          next = roundDownToMajor((current * BigInt(100 - s.stepPct)) / 100n, currency);
          if (next <= 0n || next >= current) { out.skipped.push({ campaignId: c.campaignId, reason: "budget_too_small" }); continue; }
        } else {
          const step = BigInt(Math.min(s.stepPct, Number(maxIncreasePct)));
          next = roundDownToMajor((current * (100n + step)) / 100n, currency);
          if (maxDaily !== null && next > maxDaily) { next = maxDaily; evidence.limited_by_guardrail = true; }
          if (step < BigInt(s.stepPct)) evidence.limited_by_guardrail = true;
          if (next <= current) { out.skipped.push({ campaignId: c.campaignId, reason: "at_guardrail" }); continue; }
        }
        kind = "campaign.budget";
        payload.budget_minor = String(next);
        evidence.current_budget_minor = String(current);
        evidence.new_budget_minor = String(next);
        evidence.cpa_minor = String(divRound(c.spend * SCALE, c.conv));
        evidence.client_cpa_minor = String(clientCpa);
      }
      payload.evidence = evidence;

      const [created] = await deps.db.query(
        `insert into public.approval_requests
           (workspace_id, client_id, kind, payload, requested_by_agent, ad_account_id, target_type, target_id, target_name, reason, expires_at)
         values ($1, $2, $3, $4, $5, $6, 'campaign', $7, $8, $9, now() + ($10 || ' hours')::interval) returning id`,
        [client.workspace_id, client.id, kind, JSON.stringify(payload), RULES_AGENT, c.adAccountId, c.campaignId,
          c.name ?? state.name, englishReason(evidence), String(SUGGESTION_TTL_HOURS)],
      );
      await deps.db.query(
        `insert into public.audit_log (workspace_id, actor_kind, actor_label, action, entity_type, entity_id, metadata)
         values ($1, 'agent', $2, 'approval.suggested', 'approval_request', $3, $4)`,
        [client.workspace_id, RULES_AGENT, created!.id, JSON.stringify({ rule, client_id: client.id, target_id: c.campaignId })],
      );
      busy.add(key);
      out.created.push({ id: created!.id, rule, campaignId: c.campaignId });
    }
  }
  return out;
}

/** Run the rules for several clients; one client's failure doesn't stop the others. */
export async function suggestForClients(
  deps: ExecutorDeps,
  args: { clientIds: string[]; yesterday: string; settings?: RuleSettings },
): Promise<Array<SuggestionOutcome & { error?: string }>> {
  const results: Array<SuggestionOutcome & { error?: string }> = [];
  for (const clientId of args.clientIds) {
    try {
      results.push(await suggestForClient(deps, { clientId, yesterday: args.yesterday, settings: args.settings }));
    } catch (err) {
      const code = (err as { code?: unknown })?.code;
      results.push({ clientId, created: [], skipped: [], error: typeof code === "string" ? code.slice(0, 40) : "UNKNOWN" });
    }
  }
  return results;
}
