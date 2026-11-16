/**
 * TikTok API for Business: endpoints, parameters and response shapes.
 *
 * TODO(verify): Everything in this file comes from the TikTok Marketing API
 * v1.3 as remembered, NOT from documentation read for this project. TikTok
 * now also documents a v2.0 API (its v2.0 reference currently covers
 * authentication and reporting). Before connecting a real account, confirm
 * each item below against the developer portal and update the fixtures in
 * test/fixtures to match a real (anonymised) response:
 *   - base URL and API version
 *   - authorization URL and its query parameters
 *   - token exchange path, request body and response fields
 *   - report path, parameter names, JSON-encoding of array parameters
 *   - dimension and metric names, and whether spend is returned as a string
 *   - the maximum date range per daily report request
 *   - which business error codes mean "rate limited" / "retry later"
 * This file is the ONLY place these details live.
 */

export const TIKTOK_API_BASE = "https://business-api.tiktok.com/open_api/v1.3"; // TODO(verify)
export const TIKTOK_AUTH_URL = "https://business-api.tiktok.com/portal/auth"; // TODO(verify)
export const TIKTOK_TOKEN_PATH = "/oauth2/access_token/"; // TODO(verify)
export const TIKTOK_REPORT_PATH = "/report/integrated/get/"; // TODO(verify)

/** TODO(verify): maximum days per daily report request. */
export const TIKTOK_MAX_DAYS_PER_REPORT = 30;
export const TIKTOK_PAGE_SIZE = 1000; // TODO(verify): maximum page size

/** Campaign x day report parameters. TODO(verify): names and values. */
export function campaignDailyReportParams(advertiserId: string, dateFrom: string, dateTo: string, page: number) {
  return {
    advertiser_id: advertiserId,
    report_type: "BASIC",
    data_level: "AUCTION_CAMPAIGN",
    dimensions: ["campaign_id", "stat_time_day"],
    metrics: ["campaign_name", "spend", "impressions", "clicks", "conversion"],
    start_date: dateFrom,
    end_date: dateTo,
    page,
    page_size: TIKTOK_PAGE_SIZE,
  };
}

/** Expected envelope of every TikTok API response. TODO(verify). */
export interface TikTokEnvelope<T> {
  code: number; // 0 = success
  message: string;
  request_id?: string;
  data?: T;
}

export interface TikTokReportData {
  list: Array<{
    dimensions: Record<string, string>;
    metrics: Record<string, string | number | null | undefined>;
  }>;
  page_info: { page: number; page_size: number; total_number: number; total_page: number };
}

export interface TikTokTokenData {
  access_token: string;
  advertiser_ids?: string[];
  scope?: unknown;
}
