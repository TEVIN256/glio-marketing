import { assertIsoDate, sha256OfJson } from "@glio/core";
import { type SqlExecutor, clientValueSources } from "@glio/sync";
import { type CommentaryModel, type CommentaryResult, generateCommentary } from "./commentary.ts";
import { type ChannelTotals, type ReportModel, buildReport } from "./figures.ts";
import type { Digits } from "./format.ts";

type Sum = bigint | null | "partial";

/** Sum one metric across rows: null if no row has it, "partial" if only some do. */
function summed(n: number, nonNull: number, total: string | null, scale = false): Sum {
  if (n === 0) return 0n; // no rows: nothing was delivered in the period
  if (nonNull === 0) return null;
  if (nonNull < n) return "partial";
  const text = total ?? "0";
  if (!scale) return BigInt(text);
  const [whole = "0", frac = ""] = text.split(".");
  return BigInt(whole + frac.padEnd(4, "0").slice(0, 4)); // numeric(20,4) sum has at most 4 decimals
}

/** Load per-channel totals for a client and period, with the raw payloads behind them. */
export async function loadChannelTotals(
  db: SqlExecutor,
  clientId: string,
  period: { from: string; to: string },
): Promise<{ channels: ChannelTotals[]; total: ChannelTotals | null; valueSources: string[] }> {
  const sources = await clientValueSources(db, clientId);
  const rows = await db.query(
    `select m.platform, m.currency, count(*)::int as n,
            count(m.spend_minor)::int as n_spend, sum(m.spend_minor)::text as spend,
            count(m.impressions)::int as n_impr, sum(m.impressions)::text as impressions,
            count(m.clicks)::int as n_clicks, sum(m.clicks)::text as clicks,
            count(m.conversions)::int as n_conv, sum(m.conversions)::text as conversions,
            count(m.purchase_value_minor)::int as n_value, sum(m.purchase_value_minor)::text as purchase_value,
            count(m.app_purchase_value_minor)::int as n_app, sum(m.app_purchase_value_minor)::text as app_value,
            count(m.shop_revenue_minor)::int as n_shop, sum(m.shop_revenue_minor)::text as shop_revenue,
            array_agg(distinct m.raw_payload_id order by m.raw_payload_id) as raw_ids
     from public.metric_daily m
     where m.client_id = $1 and m.level = 'campaign' and m.date between $2 and $3
     group by m.platform, m.currency
     order by m.platform, m.currency`,
    [clientId, period.from, period.to],
  );
  const recon = await db.query(
    `select a.platform, l.status
     from public.reconciliation_latest l join public.ad_accounts a on a.id = l.ad_account_id
     where l.client_id = $1`,
    [clientId],
  );
  const reconFor = (platform: string): ChannelTotals["reconciliation"] => {
    const statuses = recon.filter((r) => r.platform === platform).map((r) => r.status as string);
    if (statuses.length === 0) return "unchecked";
    return statuses.includes("drift") ? "drift" : statuses.includes("not_comparable") ? "not_comparable" : "ok";
  };

  const platformsWithManyCurrencies = new Set(
    rows.map((r) => r.platform).filter((p, i, all) => all.indexOf(p) !== i),
  );
  const channels: ChannelTotals[] = rows.map((r) => ({
    scope: platformsWithManyCurrencies.has(r.platform) ? `${r.platform}_${r.currency}` : r.platform,
    currency: r.currency,
    rows: r.n,
    spendMinor: summed(r.n, r.n_spend, r.spend),
    impressions: summed(r.n, r.n_impr, r.impressions),
    clicks: summed(r.n, r.n_clicks, r.clicks),
    conversionsScaled: summed(r.n, r.n_conv, r.conversions, true),
    // In-app and TikTok Shop values are TikTok metrics: other platforms count their own purchase value only.
    purchaseValueMinor: combine((r.platform === "tiktok" ? sources : ["website" as const]).map((s) =>
      s === "app" ? summed(r.n, r.n_app, r.app_value) : s === "shop" ? summed(r.n, r.n_shop, r.shop_revenue) : summed(r.n, r.n_value, r.purchase_value))),
    rawPayloadIds: (r.raw_ids as Array<string | number>).map(Number),
    reconciliation: reconFor(r.platform),
  }));

  if (channels.length <= 1) return { channels, total: null, valueSources: sources };
  const currencies = new Set(channels.map((c) => c.currency));
  const add = (pick: (c: ChannelTotals) => Sum): Sum => {
    let total = 0n;
    for (const c of channels) {
      const v = pick(c);
      if (v === null || v === "partial") return v === null ? null : "partial";
      total += v;
    }
    return total;
  };
  const total: ChannelTotals = {
    scope: "total",
    currency: currencies.size === 1 ? channels[0]!.currency : null,
    rows: channels.reduce((s, c) => s + c.rows, 0),
    spendMinor: add((c) => c.spendMinor),
    impressions: add((c) => c.impressions),
    clicks: add((c) => c.clicks),
    conversionsScaled: add((c) => c.conversionsScaled),
    purchaseValueMinor: add((c) => c.purchaseValueMinor ?? null),
    rawPayloadIds: [...new Set(channels.flatMap((c) => c.rawPayloadIds))].sort((a, b) => a - b),
    reconciliation: channels.some((c) => c.reconciliation === "drift") ? "drift" : "ok",
  };
  return { channels, total, valueSources: sources };
}

