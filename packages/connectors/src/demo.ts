import { addDays, sha256OfJson } from "@glio/core";
import type { FetchLike } from "./types.ts";

/**
 * SYNTHETIC demo data, for showing the product before real API access.
 *
 * A fake TikTok HTTP layer that produces deterministic, obviously fake
 * campaigns ("Demo Campaign A/B") for any date range, shaped like the
 * TikTok responses the connector expects. C, D and E have distinct
 * conversion rates (none / very high / very low) so the suggestion rules have
 * something to find. Account totals always equal the
 * sum of the daily rows, so reconciliation reports "ok".
 *
 * Only used when GLIO_DEMO_MODE=1. Never mix demo accounts with real ones:
 * demo ad accounts use the external id prefix "demo-".
 */

export const DEMO_EXTERNAL_ID = "demo-advertiser-001";
/** cvr = conversion rate range in percent of clicks (default 2-9). */
const CAMPAIGNS: Array<{ id: string; name: string; cvr?: [number, number] }> = [
  { id: "demo-campaign-a", name: "Demo Campaign A" },
  { id: "demo-campaign-b", name: "Demo Campaign B" },
  { id: "demo-campaign-c", name: "Demo Campaign C (no conversions)", cvr: [0, 0] },
  { id: "demo-campaign-d", name: "Demo Campaign D (strong)", cvr: [15, 25] },
  { id: "demo-campaign-e", name: "Demo Campaign E (expensive)", cvr: [1, 2] },
];

/** Deterministic pseudo-random integer in [min, max] from a seed string. */
function seeded(seed: string, min: number, max: number): number {
  const n = parseInt(sha256OfJson(seed).slice(0, 8), 16);
  return min + (n % (max - min + 1));
}

function demoRow(campaign: (typeof CAMPAIGNS)[number], day: string) {
  const impressions = seeded(`${campaign.id}|${day}|imp`, 2_000, 12_000);
  const clicks = Math.floor(impressions * seeded(`${campaign.id}|${day}|ctr`, 8, 30) / 1000);
  const [cvrMin, cvrMax] = campaign.cvr ?? [2, 9];
  const conversions = Math.floor(clicks * seeded(`${campaign.id}|${day}|cvr`, cvrMin, cvrMax) / 100);
  const spendHalalas = clicks * seeded(`${campaign.id}|${day}|cpc`, 35, 90);
  return {
    campaign, day, impressions, clicks, conversions,
    spend: `${Math.floor(spendHalalas / 100)}.${String(spendHalalas % 100).padStart(2, "0")}`,
    spendHalalas,
  };
}

function rowsFor(from: string, to: string) {
  const rows: ReturnType<typeof demoRow>[] = [];
  for (let day = from; day <= to; day = addDays(day, 1)) {
    for (const c of CAMPAIGNS) rows.push(demoRow(c, day));
  }
  return rows;
}

export const demoTikTokFetch: FetchLike = async (url) => {
  const p = new URL(url).searchParams;
  const from = p.get("start_date")!;
  const to = p.get("end_date")!;
  const rows = rowsFor(from, to);
  const requestId = `demo-${sha256OfJson(url).slice(0, 12)}`;

  if (p.get("data_level") === "AUCTION_ADVERTISER") {
    const sum = (k: "impressions" | "clicks" | "conversions" | "spendHalalas") => rows.reduce((s, r) => s + r[k], 0);
    const spend = sum("spendHalalas");
    return {
      status: 200,
      json: async () => ({
        code: 0, message: "OK", request_id: requestId,
        data: {
          list: [{
            dimensions: { advertiser_id: DEMO_EXTERNAL_ID },
            metrics: {
              spend: `${Math.floor(spend / 100)}.${String(spend % 100).padStart(2, "0")}`,
              impressions: String(sum("impressions")), clicks: String(sum("clicks")), conversion: String(sum("conversions")),
            },
          }],
          page_info: { page: 1, page_size: 10, total_number: 1, total_page: 1 },
        },
      }),
    };
  }

  return {
    status: 200,
    json: async () => ({
      code: 0, message: "OK", request_id: requestId,
      data: {
        list: rows.map((r) => ({
          dimensions: { campaign_id: r.campaign.id, stat_time_day: `${r.day} 00:00:00` },
          metrics: {
            campaign_name: r.campaign.name, spend: r.spend, impressions: String(r.impressions),
            clicks: String(r.clicks), conversion: String(r.conversions),
          },
        })),
        page_info: { page: 1, page_size: 1000, total_number: rows.length, total_page: 1 },
      },
    }),
  };
};
