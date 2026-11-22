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
/** Advertisers the access token may use (app_id + secret as query params, token in header). TODO(verify). */
export const TIKTOK_ADVERTISER_GET_PATH = "/oauth2/advertiser/get/";
/** Name, currency and timezone of advertisers. TODO(verify): path, max 100 ids per call, field names. */
export const TIKTOK_ADVERTISER_INFO_PATH = "/advertiser/info/";
export const TIKTOK_ADVERTISER_INFO_FIELDS = ["advertiser_id", "name", "currency", "timezone", "display_timezone"];
export const TIKTOK_ADVERTISER_INFO_MAX_IDS = 100;
/** Campaign read and writes (Ads management scope). TODO(verify): paths, field names, enum values. */
export const TIKTOK_CAMPAIGN_GET_PATH = "/campaign/get/";
export const TIKTOK_CAMPAIGN_STATUS_PATH = "/campaign/status/update/";
export const TIKTOK_CAMPAIGN_UPDATE_PATH = "/campaign/update/";
export const TIKTOK_CAMPAIGN_FIELDS = ["campaign_id", "campaign_name", "operation_status", "budget", "budget_mode"];

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

/**
 * Account-level totals over the whole range (no day dimension), used for
 * reconciliation. TODO(verify): data level and dimension names, and that
 * omitting stat_time_day returns one aggregated row for the range.
 */
export function accountTotalsParams(advertiserId: string, dateFrom: string, dateTo: string) {
  return {
    advertiser_id: advertiserId,
    report_type: "BASIC",
    data_level: "AUCTION_ADVERTISER",
    dimensions: ["advertiser_id"],
    metrics: ["spend", "impressions", "clicks", "conversion"],
    start_date: dateFrom,
    end_date: dateTo,
    page: 1,
    page_size: 10,
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

export interface TikTokAdvertiserListData {
  list: Array<{ advertiser_id: string | number; advertiser_name?: string | null }>;
}

export interface TikTokAdvertiserInfoData {
  list: Array<{
    advertiser_id: string | number;
    name?: string | null;
    currency?: string | null;
    timezone?: string | null;
    display_timezone?: string | null;
  }>;
}

export interface TikTokCampaignListData {
  list: Array<{
    campaign_id: string | number;
    campaign_name?: string | null;
    operation_status?: string | null; // "ENABLE" | "DISABLE" TODO(verify)
    budget?: string | number | null;
    budget_mode?: string | null; // e.g. "BUDGET_MODE_DAY", "BUDGET_MODE_INFINITE" TODO(verify)
  }>;
}