/** Sum of the client's value sources: any "not provided" source makes it not provided; any partial, partial. */
export function combine(parts: Sum[]): Sum {
  let total = 0n;
  for (const p of parts) {
    if (p === null) return null;
    if (p === "partial") return "partial";
    total += p;
  }
  return total;
}

export interface SnapshotDeps {
  db: SqlExecutor;
  model: CommentaryModel | null;
}

export interface SnapshotArgs {
  clientId: string;
  dateFrom: string;
  dateTo: string;
  digits?: Digits;
  createdBy?: string; // auth user id
  createdByLabel?: string; // e.g. "scheduler"
}

export interface SnapshotResult {
  snapshotId: string;
  commentaryId: string;
  report: ReportModel;
  reportSha256: string;
  commentary: CommentaryResult;
}

/**
 * Build a client's report for a period, generate (and validate) the
 * commentary, and store both as permanent records. What is stored is exactly
 * what the client will be shown.
 */
export async function createReportSnapshot(deps: SnapshotDeps, args: SnapshotArgs): Promise<SnapshotResult> {
  assertIsoDate(args.dateFrom);
  assertIsoDate(args.dateTo);
  if (args.dateTo < args.dateFrom) throw new Error("Report period ends before it starts");
  if (!args.createdBy && !args.createdByLabel) throw new Error("A snapshot needs a creator (user id or label)");

  const [client] = await deps.db.query("select id, workspace_id from public.clients where id = $1", [args.clientId]);
  if (!client) throw new Error(`Client ${args.clientId} not found`);

  const period = { from: args.dateFrom, to: args.dateTo };
  const { channels, total, valueSources } = await loadChannelTotals(deps.db, args.clientId, period);
  const report = buildReport({ period, channels, total, valueSources, digits: args.digits ?? "latn" });
  const reportSha256 = sha256OfJson(report);
  const commentary = await generateCommentary(deps.model, report);

  const ids = await deps.db.transaction(async (q) => {
    const [c] = await q(
      `insert into public.ai_commentary
         (workspace_id, client_id, input, input_sha256, prompt_version, system_prompt_sha256, model, source, text_ar, text_en, attempts)
       values ($1, $2, $3, $4, $5, $6, $7, $8, $9, $10, $11) returning id`,
      [
        client.workspace_id, client.id, JSON.stringify(commentary.input), commentary.inputSha256, commentary.promptVersion,
        commentary.systemPromptSha256, commentary.model, commentary.source, commentary.ar, commentary.en,
        JSON.stringify(commentary.attempts),
      ],
    );
    const [s] = await q(
      `insert into public.report_snapshots
         (workspace_id, client_id, date_from, date_to, report, report_sha256, commentary_id, created_by, created_by_label)
       values ($1, $2, $3, $4, $5, $6, $7, $8, $9) returning id`,
      [
        client.workspace_id, client.id, period.from, period.to, JSON.stringify(report), reportSha256, c!.id,
        args.createdBy ?? null, args.createdByLabel ?? null,
      ],
    );
    return { snapshotId: s!.id as string, commentaryId: c!.id as string };
  });

  return { ...ids, report, reportSha256, commentary };
}
