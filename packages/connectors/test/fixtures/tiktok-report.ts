/**
 * SYNTHETIC TikTok report pages for tests, shaped after the documented v1.3
 * reporting response (checked 2026-11-25, see src/tiktok/api.ts). IDs and
 * names are obviously fake. Compare with an anonymised real response once a
 * real account is connected.
 */

type Row = { campaign: string; name: string; day: string; spend: string; impressions: string; clicks: string; conversion: string };

export function tiktokReportPage(rows: Row[], page: number, totalPages: number, totalNumber = rows.length) {
  return {
    code: 0,
    message: "OK",
    request_id: `test-request-${page}`,
    data: {
      list: rows.map((r) => ({
        dimensions: { campaign_id: r.campaign, stat_time_day: `${r.day} 00:00:00` },
        metrics: {
          campaign_name: r.name,
          spend: r.spend,
          impressions: r.impressions,
          clicks: r.clicks,
          conversion: r.conversion,
        },
      })),
      page_info: { page, page_size: 1000, total_number: totalNumber, total_page: totalPages },
    },
  };
}

/** Two pages, two campaigns, three days (2026-01-01..03). */
export const PAGE_1 = tiktokReportPage(
  [
    { campaign: "test-campaign-001", name: "Test Campaign One", day: "2026-01-01", spend: "120.50", impressions: "10000", clicks: "250", conversion: "12" },
    { campaign: "test-campaign-001", name: "Test Campaign One", day: "2026-01-02", spend: "99.99", impressions: "8000", clicks: "190", conversion: "9" },
    { campaign: "test-campaign-001", name: "Test Campaign One", day: "2026-01-03", spend: "0.00", impressions: "0", clicks: "0", conversion: "0" },
  ],
  1, 2, 6,
);

export const PAGE_2 = tiktokReportPage(
  [
    { campaign: "test-campaign-002", name: "Test Campaign Two", day: "2026-01-01", spend: "45.10", impressions: "5000", clicks: "80", conversion: "3" },
    { campaign: "test-campaign-002", name: "Test Campaign Two", day: "2026-01-02", spend: "60.00", impressions: "6100", clicks: "95", conversion: "4" },
    { campaign: "test-campaign-002", name: "Test Campaign Two", day: "2026-01-03", spend: "12.30", impressions: "1500", clicks: "20", conversion: "1" },
  ],
  2, 2, 6,
);

/** Expected totals for PAGE_1 + PAGE_2, in SAR halalas. */
export const EXPECTED_TOTALS = {
  spend_minor: 12050 + 9999 + 0 + 4510 + 6000 + 1230, // 33789
  impressions: 10000 + 8000 + 0 + 5000 + 6100 + 1500, // 30600
  clicks: 250 + 190 + 0 + 80 + 95 + 20, // 635
  conversions: 12 + 9 + 0 + 3 + 4 + 1, // 29
  rows: 6,
};

/** SYNTHETIC account-level totals response (one aggregated row). */
export function tiktokAccountTotals(t: { spend: string; impressions: string; clicks: string; conversion: string }) {
  return {
    code: 0,
    message: "OK",
    request_id: "test-request-totals",
    data: {
      list: [{ dimensions: { advertiser_id: "test-advertiser-1" }, metrics: { ...t } }],
      page_info: { page: 1, page_size: 10, total_number: 1, total_page: 1 },
    },
  };
}
